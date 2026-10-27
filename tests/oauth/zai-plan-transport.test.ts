import { describe, expect, spyOn, test } from "bun:test";
import { createZaiPlanTransport, isZaiPlanCaptchaChallenge } from "../../src/adapters/zai-plan-transport";
import { createZaiPlanAdapter } from "../../src/adapters/zai-plan";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxParsedRequest } from "../../src/types";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createZaiPlanPolicy } from "../../src/oauth/zai-plan-policy";
import { assertZaiPlanJwtActive, zaiPlanJwtExpiry, refreshZaiPlanToken, loginZaiPlan } from "../../src/oauth/zai-plan";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { buildDshClientConfig } from "../../src/clients/config-export/dsh";

const request = { url: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", method: "POST",
  headers: { authorization: "Bearer fake.jwt.test" }, body: '{"model":"GLM-5.3-Flash","stream":true}' };
function fakeFetch(run: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((input, init) => run(String(input), init)) as typeof fetch;
}
const config = (skip = true) => Response.json({ data: { configs: { captcha: { enabled: true, skip_model_request: skip } } } });

describe("ZCode Start Plan transport", () => {
  test("saved providers gain Flash image capability while GLM-5.3 uses the vision sidecar", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("zai-plan")!) };
    delete provider.modelInputModalities;
    delete provider.noVisionModels;
    enrichProviderFromRegistry("zai-plan", provider);
    for (const id of ["GLM-5.3-Flash", "glm-5.3-flash", "GLM-5.3"]) {
      const row = applyProviderConfigHints("zai-plan", provider, { provider: "zai-plan", id });
      expect(row.inputModalities).toEqual(["text", "image"]);
      expect(isModelVisionSidecarConsumer(provider, id)).toBe(id === "GLM-5.3");
      const dsh = buildDshClientConfig({ baseUrl: "http://127.0.0.1:10100/v1",
        models: [{ ...row, namespaced: `zai-plan/${id}` }] });
      expect(dsh["llm-pi-ai"].providers.opencodex.models[0].input).toEqual(["text", "image"]);
    }
    expect(provider.modelInputModalities?.["GLM-5.3"]).toEqual(["text"]);
  });

  test("policy refresh follows explicit skip/disable changes and bounds a cached challenge", async () => {
    let clock = 1000, calls = 0, skip = false, enabled = true;
    const policy = createZaiPlanPolicy(fakeFetch(() => { calls++; return Response.json({ data: { configs: { captcha: {
      enabled, skip_model_request: skip,
    } } } }); }), () => clock);
    expect(await policy.required()).toBe(true); expect(calls).toBe(1);
    skip = true; expect(await policy.required()).toBe(true); expect(calls).toBe(1);
    clock += 60_001; expect(await policy.required()).toBe(false); expect(calls).toBe(2);
    policy.challenge(); expect(await policy.required()).toBe(true); expect(calls).toBe(2);
    clock += 60_001; enabled = false; skip = false;
    expect(await policy.required()).toBe(false); expect(calls).toBe(3);
  });
  test("explicit login bypasses local-only import and completes the browser poll", async () => {
    let polls = 0, authorized = false;
    const mock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch(url => {
      if (url.endsWith("/cli/init")) return Response.json({ data: { flow_id: "test-flow", authorize_url: "https://example.invalid/test-auth" } });
      polls++; return Response.json({ data: { token: "fake.jwt.test" } });
    }));
    try {
      const login = await loginZaiPlan({ onAuth: () => { authorized = true; } }, { forceLogin: true, importLocal: "only" });
      expect(login.access).toBe("fake.jwt.test"); expect(polls).toBe(1); expect(authorized).toBe(true);
    } finally { mock.mockRestore(); }
  });

  test("manual login completion cancels the losing browser poll", async () => {
    let signal: AbortSignal | null | undefined;
    const mock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch((_url, init) => {
      signal = init?.signal;
      return Response.json({ data: { flow_id: "test-flow", authorize_url: "https://example.invalid/test-auth" } });
    }));
    try {
      const result = await loginZaiPlan({ onManualCodeInput: async () => "fake.jwt.test" }, { forceLogin: true });
      expect(result.access).toBe("fake.jwt.test"); expect(signal?.aborted).toBe(true);
    } finally { mock.mockRestore(); }
  });
  test("expired JWTs require login; missing expiry remains compatible", () => {
    const jwt = (exp: unknown) => `fake.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
    expect(zaiPlanJwtExpiry(jwt(10))).toBe(10_000);
    expect(() => assertZaiPlanJwtActive(jwt(10), 10_000)).toThrow("login expired");
    expect(() => assertZaiPlanJwtActive(jwt(11), 10_000)).not.toThrow();
    expect(zaiPlanJwtExpiry(jwt("invalid"))).toBeUndefined();
    expect(() => assertZaiPlanJwtActive(jwt(0), 10_000)).toThrow("login expired");
    expect(() => assertZaiPlanJwtActive("fake.jwt.test", 10_000)).not.toThrow();
  });

  test("without a matching Desktop login, refresh does not invent a new token lifetime or device", async () => {
    const credential = { access: "fake.jwt.test", refresh: "fake.jwt.test", expires: 100,
      zaiPlan: { deviceMid: "test-device", sessionId: "test-session" } };
    expect(await refreshZaiPlanToken(credential.refresh, undefined, credential)).toEqual(credential);
  });
  test("skipped CAPTCHA streams immediately without importing a browser, also with another stream in flight", async () => {
    let requests = 0;
    const transport = createZaiPlanTransport({
      fetch: fakeFetch(url => url.includes("client/configs") ? config() : (++requests, new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
      }), { headers: { "content-type": "text/event-stream" } }))),
      captcha: async () => { throw new Error("browser must not load"); },
    });
    const first = await transport(request);
    const second = await transport(request);
    expect(requests).toBe(2);
    const reader = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await reader.cancel(); await second.body!.cancel();
  });

  test("explicit challenge recovers once through CAPTCHA with send accounting and cancellation signal", async () => {
    const ordinals: number[] = [];
    let solved = 0;
    let browserCalls = 0;
    const transport = createZaiPlanTransport({
      fetch: fakeFetch(url => url.includes("client/configs") ? config() : Response.json({ code: 3007 }, { status: 400 })),
      captcha: async () => ({
        getZaiPlanVerifyParam: async () => { solved++; return "verified-test"; },
        invalidateZaiPlanCaptcha() {}, ZAI_CAPTCHA_HEADER: "X-Aliyun-Captcha-Verify-Param",
        ZAI_CAPTCHA_REGION_HEADER: "X-Aliyun-Captcha-Verify-Region", ZAI_CAPTCHA_REGION: "cn",
        zaiPlanBrowserFetch: async input => {
          browserCalls++;
          expect(input.headers.authorization).toBe(request.headers.authorization);
          expect(input.headers["X-Aliyun-Captcha-Verify-Param"]).toBe("verified-test");
          expect(input.signal).toBeDefined();
          return { status: 200, headers: {}, body: new Response("OK").body! };
        },
      }),
    });
    expect(await (await transport(request, { onPhysicalSend: send => ordinals.push(send.ordinal) })).text()).toBe("OK");
    expect(ordinals).toEqual([1, 2]); expect(solved).toBe(1); expect(browserCalls).toBe(1);
  });

  test.each([3012, 402, 429, 500])("does not replay non-CAPTCHA refusal %i or silently change plan", async code => {
    let sends = 0;
    const transport = createZaiPlanTransport({ fetch: fakeFetch(url => {
      if (url.includes("client/configs")) return config();
      sends++; return Response.json({ code }, { status: code === 3012 ? 405 : code });
    }), captcha: async () => { throw new Error("unexpected browser"); } });
    const result = await transport(request);
    expect(result.status).toBe(code === 3012 ? 405 : code); expect(sends).toBe(1);
  });

  test("unknown public policy attempts HTTP; config request contains no account headers", async () => {
    const transport = createZaiPlanTransport({ fetch: fakeFetch((url, init) => {
      if (url.includes("client/configs")) { expect(init?.headers).toBeUndefined(); throw new Error("offline config"); }
      expect(init?.redirect).toBe("error"); return new Response("OK");
    }) });
    expect(await (await transport(request)).text()).toBe("OK");
  });

  test("exhausted inference budget refuses CAPTCHA replay before solving or browser launch", async () => {
    let browserLoads = 0;
    const transport = createZaiPlanTransport({
      fetch: fakeFetch(url => url.includes("client/configs") ? config() : Response.json({ code: 3007 }, { status: 400 })),
      captcha: async () => { browserLoads++; throw new Error("must not load"); },
    });
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    await expect(transport(request, { sendBudget: budget })).rejects.toThrow();
    expect(browserLoads).toBe(0); expect(budget.used).toBe(1);
  });

  test("pre-aborted caller never fetches config or inference", async () => {
    const controller = new AbortController(); controller.abort();
    const transport = createZaiPlanTransport({ fetch: fakeFetch(() => { throw new Error("must not fetch"); }) });
    await expect(transport(request, { abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("account changes during policy lookup refuse before physical inference", async () => {
    let eligible = true, sends = 0;
    const transport = createZaiPlanTransport({ fetch: fakeFetch(url => {
      if (url.includes("client/configs")) { eligible = false; return config(); }
      sends++; return new Response("must not send");
    }) });
    const response = await transport(request, {}, () => eligible ? null : new Response(null, { status: 401 }));
    expect(response.status).toBe(401); expect(sends).toBe(0);
  });

  test("caller cancellation remains attached after response headers", async () => {
    const controller = new AbortController();
    const transport = createZaiPlanTransport({ fetch: fakeFetch((url, init) => url.includes("client/configs") ? config() :
      new Response(new ReadableStream({ start(stream) {
        init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason), { once: true });
      } }))) });
    const response = await transport(request, { abortSignal: controller.signal });
    const reading = response.body!.getReader().read();
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  test("header deadline does not cut off a successful long response body", async () => {
    let signal: AbortSignal | null | undefined;
    const transport = createZaiPlanTransport({ fetch: fakeFetch((url, init) => {
      if (url.includes("client/configs")) return config();
      signal = init?.signal; return new Response("OK");
    }) });
    const response = await transport(request, { timeoutMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(false); expect(await response.text()).toBe("OK");
  });

  test("2xx model output mentioning CAPTCHA is never a challenge", async () => {
    expect(await isZaiPlanCaptchaChallenge(new Response('{"code":3007}'))).toBe(false);
    expect(await isZaiPlanCaptchaChallenge(Response.json({ code: 3012 }, { status: 405 }))).toBe(false);
  });

  test("a CAPTCHA header cannot override a rate, auth or risk refusal", async () => {
    for (const status of [401, 405, 429, 500]) {
      expect(await isZaiPlanCaptchaChallenge(Response.json({ code: 3012 }, { status,
        headers: { "x-aliyun-captcha-verify-param": "required" } }))).toBe(false);
    }
    expect(await isZaiPlanCaptchaChallenge(Response.json({ code: 3012 }, { status: 403,
      headers: { "x-aliyun-captcha-verify-param": "required" } }))).toBe(false);
    expect(await isZaiPlanCaptchaChallenge(new Response("", { status: 403,
      headers: { "x-aliyun-captcha-verify-param": "" } }))).toBe(false);
  });

  test("real adapter preserves client instructions, tools and requested model under official prefix", async () => {
    const adapter = withTestTranslatorBudget(createZaiPlanAdapter({ baseUrl: "https://zcode.z.ai", apiKey: "fake.jwt.test", authMode: "key" }));
    const parsed: OcxParsedRequest = { modelId: "glm-5.3-flash", stream: true, options: {}, context: {
      systemPrompt: ["Respect the host tool permissions and answer in Chinese."],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [{ role: "user", content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", imageUrl: "https://example.invalid/test-image.png" },
      ], timestamp: 0 }],
    } };
    const built = await adapter.buildRequest(parsed);
    const body = JSON.parse(built.body);
    expect(body.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(body.system.at(-1).text).toContain("Respect the host tool permissions");
    expect(body.model).toBe("GLM-5.3-Flash");
    expect(body.tools[0].name).toBe("read_file");
    expect(body.messages.at(-1).content).toContainEqual(expect.objectContaining({
      type: "image", source: { type: "url", url: "https://example.invalid/test-image.png" },
    }));
    expect(body.system[1].text).toContain("# ZCode Desktop Context");
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system.map((block: { text: string }) => block.text).join("\n")).not.toContain("Primary working directory: unknown");
    expect(built.url).toBe(request.url);
  });
});
