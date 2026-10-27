import { createHash } from "node:crypto";
import type { OAuthCredentials } from "./types";
import { assertZaiPlanJwtActive, buildZaiPlanIdentityHeaders, canonicalZaiPlanModel, ZAI_ORIGIN, ZAI_PLAN_APP_VERSION } from "./zai-plan";
import { readBoundedResponseBody } from "../lib/bounded-body";

export type ZaiPlanState = "available" | "exhausted" | "pending" | "expired" | "unavailable" | "unknown";
export interface ZaiPlanModelBalance {
  model: string;
  total: number;
  used: number;
  remaining: number;
  expiresAt?: number;
}
export interface ZaiPlanBalance {
  plan: "start-plan";
  state: ZaiPlanState;
  models: ZaiPlanModelBalance[];
  sampledAt: number;
  validUntil: number;
  failure?: "authentication" | "rate-limited" | "upstream" | "malformed" | "missing-device" | "account-unavailable";
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (value === "") return undefined;
  const n = Number(value);
  const result = Number.isFinite(n) ? n * (n < 1e12 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
function units(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function unknownZaiPlanBalance(now = Date.now(), failure?: ZaiPlanBalance["failure"]): ZaiPlanBalance {
  return { plan: "start-plan", state: "unknown", models: [], sampledAt: now, validUntil: now + 5_000, ...(failure ? { failure } : {}) };
}

/** Billing identifiers are used for matching only, never returned in a summary or model catalog. */
export function parseZaiPlanBalance(payload: unknown, now = Date.now()): ZaiPlanBalance {
  const root = record(payload), data = record(root?.data);
  if (root?.code !== 0 || !Array.isArray(data?.plans) || !Array.isArray(data.balances)
    || data.plans.length > 1000 || data.balances.length > 1000) return unknownZaiPlanBalance(now, "malformed");
  const active = new Map<unknown, number | undefined>();
  let pending = false, expired = false;
  let validUntil = now + 60_000;
  for (const value of data.plans) {
    const plan = record(value);
    if (!plan || typeof plan.user_plan_id !== "string") continue;
    const start = timestamp(plan.starts_at), end = timestamp(plan.ends_at);
    if (start && start > now) { pending = true; validUntil = Math.min(validUntil, start); continue; }
    if (end && end <= now) { expired = true; continue; }
    const status = String(plan.status ?? "").toLowerCase();
    if (status === "pending") { pending = true; continue; }
    if (status === "expired") { expired = true; continue; }
    if (status === "active") { active.set(plan.user_plan_id, end); if (end) validUntil = Math.min(validUntil, end); }
  }
  const models = new Map<string, ZaiPlanModelBalance>();
  for (const value of data.balances) {
    const bucket = record(value);
    if (!bucket || !active.has(bucket.user_plan_id) || bucket.meter !== "model_usage" || bucket.unit_type !== "token"
      || !Array.isArray(bucket.capabilities) || bucket.capabilities.length > 128) continue;
    const ids = [...new Set(bucket.capabilities.filter((cap): cap is string => typeof cap === "string"
      && /^model:glm-[\w.-]{1,100}$/i.test(cap)).map(cap => canonicalZaiPlanModel(cap.slice(6))))];
    if (!ids.length) continue;
    const start = timestamp(bucket.period_start);
    const deadlines = [active.get(bucket.user_plan_id), timestamp(bucket.expires_at), timestamp(bucket.period_end)]
      .filter((time): time is number => time !== undefined);
    const end = deadlines.length ? Math.min(...deadlines) : undefined;
    if (start && start > now) { validUntil = Math.min(validUntil, start); continue; }
    if (end && end <= now) continue;
    const total = units(bucket.total_units), used = units(bucket.used_units);
    const remaining = units(bucket.available_units) ?? units(bucket.remaining_units)
      ?? (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
    if (total === undefined || used === undefined || remaining === undefined) return unknownZaiPlanBalance(now, "malformed");
    for (const model of ids) {
      const previous = models.get(model);
      const row = { model, total: (previous?.total ?? 0) + total, used: (previous?.used ?? 0) + used,
        remaining: (previous?.remaining ?? 0) + remaining, ...(end ? { expiresAt: Math.min(previous?.expiresAt ?? end, end) } : {}) };
      if (![row.total, row.used, row.remaining].every(Number.isFinite)) return unknownZaiPlanBalance(now, "malformed");
      models.set(model, row);
    }
    if (end) validUntil = Math.min(validUntil, end);
  }
  const rows = [...models.values()];
  const state: ZaiPlanState = rows.length ? rows.some(row => row.remaining > 0) ? "available" : "exhausted"
    : active.size ? "unavailable" : pending ? "pending" : expired ? "expired" : "unavailable";
  return { plan: "start-plan", state, models: rows, sampledAt: now, validUntil };
}

export function createZaiPlanBalanceReader(fetcher: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, ZaiPlanBalance>();
  return async (credential: OAuthCredentials, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ZaiPlanBalance> => {
    options.signal?.throwIfAborted();
    const at = now();
    const mid = credential.zaiPlan?.deviceMid;
    if (!mid) return unknownZaiPlanBalance(at, "missing-device");
    try { assertZaiPlanJwtActive(credential.access, at); } catch { return unknownZaiPlanBalance(at, "authentication"); }
    const key = createHash("sha256").update(JSON.stringify([credential.access, mid, ZAI_PLAN_APP_VERSION])).digest("hex");
    const previous = cache.get(key);
    if (!options.force && previous && previous.validUntil > at) return structuredClone(previous);
    let result: ZaiPlanBalance;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetcher(`${ZAI_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${ZAI_PLAN_APP_VERSION}`, {
        headers: { ...buildZaiPlanIdentityHeaders(mid), Authorization: `Bearer ${credential.access}` },
        signal, redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        result = unknownZaiPlanBalance(at, [401, 403].includes(response.status) ? "authentication" : response.status === 429 ? "rate-limited" : "upstream");
      } else {
        const read = await readBoundedResponseBody(response, { signal, maxBytes: 1_048_576, totalTimeoutMs: 10_000 });
        result = read.displaySafe ? parseZaiPlanBalance(JSON.parse(read.text), now()) : unknownZaiPlanBalance(at, "malformed");
      }
    } catch {
      options.signal?.throwIfAborted();
      result = unknownZaiPlanBalance(at, "upstream");
    }
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return structuredClone(result);
  };
}
export const readZaiPlanBalance = createZaiPlanBalanceReader();
