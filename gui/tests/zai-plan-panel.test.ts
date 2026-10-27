import { expect, test } from "bun:test";
import { diagnose, sessionHeaders } from "../public/zai-plan.js";
import { zaiPlanCopy } from "../src/i18n/zai-plan-copy";
import { DICTS } from "../src/i18n/catalogs";

test("panel copy is present in every dashboard locale", () => {
  expect(Object.keys(zaiPlanCopy).sort()).toEqual(Object.keys(DICTS).sort());
  for (const locale of Object.keys(DICTS)) {
    for (const key of Object.keys(zaiPlanCopy.en)) expect(DICTS[locale][key]).toBe(zaiPlanCopy[locale][key]);
  }
});

test("manual panel uses the existing GUI session and CSRF only on writes", () => {
  const session = { token: "ocx_session_test", csrf: "csrf-test", origin: "http://localhost:10100" };
  expect(sessionHeaders(session, "POST")["X-OpenCodex-CSRF-Token"]).toBe("csrf-test");
  expect(sessionHeaders(session)["X-OpenCodex-CSRF-Token"]).toBeUndefined();
  expect(() => sessionHeaders({ ...session, token: "admin-token" })).toThrow();
});

test("diagnostic is a single normal data-plane request with trace-confirmed attribution", async () => {
  let sends = 0;
  const api = async path => {
    if (path.includes("diagnostic")) {
      expect(path).toContain("observationId=observation-test");
      return { verified: true, plan: "start-plan", model: "GLM-5.3-Flash", accountId: "a", observedTokenDecrease: 30,
        startPlan: { models: [{ model: "GLM-5.3-Flash", remaining: 70 }] } };
    }
    return { activeAccountId: "a", observationId: "observation-test", startPlan: { state: "available", models: [{ model: "GLM-5.3-Flash", remaining: 100 }] } };
  };
  const result = await diagnose({ api, model: "GLM-5.3-Flash", dataFetch: async (path, init) => {
    sends++; expect(path).toBe("/v1/responses");
    expect(JSON.parse(init.body).max_output_tokens).toBe(64);
    expect(new Headers(init.headers).get("x-opencodex-api-key")).toBeNull();
    return Response.json({ output: [{ content: [{ type: "output_text", text: "OK" }] }] }, { headers: { "x-opencodex-request-id": "ocx-test" } });
  } });
  expect(sends).toBe(1); expect(result.ok).toBe(true); expect(result.observedTokenDecrease).toBe(30);
});

test("unknown entitlement sends nothing, and an unverified route cannot claim Start Plan success", async () => {
  let sends = 0;
  await expect(diagnose({ model: "GLM-5.3-Flash", api: async () => ({ startPlan: { state: "unknown" } }), dataFetch: async () => { sends++; } })).rejects.toThrow();
  expect(sends).toBe(0);
  const result = await diagnose({ model: "GLM-5.3-Flash", api: async path => path.includes("diagnostic") ? { verified: false }
    : { activeAccountId: "a", startPlan: { state: "available", models: [{ model: "GLM-5.3-Flash", remaining: 100 }] } },
    dataFetch: async () => Response.json({ output: [{ content: [{ type: "output_text", text: "OK" }] }] }, { headers: { "x-opencodex-request-id": "ocx-test" } }),
  });
  expect(result.ok).toBe(false); expect(result.observedTokenDecrease).toBeNull();
});
