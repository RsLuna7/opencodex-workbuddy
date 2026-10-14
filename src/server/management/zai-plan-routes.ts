import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { getAccountSet, getCredential, saveCredential } from "../../oauth/store";
import {
  ZAI_ORIGIN,
  ZAI_PLAN_APP_VERSION,
  ZAI_PLAN_PROVIDER_ID,
  buildZaiPlanIdentityHeaders,
  importLocalZcodeJwt,
} from "../../oauth/zai-plan";
import {
  getZaiPlanVerifyParam,
  ZAI_CAPTCHA_HEADER,
  ZAI_CAPTCHA_REGION,
  ZAI_CAPTCHA_REGION_HEADER,
} from "../../oauth/zai-plan-captcha";

function identity(jwt: string): Record<string, string> {
  const mid = getCredential(ZAI_PLAN_PROVIDER_ID)?.zaiPlan?.deviceMid || crypto.randomUUID();
  return {
    ...buildZaiPlanIdentityHeaders(mid),
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

async function withCaptcha(headers: Record<string, string>): Promise<Record<string, string>> {
  const param = await getZaiPlanVerifyParam();
  return {
    ...headers,
    [ZAI_CAPTCHA_HEADER]: param,
    [ZAI_CAPTCHA_REGION_HEADER]: ZAI_CAPTCHA_REGION,
  };
}

export async function handleZaiPlanRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/zai-plan")) return null;

  if (url.pathname === "/api/zai-plan/accounts" && req.method === "GET") {
    const cred = getCredential(ZAI_PLAN_PROVIDER_ID);
    const set = getAccountSet(ZAI_PLAN_PROVIDER_ID);
    return jsonResponse({
      provider: ZAI_PLAN_PROVIDER_ID,
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
    }, 200, req, config);
  }

  const jwt = getCredential(ZAI_PLAN_PROVIDER_ID)?.access;
  if (!jwt) return jsonResponse({ error: "zai-plan not logged in" }, 401, req, config);

  if (url.pathname === "/api/zai-plan/import" && req.method === "POST") {
    const local = importLocalZcodeJwt();
    if (!local) return jsonResponse({ error: "no ~/.zcode credentials" }, 404, req, config);
    saveCredential(ZAI_PLAN_PROVIDER_ID, local);
    return jsonResponse({ ok: true, source: "local-cli" }, 200, req, config);
  }

  if (url.pathname.endsWith("/preview") && req.method === "GET") {
    const headers = await withCaptcha(identity(jwt));
    const res = await fetch(`${ZAI_ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${ZAI_PLAN_APP_VERSION}&platform=win32`, { headers });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/claim") && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { plan_id?: string };
    if (!body.plan_id) return jsonResponse({ error: "plan_id required" }, 400, req, config);
    const headers = await withCaptcha(identity(jwt));
    const res = await fetch(`${ZAI_ORIGIN}/api/v1/zcode-plan/billing/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ plan_id: body.plan_id }),
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/telemetry") && req.method === "POST") {
    const cred = getCredential(ZAI_PLAN_PROVIDER_ID);
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
    const cred = getCredential(ZAI_PLAN_PROVIDER_ID);
    if (!cred) return jsonResponse({ error: "not logged in" }, 401, req, config);
    cred.zaiPlan = { ...(cred.zaiPlan ?? {}), deviceMid: crypto.randomUUID() };
    saveCredential(ZAI_PLAN_PROVIDER_ID, cred);
    return jsonResponse({ ok: true, deviceMid: cred.zaiPlan.deviceMid }, 200, req, config);
  }

  return jsonResponse({ error: "unknown zai-plan route" }, 404, req, config);
}
