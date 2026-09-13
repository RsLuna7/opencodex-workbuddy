import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { getCredential } from "../oauth/store";
import {
  buildOfficialStartPlanHeaders,
  buildStartPlanSystemBlocks,
  buildZaiPlanIdentityHeaders,
  canonicalZaiPlanModel,
  officialMetadataUserId,
  ZAI_PLAN_BASE_URL,
  ZAI_PLAN_MESSAGES_URL,
  ZAI_PLAN_PROVIDER_ID,
  ZAI_ULTRA_MESSAGES_URL,
} from "../oauth/zai-plan";
import {
  getZaiPlanVerifyParam,
  invalidateZaiPlanCaptcha,
  isZaiPlanCdpError,
  resetZaiPlanChrome,
  ZAI_CAPTCHA_HEADER,
  ZAI_CAPTCHA_REGION,
  ZAI_CAPTCHA_REGION_HEADER,
  zaiPlanBrowserFetch,
} from "../oauth/zai-plan-captcha";
import {
  applyZaiPlanSigning,
  isZaiPlanVerifyFailure,
  noteZaiPlanVerifyFailure,
  parseTwoPartKey,
} from "../oauth/zai-plan-signing";
import { createAnthropicAdapter } from "./anthropic";

const MAX_TOKENS = 131_072;
const CAPTCHA_RETRIES = 3;

function isCanonical(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname === "zcode.z.ai";
  } catch {
    return false;
  }
}

function rewriteBody(raw: string, opts?: {
  startPlanSystem?: boolean;
  deviceMid?: string;
  sessionId?: string;
}): string {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    body = { ...(parsed as Record<string, unknown>) };
  } catch {
    return raw;
  }
  if (typeof body.model === "string") body.model = canonicalZaiPlanModel(body.model);
  if (typeof body.max_tokens === "number" && body.max_tokens > MAX_TOKENS) body.max_tokens = MAX_TOKENS;
  if (opts?.startPlanSystem !== false) {
    body.system = buildStartPlanSystemBlocks(typeof body.model === "string" ? body.model : undefined);
  }
  if (opts?.deviceMid) {
    const meta = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
    meta.user_id = officialMetadataUserId(opts.deviceMid, opts.sessionId || crypto.randomUUID());
    body.metadata = meta;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    if (rec.role === "system") continue;
    if (typeof rec.content === "string") {
      rec.content = [{ type: "text", text: rec.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(rec.content) && rec.content.length > 0) {
      const last = rec.content[rec.content.length - 1];
      if (last && typeof last === "object" && !(last as { cache_control?: unknown }).cache_control) {
        (last as { cache_control: { type: string } }).cache_control = { type: "ephemeral" };
      }
    }
    break;
  }
  return JSON.stringify(body);
}

function identityHeaders(jwt: string): Record<string, string> {
  const mid = getCredential(ZAI_PLAN_PROVIDER_ID)?.zaiPlan?.deviceMid || crypto.randomUUID();
  return buildZaiPlanIdentityHeaders(mid);
}

function dropClaudeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-stainless") || lower.startsWith("anthropic-beta") || lower === "x-claude-code-session-id") continue;
    out[key] = value;
  }
  return out;
}

function readBiz(text: string): { code?: number; msg?: string } {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "number" ? parsed.code : undefined,
      msg: typeof parsed.msg === "string" ? parsed.msg : typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return {};
  }
}

function isCaptchaFail(status: number, text: string): boolean {
  if (text.includes("3007") || /captcha verify failed/i.test(text)) return true;
  return status === 400 && readBiz(text).code === 3007;
}

function isQuotaFail(status: number, text: string): boolean {
  if (status === 402) return true;
  return /quota|insufficient|balance|exhaust|额度|余额不足/i.test(text);
}

