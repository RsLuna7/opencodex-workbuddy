import { describe, expect, test } from "bun:test";
import { isZaiPlanQuotaFail } from "../../src/adapters/zai-plan";
import { accountHeadroomPercent, rankAccountsByHeadroom } from "../../src/oauth/account-quota-rank";
import { setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";

describe("zai-plan quota detection", () => {
  test("HTTP 402 is quota regardless of body", () => {
    expect(isZaiPlanQuotaFail(402, "")).toBe(true);
    expect(isZaiPlanQuotaFail(402, '{"error":{"type":"insufficient_quota"}}')).toBe(true);
  });

  test("2xx SSE or model text mentioning quota is not quota", () => {
    const sse = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"quota exhausted and balance/额度"}}',
      "",
    ].join("\n");
    expect(isZaiPlanQuotaFail(200, sse)).toBe(false);
    expect(isZaiPlanQuotaFail(200, "The request has been blocked due to unusual activity. quota exhausted.")).toBe(false);
  });

  test("4xx/5xx error JSON with insufficient_quota is quota", () => {
    expect(isZaiPlanQuotaFail(400, '{"error":{"type":"insufficient_quota","message":"ZCode Plan quota exhausted"}}')).toBe(true);
    expect(isZaiPlanQuotaFail(403, '{"type":"insufficient_quota","msg":"余额不足"}')).toBe(true);
    expect(isZaiPlanQuotaFail(429, '{"error":{"type":"quota_exceeded","message":"额度用尽"}}')).toBe(true);
  });

  test("4xx without a quota error object is not quota", () => {
    expect(isZaiPlanQuotaFail(405, '{"code":3012,"msg":"request has been blocked due to unusual activity."}')).toBe(false);
    expect(isZaiPlanQuotaFail(400, "not json but says quota exhausted")).toBe(false);
    expect(isZaiPlanQuotaFail(500, '{"error":{"type":"api_error","message":"upstream timeout"}}')).toBe(false);
  });
});

describe("ZCode exact model quota ranking", () => {
  test("one exhausted model cannot block another model on the same account", () => {
    setCachedProviderAccountQuotaForTests("zai-plan", "test-a", { updatedAt: Date.now(), customWindows: [
      { label: "Flash", scope: "model", modelId: "GLM-5.3-Flash", percent: 100 },
      { label: "GLM", scope: "model", modelId: "GLM-5.3", percent: 20 },
    ] });
    try {
      expect(accountHeadroomPercent("zai-plan", "test-a", "glm-5.3-flash")).toBe(0);
      expect(accountHeadroomPercent("zai-plan", "test-a", "zai-plan/GLM-5.3")).toBe(80);
      expect(accountHeadroomPercent("zai-plan", "test-a", "GLM-unknown")).toBeNull();
    } finally { setCachedProviderAccountQuotaForTests("zai-plan", "test-a", null); }
  });

  test("fresh model allowance ranks accounts; expired or stale evidence is unknown", () => {
    const at = Date.now();
    const quota = (percent: number, updatedAt = at, resetAt = at + 100_000) => ({ updatedAt, customWindows: [
      { label: "Flash", scope: "model" as const, modelId: "GLM-5.3-Flash", percent, resetAt },
    ] });
    setCachedProviderAccountQuotaForTests("zai-plan", "test-a", quota(100));
    setCachedProviderAccountQuotaForTests("zai-plan", "test-b", quota(20));
    try {
      expect(rankAccountsByHeadroom("zai-plan", ["test-a", "test-b"], "GLM-5.3-Flash")).toEqual(["test-b", "test-a"]);
      setCachedProviderAccountQuotaForTests("zai-plan", "test-a", quota(0, at - 61_000));
      expect(accountHeadroomPercent("zai-plan", "test-a", "GLM-5.3-Flash")).toBeNull();
      setCachedProviderAccountQuotaForTests("zai-plan", "test-a", quota(0, at, at - 1));
      expect(accountHeadroomPercent("zai-plan", "test-a", "GLM-5.3-Flash")).toBeNull();
    } finally {
      setCachedProviderAccountQuotaForTests("zai-plan", "test-a", null);
      setCachedProviderAccountQuotaForTests("zai-plan", "test-b", null);
    }
  });
});
