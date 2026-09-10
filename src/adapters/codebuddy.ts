import type { AdapterEvent } from "../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { TranslatorBudget } from "../lib/translator-budget";
import { getCredential } from "../oauth/store";
import { CODEBUDDY_CHAT_BASE_URL, CODEBUDDY_PROVIDER_ID } from "../oauth/codebuddy";
import { createOpenAIChatAdapter } from "./openai-chat";
import { openaiChatCompletionsUrl } from "./openai-chat-url";
import { formatOpenAIChatErrorBody } from "./openai-chat";

const CODEBUDDY_MAX_OUTPUT_TOKENS = 32_768;
const CODEBUDDY_QUOTA_CODE = 14018;

const STATIC_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Product": "SaaS",
  "X-IDE-Name": "CodeBuddyIDE",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "CodeBuddyIDE",
};

function isCanonicalCodebuddyEndpoint(baseUrl: string): boolean {
  try {
    const actual = new URL(baseUrl.trim());
    const expected = new URL(CODEBUDDY_CHAT_BASE_URL);
    const norm = (value: URL) => {
      value.pathname = value.pathname.replace(/\/+$/, "") || "/";
      return value.toString().replace(/\/$/, "");
    };
    return norm(actual) === norm(expected);
  } catch {
    return false;
  }
}

function applyAccountHeaders(headers: Record<string, string>): void {
  const cred = getCredential(CODEBUDDY_PROVIDER_ID);
  const uid = cred?.codebuddy?.uid ?? cred?.accountId;
  const enterpriseId = cred?.codebuddy?.enterpriseId;
  const domain = cred?.codebuddy?.domain;
  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }
  if (domain) headers["X-Domain"] = domain;
}

function forceStreamBody(raw: string): string {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    body = { ...(parsed as Record<string, unknown>) };
  } catch {
    return raw;
  }
  body.stream = true;
  body.stream_options = {
    ...(body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options)
      ? body.stream_options as Record<string, unknown>
      : {}),
    include_usage: true,
  };
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[field];
    if (typeof value === "number" && value > CODEBUDDY_MAX_OUTPUT_TOKENS) {
      body[field] = CODEBUDDY_MAX_OUTPUT_TOKENS;
    }
  }
  return JSON.stringify(body);
}

function rewriteQuotaError(status: number, payloadText: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadText) as { code?: unknown; error?: { data?: { code?: unknown } } };
    const code = parsed.code ?? parsed.error?.data?.code;
    if (code === CODEBUDDY_QUOTA_CODE || code === String(CODEBUDDY_QUOTA_CODE)) {
      return JSON.stringify({
        error: {
          type: "rate_limit_error",
          code: String(CODEBUDDY_QUOTA_CODE),
          message: "CodeBuddy quota exhausted",
        },
      });
    }
  } catch {
    /* keep the original body */
  }
  return status === 429 ? undefined : undefined;
}

export function createCodebuddyAdapter(provider: OcxProviderConfig): ProviderAdapter {
  if (!isCanonicalCodebuddyEndpoint(provider.baseUrl)) {
    throw new Error(
      "The codebuddy adapter only supports the canonical CodeBuddy CN endpoint. Use openai-chat for a custom endpoint.",
    );
  }
  const base = createOpenAIChatAdapter(provider);
  const chatUrl = openaiChatCompletionsUrl(CODEBUDDY_CHAT_BASE_URL);

  return {
    ...base,
    name: "codebuddy",

    formatErrorBody(status, headers, payloadText) {
      return rewriteQuotaError(status, payloadText)
        ?? formatOpenAIChatErrorBody(status, headers, payloadText);
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const baseReq = await base.buildRequest(parsed, incoming);
      const headers: Record<string, string> = {
        ...STATIC_HEADERS,
        ...(baseReq.headers as Record<string, string> | undefined),
        ...STATIC_HEADERS,
        Accept: "text/event-stream",
      };
      applyAccountHeaders(headers);
      return {
        ...baseReq,
        url: chatUrl,
        headers,
        body: forceStreamBody(String(baseReq.body ?? "")),
      };
    },

    async parseResponse(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): Promise<AdapterEvent[]> {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") || contentType.includes("text/plain")) {
        const events: AdapterEvent[] = [];
        for await (const event of base.parseStream(response, budget, tierMetadata)) {
          events.push(event);
        }
        return events;
      }
      return base.parseResponse!(response, budget, tierMetadata);
    },
  };
}