function isRiskFail(status: number, text: string): boolean {
  return status === 405 || readBiz(text).code === 3012 || /unusual activity/i.test(text);
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createZaiPlanAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long"): ProviderAdapter {
  if (!isCanonical(provider.baseUrl)) {
    throw new Error("The zai-plan adapter only supports zcode.z.ai. Use anthropic for a custom endpoint.");
  }
  const inner = createAnthropicAdapter({
    ...provider,
    authMode: "key",
    apiKeyTransport: "bearer",
    baseUrl: ZAI_PLAN_BASE_URL,
  }, cacheRetention);

  return {
    ...inner,
    name: "zai-plan",

    formatErrorBody(status, headers, payloadText) {
      if (isCaptchaFail(status, payloadText)) return "ZCode Plan captcha failed. Retry the request.";
      if (isRiskFail(status, payloadText)) return "ZCode Plan blocked the request (unusual activity). Wait and retry.";
      if (isQuotaFail(status, payloadText)) return "ZCode Plan quota exhausted.";
      return inner.formatErrorBody?.(status, headers, payloadText) ?? payloadText.slice(0, 500);
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const baseReq = await inner.buildRequest(parsed, incoming);
      const stored = getCredential(ZAI_PLAN_PROVIDER_ID);
      const jwt = provider.apiKey?.trim() || stored?.access || "";
      const codingKey = stored?.zaiPlan?.codingKey?.trim();
      const sessionId = stored?.zaiPlan?.sessionId || crypto.randomUUID();
      const identity = identityHeaders(jwt);
      const useStartPlan = jwt.split(".").length === 3;
      if (!useStartPlan && codingKey && parseTwoPartKey(codingKey)) {
        const headers = dropClaudeHeaders({
          ...(baseReq.headers as Record<string, string> | undefined),
          ...identity,
          "x-api-key": codingKey,
          "anthropic-version": "2023-06-01",
          "X-Session-Id": sessionId,
          "x-query-id": crypto.randomUUID(),
        });
        delete headers.Authorization;
        return {
          ...baseReq,
          url: ZAI_ULTRA_MESSAGES_URL,
          headers,
          body: rewriteBody(String(baseReq.body ?? ""), { startPlanSystem: false }),
        };
      }
      const mid = stored?.zaiPlan?.deviceMid || crypto.randomUUID();
      return {
        ...baseReq,
        url: ZAI_PLAN_MESSAGES_URL,
        headers: buildOfficialStartPlanHeaders({ jwt, deviceMid: mid }),
        body: rewriteBody(String(baseReq.body ?? ""), {
          startPlanSystem: true,
          deviceMid: mid,
          sessionId,
        }),
      };
    },

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const stored = getCredential(ZAI_PLAN_PROVIDER_ID);
      const codingKey = stored?.zaiPlan?.codingKey?.trim();
      if (codingKey && parseTwoPartKey(codingKey) && request.url.includes("/ultra")) {
        const send = async (headers: Record<string, string>) => fetch(request.url, {
          method: request.method,
          headers,
          body: String(request.body ?? ""),
          signal: ctx?.abortSignal ?? AbortSignal.timeout(120_000),
        });
        let headers = await applyZaiPlanSigning({
          url: request.url,
          headers: request.headers as Record<string, string>,
          credential: codingKey,
        });
        let resp = await send(headers);
        if (await isZaiPlanVerifyFailure(resp)) {
          const next = noteZaiPlanVerifyFailure();
          if (next === "retry") {
            headers = await applyZaiPlanSigning({
              url: request.url,
              headers: request.headers as Record<string, string>,
              credential: codingKey,
            });
            resp = await send(headers);
            if (await isZaiPlanVerifyFailure(resp)) noteZaiPlanVerifyFailure();
          }
        }
        const text = await resp.text();
        if (!isQuotaFail(resp.status, text)) {
          return new Response(text, {
            status: resp.status,
            headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
          });
        }
        // Coding-plan key has no quota (Start Plan only) — fall through to JWT+captcha.
        const jwt = stored?.access || "";
        const mid = stored?.zaiPlan?.deviceMid || crypto.randomUUID();
        request = {
          ...request,
          url: ZAI_PLAN_MESSAGES_URL,
          headers: buildOfficialStartPlanHeaders({
            jwt,
            deviceMid: mid,
          }),
          body: rewriteBody(String(request.body ?? ""), {
            startPlanSystem: true,
            deviceMid: mid,
            sessionId: stored?.zaiPlan?.sessionId || crypto.randomUUID(),
          }),
        };
      }

      let lastText = "";
      let lastStatus = 0;
      for (let attempt = 0; attempt < CAPTCHA_RETRIES; attempt++) {
        try {
          const param = await getZaiPlanVerifyParam(ctx?.abortSignal);
          const headers = {
            ...(request.headers as Record<string, string>),
            [ZAI_CAPTCHA_HEADER]: param,
            [ZAI_CAPTCHA_REGION_HEADER]: ZAI_CAPTCHA_REGION,
          };
          const viaChrome = await zaiPlanBrowserFetch({
            url: request.url,
            headers,
            body: String(request.body ?? ""),
            signal: ctx?.abortSignal,
          });
          lastStatus = viaChrome.status;
          if (viaChrome.status >= 400) {
            lastText = await new Response(viaChrome.body).text();
            if (isCaptchaFail(viaChrome.status, lastText)) {
              invalidateZaiPlanCaptcha();
              continue;
            }
            if (isQuotaFail(viaChrome.status, lastText)) {
              return jsonResponse(402, { error: { type: "insufficient_quota", message: "ZCode Plan quota exhausted" } });
            }
            return new Response(lastText, {
              status: viaChrome.status,
              headers: { "content-type": viaChrome.headers["content-type"] ?? "application/json" },
            });
          }
          return new Response(viaChrome.body, {
            status: viaChrome.status,
            headers: { "content-type": viaChrome.headers["content-type"] ?? "application/json" },
          });
        } catch (err) {
          if (ctx?.abortSignal?.aborted) throw err;
          if (isZaiPlanCdpError(err) && attempt < CAPTCHA_RETRIES - 1) {
            resetZaiPlanChrome();
            continue;
          }
          throw err;
        }
      }
      return new Response(lastText, { status: lastStatus || 400, headers: { "content-type": "application/json" } });
    },
  };
}
