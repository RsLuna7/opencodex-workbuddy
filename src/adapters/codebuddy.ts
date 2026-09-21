import type { AdapterEvent } from "../types";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { TranslatorBudget } from "../lib/translator-budget";
import { readBoundedResponseBody } from "../lib/bounded-body";
import {
  CODEBUDDY_PROVIDER_ID,
  codebuddyFailoverHintFromQuotaCode,
  rememberCodebuddyFailoverHint,
} from "../oauth/codebuddy";
import { applyWorkbuddyChatHeaders } from "../oauth/codebuddy-headers";
import { isCanonicalWorkbuddyChatBase, workbuddyChatCompletionsUrl } from "../oauth/codebuddy-hosts";
import { prepareWorkbuddyChatBody } from "../oauth/codebuddy-payload";
import { resolveWorkbuddyRealm } from "../oauth/codebuddy-realm";
import { applyGenericFailoverCooldown } from "../oauth/generic-account-failover";
import { workbuddyFetch } from "../oauth/workbuddy-fetch";
import {
  acquireWorkbuddyLease,
  bindWorkbuddySession,
  noteWorkbuddyPoolFailure,
  noteWorkbuddyPoolSuccess,
  releaseWorkbuddyLease,
  workbuddyAccountIdForUid,
} from "../oauth/workbuddy-pool";
import {
  inspectWorkbuddyWafBlock,
  noteWorkbuddyWafHit,
  WORKBUDDY_WAF_ACCOUNT_COOLDOWN_MS,
} from "../oauth/workbuddy-waf";
import { createOpenAIChatAdapter } from "./openai-chat";
import { formatOpenAIChatErrorBody } from "./openai-chat";

const CODEBUDDY_MAX_OUTPUT_TOKENS = 32_768;
/** Account-wide exhaustion (CLIProxyAPI / CodeRelay). */
const CODEBUDDY_QUOTA_CODE = "14018";
/** Per-model rolling frequency window (observed 2026-09-11 on deepseek-v4.1-flash). */
const CODEBUDDY_MODEL_RATE_QUOTA_CODE = "6004";
const CODEBUDDY_QUOTA_CODES = new Set([CODEBUDDY_QUOTA_CODE, CODEBUDDY_MODEL_RATE_QUOTA_CODE]);

function isCanonicalCodebuddyEndpoint(baseUrl: string): boolean {
  return isCanonicalWorkbuddyChatBase(baseUrl);
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

function conversationMeta(parsed: OcxParsedRequest): { conversationId?: string; conversationRequestId?: string } {
  const conversationId = parsed.options.promptCacheKey?.trim()
    || parsed._providerContinuation?.cursor?.conversationId?.trim();
  return conversationId ? { conversationId, conversationRequestId: conversationId } : {};
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
      "The codebuddy adapter only supports the canonical CodeBuddy CN or WorkBuddy Global endpoints. Use openai-chat for a custom endpoint.",
    );
  }
  const base = createOpenAIChatAdapter(provider);

  return {
    ...base,
    name: "codebuddy",

    formatErrorBody: formatCodebuddyErrorBody,

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const executor = ctx?.executor ?? workbuddyFetch;
      const uid = request.headers["X-User-Id"] ?? request.headers["x-user-id"];
      const accountId = workbuddyAccountIdForUid(uid);
      const sessionKey = request.headers["X-Conversation-ID"] ?? request.headers["x-conversation-id"];
      if (accountId) acquireWorkbuddyLease(accountId);
      try {
        const response = await executor(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: ctx?.abortSignal,
        });
        const rewritten = await rewriteCodebuddyQuotaResponse(response, ctx?.abortSignal);
        if (accountId && rewritten.ok) {
          noteWorkbuddyPoolSuccess({ accountId });
          if (sessionKey) bindWorkbuddySession(sessionKey, accountId);
        } else if (accountId && rewritten.status === 403
          && await inspectWorkbuddyWafBlock(rewritten, ctx?.abortSignal)) {
          applyGenericFailoverCooldown({
            providerName: CODEBUDDY_PROVIDER_ID,
            accountId,
            cooldownMs: WORKBUDDY_WAF_ACCOUNT_COOLDOWN_MS,
          });
          noteWorkbuddyWafHit(uid ?? accountId);
        } else if (accountId && rewritten.status >= 500) {
          noteWorkbuddyPoolFailure({ accountId });
        }
        return rewritten;
      } catch (error) {
        if (accountId) noteWorkbuddyPoolFailure({ accountId });
        throw error;
      } finally {
        if (accountId) releaseWorkbuddyLease(accountId);
      }
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const baseReq = await base.buildRequest(parsed, incoming);
      const routing = parsed._codebuddyAuthContext;
      const realm = resolveWorkbuddyRealm(routing?.realm, routing?.domain);
      const headers: Record<string, string> = {
        ...(baseReq.headers as Record<string, string> | undefined),
      };
      applyWorkbuddyChatHeaders(headers, realm, routing, {
        ...conversationMeta(parsed),
        deviceToken: routing?.deviceToken,
      });
      const streamed = forceStreamBody(String(baseReq.body ?? ""));
      const body = prepareWorkbuddyChatBody(streamed, {
        ensureSystem: realm === "global",
        sanitize: true,
      });
      return {
        ...baseReq,
        url: workbuddyChatCompletionsUrl(realm),
        headers,
        body,
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
