import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { ImageBridgePlan } from "../../src/images/types";
import { runWithImageBridge as runWithImageBridgeProduction, type ImageBridgeDeps } from "../../src/images/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function runWithImageBridge(
  deps: Omit<ImageBridgeDeps, "incomingMeta"> & { incomingMeta?: ImageBridgeDeps["incomingMeta"] },
): Promise<Response> {
  return runWithImageBridgeProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

const plan = {
  provider: {} as never,
  auth: { baseUrl: "https://api.x.ai", token: "test-token" },
  model: "grok-imagine-image-quality",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function makeParsed(): OcxParsedRequest {
  return { modelId: "test-model", context: { messages: [], tools: [] }, stream: true, options: {} } as OcxParsedRequest;
}

describe("image-bridge loop 402 credential failover", () => {
  test("402 OAuth rotation awaits a refreshed adapter and retries the iteration", async () => {
    let fetchCalls = 0;
    let rotations = 0;
    let seenRefusal: Response | undefined;
    const makeRotatingAdapter = (label: string): ProviderAdapter => ({
      name: label,
      buildRequest: async () => ({ url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response("quota", { status: 402 });
        return new Response("{}", { status: 200 });
      },
      parseStream: async function* (): AsyncGenerator<AdapterEvent> {
        if (label === "after-rotate") {
          yield { type: "text_delta", text: "after rotate" };
          yield { type: "done" };
        }
      },
    });
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: makeRotatingAdapter("before-rotate"),
      plan,
      on429: async (_retryAfter, _headers, retryParsed, refusal) => {
        rotations++;
        seenRefusal = refusal;
        if (!retryParsed) throw new Error("the loop must pass the iteration request to on429");
        return makeRotatingAdapter("after-rotate");
      },
    });
    const sse = await response.text();
    expect(rotations).toBe(1);
    expect(fetchCalls).toBe(2);
    expect(seenRefusal?.status).toBe(402);
    expect(sse).toContain("after rotate");
  });

  test("402 with a null hook surfaces the provider 402", async () => {
    const adapter: ProviderAdapter = {
      name: "mock-402",
      buildRequest: async () => ({ url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("payment required", { status: 402 }),
      parseStream: async function* (): AsyncGenerator<AdapterEvent> { /* unused */ },
    };
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter,
      plan,
      on429: () => null,
    });
    expect(response.status).toBe(402);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("402");
  });
});
