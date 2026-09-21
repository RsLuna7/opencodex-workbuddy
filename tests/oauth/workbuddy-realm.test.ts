import { describe, expect, test } from "bun:test";
import { applyWorkbuddyChatHeaders } from "../../src/oauth/codebuddy-headers";
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
