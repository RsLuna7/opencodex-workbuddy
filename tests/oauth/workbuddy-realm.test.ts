import { describe, expect, test } from "bun:test";
import { applyWorkbuddyBillingHeaders, applyWorkbuddyChatHeaders, workbuddyBillingUserAgent } from "../../src/oauth/codebuddy-headers";
import {
  isCanonicalWorkbuddyChatBase,
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_GLOBAL_CHAT_BASE,
  workbuddyAuthStateUrl,
  workbuddyBillingMeterPaths,
  workbuddyChatCompletionsUrl,
  workbuddyModelsUrl,
  workbuddySiteProfile,
} from "../../src/oauth/codebuddy-hosts";
import {
  credentialWorkbuddyRealm,
  isWorkbuddyGlobalDomain,
  parseWorkbuddyRealm,
  resolveWorkbuddyRealm,
  routedWorkbuddyRealm,
  workbuddyAccountsShareRealm,
  workbuddyGlobalRoutingEnabled,
} from "../../src/oauth/codebuddy-realm";
import {
  ensureLeadingSystemMessage,
  prepareWorkbuddyChatBody,
  sanitizeWorkbuddyFingerprintText,
} from "../../src/oauth/codebuddy-payload";
import { parseCodebuddyResetAtMs } from "../../src/oauth/codebuddy";
import { createCodebuddyAdapter } from "../../src/adapters/codebuddy";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

describe("workbuddy realm", () => {
  test("domain suffix workbuddy.ai is global", () => {
    expect(isWorkbuddyGlobalDomain("www.workbuddy.ai")).toBe(true);
    expect(isWorkbuddyGlobalDomain("workbuddy.ai")).toBe(true);
    expect(isWorkbuddyGlobalDomain("copilot.tencent.com")).toBe(false);
    expect(resolveWorkbuddyRealm(undefined, "www.workbuddy.ai")).toBe("global");
    expect(resolveWorkbuddyRealm(undefined, "copilot.tencent.com")).toBe("cn");
  });

  test("explicit realm wins over domain", () => {
    expect(resolveWorkbuddyRealm("global", "copilot.tencent.com")).toBe("global");
    expect(parseWorkbuddyRealm("intl")).toBe("global");
  });

  test("legacy credentials without realm stay cn", () => {
    expect(credentialWorkbuddyRealm({ codebuddy: { uid: "u1" } })).toBe("cn");
  });

  test("global.enabled false locks routing to cn without rewriting storage", () => {
    const cred = { codebuddy: { uid: "g1", domain: "www.workbuddy.ai", realm: "global" as const } };
    expect(workbuddyGlobalRoutingEnabled({ workbuddyGlobal: { enabled: false } })).toBe(false);
    expect(routedWorkbuddyRealm(cred, { workbuddyGlobal: { enabled: false } })).toBe("cn");
    expect(credentialWorkbuddyRealm(cred)).toBe("global");
  });

  test("same-realm compares stored realm", () => {
    expect(workbuddyAccountsShareRealm(
      { codebuddy: { domain: "www.workbuddy.ai" } },
      { codebuddy: { realm: "global" } },
    )).toBe(true);
    expect(workbuddyAccountsShareRealm(
      { codebuddy: { domain: "www.workbuddy.ai" } },
      { codebuddy: { uid: "cn1" } },
    )).toBe(false);
  });
});

describe("workbuddy hosts", () => {
  test("global chat is /v2/chat/completions on workbuddy.ai", () => {
    expect(workbuddyModelsUrl("global")).toBe("https://www.workbuddy.ai/v2/enterprises/personal/models");
    expect(workbuddyChatCompletionsUrl("global")).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(workbuddyChatCompletionsUrl("cn")).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(isCanonicalWorkbuddyChatBase(WORKBUDDY_CN_CHAT_BASE)).toBe(true);
    expect(isCanonicalWorkbuddyChatBase(WORKBUDDY_GLOBAL_CHAT_BASE)).toBe(true);
    expect(isCanonicalWorkbuddyChatBase("https://www.codebuddy.ai")).toBe(false);
  });

  test("global login tries workbuddy-ai then CLI", () => {
    expect([...workbuddySiteProfile("global").loginPlatforms]).toEqual(["workbuddy-ai", "CLI"]);
    expect(workbuddyAuthStateUrl("global", "workbuddy-ai"))
      .toBe("https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai");
    expect(workbuddySiteProfile("cn").loginPlatforms).toEqual(["ide"]);
  });

  test("global billing meter tries unprefixed then /v2", () => {
    expect(workbuddyBillingMeterPaths("global", "daily-checkin")).toEqual([
      "/billing/meter/daily-checkin",
      "/v2/billing/meter/daily-checkin",
    ]);
    expect(workbuddyBillingMeterPaths("cn", "daily-checkin")).toEqual([
      "/v2/billing/meter/daily-checkin",
    ]);
  });
});

