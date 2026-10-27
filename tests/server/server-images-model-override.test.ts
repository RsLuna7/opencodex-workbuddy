import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const priorHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const token = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
let home: string;
let isolatedCodexHome: IsolatedCodexHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-image-model-"));
  process.env.OPENCODEX_HOME = home;
  isolatedCodexHome = installIsolatedCodexHome("ocx-image-model-codex-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  isolatedCodexHome.restore();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

function config(model: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    images: { model },
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex///",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function request(url: URL, endpoint: "generations" | "edits"): Promise<Response> {
  return fetch(new URL(`/v1/images/${endpoint}`, url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify(endpoint === "edits"
      ? { prompt: "make it blue", model: "gpt-image-2", images: [{ image_url: "data:image/png;base64,aGk=" }] }
      : { prompt: "a cat", model: "gpt-image-2", size: "auto" }),
  });
}

function stubForward(captured: Array<{ path: string; body: Record<string, unknown> }>) {
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({ path: new URL(req.url).pathname, body: await req.json() as Record<string, unknown> });
      return Response.json({ created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] });
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com") return originalFetch(input, init);
    const path = url.pathname.slice("/backend-api/codex".length);
    return originalFetch(new URL(path, upstream.url), init);
  }) as typeof fetch;
  return upstream;
}

test("images.model rewrites the ChatGPT forward generation and edit bodies", async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = stubForward(captured);
  saveConfig(config("gpt-image-2.5-flare"));
  const server = startServer(0);
  try {
    expect((await request(server.url, "generations")).status).toBe(200);
    expect((await request(server.url, "edits")).status).toBe(200);
    expect(captured.map(row => row.path)).toEqual(["/images/generations", "/images/edits"]);
    expect(captured.map(row => row.body.model)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-flare"]);
    expect(captured[0]?.body.size).toBe("auto");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("blank images.model preserves Codex's requested model", async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = stubForward(captured);
  saveConfig(config("   "));
  const server = startServer(0);
  try {
    expect((await request(server.url, "generations")).status).toBe(200);
    expect(captured[0]?.body.model).toBe("gpt-image-2");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("images.model does not replace the xAI Imagine bridge model", async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(value);
    if (url.hostname !== "api.x.ai") return originalFetch(input, init);
    captured.push({ path: url.pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ data: [{ b64_json: tinyPng }] });
  }) as typeof fetch;
  saveConfig({
    ...config("gpt-image-2.5-flare"),
    images: { bridgeEnabled: true, model: "gpt-image-2.5-flare" },
    providers: {
      ...config("gpt-image-2.5-flare").providers,
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-test-token" },
    },
  });
  const server = startServer(0);
  try {
    expect((await request(server.url, "generations")).status).toBe(200);
    expect(JSON.stringify(captured[0]?.body)).toContain("grok-imagine-image-quality");
    expect(JSON.stringify(captured[0]?.body)).not.toContain("gpt-image-2.5-flare");
  } finally {
    await server.stop(true);
  }
});
