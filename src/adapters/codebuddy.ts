import type { AdapterEvent } from "../types";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { TranslatorBudget } from "../lib/translator-budget";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { getCredential } from "../oauth/store";
import {
  applyCodebuddyAccountHeaders,
  codebuddyFailoverHintFromQuotaCode,
  CODEBUDDY_CHAT_BASE_URL,
  CODEBUDDY_PROVIDER_ID,
  rememberCodebuddyFailoverHint,
} from "../oauth/codebuddy";
import { createOpenAIChatAdapter } from "./openai-chat";
import { openaiChatCompletionsUrl } from "./openai-chat-url";
import { formatOpenAIChatErrorBody } from "./openai-chat";

const CODEBUDDY_MAX_OUTPUT_TOKENS = 32_768;
/** Account-wide exhaustion (CLIProxyAPI / CodeRelay). */
const CODEBUDDY_QUOTA_CODE = "14018";
/** Per-model rolling frequency window (observed 2026-09-11 on deepseek-v4.1-flash). */
const CODEBUDDY_MODEL_RATE_QUOTA_CODE = "6004";
const CODEBUDDY_QUOTA_CODES = new Set([CODEBUDDY_QUOTA_CODE, CODEBUDDY_MODEL_RATE_QUOTA_CODE]);

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

function applyAccountHeaders(
  headers: Record<string, string>,
  routing?: { uid?: string; enterpriseId?: string; domain?: string } | null,
): void {
  applyCodebuddyAccountHeaders(
    headers,
    routing
      ? { accountId: routing.uid, codebuddy: routing }
      : getCredential(CODEBUDDY_PROVIDER_ID),
  );
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown> | undefined, names: string[]): string | undefined {
  if (!record) return undefined;
  for (const name of names) {
    const raw = record[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

function readBizCode(parsed: Record<string, unknown>): string | undefined {
  const error = asRecord(parsed.error);
  const data = asRecord(error?.data);
  const raw = parsed.code ?? error?.code ?? data?.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

function readUpstreamMessage(parsed: Record<string, unknown>): string | undefined {
  const error = asRecord(parsed.error);
  return readStringField(parsed, ["msg", "message"])
    ?? readStringField(error, ["message", "msg"]);
}

/** Client-facing message that classifyError maps to insufficient_quota (no synthetic Retry-After). */
export function codebuddyQuotaErrorMessage(payloadText: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    const record = asRecord(parsed);
    if (!record) return undefined;
    const code = readBizCode(record);
    if (!code || !CODEBUDDY_QUOTA_CODES.has(code)) return undefined;
    const detail = readUpstreamMessage(record);
    return detail
      ? `CodeBuddy quota exhausted (${code}). ${detail}`
      : `CodeBuddy quota exhausted (${code})`;
  } catch {
    return undefined;
  }
}

function formatCodebuddyErrorBody(status: number, headers: Headers, payloadText: string): string {
  const quota = codebuddyQuotaErrorMessage(payloadText);
  if (quota) return quota;
  const openai = formatOpenAIChatErrorBody(status, headers, payloadText);
  if (openai) return openai;
  try {
    return readUpstreamMessage(asRecord(JSON.parse(payloadText)) ?? {}) ?? "";
  } catch {
    return "";
  }
}

/**
 * Codex retries HTTP 429 (including with ocx's 2s synthetic Retry-After). 6004/14018
 * will not recover until the upstream window resets, so rewrite to 402 + insufficient_quota
 * and omit Retry-After.
 */
async function rewriteCodebuddyQuotaResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Response> {
  if (response.ok) return response;
  let text = "";
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe) return response;
    text = body.text;
  } catch (error) {
    if (signal?.aborted) throw error;
    return response;
  }
  const message = codebuddyQuotaErrorMessage(text);
  if (!message) return response;
  try {
    void response.body?.cancel();
  } catch {
    /* already consumed */
  }
  const rewritten = new Response(JSON.stringify({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message,
    },
  }), {
    status: 402,
    statusText: "Payment Required",
    headers: { "Content-Type": "application/json" },
  });
  // 402 is for Codex (no Retry-After). The hint is process-local so core can rotate
  // accounts without putting ocx-internal headers on the client response.
  try {
    const record = asRecord(JSON.parse(text));
    const code = record ? readBizCode(record) : undefined;
    if (code) {
      const hint = codebuddyFailoverHintFromQuotaCode(code, message);
      if (hint) rememberCodebuddyFailoverHint(rewritten, hint);
    }
  } catch {
    /* message already identified the quota; rotation hint is best-effort */
  }
  return rewritten;
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

    formatErrorBody: formatCodebuddyErrorBody,

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const executor = ctx?.executor ?? globalThis.fetch;
      const response = await executor(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: ctx?.abortSignal,
      });
      return rewriteCodebuddyQuotaResponse(response, ctx?.abortSignal);
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const baseReq = await base.buildRequest(parsed, incoming);
      const headers: Record<string, string> = {
        ...STATIC_HEADERS,
        ...(baseReq.headers as Record<string, string> | undefined),
        ...STATIC_HEADERS,
        Accept: "text/event-stream",
      };
      applyAccountHeaders(headers, parsed._codebuddyAuthContext);
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
