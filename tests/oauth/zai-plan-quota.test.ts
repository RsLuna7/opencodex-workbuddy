import { describe, expect, test } from "bun:test";
import { isZaiPlanQuotaFail } from "../../src/adapters/zai-plan";

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
