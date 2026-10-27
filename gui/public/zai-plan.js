export function sessionHeaders(session, method = "GET") {
  if (!session.token?.startsWith("ocx_session_") || !session.origin || !session.csrf) throw Error("sessionRequired");
  return { "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": session.origin,
    ...(method === "GET" ? {} : { "X-OpenCodex-CSRF-Token": session.csrf }) };
}

export async function diagnose({ api, dataFetch, model, gatewayKey = "", signal, now = Date.now }) {
  if (!/^glm-[\w.-]{1,100}$/i.test(model)) throw Error("invalidModel");
  const before = await api("/api/zai-plan/accounts?balance=1&refresh=1");
  const allowance = before.startPlan?.models?.find(row => row.model === model && row.remaining > 0);
  if (before.startPlan?.state !== "available" || !allowance) throw Error("entitlementUnavailable");
  const started = now();
  const response = await dataFetch("/v1/responses", { method: "POST", signal,
    headers: { "content-type": "application/json", ...(gatewayKey ? { "x-opencodex-api-key": gatewayKey } : {}) },
    body: JSON.stringify({ model: `zai-plan/${model}`, input: "Reply with OK.", max_output_tokens: 64, store: false }),
  });
  if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, elapsedMs: now() - started }; }
  const body = await response.json();
  const text = (body.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === "output_text").map(part => part.text).join("").trim();
  const requestId = response.headers.get("x-opencodex-request-id");
  let trace = { verified: false };
  if (requestId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { trace = await api(`/api/zai-plan/diagnostic?requestId=${encodeURIComponent(requestId)}&observationId=${encodeURIComponent(before.observationId ?? "")}`); break; }
      catch (error) { if (error.status !== 404 || attempt === 2) break; await new Promise(resolve => setTimeout(resolve, 150)); }
    }
  }
  const sameAccount = trace.verified === true && trace.plan === "start-plan" && trace.accountId === before.activeAccountId;
  return { ok: /^OK[.!]?$/i.test(text) && trace.verified === true && trace.plan === "start-plan" && trace.model === model,
    requestId, status: response.status, elapsedMs: now() - started, provenance: trace,
    observedTokenDecrease: sameAccount && typeof trace.observedTokenDecrease === "number" ? trace.observedTokenDecrease : null,
    balanceAttribution: sameAccount && typeof trace.observedTokenDecrease === "number" ? "same-account-observation" : "unknown",
  };
}

async function init() {
  const byId = id => document.getElementById(id), out = byId("out"), status = byId("status");
  const dictionaries = await fetch("/zai-plan-locales.json").then(response => response.json());
  let stored; try { stored = localStorage.getItem("ocx-lang"); } catch { /* local storage is optional */ }
  const nav = navigator.language.toLowerCase();
  const detected = nav.startsWith("zh") ? /tw|hk|mo|hant/.test(nav) ? "zh-TW" : "zh" : nav.split("-")[0];
  const preferred = new URLSearchParams(location.search).get("lang") ?? stored ?? detected;
  const locale = Object.hasOwn(dictionaries, preferred) ? preferred : "en";
  const copy = dictionaries[locale], t = key => copy[`zcodePanel.${key}`] ?? copy["zcodePanel.requestFailed"];
  document.documentElement.lang = locale === "zh" ? "zh-CN" : locale === "pt" ? "pt-BR" : locale;
  document.querySelectorAll("[data-copy]").forEach(element => { element.textContent = t(element.dataset.copy); });
  const session = {};
  for (const [key, name] of [["token", "opencodex-session-token"], ["csrf", "opencodex-session-csrf"], ["origin", "opencodex-session-origin"]]) {
    const meta = document.querySelector(`meta[name="${name}"]`); session[key] = meta?.content; meta?.remove();
  }
  let busy = false, hasModels = false, hasPlans = false;
  const controls = () => {
    document.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    byId("claim").disabled = busy || !hasPlans; byId("plans").disabled = busy || !hasPlans;
    byId("probe").disabled = busy || !hasModels; byId("model").disabled = busy || !hasModels;
  };
  async function api(path, options = {}) {
    const method = options.method ?? "GET";
    const response = await fetch(path, { ...options, headers: { ...sessionHeaders(session, method), ...(options.headers ?? {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = Error("requestFailed"); error.status = response.status; throw error; }
    return data;
  }
  async function run(work) {
    if (busy) return; busy = true; controls(); status.textContent = t("working");
    try {
      const data = await work(); out.textContent = JSON.stringify(data, null, 2);
      status.textContent = data.ok === false ? t("failed") : data.provenance ? t("passed")
        : typeof data.code === "number" && data.code !== 0 ? t("upstreamCode").replace("{code}", data.code) : t("done");
      if (data.provenance) byId("details").open = true;
    }
    catch (error) { status.textContent = t(error.message) + (error.status ? ` (HTTP ${error.status})` : ""); }
    finally { busy = false; controls(); }
  }
  byId("refresh").onclick = () => void run(() => api("/api/zai-plan/accounts"));
  byId("import").onclick = () => void run(() => api("/api/zai-plan/import", { method: "POST" }));
  byId("balance").onclick = () => void run(async () => {
    const data = await api("/api/zai-plan/accounts?balance=1&refresh=1");
    const models = data.startPlan?.models?.filter(row => row.remaining > 0) ?? [];
    byId("model").replaceChildren(...(models.length ? models.map(row => new Option(row.model, row.model)) : [new Option(t("noModels"), "")])); hasModels = models.length > 0;
    return data;
  });
  byId("preview").onclick = () => void run(async () => {
    hasPlans = false;
    const data = await api("/api/zai-plan/accounts/me/preview");
    const plans = (data.data?.plans ?? data.plans ?? []).filter(plan => typeof plan.plan_id === "string" && plan.plan_id.length <= 256).slice(0, 100);
    byId("plans").replaceChildren(...(plans.length ? plans.map(plan => new Option(String(plan.name ?? plan.plan_id), plan.plan_id)) : [new Option(t("noPlans"), "")])); hasPlans = plans.length > 0;
    return data;
  });
  byId("claim-form").onsubmit = event => { event.preventDefault(); void run(() => api("/api/zai-plan/accounts/me/claim", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: byId("plans").value }),
  })); };
  byId("probe-form").onsubmit = event => { event.preventDefault(); void run(() => diagnose({ api, dataFetch: fetch,
    model: byId("model").value, gatewayKey: byId("gateway-key").value.trim(), signal: AbortSignal.timeout(45_000),
  })); };
  for (const [id, path] of [["telemetry", "telemetry"], ["rotate", "fingerprint/rotate"]]) {
    byId(id).onclick = () => void run(() => api(`/api/zai-plan/accounts/me/${path}`, { method: "POST" }));
  }
  byId("refresh").click();
}
if (typeof document !== "undefined" && document.getElementById("zcode-panel")) void init().catch(() => {
  document.getElementById("status").textContent = "zcodePanel.copyUnavailable";
});
