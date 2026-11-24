// WorkBuddy schema compatibility, based on upstream opencodex's workbuddy-schema.ts.
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const schemaValues = new Set(["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]);
const jsonTypes = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
// Valid UTF-8 JSON strings cannot contain lone UTF-16 surrogates, so REA's
// JS-style surrogate exclusions are redundant. Rewriting them to RE2's \x{...}
// syntax fixes WorkBuddy's 400/11129 RE2 validator but breaks downstream model
// providers (400/11133, e.g. 400001 / invalid_parameter_value) that reject \x{...}.
const reaSurrogateExclusionAnyRe = /^\^\[\^\\u[dD]800-\\u[dD][fF]{3}\](?:\*|\{0,\})\$$/;
const reaSurrogateExclusionNonEmptyRe = /^\^\[\^\\u[dD]800-\\u[dD][fF]{3}\](?:\+|\{1,\})\$$/;

function isRedundantSurrogatePatternOnly(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const keys = Object.keys(schema);
  if (keys.length !== 1 || keys[0] !== "pattern") return false;
  const pattern = (schema as Record<string, unknown>).pattern;
  return typeof pattern === "string" && reaSurrogateExclusionAnyRe.test(pattern);
}

/** Normalize schema positions only; defaults, examples and property names remain data. */
export function workBuddySchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 64) throw new Error("WorkBuddy tool schema exceeds maximum depth");
  if (value === false) return { not: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>, out = { ...input };
  for (const [key, child] of Object.entries(input)) {
    if (schemaMaps.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      out[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, workBuddySchema(schema, depth + 1)]));
    } else if (schemaLists.has(key) && Array.isArray(child)) {
      if (key === "allOf") {
        const filtered = child.filter(schema => !isRedundantSurrogatePatternOnly(schema));
        if (filtered.length !== child.length && filtered.length === 0) {
          delete out.allOf;
        } else {
          out.allOf = filtered.map(schema => workBuddySchema(schema, depth + 1));
        }
      } else {
        out[key] = child.map(schema => workBuddySchema(schema, depth + 1));
      }
    } else if (schemaValues.has(key)) {
      if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") continue;
      out[key] = key === "items" && Array.isArray(child)
        ? { anyOf: child.map(schema => workBuddySchema(schema, depth + 1)) } : workBuddySchema(child, depth + 1);
    }
  }
  if (typeof out.pattern === "string") out.pattern = out.pattern.replace(/\\\\|\\0(?![0-9])/g, match => match === "\\0" ? "\\u0000" : match);
  if (typeof out.pattern === "string") {
    if (reaSurrogateExclusionAnyRe.test(out.pattern)) {
      delete out.pattern;
    } else if (reaSurrogateExclusionNonEmptyRe.test(out.pattern)) {
      delete out.pattern;
      if (typeof out.minLength !== "number" || out.minLength < 1) out.minLength = 1;
    }
  }
  if (out.required !== undefined && !Array.isArray(out.required)) delete out.required;
  if (typeof out.type === "string") {
    out.type = out.type.toLowerCase();
    if (!jsonTypes.has(out.type as string)) delete out.type;
  }
  if (Array.isArray(out.enum)) {
    if (!out.enum.length) delete out.enum;
    else if (out.type === undefined) {
      const groups = new Map<string, unknown[]>();
      for (const item of out.enum) {
        const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
        const values = groups.get(type) ?? []; values.push(item); groups.set(type, values);
      }
      if (groups.size === 1) out.type = groups.keys().next().value;
      else {
        const union = { anyOf: [...groups].map(([type, values]) => ({ type, enum: values })) };
        out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), union];
        delete out.enum;
      }
    }
  }
  return out;
}

export function workBuddyToolParameters(value: unknown): Record<string, unknown> {
  const out = workBuddySchema(value);
  const properties: Record<string, unknown> = { ...(out.properties as Record<string, unknown> ?? {}) };
  const required = new Set(Array.isArray(out.required) ? out.required.filter(x => typeof x === "string") : []);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const variant of Array.isArray(out[key]) ? out[key] : []) {
      const row = variant as Record<string, unknown>;
      Object.assign(properties, row.properties);
      if (key === "allOf" && Array.isArray(row.required)) for (const field of row.required) if (typeof field === "string") required.add(field);
    }
    delete out[key];
  }
  return { ...out, type: "object", properties, ...(required.size ? { required: [...required] } : {}) };
}
