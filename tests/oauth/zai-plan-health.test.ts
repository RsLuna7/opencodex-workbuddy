import { describe, expect, test } from "bun:test";
import { createZaiPlanHealth, type ZaiPlanRequestAccount } from "../../src/oauth/zai-plan-health";
import type { OAuthCredentials } from "../../src/oauth/types";

function fixture() {
  let clock = 1000;
  const credential: OAuthCredentials = { access: "fake.jwt.test", refresh: "fake.jwt.test", expires: 100_000,
    zaiPlan: { deviceMid: "test-device" } };
  const rows = new Map(["a", "b"].map(id => [id, { credential: structuredClone(credential), paused: false }]));
  const until = new Map<string, number>(), reauth: string[] = [];
  const health = createZaiPlanHealth({ now: () => clock, account: id => rows.get(id) ?? null,
    cool: (id, ms) => { until.set(id, clock + ms); }, remaining: id => Math.max(0, Math.ceil(((until.get(id) ?? 0) - clock) / 1000)) || null,
    reauthenticate: async account => { reauth.push(account.id); },
  });
  const account = (id = "a", model = "GLM-5.3-Flash"): ZaiPlanRequestAccount => ({ id, model,
    credential: structuredClone(rows.get(id)!.credential), writerGeneration: 0 });
  return { health, rows, until, reauth, account, advance: (ms: number) => { clock += ms; } };
}

describe("ZCode Start Plan account health", () => {
  test("risk refusal cools only the served account and recovers after the interval", async () => {
    const f = fixture();
    await f.health.observe(f.account(), Response.json({ code: 3012 }, { status: 405 }));
    expect(f.health.before(f.account())?.status).toBe(429);
    expect(f.health.before(f.account())?.headers.get("retry-after")).toBe("900");
    expect(f.health.before(f.account("b"))).toBeNull(); expect(f.reauth).toEqual([]);
    f.advance(900_001); expect(f.health.before(f.account())).toBeNull();
  });

  test("a canonical POST refused as method-not-allowed cannot trigger a hot retry loop", async () => {
    const f = fixture();
    await f.health.observe(f.account(), new Response("Method not allowed", { status: 405 }));
    expect(f.health.before(f.account())?.status).toBe(429);
    expect(f.health.before(f.account("b"))).toBeNull();
  });

  test("429 uses Retry-After while model exhaustion does not hold other models", async () => {
    const f = fixture();
    await f.health.observe(f.account(), new Response(null, { status: 429, headers: { "retry-after": "12" } }));
    expect(f.health.before(f.account())?.headers.get("retry-after")).toBe("12");
    f.advance(12_001);
    await f.health.observe(f.account(), new Response(null, { status: 402 }));
    expect(f.health.before(f.account())?.status).toBe(402);
    expect(f.health.before(f.account("a", "GLM-5.3"))).toBeNull();
    expect(f.health.before(f.account("b"))).toBeNull();
  });

  test("auth refusals request re-login but CAPTCHA and risk refusals do not", async () => {
    const f = fixture();
    await f.health.observe(f.account(), Response.json({ code: 3007 }, { status: 403 }));
    expect(f.health.before(f.account())).toBeNull(); expect(f.reauth).toEqual([]);
    await f.health.observe(f.account(), new Response(null, { status: 401 }));
    expect(f.reauth).toEqual(["a"]); expect(f.health.before(f.account("b"))).toBeNull();
  });

  test("late refusals cannot mark a replacement credential or rotated device", async () => {
    const f = fixture(), original = f.account();
    f.rows.get("a")!.credential.access = "replacement.jwt.test";
    await f.health.observe(original, new Response(null, { status: 401 }));
    expect(f.reauth).toEqual([]); expect(f.until.size).toBe(0);
    expect(f.health.before(original)?.status).toBe(401);
    const second = f.account();
    f.rows.get("a")!.credential.zaiPlan!.deviceMid = "replacement-device";
    await f.health.observe(second, Response.json({ code: 3012 }, { status: 405 }));
    expect(f.until.size).toBe(0);
  });

  test("pausing or removing a bound account prevents sending", () => {
    const f = fixture(), account = f.account();
    f.rows.get("a")!.paused = true;
    expect(f.health.before(account)?.status).toBe(401);
    f.rows.delete("a"); expect(f.health.before(account)?.status).toBe(401);
  });

  test("success clears transient server strikes; repeated server refusals cool the account", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) await f.health.observe(f.account(), new Response(null, { status: 503 }));
    expect(f.health.before(f.account())).toBeNull();
    await f.health.observe(f.account(), new Response("OK"));
    await f.health.observe(f.account(), new Response(null, { status: 503 }));
    expect(f.health.before(f.account())).toBeNull();
    for (let i = 0; i < 2; i++) await f.health.observe(f.account(), new Response(null, { status: 503 }));
    expect(f.health.before(f.account())?.status).toBe(429);
  });

  test("a successful response body is never consumed by health inspection", async () => {
    const f = fixture();
    const response = new Response(new ReadableStream({ start(controller) { controller.error(Error("stream interrupted")); } }));
    await f.health.observe(f.account(), response);
    expect(f.health.before(f.account())).toBeNull(); expect(response.bodyUsed).toBe(false);
  });
});
