import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { getAccountSet, getCredential } from "../oauth/store";
import { createZaiPlanTransport } from "./zai-plan-transport";
import { createAdapterPhysicalSend } from "./physical-send";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import type { ZaiPlanRequestAccount } from "../oauth/zai-plan-health";
import {
  buildOfficialStartPlanHeaders,
  assertZaiPlanJwtActive,
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
  applyZaiPlanSigning,
  isZaiPlanVerifyFailure,
  noteZaiPlanVerifyFailure,
  parseTwoPartKey,
} from "../oauth/zai-plan-signing";
import { createAnthropicAdapter } from "./anthropic";

const MAX_TOKENS = 131_072;

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
    const original = typeof body.system === "string" ? [{ type: "text", text: body.system }]
      : Array.isArray(body.system) ? body.system : [];
    const official = buildStartPlanSystemBlocks(typeof body.model === "string" ? body.model : undefined);
    body.system = original[0]?.text === official[0].text ? original : [...official, ...original];
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Quota only from HTTP 402 or a 4xx/5xx error JSON — never from model/SSE body text. */
export function isZaiPlanQuotaFail(status: number, text: string): boolean {
  if (status === 402) return true;
  if (status >= 200 && status < 300) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const root = asRecord(parsed);
  if (!root) return false;
  const err = asRecord(root.error) ?? root;
  const type = readString(err.type) ?? readString(root.type);
  if (type && /^(insufficient_quota|quota_exhausted|quota_exceeded)$/i.test(type)) return true;
  const msg = readString(err.message) ?? readString(root.msg) ?? readString(root.message);
  if (!msg) return false;
  return /insufficient_quota|quota exhausted|额度不足|余额不足|额度用尽/i.test(msg);
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

  const fetchStartPlan = createZaiPlanTransport();
  const requestAccounts = new WeakMap<AdapterRequest, ZaiPlanRequestAccount>();
  return {
    ...inner,
    name: "zai-plan",

    formatErrorBody(status, headers, payloadText) {
      if (isCaptchaFail(status, payloadText)) return "ZCode Plan captcha failed. Retry the request.";
      if (isRiskFail(status, payloadText)) return "ZCode Plan blocked the request (unusual activity). Wait and retry.";
      if (isZaiPlanQuotaFail(status, payloadText)) return "ZCode Plan quota exhausted.";
      return inner.formatErrorBody?.(status, headers, payloadText) ?? payloadText.slice(0, 500);
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const baseReq = await inner.buildRequest(parsed, incoming);
      const jwt = provider.apiKey?.trim() || getCredential(ZAI_PLAN_PROVIDER_ID)?.access || "";
      assertZaiPlanJwtActive(jwt);
      const account = getAccountSet(ZAI_PLAN_PROVIDER_ID)?.accounts.find(account => account.credential.access === jwt || account.credential.zaiPlan?.codingKey === jwt);
      const stored = account?.credential;
      const bind = (request: AdapterRequest): AdapterRequest => {
        if (account) requestAccounts.set(request, { id: account.id, credential: structuredClone(account.credential),
          model: canonicalZaiPlanModel(parsed.modelId), writerGeneration: captureConfigGeneration() });
        return request;
      };
      const codingKey = stored?.zaiPlan?.codingKey?.trim();
      const sessionId = stored?.zaiPlan?.sessionId || crypto.randomUUID();
      const identity = buildZaiPlanIdentityHeaders(stored?.zaiPlan?.deviceMid || crypto.randomUUID());
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
        return bind({
          ...baseReq,
          url: ZAI_ULTRA_MESSAGES_URL,
          headers,
          body: rewriteBody(String(baseReq.body ?? ""), { startPlanSystem: false }),
        });
      }
      const mid = stored?.zaiPlan?.deviceMid || crypto.randomUUID();
      return bind({
        ...baseReq,
        url: ZAI_PLAN_MESSAGES_URL,
        headers: buildOfficialStartPlanHeaders({ jwt, deviceMid: mid }),
        body: rewriteBody(String(baseReq.body ?? ""), {
          startPlanSystem: true,
          deviceMid: mid,
          sessionId,
        }),
      });
    },

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      if (!request.url.includes("/ultra")) {
        const account = requestAccounts.get(request);
        if (!account) return fetchStartPlan(request, ctx);
        const { zaiPlanHealth } = await import("../oauth/zai-plan-health");
        let local = false;
        const response = await fetchStartPlan(request, ctx, () => {
          const refused = zaiPlanHealth.before(account);
          if (refused) local = true;
          return refused;
        });
        if (!local) await zaiPlanHealth.observe(account, response, ctx?.abortSignal);
        return response;
      }
      // Coding requests retain their selected key and never switch the billing plan implicitly.
      const codingKey = request.headers["x-api-key"] ?? "";
      const send = createAdapterPhysicalSend(ctx);
      for (let attempt = 0; attempt < 2; attempt++) {
        const headers = await applyZaiPlanSigning({ url: request.url, headers: request.headers, credential: codingKey });
        const response = await send({ url: request.url, sendClass: attempt ? "auth-recovery" : "initial",
          dispatch: executor => executor(request.url, {
            method: request.method, headers, body: request.body, redirect: "error", signal: ctx?.abortSignal,
          }),
        });
        if (attempt || !await isZaiPlanVerifyFailure(response)) return response;
        noteZaiPlanVerifyFailure();
        await response.body?.cancel();
      }
      throw new Error("ZCode Plan signing recovery exhausted");
    },
  };
}
