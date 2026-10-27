import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleZaiPlanRoutes } from "../../src/server/management/zai-plan-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { getAccountSet, getCredential } from "../../src/oauth/store";
import { getDefaultConfig } from "../../src/config";
import { createZaiPlanBalanceReader } from "../../src/oauth/zai-plan-balance";
import { fetchZaiPlanUsableModels } from "../../src/adapters/zai-plan-models";
import { fetchZaiPlanQuota } from "../../src/providers/quota/zai-plan";
import { createZaiPlanAdapter } from "../../src/adapters/zai-plan";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const a = { access: "fake.jwt.a", refresh: "fake.jwt.a", expires: Date.now() + 3600_000, accountId: "test-a", zaiPlan: { deviceMid: "mid-a" } };
const b = { ...a, access: "fake.jwt.b", refresh: "fake.jwt.b", accountId: "test-b", zaiPlan: { deviceMid: "mid-b" } };
const context = (path: string, method = "GET", principal: ManagementContext["principal"] = "admin-token", body?: unknown) => {
  const req = new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  return { req, url: new URL(req.url), config: getDefaultConfig(), deps: {}, version: "test", principal } as ManagementContext;
};

describe("ZCode account management", () => {
  const previous = process.env.OPENCODEX_HOME;
  let root: string, idA: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-zcode-management-")); process.env.OPENCODEX_HOME = root;
    idA = "account-a";
    writeFileSync(join(root, "auth.json"), JSON.stringify({ "zai-plan": { activeAccountId: "account-b", accounts: [
      { id: idA, credential: a, addedAt: Date.now() }, { id: "account-b", credential: b, addedAt: Date.now() },
    ] } }), { mode: 0o600 });
  }, 30_000);
  afterAll(() => { process.env.OPENCODEX_HOME = previous; if (previous === undefined) delete process.env.OPENCODEX_HOME; removeTreeWithRetry(root); });

  test("cheap account list does not request balance; explicit refresh returns a safe summary", async () => {
    let calls = 0;
    const read = createZaiPlanBalanceReader((async (_url, init) => {
      calls++; expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${b.access}`);
      expect(new Headers(init?.headers).get("x-device-mid")).toBe("mid-b");
      return Response.json({ code: 0, data: { plans: [], balances: [] } });
    }) as typeof fetch);
    await handleZaiPlanRoutes(context("/api/zai-plan/accounts"), { balance: read }); expect(calls).toBe(0);
    const response = await handleZaiPlanRoutes(context("/api/zai-plan/accounts?balance=1&refresh=1"), { balance: read });
    const body = await response!.json(); expect(body.startPlan.state).toBe("unavailable"); expect(calls).toBe(1);
    expect(JSON.stringify(body)).not.toContain(b.access);
  });

  test("explicit account preview uses that account and device without changing the active slot", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${a.access}`); expect(headers.get("x-device-mid")).toBe("mid-a");
      expect(init?.redirect).toBe("error"); return Response.json({ code: 0, data: { plans: [] } });
    }) as typeof fetch);
    try {
      expect((await handleZaiPlanRoutes(context(`/api/zai-plan/accounts/${idA}/preview`)))!.status).toBe(200);
      expect(getCredential("zai-plan")!.access).toBe(b.access); expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
  });

  test("unknown account paths cannot fall back to the active account", async () => {
    const mock = spyOn(globalThis, "fetch");
    try { expect((await handleZaiPlanRoutes(context("/api/zai-plan/accounts/missing/preview")))!.status).toBe(404); expect(mock).not.toHaveBeenCalled(); }
    finally { mock.mockRestore(); }
  });

  test("an expired Desktop import cannot replace a working account", async () => {
    const expired = `test.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    const before = getCredential("zai-plan")!.access;
    const response = await handleZaiPlanRoutes(context("/api/zai-plan/import", "POST"), { importLocal: () => ({ ...a, access: expired }) });
    expect(response!.status).toBe(401); expect(getCredential("zai-plan")!.access).toBe(before);
    expect(await handleZaiPlanRoutes(context("/api/zai-plan-other"))).toBeNull();
  });

  test("a manual balance refresh does not probe a paused account", async () => {
    const path = join(root, "auth.json"), stored = JSON.parse(readFileSync(path, "utf8"));
    const row = stored["zai-plan"].accounts.find(account => account.id === stored["zai-plan"].activeAccountId);
    row.paused = true; writeFileSync(path, JSON.stringify(stored));
    let probes = 0;
    try {
      const response = await handleZaiPlanRoutes(context("/api/zai-plan/accounts?balance=1&refresh=1"), {
        balance: async () => { probes++; throw Error("must not probe"); },
      });
      expect((await response!.json()).startPlan.failure).toBe("account-unavailable"); expect(probes).toBe(0);
    } finally { row.paused = false; writeFileSync(path, JSON.stringify(stored)); }
  });

  test("discovery and quota projections preserve exact model entitlement", async () => {
    const read = createZaiPlanBalanceReader((async () => Response.json({ code: 0, data: {
      plans: [{ user_plan_id: "test-plan", status: "active" }], balances: [
        { user_plan_id: "test-plan", meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3-flash"], total_units: 100, used_units: 100, available_units: 0 },
        { user_plan_id: "test-plan", meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3"], total_units: 100, used_units: 10, available_units: 90 },
      ],
    } })) as typeof fetch);
    expect(await fetchZaiPlanUsableModels(b.access, read)).toEqual({ ok: true, models: ["GLM-5.3"] });
    expect(await fetchZaiPlanUsableModels("unknown.jwt.test", read)).toEqual({ ok: false, models: [] });
    const quota = await fetchZaiPlanQuota("zai-plan", b, read);
    expect(quota && typeof quota !== "symbol" && quota.quota.customWindows?.map(row => row.modelId)).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
  });

  test("explicit coding keys and Start JWTs bind their own account without changing plans", async () => {
    const path = join(root, "auth.json"), original = readFileSync(path, "utf8"), stored = JSON.parse(original);
    const key = "test-account-key.test-secret-value";
    stored["zai-plan"].accounts.find(account => account.id === idA).credential.zaiPlan.codingKey = key;
    writeFileSync(path, JSON.stringify(stored));
    try {
      const parsed = { modelId: "GLM-5.3-Flash", stream: false, options: {}, context: { messages: [{ role: "user" as const, content: "OK", timestamp: 0 }] } };
      const coding = await withTestTranslatorBudget(createZaiPlanAdapter({ baseUrl: "https://zcode.z.ai", authMode: "key", apiKey: key })).buildRequest(parsed);
      expect(coding.url).toContain("/ultra-zai/"); expect(coding.headers["X-Device-Mid"]).toBe("mid-a");
      expect(coding.headers["x-api-key"]).toBe(key);
      expect(Object.keys(coding.headers).some(name => name.toLowerCase() === "authorization")).toBe(false);
      const start = await withTestTranslatorBudget(createZaiPlanAdapter({ baseUrl: "https://zcode.z.ai", authMode: "oauth", apiKey: b.access })).buildRequest(parsed);
      expect(start.url).toContain("/zcode-plan/");
      expect(JSON.parse(JSON.parse(start.body).metadata.user_id).device_id).toBe("mid-b");
    } finally { writeFileSync(path, original); }
  });

  test("identity and claim actions require the real dashboard principal", async () => {
    const mock = spyOn(globalThis, "fetch");
    try {
      for (const path of ["claim", "telemetry", "fingerprint/rotate"]) {
        expect((await handleZaiPlanRoutes(context(`/api/zai-plan/accounts/me/${path}`, "POST", "admin-token", { plan_id: "test-plan" })))!.status).toBe(403);
      }
      expect(mock).not.toHaveBeenCalled();
    } finally { mock.mockRestore(); }
  });

  test("rotating an inactive account's device leaves the active account unchanged", async () => {
    expect((await handleZaiPlanRoutes(context(`/api/zai-plan/accounts/${idA}/fingerprint/rotate`, "POST", "gui-session")))!.status).toBe(200);
    expect(getCredential("zai-plan")!.access).toBe(b.access);
    expect(getAccountSet("zai-plan")!.accounts.find(row => row.id === idA)!.credential.zaiPlan!.deviceMid).not.toBe("mid-a");
  });

  test("first import is awaited and works before an account exists", async () => {
    const first = mkdtempSync(join(tmpdir(), "ocx-zcode-first-import-")); process.env.OPENCODEX_HOME = first;
    try {
      const response = await handleZaiPlanRoutes(context("/api/zai-plan/import", "POST"), { importLocal: () => a });
      expect(response!.status).toBe(200); expect(getCredential("zai-plan")!.access).toBe(a.access);
    } finally { process.env.OPENCODEX_HOME = root; removeTreeWithRetry(first); }
  }, 30_000);
});
