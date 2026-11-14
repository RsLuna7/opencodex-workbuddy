import { afterEach, describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_CLI_REQUEST_UA,
  ANTIGRAVITY_REQUEST_UA,
  antigravityFingerprintDecision,
  antigravityLearnedClientFamily,
  antigravityUserAgentForWireModel,
  clearAntigravityLearnedClientFamilies,
} from "../../../src/adapters/google-antigravity-wire";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * Cloud Code Assist gates a model by CLIENT FAMILY as well as by version, and the gate is
 * Google's: `gemini-4-argon` shipped after the `gemini-3.7-*` gate was pinned, and
 * `gemini-4-hydrogen` shipped after Argon was pinned to a literal id list. Both times a model the
 * account could legitimately call answered
 * `404 NOT_FOUND "Requested entity was not found."` under the guessed family.
 *
 * Verified against live CCA on 2026-11-14 with a real OAuth token:
 *   gemini-4-hydrogen-{low,medium,high,xhigh} : ide 404 / cli 200
 *   gemini-4-argon-{low,medium,high}          : ide 404 / cli 200
 *   gemini-4-carbon-disabled                  : ide 404 / cli 404  (plan-gated, not a fingerprint)
 *   gemini-3.8-flash-*, claude-*-5-5-*, gpt-oss-120b-medium : both 200
 * IDE versions 2.5.5 / 2.6.0 / 2.7.0 / 2.9.9 / 3.0.0 all behaved identically, so raising the
 * pinned IDE version is NOT a fix and a future `gemini-5-*` must not be assumed to need one.
 */

const BASE = "https://family-learning.example.test";

afterEach(() => clearAntigravityLearnedClientFamilies());

describe("static client-family guess", () => {
  test("every gemini-4 tier id takes the CLI family, including the fourth rung", () => {
    for (const wire of [
      "gemini-4-argon-low",
      "gemini-4-argon-medium",
      "gemini-4-argon-high",
      "gemini-4-hydrogen-low",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-xhigh",
    ]) {
      expect(antigravityUserAgentForWireModel(wire, BASE)).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
    }
  });

  test("models CCA serves to both families keep the IDE fingerprint", () => {
    for (const wire of [
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-medium",
      "gpt-oss-120b-medium",
      "gemini-3.1-flash-image",
    ]) {
      expect(antigravityUserAgentForWireModel(wire, BASE)).toBe(ANTIGRAVITY_REQUEST_UA);
    }
  });

  test("a plan-gated id is not routed to the CLI family", () => {
    // Both families 404, so a family switch is not its remedy; only `disabled: true` parsing is.
    expect(antigravityUserAgentForWireModel("gemini-4-carbon-disabled", BASE)).toBe(ANTIGRAVITY_REQUEST_UA);
  });
});

describe("learned client family", () => {
  test("a 404 flips the family and asks for exactly one replay", () => {
    const decision = antigravityFingerprintDecision(BASE, "gemini-5-future-medium", 404);
    // An unknown generation starts on IDE, so the first 404 must offer the CLI fingerprint.
    expect(decision.retryUserAgent).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
    expect(antigravityLearnedClientFamily(BASE, "gemini-5-future-medium")).toBe("cli");
    // The next request takes the learned family without spending a round trip.
    expect(antigravityUserAgentForWireModel("gemini-5-future-medium", BASE)).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
  });

  test("a successful status confirms the family and does not replay", () => {
    const decision = antigravityFingerprintDecision(BASE, "gemini-4-hydrogen-high", 200);
    expect(decision.retryUserAgent).toBeUndefined();
    expect(antigravityLearnedClientFamily(BASE, "gemini-4-hydrogen-high")).toBe("cli");
  });

  test("every non-404 status is treated as a fingerprint confirmation", () => {
    // A 400/429/500 for this model is about the request, not the client, so a family replay would
    // be a wasted send and would hide the real failure behind a different error.
    for (const status of [200, 400, 401, 403, 429, 500, 503]) {
      clearAntigravityLearnedClientFamilies();
      expect(antigravityFingerprintDecision(BASE, "gemini-4-hydrogen-low", status).retryUserAgent).toBeUndefined();
      expect(antigravityLearnedClientFamily(BASE, "gemini-4-hydrogen-low")).toBe("cli");
    }
  });

  test("the learned family is scoped per base URL", () => {
    antigravityFingerprintDecision(BASE, "gemini-4-hydrogen-low", 404);
    expect(antigravityLearnedClientFamily(BASE, "gemini-4-hydrogen-low")).toBe("ide");
    expect(antigravityLearnedClientFamily("https://other.example.test", "gemini-4-hydrogen-low")).toBeUndefined();
  });

  test("a 404 on a known model is not double-flipped into a loop", () => {
    // First 404: cli -> ide, with a replay offered.
    expect(antigravityFingerprintDecision(BASE, "gemini-4-hydrogen-low", 404).retryUserAgent)
      .toBe(ANTIGRAVITY_REQUEST_UA);
    // The replay succeeded, so the IDE answer is now the learned one and stays put.
    expect(antigravityFingerprintDecision(BASE, "gemini-4-hydrogen-low", 200).retryUserAgent).toBeUndefined();
    expect(antigravityLearnedClientFamily(BASE, "gemini-4-hydrogen-low")).toBe("ide");
  });
});

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

