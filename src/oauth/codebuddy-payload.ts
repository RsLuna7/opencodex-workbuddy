/**
 * WorkBuddy outbound body guards: leading system (11128) and fingerprint rewrite.
 *
 * Leading-system rule from CangShui/workbuddy-gateway (international site is strict).
 * Fingerprint rewrites from Sliverkiss/workbuddy2api sanitize.go (MIT): exact-match
 * blacklist, one-word edits, no semantic rewrite.
 */

const DEFAULT_SYSTEM = "You are a helpful assistant.";

const FINGERPRINT_NEEDLES = [
  "x-anthropic-billing-header",
  "cc_entrypoint=",
  "You are Claude Code",
  "Main branch (",
  "You are a coding agent running in the Codex CLI",
  "github.com/anthropics/",
  "11128",
];

const FINGERPRINT_REWRITES: Array<[string, string]> = [
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)",
  ],
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  ["11128", "11-128"],
];

const HEADER_KV_RE = /x-anthropic-billing-header:[^;\n]*;?\s*/gi;
const HEADER_BARE_RE = /x-anthropic-billing-header/gi;
const CC_KV_RE = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi;

function roleOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

function asMessages(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Guarantee the first messages[] entry is role=system. Global 11128 otherwise. */
export function ensureLeadingSystemMessage(body: Record<string, unknown>): void {
  const messages = asMessages(body.messages);
  if (!messages || messages.length === 0) {
    body.messages = [{ role: "system", content: DEFAULT_SYSTEM }];
    return;
  }
  const firstRole = roleOf(messages[0]);
  if (firstRole === "system") return;
  if (firstRole === "developer") {
    const first = { ...(messages[0] as object), role: "system" };
    messages[0] = first;
    body.messages = messages;
    return;
  }
  const later = messages.findIndex(item => {
    const role = roleOf(item);
    return role === "system" || role === "developer";
  });
  if (later > 0) {
    const picked = messages.splice(later, 1)[0];
    const normalized = { ...(picked as object), role: "system" };
    messages.unshift(normalized);
    body.messages = messages;
    return;
  }
  messages.unshift({ role: "system", content: DEFAULT_SYSTEM });
  body.messages = messages;
}

export function workbuddyBodyHasFingerprint(text: string): boolean {
  return FINGERPRINT_NEEDLES.some(needle => text.includes(needle));
}

export function sanitizeWorkbuddyFingerprintText(text: string): string {
  if (!workbuddyBodyHasFingerprint(text)) return text;
  let out = text.replace(HEADER_KV_RE, "").replace(CC_KV_RE, "");
  out = out.replace(HEADER_BARE_RE, "x-anthropic-billing-hdr");
  for (const [from, to] of FINGERPRINT_REWRITES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function rewriteJsonStrings(value: unknown): unknown {
  if (typeof value === "string") return sanitizeWorkbuddyFingerprintText(value);
  if (Array.isArray(value)) return value.map(rewriteJsonStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteJsonStrings(child);
    }
    return out;
  }
  return value;
}

export function prepareWorkbuddyChatBody(
  raw: string,
  opts: { ensureSystem: boolean; sanitize: boolean },
): string {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    body = { ...(parsed as Record<string, unknown>) };
  } catch {
    return opts.sanitize ? sanitizeWorkbuddyFingerprintText(raw) : raw;
  }
  if (opts.sanitize) {
    const rewritten = rewriteJsonStrings(body);
    if (rewritten && typeof rewritten === "object" && !Array.isArray(rewritten)) {
      body = rewritten as Record<string, unknown>;
    }
  }
  if (opts.ensureSystem) ensureLeadingSystemMessage(body);
  return JSON.stringify(body);
}
