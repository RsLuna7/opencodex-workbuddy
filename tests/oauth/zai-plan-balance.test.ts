import { describe, expect, test } from "bun:test";
import { createZaiPlanBalanceReader, parseZaiPlanBalance } from "../../src/oauth/zai-plan-balance";
import type { OAuthCredentials } from "../../src/oauth/types";

const now = 1_800_000_000_000;
const plan = { user_plan_id: "plan-private-test", status: "active", starts_at: now / 1000 - 100, ends_at: now / 1000 + 100 };
const bucket = { user_plan_id: plan.user_plan_id, show_name: "GLM-5.3-Flash", total_units: 100, used_units: 20,
  meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3-flash"],
  remaining_units: 80, available_units: 75, expires_at: now / 1000 + 90 };
const payload = (plans: unknown[] = [plan], balances: unknown[] = [bucket]) => ({ code: 0, data: { plans, balances } });
const credential = (access = "fake.jwt.test", deviceMid = "test-mid"): OAuthCredentials => ({
  access, refresh: access, expires: now + 1_000_000, zaiPlan: { deviceMid },
});
const fetcher = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  ((url, init) => handler(String(url), init)) as typeof fetch;

describe("ZCode account entitlement", () => {
  test("uses only matching active plan and unexpired model buckets, and strips billing identifiers", () => {
    const value = parseZaiPlanBalance(payload([plan, { ...plan, user_plan_id: "future", starts_at: now / 1000 + 5 }], [
      bucket, { ...bucket, user_plan_id: "other", show_name: "GLM-5.3" },
      { ...bucket, user_plan_id: "future" }, { ...bucket, expires_at: now / 1000 - 1, show_name: "GLM-5.3" },
    ]), now);
    expect(value.state).toBe("available");
    expect(value.models).toEqual([{ model: "GLM-5.3-Flash", total: 100, used: 20, remaining: 75, expiresAt: now + 90_000 }]);
    expect(JSON.stringify(value)).not.toContain("plan-private-test");
    expect(value.validUntil).toBe(now + 5_000);
  });

  test("combines the same model's live grants but caps freshness at the first expiry", () => {
    const value = parseZaiPlanBalance(payload([plan], [bucket, { ...bucket, total_units: 50, used_units: 10,
      available_units: 40, expires_at: now / 1000 + 5 }]), now);
    expect(value.models[0].remaining).toBe(115); expect(value.models[0].total).toBe(150);
    expect(value.validUntil).toBe(now + 5_000);
  });

  test("available units take precedence over unreserved remaining units", () => {
    expect(parseZaiPlanBalance(payload([plan], [{ ...bucket, available_units: 0 }]), now).state).toBe("exhausted");
  });

  test("pending, expired and missing plans are distinct from a failed probe", () => {
    expect(parseZaiPlanBalance(payload([{ ...plan, starts_at: now / 1000 + 50 }]), now).state).toBe("pending");
    expect(parseZaiPlanBalance(payload([{ ...plan, ends_at: now / 1000 - 1 }]), now).state).toBe("expired");
    expect(parseZaiPlanBalance(payload([], []), now).state).toBe("unavailable");
    expect(parseZaiPlanBalance({ code: 3012 }, now).state).toBe("unknown");
    expect(parseZaiPlanBalance({ code: 0, data: { plans: [] } }, now).state).toBe("unknown");
  });

  test("non-model, malformed and not-yet-active buckets cannot grant model access", () => {
    const value = parseZaiPlanBalance(payload([plan], [
      { ...bucket, show_name: "MCP requests" }, { ...bucket, period_start: now / 1000 + 1 },
      { ...bucket, total_units: -1 }, { ...bucket, used_units: Infinity },
    ]), now);
    expect(value.models).toEqual([]); expect(value.state).toBe("unknown");
  });

  test("a GLM display label cannot turn an MCP or time bucket into model quota", () => {
    const value = parseZaiPlanBalance(payload([plan], [{ ...bucket, meter: "mcp_usage", unit_type: "time" }]), now);
    expect(value.models).toEqual([]); expect(value.state).toBe("unavailable");
  });

  test("reader fixes the destination and account device header, caches only that identity, honors force", async () => {
    let count = 0, clock = now;
    const read = createZaiPlanBalanceReader(fetcher((url, init) => {
      count++; expect(new URL(url).origin).toBe("https://zcode.z.ai");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-device-mid")).toBeTruthy();
      return Response.json(payload());
    }), () => clock);
    const result = await read(credential()); result.models.length = 0;
    expect((await read(credential())).models).toHaveLength(1); expect(count).toBe(1);
    await read(credential("other.jwt.test")); expect(count).toBe(2);
    await read(credential("other.jwt.test", "another-device")); expect(count).toBe(3);
    await read(credential(), { force: true }); expect(count).toBe(4);
    clock += 61_000; await read(credential()); expect(count).toBe(5);
  });

  test("network and authentication failures do not reuse an earlier positive entitlement", async () => {
    let status = 200;
    const read = createZaiPlanBalanceReader(fetcher(() => status === 200 ? Response.json(payload())
      : new Response("must not expose upstream content", { status })), () => now);
    expect((await read(credential())).state).toBe("available");
    status = 401;
    const failed = await read(credential(), { force: true });
    expect(failed.state).toBe("unknown"); expect(failed.failure).toBe("authentication"); expect(failed.models).toEqual([]);
    expect(JSON.stringify(failed)).not.toContain("upstream content");
  });

  test("missing identity and pre-aborted probes never fetch", async () => {
    let calls = 0;
    const read = createZaiPlanBalanceReader(fetcher(() => { calls++; throw Error("must not fetch"); }), () => now);
    expect((await read({ ...credential(), zaiPlan: {} })).failure).toBe("missing-device");
    const controller = new AbortController(); controller.abort();
    await expect(read(credential(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});