describe("workbuddy headers", () => {
  test("CN keeps CodeBuddyIDE + SaaS", () => {
    const headers: Record<string, string> = {};
    applyWorkbuddyChatHeaders(headers, "cn", { uid: "u1", domain: "copilot.tencent.com" });
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-IDE-Name"]).toBe("CodeBuddyIDE");
    expect(headers["User-Agent"]).toBe("CodeBuddyIDE");
    expect(headers["X-User-Id"]).toBe("u1");
    expect(headers["X-Domain"]).toBe("copilot.tencent.com");
  });

  test("Global uses WorkBuddy AI desktop attribution", () => {
    const headers: Record<string, string> = {};
    applyWorkbuddyChatHeaders(headers, "global", { uid: "g1", realm: "global" });
    expect(headers["X-Product"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Name"]).toBe("WorkBuddy");
    expect(headers["X-Agent-Purpose"]).toBe("conversation");
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
    expect(headers["X-No-Enterprise-Id"]).toBe("1");
    expect(headers["Accept-Language"]).toBe("en-US");
    expect(headers["User-Agent"]).toContain("WorkBuddy AI");
    expect(headers["X-Machine-ID"]).toHaveLength(36);
    expect(headers["X-Session-ID"]).toHaveLength(36);
  });

  test("billing headers use the desktop WorkBuddy UA", () => {
    const headers: Record<string, string> = {};
    applyWorkbuddyBillingHeaders(headers, "cn", { uid: "u1", domain: "copilot.tencent.com" });
    expect(headers["User-Agent"]).toBe(workbuddyBillingUserAgent());
    expect(headers["User-Agent"]).toBe("WorkBuddy/5.5.4");
    expect(headers["X-CodeBuddy-Request"]).toBe("1");
    expect(headers["Origin"]).toBe("https://www.codebuddy.cn");
    expect(headers["Accept-Language"]).toBe("zh-CN");
  });
});

describe("workbuddy payload", () => {
  test("inserts a leading system when the first message is user", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "hi" }],
    };
    ensureLeadingSystemMessage(body);
    const messages = body.messages as Array<{ role: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
  });

  test("rewrites Claude Code fingerprint sentences", () => {
    const raw = "You are Claude Code, Anthropic's official CLI for Claude.";
    expect(sanitizeWorkbuddyFingerprintText(raw)).toContain("CLI tool for Claude");
    expect(sanitizeWorkbuddyFingerprintText("error 11128")).toBe("error 11-128");
  });

  test("rewrites fixed DeepSeek Harness prompt lines in a WorkBuddy request", () => {
    const source = "You are an AI agent powered by DeepSeek Harness.";
    const checkout = "The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate.";
    const webSurface = "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.";
    const raw = JSON.stringify({
      messages: [
        { role: "system", content: `${source}\n${checkout}\n${webSurface}\nFollow the user's instructions.` },
        { role: "user", content: "Current DeepSeek Harness implementation checkout: C:\\example.\nCurrent DeepSeek Harness Web GUI URL: http://127.0.0.1:9342.\nhello" },
      ],
    });
    const out = prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: true });
    const parsed = JSON.parse(out) as { messages: Array<{ role: string; content: string }> };
    expect(parsed.messages[0]?.content).toBe(
      "You are an AI agent that helps users with software engineering tasks.\n"
      + "The runtime context names the agent implementation checkout. The checkout location and current working directory are separate.\n"
      + "You are interacting with the user through the web chat interface whose URL the runtime context names.\n"
      + "Follow the user's instructions.",
    );
    expect(parsed.messages[1]?.content).toBe("Current agent implementation checkout: C:\\example.\nCurrent web chat URL: http://127.0.0.1:9342.\nhello");
    expect(sanitizeWorkbuddyFingerprintText("DeepSeek Harness is installed.")).toBe("DeepSeek Harness is installed.");
  });

  test("prepareWorkbuddyChatBody applies both guards for global", () => {
    const out = prepareWorkbuddyChatBody(
      JSON.stringify({
        messages: [
          { role: "user", content: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
      }),
      { ensureSystem: true, sanitize: true },
    );
    const parsed = JSON.parse(out) as { messages: Array<{ role: string; content: string }> };
    expect(parsed.messages[0]?.role).toBe("system");
    expect(parsed.messages[1]?.content).toContain("CLI tool for Claude");
  });

  test("normalizes the DSH file-reference opener rejected by channel verification", () => {
    const opener = "Tokens prefixed with @ are paths the user explicitly referenced.";
    const remainder = " Relative paths resolve from the workspace root; absolute paths identify files or directories on the host."
      + " A trailing slash marks a directory: list it when its contents matter."
      + " Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading."
      + ' @"..." quotes a path containing spaces.';
    const raw = JSON.stringify({
      messages: [{ role: "system", content: opener + remainder }, { role: "user", content: "Inspect @src/index.ts" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    });
    const result = JSON.parse(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: true }));
    expect(result.messages[0].content).toBe("Paths prefixed with @ were explicitly referenced by the user." + remainder);
    expect(result.messages[1]).toEqual(JSON.parse(raw).messages[1]);
    expect(result.tools).toEqual(JSON.parse(raw).tools);
    expect(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: false })).toBe(raw);
    expect(sanitizeWorkbuddyFingerprintText(result.messages[0].content)).toBe(result.messages[0].content);
  });
});

