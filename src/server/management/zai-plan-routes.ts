import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { credentialGeneration, getAccountSet, mergeAccountCredential, saveCredential } from "../../oauth/store";
import type { OAuthCredentials } from "../../oauth/types";
import { readZaiPlanBalance, unknownZaiPlanBalance } from "../../oauth/zai-plan-balance";
import { isZaiPlanCaptchaChallenge } from "../../adapters/zai-plan-transport";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { getRequestLogEntries } from "../request-log";
import { observedZaiPlanDecrease, projectZaiPlanDiagnostic, recordZaiPlanObservation } from "./zai-plan-diagnostic";
import {
  ZAI_ORIGIN,
  ZAI_PLAN_APP_VERSION,
  ZAI_PLAN_PROVIDER_ID,
  buildZaiPlanIdentityHeaders,
  importLocalZcodeJwt,
  assertZaiPlanJwtActive,
} from "../../oauth/zai-plan";
import {
  getZaiPlanVerifyParam,
  ZAI_CAPTCHA_HEADER,
  ZAI_CAPTCHA_REGION,
  ZAI_CAPTCHA_REGION_HEADER,
} from "../../oauth/zai-plan-captcha";

function identity(credential: OAuthCredentials): Record<string, string> {
  const mid = credential.zaiPlan?.deviceMid || "";
  return {
    ...buildZaiPlanIdentityHeaders(mid),
    Authorization: `Bearer ${credential.access}`,
    "Content-Type": "application/json",
  };
}

async function withCaptcha(headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, string>> {
  const param = await getZaiPlanVerifyParam(signal);
  return {
    ...headers,
    [ZAI_CAPTCHA_HEADER]: param,
    [ZAI_CAPTCHA_REGION_HEADER]: ZAI_CAPTCHA_REGION,
  };
}

async function billingRequest(credential: OAuthCredentials, path: string, req: Request, body?: string): Promise<Response> {
  const headers = identity(credential);
  const send = (headers: Record<string, string>) => fetch(`${ZAI_ORIGIN}/api/v1/zcode-plan/billing/${path}`, {
    method: body ? "POST" : "GET", headers, body, signal: AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]), redirect: "error",
  });
  let response = await send(headers);
  if (await isZaiPlanCaptchaChallenge(response, req.signal)) {
    await response.body?.cancel();
    response = await send(await withCaptcha(headers, req.signal));
  }
  return response;
}

async function billingResponse(response: Response, credential: OAuthCredentials, req: Request): Promise<Response> {
  const read = await readBoundedResponseBody(response, { signal: req.signal, maxBytes: 1_048_576, totalTimeoutMs: 10_000 });
  if (!read.displaySafe) return Response.json({ error: "ZCode billing response unavailable" }, { status: 502 });
  return new Response(read.text.replaceAll(credential.access, "[redacted]"), {
    status: response.status, headers: { "content-type": "application/json" },
  });
}

