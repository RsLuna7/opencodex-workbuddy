import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodebuddyAdapter } from "../../src/adapters/codebuddy";
import {
  CODEBUDDY_CHAT_BASE_URL,
  codebuddyFailoverHintFromQuotaCode,
  getCodebuddyFailoverHint,
  parseCodebuddyResetAtMs,
  rememberCodebuddyFailoverHint,
} from "../../src/oauth/codebuddy";
import {
  applyGenericFailoverCooldown,
  clearGenericFailoverHealth,
  isGenericFailoverCooled,
  normalizeGenericFailoverModelId,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
  shouldAttemptGenericOAuthFailover,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, getCredential, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROVIDER = "workbuddy-test";

afterEach(() => {
  clearGenericFailoverHealth(PROVIDER);
  clearGenericFailoverHealth("workbuddy");
});

describe("parseCodebuddyResetAtMs", () => {
  test("reads UTC+8 clock from the 6004 message", () => {
    const now = Date.parse("2026-09-11T10:00:00+08:00");
    const ms = parseCodebuddyResetAtMs(
      "您的使用量已超出频率限制，将在 2026-09-11 18:52:21 UTC+8 重置，您也可以切换其他模型继续使用。",
      now,
    );
    expect(ms).toBe(Date.parse("2026-09-11T18:52:21+08:00"));
  });

  test("ignores a reset already in the past", () => {
    const now = Date.parse("2026-09-11T19:00:00+08:00");
    expect(parseCodebuddyResetAtMs("将在 2026-09-11 18:52:21 UTC+8 重置", now)).toBeUndefined();
  });

  test("returns undefined when the message has no clock", () => {
    expect(parseCodebuddyResetAtMs("quota exhausted", Date.now())).toBeUndefined();
  });
});

describe("codebuddyFailoverHintFromQuotaCode", () => {
  test("6004 is model-scoped and carries resetAtMs", () => {
    const now = Date.parse("2026-09-11T10:00:00+08:00");
    const hint = codebuddyFailoverHintFromQuotaCode(
      "6004",
      "CodeBuddy quota exhausted (6004). 将在 2026-09-11 18:52:21 UTC+8 重置",
      now,
    );
    expect(hint?.scope).toBe("model");
    expect(hint?.code).toBe("6004");
    expect(hint?.resetAtMs).toBe(Date.parse("2026-09-11T18:52:21+08:00"));
  });

  test("14018 is account-scoped", () => {
    const hint = codebuddyFailoverHintFromQuotaCode("14018", "CodeBuddy quota exhausted (14018)");
    expect(hint?.scope).toBe("account");
    expect(hint?.resetAtMs).toBeUndefined();
  });
});

describe("failover hint WeakMap", () => {
  test("stays on the rewritten 402 Response object", () => {
    const response = new Response("{}", { status: 402 });
    rememberCodebuddyFailoverHint(response, { code: "6004", scope: "model", resetAtMs: 1 });
    expect(getCodebuddyFailoverHint(response)?.code).toBe("6004");
    expect(getCodebuddyFailoverHint(new Response("{}", { status: 402 }))).toBeUndefined();
  });
});

describe("account × model cooldown", () => {
  test("6004 cools one model and leaves others on the same account", () => {
    const now = 1_000_000;
    const provider = "workbuddy";
    applyGenericFailoverCooldown({
      providerName: provider,
      accountId: "acct-a",
      modelId: "deepseek-v4.1-flash",
      cooldownMs: 24 * 60 * 60_000,
      now,
    });
    expect(isGenericFailoverCooled(provider, "acct-a", now + 1000, "deepseek-v4.1-flash")).toBe(true);
    expect(isGenericFailoverCooled(provider, "acct-a", now + 1000, "workbuddy/deepseek-v4.1-flash")).toBe(true);
    expect(isGenericFailoverCooled(provider, "acct-a", now + 1000, "glm-5.3")).toBe(false);
    expect(isGenericFailoverCooled(provider, "acct-b", now + 1000, "deepseek-v4.1-flash")).toBe(false);
  });

  test("14018 cools every model on that account", () => {
    const now = 1_000_000;
    applyGenericFailoverCooldown({
      providerName: PROVIDER,
      accountId: "acct-a",
      cooldownMs: 24 * 60 * 60_000,
      now,
    });
    expect(isGenericFailoverCooled(PROVIDER, "acct-a", now + 1000, "glm-5.3")).toBe(true);
    expect(isGenericFailoverCooled(PROVIDER, "acct-a", now + 1000, "deepseek-v4.1-flash")).toBe(true);
    expect(isGenericFailoverCooled(PROVIDER, "acct-b", now + 1000, "glm-5.3")).toBe(false);
  });

  test("expires after the cooldown window", () => {
    const now = 1_000_000;
    applyGenericFailoverCooldown({
      providerName: PROVIDER,
      accountId: "acct-a",
      modelId: "flash",
      cooldownMs: 60_000,
      now,
    });
    expect(isGenericFailoverCooled(PROVIDER, "acct-a", now + 59_000, "flash")).toBe(true);
    expect(isGenericFailoverCooled(PROVIDER, "acct-a", now + 60_001, "flash")).toBe(false);
  });
});

describe("normalizeGenericFailoverModelId", () => {
  test("strips the provider prefix", () => {
    expect(normalizeGenericFailoverModelId("workbuddy", "workbuddy/deepseek-v4.1-flash"))
      .toBe("deepseek-v4.1-flash");
    expect(normalizeGenericFailoverModelId("workbuddy", "deepseek-v4.1-flash"))
      .toBe("deepseek-v4.1-flash");
  });
});

describe("shouldAttemptGenericOAuthFailover", () => {
  const config = { providers: { workbuddy: { authMode: "oauth" as const } } };
  let emptyHome = "";

  beforeEach(() => {
    emptyHome = mkdtempSync(join(tmpdir(), "ocx-workbuddy-quorum-"));
    process.env.OPENCODEX_HOME = emptyHome;
    clearGenericFailoverHealth();
  });

  afterEach(() => {
    clearGenericFailoverHealth();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    if (emptyHome) removeTreeWithRetry(emptyHome);
  });

  test("without a 2-account quorum, 402 does not rotate", () => {
    expect(shouldAttemptGenericOAuthFailover(
      config as never,
      "workbuddy",
      402,
      "acct-a",
      0,
      { scope: "model" },
    )).toBe(false);
  });

  test("ordinary 401 never rotates", () => {
    expect(shouldAttemptGenericOAuthFailover(
      config as never,
      "workbuddy",
      401,
      "acct-a",
      0,
      { scope: "model" },
    )).toBe(false);
  });
});

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let isolatedHome = "";

function workbuddyConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "workbuddy",
    providers: {
      workbuddy: {
        adapter: "codebuddy",
        baseUrl: CODEBUDDY_CHAT_BASE_URL,
        authMode: "oauth",
        models: ["deepseek-v4.1-flash", "glm-5.3"],
      },
    },
  } as OcxConfig;
}

