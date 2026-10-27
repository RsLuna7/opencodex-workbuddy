import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { startManagementServerFixture, settleServerAuthFixture, managementHeaders, type ManagementServerFixture } from "../helpers/server-auth-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("Start Plan reactive account rotation rebuilds the serving device and preserves host instructions", async () => {
  const originalHome = process.env.OPENCODEX_HOME, originalCodex = process.env.CODEX_HOME;
  const root = mkdtempSync(join(tmpdir(), "ocx-zcode-proxy-pool-"));
  const codex = join(root, "codex"); process.env.CODEX_HOME = codex;
  let fixture: ManagementServerFixture | undefined;
  const nativeFetch = globalThis.fetch;
  const served: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://zcode.z.ai/")) return nativeFetch(input, init);
    if (url.includes("client/configs")) return Response.json({ data: { configs: { captcha: { enabled: true, skip_model_request: true } } } });
    if (!url.endsWith("/v1/messages")) return Response.json({ code: 0, data: { plans: [], balances: [] } });
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bearer = headers.get("authorization");
    const slot = bearer === "Bearer fake.jwt.a" ? "a" : bearer === "Bearer fake.jwt.b" ? "b" : "unexpected";
    served.push(slot);
    const body = JSON.parse(String(init?.body));
    expect(JSON.parse(body.metadata.user_id).device_id).toBe(`mid-${slot}`);
    expect(body.system.some((block: { text: string }) => block.text.includes("host-policy"))).toBe(true);
    if (slot === "a") return Response.json({ error: { type: "rate_limit_error", message: "test account rate limit" } }, { status: 429, headers: { "retry-after": "60" } });
    return Response.json({ id: "msg-test", type: "message", role: "assistant", model: "GLM-5.3-Flash",
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
  }) as typeof fetch);
  try {
    clearGenericFailoverHealth("zai-plan");
    fixture = await startManagementServerFixture(root, { ...getDefaultConfig(), hostname: "127.0.0.1",
      defaultProvider: "zai-plan", subagentModels: [], codexAutoStart: false, codexShimAutoRestore: false,
      providers: { "zai-plan": { adapter: "zai-plan", authMode: "oauth", baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
        models: ["GLM-5.3-Flash"], liveModels: false, oauthAccountFailover: { enabled: true } } },
    });
    writeFileSync(join(root, "auth.json"), JSON.stringify({ "zai-plan": { activeAccountId: "account-a", accounts: ["a", "b"].map(slot => ({
      id: `account-${slot}`, addedAt: Date.now(), credential: { access: `fake.jwt.${slot}`, refresh: `fake.jwt.${slot}`,
        expires: Date.now() + 3600_000, accountId: `test-${slot}`, zaiPlan: { deviceMid: `mid-${slot}`, sessionId: `session-${slot}` } },
    })) } }), { mode: 0o600 });
    await fixture.run(async () => {
      const response = await nativeFetch(new URL("/v1/responses", fixture!.server.url), { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "zai-plan/GLM-5.3-Flash",
          input: "Reply OK.", instructions: "Keep the host-policy intact.", max_output_tokens: 64 }),
        signal: AbortSignal.any([fixture!.signal, AbortSignal.timeout(30_000)]),
      });
      const body = await response.json();
      expect(response.status).toBe(200); expect(JSON.stringify(body.output)).toContain("OK");
      expect(served).toEqual(["a", "b"]);
      const requestId = response.headers.get("x-opencodex-request-id")!;
      expect(requestId).toBeTruthy();
      const diagnostic = await nativeFetch(new URL(`/api/zai-plan/diagnostic?requestId=${encodeURIComponent(requestId)}`, fixture!.server.url), {
        headers: managementHeaders(), signal: fixture!.signal,
      });
      expect(diagnostic.status).toBe(200);
      expect(await diagnostic.json()).toMatchObject({ verified: true, accountId: "account-b", plan: "start-plan", sends: 2 });
    });
  } finally {
    await fixture?.close(); mock.mockRestore(); clearGenericFailoverHealth("zai-plan");
    await settleServerAuthFixture(root, codex);
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
    if (originalCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodex;
    removeTreeWithRetry(root);
  }
}, 60_000);