describe("parseCodebuddyResetAtMs english 6004", () => {
  test("reads will reset at UTC+8 and ignores the alternatively tail", () => {
    const now = Date.parse("2026-09-19T00:00:00+08:00");
    const ms = parseCodebuddyResetAtMs(
      "usage exceeds frequency limit, but don't worry, your usage will reset at 2026-09-19 04:23:04 UTC+8, alternatively, you can switch to the other models to continue using it. (code 6004)",
      now,
    );
    expect(ms).toBe(Date.parse("2026-09-19T04:23:04+08:00"));
  });
});

test("WorkBuddy normalizes function schemas only when requested", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "hello" }], tools: [
    { type: "function", function: { name: "lookup", parameters: { anyOf: [{ properties: { x: { enum: [1, "one"] }, y: { items: [{ type: "String" }, false] } } }], default: { type: "String" } } } },
    { type: "other", value: "unchanged" },
  ] });
  const body = JSON.parse(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: false, normalizeTools: true }));
  const schema = body.tools[0].function.parameters;
  expect(schema.type).toBe("object");
  expect(schema.default).toEqual({ type: "String" });
  expect(schema.properties.x.allOf[0].anyOf).toHaveLength(2);
  expect(schema.properties.y.items.anyOf).toEqual([{ type: "string" }, { not: {} }]);
  expect(body.tools[1]).toEqual({ type: "other", value: "unchanged" });
  expect(JSON.parse(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: false })).tools[0].function.parameters.anyOf).toBeDefined();
});

test("WorkBuddy adapter sends normalized tool schemas", async () => {
  const adapter = createCodebuddyAdapter({ adapter: "codebuddy", baseUrl: WORKBUDDY_CN_CHAT_BASE, authMode: "oauth", apiKey: "test-key" } as never);
  const request = await adapter.buildRequest({
    modelId: "deepseek-v4.1-flash", stream: true, options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [{ name: "lookup", parameters: { anyOf: [{ properties: { query: { type: "String" } } }] } }] },
  } as never, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
  const parameters = JSON.parse(request.body).tools[0].function.parameters;
  expect(parameters.type).toBe("object");
  expect(parameters.properties.query.type).toBe("string");
  expect(parameters.anyOf).toBeUndefined();
});

test.each(["^[^\\uD800-\\uDFFF]*$", "^[^\\uD800-\\uDFFF]{0,}$", "^[^\\ud800-\\udfff]*$"])("WorkBuddy strips REA's redundant surrogate-exclusion pattern %s", pattern => {
  const parameters = {
    type: "object", additionalProperties: false,
    properties: { expected_server_path: { type: "string", minLength: 1, allOf: [
      { pattern: "^[^\\x00]*$" }, { pattern }, { pattern: "^\\/" },
    ] } },
    default: { pattern }, examples: [{ pattern }],
  };
  const raw = JSON.stringify({ tools: [{ type: "function", function: { name: "probe", parameters } }] });
  const result = JSON.parse(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: false, normalizeTools: true })).tools[0].function.parameters;
  expect(result.properties.expected_server_path.allOf).toEqual([
    { pattern: "^[^\\x00]*$" }, { pattern: "^\\/" },
  ]);
  expect(result.additionalProperties).toBe(false);
  expect(result.default).toEqual({ pattern });
  expect(result.examples).toEqual([{ pattern }]);
  expect(parameters.properties.expected_server_path.allOf[1]).toEqual({ pattern });
});

test("WorkBuddy strips direct/non-empty surrogate patterns and cleans up emptied allOf", () => {
  const raw = JSON.stringify({
    tools: [{
      type: "function",
      function: {
        name: "probe",
        parameters: {
          type: "object",
          properties: {
            direct: { type: "string", minLength: 1, pattern: "^[^\\uD800-\\uDFFF]*$" },
            soleAllOf: { type: "string", allOf: [{ pattern: "^[^\\uD800-\\uDFFF]*$" }] },
            nonEmptyPlus: { type: "string", pattern: "^[^\\uD800-\\uDFFF]+$" },
            nonEmptyBrace: { type: "string", minLength: 3, pattern: "^[^\\uD800-\\uDFFF]{1,}$" },
            union: { anyOf: [{ pattern: "^[^\\uD800-\\uDFFF]*$" }, { type: "null" }] },
          },
        },
      },
    }],
  });
  const props = JSON.parse(prepareWorkbuddyChatBody(raw, { ensureSystem: false, sanitize: false, normalizeTools: true })).tools[0].function.parameters.properties;
  expect(props.direct).toEqual({ type: "string", minLength: 1 });
  expect(props.soleAllOf).toEqual({ type: "string" });
  expect(props.nonEmptyPlus).toEqual({ type: "string", minLength: 1 });
  expect(props.nonEmptyBrace).toEqual({ type: "string", minLength: 3 });
  expect(props.union).toEqual({ anyOf: [{}, { type: "null" }] });
});