function parsed(modelId: string, effort?: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: effort ? { reasoning: effort } : {},
  } as unknown as OcxParsedRequest;
}

describe("the built CCA request", () => {
  test("carries the CLI fingerprint and names its wire model for the transport", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-hydrogen", "high"));
    expect(JSON.parse(req.body).model).toBe("gemini-4-hydrogen-high");
    expect(req.headers["User-Agent"]).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
    // The transport reads this to interpret a 404; `parsed.modelId` is the picker id and would
    // name the un-suffixed base model.
    expect(req.providerWireModelId).toBe("gemini-4-hydrogen-high");
  });

  test("an xhigh selection reaches the fourth rung instead of collapsing to high", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-hydrogen", "xhigh"));
    expect(JSON.parse(req.body).model).toBe("gemini-4-hydrogen-xhigh");
  });

  test("a three-rung family still clamps xhigh to its highest real rung", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-3.8-flash", "xhigh"));
    expect(JSON.parse(req.body).model).toBe("gemini-3.8-flash-high");
    expect(req.headers["User-Agent"]).toBe(ANTIGRAVITY_REQUEST_UA);
  });

  test("the 404 replay is spent as a recovery against the shared send budget", async () => {
    const adapter = createGoogleAdapter(provider);
    const request = await adapter.buildRequest(parsed("gemini-5-future", "medium"));
    const sentUserAgents: string[] = [];
    let status = 404;
    const executor = (async (_input: unknown, init?: RequestInit) => {
      const headerBag = init?.headers;
      const userAgent = headerBag instanceof Headers
        ? headerBag.get("User-Agent")
        : (headerBag as Record<string, string> | undefined)?.["User-Agent"];
      sentUserAgents.push(userAgent!);
      // The first family is refused, the second serves — the live Argon/Hydrogen shape.
      const code = status;
      status = 200;
      return code === 200
        ? Response.json({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } })
        : Response.json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, { status: 404 });
    }) as typeof fetch;
    const sends: Array<{ ordinal: number; recovery?: string }> = [];
    const res = await adapter.fetchResponse!(request, {
      executor,
      onPhysicalSend: send => sends.push(send),
    });
    expect(res.status).toBe(200);
    expect(sentUserAgents).toEqual([ANTIGRAVITY_REQUEST_UA, ANTIGRAVITY_CLI_REQUEST_UA]);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.recovery).toBe("client-fingerprint");
    // The learned family is reused rather than re-probed on the next turn.
    const next = await adapter.buildRequest(parsed("gemini-5-future", "medium"));
    expect(next.headers["User-Agent"]).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
  });

  test("a 404 that the alternate family also refuses is reported, not retried forever", async () => {
    const adapter = createGoogleAdapter(provider);
    const request = await adapter.buildRequest(parsed("gemini-4-carbon-disabled", "medium"));
    let calls = 0;
    const executor = (async () => {
      calls += 1;
      return Response.json(
        { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
        { status: 404 },
      );
    }) as typeof fetch;
    const res = await adapter.fetchResponse!(request, { executor });
    expect(res.status).toBe(404);
    // Exactly one replay: the changed-fingerprint recovery is one-shot, not a ladder.
    expect(calls).toBe(2);
  });
});
