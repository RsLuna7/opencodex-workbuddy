import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../../src/web-search/loop";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function runWithWebSearch(
  deps: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("web-search loop 402 credential failover", () => {
  test("loop 402 awaits on429 rotation and succeeds with the rebuilt adapter", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    const quotaBody = JSON.stringify({ error: { code: 6004, message: "frequency" } });
    const firstAdapter: ProviderAdapter = {
      name: "mock-402",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response(quotaBody, { status: 402 }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "text_delta", text: "should not reach" }, { type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("{}", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "answer from next account" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };
    let rotations = 0;
    let seenRefusal: Response | undefined;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      on429: async (_retryAfter, _headers, retryParsed, refusal) => {
        rotations++;
        seenRefusal = refusal;
        if (!retryParsed) throw new Error("the loop must pass the iteration request to on429");
        return rotatedAdapter;
      },
    });
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as { type: string; content?: { text?: string }[] }[];
    expect(output.find(o => o.type === "message")?.content?.[0]?.text).toBe("answer from next account");
    expect(rotations).toBe(1);
    expect(seenRefusal?.status).toBe(402);
  });

  test("loop 402 with a null hook surfaces the provider 402", async () => {
    const firstAdapter: ProviderAdapter = {
      name: "mock-402",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("payment required", { status: 402 }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      on429: () => null,
    });
    expect(response.status).toBe(402);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("402");
  });
});