async function seedWorkbuddyAccounts(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("workbuddy", {
      access: `wb-access-${i}`,
      refresh: `wb-refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `wb-uid-${i}`,
      codebuddy: { uid: `wb-uid-${i}` },
    } as never, { addAccount: true });
  }
  const ids = getAccountSet("workbuddy")?.accounts.map(account => account.id) ?? [];
  if (ids[0]) await setActiveAccount("workbuddy", ids[0]);
  return ids;
}

function quotaResponse(code: "6004" | "14018"): Response {
  return new Response(JSON.stringify({
    code: Number(code),
    msg: code === "6004"
      ? "您的使用量已超出频率限制，将在 2099-01-01 18:00:00 UTC+8 重置"
      : "account quota exhausted",
  }), { status: 403, headers: { "content-type": "application/json" } });
}

function chatSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("WorkBuddy quota rewrite and 402 rotation", () => {
  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-workbuddy-failover-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    clearGenericFailoverHealth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearGenericFailoverHealth();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    if (isolatedHome) removeTreeWithRetry(isolatedHome);
    isolatedHome = "";
  });

  test("fetchResponse rewrites 6004 to 402 and keeps the rotation hint on that object", async () => {
    const adapter = createCodebuddyAdapter({
      adapter: "codebuddy",
      baseUrl: CODEBUDDY_CHAT_BASE_URL,
      authMode: "oauth",
    } as never);
    const rewritten = await adapter.fetchResponse!(
      { url: `${CODEBUDDY_CHAT_BASE_URL}/chat/completions`, method: "POST", headers: {}, body: "{}" },
      { executor: async () => quotaResponse("6004") },
    );
    expect(rewritten.status).toBe(402);
    expect(getCodebuddyFailoverHint(rewritten)).toMatchObject({ code: "6004", scope: "model" });
    const payload = await rewritten.json() as { error?: { type?: string } };
    expect(payload.error?.type).toBe("insufficient_quota");
  });

  test("two stored accounts rotate on 402+hint and on 429, never on 401", async () => {
    await seedWorkbuddyAccounts(2);
    const cfg = workbuddyConfig();
    expect(shouldAttemptGenericOAuthFailover(cfg, "workbuddy", 402, "acct-a", 0, { scope: "model" })).toBe(true);
    expect(shouldAttemptGenericOAuthFailover(cfg, "workbuddy", 429, "acct-a", 0)).toBe(true);
    expect(shouldAttemptGenericOAuthFailover(cfg, "workbuddy", 402, "acct-a", 0)).toBe(false);
    expect(shouldAttemptGenericOAuthFailover(cfg, "workbuddy", 401, "acct-a", 0, { scope: "model" })).toBe(false);
  });

  test("6004 cools one model then prefers the spare on that model with the pool knob off", async () => {
    const ids = await seedWorkbuddyAccounts(2);
    const cfg = workbuddyConfig();
    expect(rotateGenericOAuthAccountOn429(cfg, "workbuddy", ids[0]!, null, Date.now(), {
      scope: "model",
      modelId: "deepseek-v4.1-flash",
      quotaExhausted: true,
    })).toBe(ids[1]);
    expect(preferredInitialAccount(cfg, "workbuddy", Date.now(), "deepseek-v4.1-flash")).toBe(ids[1]);
    expect(preferredInitialAccount(cfg, "workbuddy", Date.now(), "glm-5.3")).toBeNull();
  });

  test("14018 cools the whole account so every model prefers the spare", async () => {
    const ids = await seedWorkbuddyAccounts(2);
    const cfg = workbuddyConfig();
    expect(rotateGenericOAuthAccountOn429(cfg, "workbuddy", ids[0]!, null, Date.now(), {
      scope: "account",
      quotaExhausted: true,
    })).toBe(ids[1]);
    expect(preferredInitialAccount(cfg, "workbuddy", Date.now(), "deepseek-v4.1-flash")).toBe(ids[1]);
    expect(preferredInitialAccount(cfg, "workbuddy", Date.now(), "glm-5.3")).toBe(ids[1]);
  });

  test("a 6004 on the active account retries the spare in the same request and does not persist active", async () => {
    const ids = await seedWorkbuddyAccounts(2);
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      sent.push(auth);
      if (auth.includes("wb-access-0")) return quotaResponse("6004");
      return chatSse("from-spare");
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "workbuddy/deepseek-v4.1-flash", input: "hi", stream: false }),
    }), workbuddyConfig(), { model: "", provider: "" });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("from-spare");
    expect(sent.some(value => value.includes("wb-access-0"))).toBe(true);
    expect(sent.some(value => value.includes("wb-access-1"))).toBe(true);
    expect(getAccountSet("workbuddy")?.activeAccountId).toBe(ids[0]);
    expect(getCredential("workbuddy")?.access).toBe("wb-access-0");
  });

  test("a 14018 on the active account retries the spare and persists the switch", async () => {
    const ids = await seedWorkbuddyAccounts(2);
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes("wb-access-0")) return quotaResponse("14018");
      return chatSse("from-spare");
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "workbuddy/deepseek-v4.1-flash", input: "hi", stream: false }),
    }), workbuddyConfig(), { model: "", provider: "" });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("from-spare");
    expect(getAccountSet("workbuddy")?.activeAccountId).toBe(ids[1]);
    expect(getCredential("workbuddy")?.access).toBe("wb-access-1");
  });

  test("the next request after 6004 does not first replay the cooled account×model", async () => {
    await seedWorkbuddyAccounts(2);
    let first = true;
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      sent.push(auth);
      if (first && auth.includes("wb-access-0")) {
        first = false;
        return quotaResponse("6004");
      }
      return chatSse("ok");
    }) as typeof fetch;
    const post = () => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "workbuddy/deepseek-v4.1-flash", input: "hi", stream: false }),
    }), workbuddyConfig(), { model: "", provider: "" });
    expect((await post()).status).toBe(200);
    sent.length = 0;
    const second = await post();
    const body = await second.text();
    expect(second.status, body).toBe(200);
    expect(sent.every(value => value.includes("wb-access-1"))).toBe(true);
    expect(sent.some(value => value.includes("wb-access-0"))).toBe(false);
  });
});
