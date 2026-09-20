import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodebuddyAdapter } from "../../src/adapters/codebuddy";
import {
  CODEBUDDY_CHAT_BASE_URL,
  codebuddyFailoverHintFromErrorPayload,
  codebuddyFailoverHintFromQuotaCode,
  getCodebuddyFailoverHint,
  parseCodebuddyResetAtMs,
  recoverCodebuddyFailoverHint,
  rememberCodebuddyFailoverHint,
} from "../../src/oauth/codebuddy";
import {
  applyGenericFailoverCooldown,
  clearGenericFailoverHealth,
  isGenericFailoverCooled,
  normalizeGenericFailoverModelId,
  shouldAttemptGenericOAuthFailover,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
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

const QUOTA_DETAIL = "您的使用量已超出频率限制，将在 2026-09-12 20:13:47 UTC+8 重置，您也可以切换其他模型继续使用。";
const QUOTA_NOW = Date.parse("2026-09-12T10:00:00+08:00");
const QUOTA_RESET_AT = Date.parse("2026-09-12T20:13:47+08:00");

function rewritten402Body(code: "6004" | "14018" = "6004"): string {
  return JSON.stringify({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: `CodeBuddy quota exhausted (${code}). ${QUOTA_DETAIL}`,
    },
  });
}

function cloneWithoutWeakMap(response: Response): Promise<Response> {
  return response.clone().text().then(text => new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
}

describe("codebuddyFailoverHintFromErrorPayload", () => {
  test("reads 6004 and the UTC+8 clock from the rewritten 402 JSON", () => {
    const hint = codebuddyFailoverHintFromErrorPayload(rewritten402Body("6004"), QUOTA_NOW);
    expect(hint).toEqual({ code: "6004", scope: "model", resetAtMs: QUOTA_RESET_AT });
  });

  test("reads 14018 as account-scoped", () => {
    const hint = codebuddyFailoverHintFromErrorPayload(rewritten402Body("14018"), QUOTA_NOW);
    expect(hint?.code).toBe("14018");
    expect(hint?.scope).toBe("account");
  });

  test("ignores an ordinary 402", () => {
    expect(codebuddyFailoverHintFromErrorPayload(JSON.stringify({
      error: { type: "insufficient_quota", message: "card declined" },
    }))).toBeUndefined();
  });
});

describe("recoverCodebuddyFailoverHint", () => {
  test("returns the WeakMap hit without needing the body", async () => {
    const response = new Response("not-json", { status: 402 });
    rememberCodebuddyFailoverHint(response, { code: "6004", scope: "model", resetAtMs: 1 });
    expect(await recoverCodebuddyFailoverHint(response)).toEqual({
      code: "6004",
      scope: "model",
      resetAtMs: 1,
    });
  });

  test("rebuilds the hint from a cloned rewritten 402 that lost the WeakMap", async () => {
    const original = new Response(rewritten402Body("6004"), {
      status: 402,
      statusText: "Payment Required",
      headers: { "Content-Type": "application/json" },
    });
    rememberCodebuddyFailoverHint(original, {
      code: "6004",
      scope: "model",
      resetAtMs: QUOTA_RESET_AT,
    });
    const cloned = await cloneWithoutWeakMap(original);
    expect(getCodebuddyFailoverHint(cloned)).toBeUndefined();
    expect(await recoverCodebuddyFailoverHint(cloned, undefined, QUOTA_NOW)).toEqual({
      code: "6004",
      scope: "model",
      resetAtMs: QUOTA_RESET_AT,
    });
    // Original body remains readable for the client-facing error path.
    expect(await original.clone().json()).toEqual(JSON.parse(rewritten402Body("6004")));
  });

  test("does not invent a hint for a 402 that is not CodeBuddy quota", async () => {
    const response = new Response(JSON.stringify({
      error: { type: "insufficient_quota", message: "card declined" },
    }), { status: 402 });
    expect(await recoverCodebuddyFailoverHint(response)).toBeUndefined();
  });
});

describe("adapter rewrite then clone", () => {
  test("fetchResponse 402 still rotates after the Response object is rebuilt", async () => {
    const adapter = createCodebuddyAdapter({
      adapter: "codebuddy",
      baseUrl: CODEBUDDY_CHAT_BASE_URL,
      authMode: "oauth",
    } as OcxProviderConfig);
    const rewritten = await adapter.fetchResponse!({
      url: `${CODEBUDDY_CHAT_BASE_URL}/chat/completions`,
      method: "POST",
      headers: {},
      body: "{}",
    }, {
      executor: async () => new Response(JSON.stringify({
        code: 6004,
        msg: QUOTA_DETAIL,
      }), { status: 429, headers: { "Content-Type": "application/json" } }),
    });
    expect(rewritten.status).toBe(402);
    expect(getCodebuddyFailoverHint(rewritten)?.code).toBe("6004");

    const cloned = await cloneWithoutWeakMap(rewritten);
    expect(getCodebuddyFailoverHint(cloned)).toBeUndefined();
    const recovered = await recoverCodebuddyFailoverHint(cloned, undefined, QUOTA_NOW);
    expect(recovered).toEqual({ code: "6004", scope: "model", resetAtMs: QUOTA_RESET_AT });
  });
});

describe("WorkBuddy 402 rotates to a spare account", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let home = "";

  function config(): OcxConfig {
    return {
      defaultProvider: "workbuddy",
      providers: {
        workbuddy: {
          adapter: "codebuddy",
          baseUrl: CODEBUDDY_CHAT_BASE_URL,
          authMode: "oauth",
          models: ["deepseek-v4.1-flash"],
        },
      },
    } as OcxConfig;
  }

  function chatSse(text: string): Response {
    const chunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    };
    const done = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-workbuddy-402-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth("workbuddy");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearGenericFailoverHealth("workbuddy");
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  });

  test("a 6004 on the active account retries the spare account on the same request", async () => {
    await saveCredential("workbuddy", {
      access: "access-a",
      refresh: "refresh-a",
      expires: Date.now() + 3_600_000,
      accountId: "uid-a",
      email: "acct-a",
      codebuddy: { uid: "uid-a" },
      source: "oauth",
    });
    await saveCredential("workbuddy", {
      access: "access-b",
      refresh: "refresh-b",
      expires: Date.now() + 3_600_000,
      accountId: "uid-b",
      email: "acct-b",
      codebuddy: { uid: "uid-b" },
      source: "oauth",
    });
    const ids = getAccountSet("workbuddy")!.accounts.map(account => account.id);
    const active = getAccountSet("workbuddy")!.accounts.find(account => account.credential.accountId === "uid-a")!.id;
    const spare = ids.find(id => id !== active)!;
    await setActiveAccount("workbuddy", active);
    expect(spare).toBeDefined();

    const auths: string[] = [];
    const userIds: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      auths.push(headers.get("authorization") ?? "");
      userIds.push(headers.get("x-user-id") ?? "");
      if (headers.get("authorization") === "Bearer access-a") {
        return new Response(JSON.stringify({ code: 6004, msg: QUOTA_DETAIL }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return chatSse("from-spare");
    }) as typeof fetch;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "workbuddy/deepseek-v4.1-flash", input: "hello", stream: false }),
      }),
      config(),
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("from-spare");
    expect(auths).toEqual(["Bearer access-a", "Bearer access-b"]);
    expect(userIds).toEqual(["uid-a", "uid-b"]);
    // 6004 must not persist the spare as the operator's selected account.
    expect(getAccountSet("workbuddy")?.activeAccountId).toBe(active);
  });
});