export async function handleZaiPlanRoutes(ctx: ManagementContext, deps: {
  balance?: typeof readZaiPlanBalance; importLocal?: typeof importLocalZcodeJwt;
} = {}): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/zai-plan/")) return null;
  if (url.pathname === "/api/zai-plan/diagnostic" && req.method === "GET") {
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) return jsonResponse({ error: "requestId required" }, 400, req, config);
    const entry = getRequestLogEntries().find(row => row.requestId === requestId);
    if (!entry) return jsonResponse({ state: "pending" }, 404, req, config);
    const accounts = getAccountSet(ZAI_PLAN_PROVIDER_ID)?.accounts ?? [];
    const result = projectZaiPlanDiagnostic(entry, accounts);
    const served = result.verified ? accounts.find(account => account.id === result.accountId && !account.paused && !account.needsReauth) : undefined;
    const balance = served ? await (deps.balance ?? readZaiPlanBalance)(served.credential, { force: true, signal: req.signal }) : undefined;
    const decrease = served && balance && result.model ? observedZaiPlanDecrease(url.searchParams.get("observationId") ?? "",
      served, balance, result.model, entry.timestamp) : null;
    return jsonResponse({ ...result, observedTokenDecrease: decrease, ...(balance ? { startPlan: balance } : {}) }, 200, req, config);
  }
  if (req.method === "POST" && ["/claim", "/telemetry", "/fingerprint/rotate"].some(path => url.pathname.endsWith(path))
    && ctx.principal !== "gui-session") return jsonResponse({ error: "Open the dashboard to perform this account action." }, 403, req, config);

  if (url.pathname === "/api/zai-plan/accounts" && req.method === "GET") {
    const set = getAccountSet(ZAI_PLAN_PROVIDER_ID);
    const active = set?.accounts.find(account => account.id === set.activeAccountId);
    const cred = active?.credential;
    const balance = cred && url.searchParams.get("balance") === "1"
      ? active?.paused || active?.needsReauth ? unknownZaiPlanBalance(Date.now(), "account-unavailable")
        : await (deps.balance ?? readZaiPlanBalance)(cred, { force: url.searchParams.get("refresh") === "1", signal: req.signal }) : undefined;
    const observationId = active && balance ? recordZaiPlanObservation(active, balance) : undefined;
    return jsonResponse({
      provider: ZAI_PLAN_PROVIDER_ID,
      activeAccountId: set?.activeAccountId ?? null,
      imported: Boolean(cred?.access),
      email: cred?.email ?? null,
      accountId: cred?.accountId ?? null,
      deviceMid: cred?.zaiPlan?.deviceMid ?? null,
      source: cred?.source ?? null,
      accounts: (set?.accounts ?? []).map((a) => ({
        id: a.id,
        alias: a.alias,
        email: a.credential.email,
        deviceMid: a.credential.zaiPlan?.deviceMid,
      })),
      settings: { autoClaim: false, dailyActive: false },
      ...(balance ? { startPlan: balance } : {}),
      ...(observationId ? { observationId } : {}),
    }, 200, req, config);
  }

  if (url.pathname === "/api/zai-plan/import" && req.method === "POST") {
    const local = (deps.importLocal ?? importLocalZcodeJwt)();
    if (!local) return jsonResponse({ error: "No usable ZCode Desktop login. Sign in again before importing." }, 404, req, config);
    try { assertZaiPlanJwtActive(local.access); } catch { return jsonResponse({ error: "ZCode Desktop login expired. Sign in again." }, 401, req, config); }
    await saveCredential(ZAI_PLAN_PROVIDER_ID, local);
    return jsonResponse({ ok: true, source: "local-cli" }, 200, req, config);
  }

  const set = getAccountSet(ZAI_PLAN_PROVIDER_ID);
  const selectedId = /^\/api\/zai-plan\/accounts\/([^/]+)\//.exec(url.pathname)?.[1];
  const selected = set?.accounts.find(account => account.id === (selectedId && selectedId !== "me" ? selectedId : set.activeAccountId));
  const credential = selected?.credential;
  if (!credential) return jsonResponse({ error: selectedId && selectedId !== "me" ? "ZCode account not found" : "zai-plan not logged in" }, selectedId && selectedId !== "me" ? 404 : 401, req, config);
  if (!credential.zaiPlan?.deviceMid) return jsonResponse({ error: "ZCode device identity is missing. Reimport or sign in again." }, 409, req, config);

  if (url.pathname.endsWith("/preview") && req.method === "GET") {
    const res = await billingRequest(credential, `preview?app_version=${ZAI_PLAN_APP_VERSION}`, req);
    return billingResponse(res, credential, req);
  }

  if (url.pathname.endsWith("/claim") && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { plan_id?: string };
    if (typeof body.plan_id !== "string" || !body.plan_id.trim() || body.plan_id.length > 256) return jsonResponse({ error: "plan_id required" }, 400, req, config);
    const res = await billingRequest(credential, "claim", req, JSON.stringify({ plan_id: body.plan_id }));
    return billingResponse(res, credential, req);
  }

  if (url.pathname.endsWith("/telemetry") && req.method === "POST") {
    const cred = credential;
    const mid = cred?.zaiPlan?.deviceMid || crypto.randomUUID();
    const userId = cred?.zaiPlan?.userId || cred?.accountId || "";
    const payload = {
      event_id: crypto.randomUUID(),
      client_timezone: "Asia/Shanghai",
      client_language: "zh-CN",
      element_name: "app_daily_active",
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: userId,
      screen_resolution: "1920x1080",
      app_version: ZAI_PLAN_APP_VERSION,
      device_os_category: "windows",
      device_os_version: "10.0.26200",
      device_mid: mid,
      mac_id: "",
      marketing_params: "{}",
    };
    const res = await fetch(`${ZAI_ORIGIN}/api/v1/event/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, req, config);
  }

  if (url.pathname.endsWith("/fingerprint/rotate") && req.method === "POST") {
    const fresh = { ...credential, zaiPlan: { ...credential.zaiPlan, deviceMid: crypto.randomUUID() } };
    const outcome = await mergeAccountCredential(ZAI_PLAN_PROVIDER_ID, selected!.id, fresh, { expectedGeneration: credentialGeneration(credential) });
    if (outcome.superseded) return jsonResponse({ error: "ZCode account changed. Retry the operation." }, 409, req, config);
    return jsonResponse({ ok: true, deviceMid: fresh.zaiPlan.deviceMid }, 200, req, config);
  }

  return jsonResponse({ error: "unknown zai-plan route" }, 404, req, config);
}
