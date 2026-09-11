import { afterEach, describe, expect, test } from "bun:test";
import {
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
  shouldAttemptGenericOAuthFailover,
} from "../../src/oauth/generic-account-failover";

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
