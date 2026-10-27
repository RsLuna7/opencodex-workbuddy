import { oauthAccountLogLabel } from "../../codex/account-label";
import type { ProviderAccount } from "../../oauth/types";
import { canonicalZaiPlanModel } from "../../oauth/zai-plan";
import type { RequestLogEntry } from "../request-log";
import { credentialGeneration } from "../../oauth/store";
import type { ZaiPlanBalance } from "../../oauth/zai-plan-balance";

const observations = new Map<string, { accountId: string; generation: string; loginId?: string; device?: string; balance: ZaiPlanBalance; at: number; until: number }>();
export function recordZaiPlanObservation(account: ProviderAccount, balance: ZaiPlanBalance, now = Date.now()): string {
  for (const [id, value] of observations) if (value.until <= now) observations.delete(id);
  if (observations.size >= 64) observations.delete(observations.keys().next().value!);
  const id = crypto.randomUUID();
  observations.set(id, { accountId: account.id, generation: credentialGeneration(account.credential), loginId: account.loginId, device: account.credential.zaiPlan?.deviceMid,
    balance: structuredClone(balance), at: now, until: Math.min(balance.validUntil, now + 60_000) });
  return id;
}

export function observedZaiPlanDecrease(id: string, account: ProviderAccount, after: ZaiPlanBalance, model: string, requestAt: number, now = Date.now()): number | null {
  const before = observations.get(id);
  if (!before || before.until <= now || before.at > requestAt || before.accountId !== account.id
    || before.generation !== credentialGeneration(account.credential) || before.loginId !== account.loginId || before.device !== account.credential.zaiPlan?.deviceMid
    || before.balance.state !== "available" || after.state === "unknown") return null;
  const old = before.balance.models.find(row => row.model === model), fresh = after.models.find(row => row.model === model);
  return old && fresh && old.total === fresh.total && old.expiresAt === fresh.expiresAt && fresh.used >= old.used
    && fresh.remaining <= old.remaining ? old.remaining - fresh.remaining : null;
}

/** Read-only provenance for a normal data-plane test; it never sends an inference request. */
export function projectZaiPlanDiagnostic(entry: RequestLogEntry, accounts: readonly ProviderAccount[], now = Date.now()) {
  const label = entry.attempts?.at(-1)?.accountLogLabel ?? entry.accountLogLabel;
  const matches = accounts.filter(account => oauthAccountLogLabel(account.id, "zai-plan") === label);
  const account = matches.length === 1 ? matches[0] : undefined;
  const last = entry.attempts?.at(-1);
  const model = canonicalZaiPlanModel((entry.servedModel ?? entry.wireModel ?? last?.model ?? entry.model).replace(/^zai-plan\//i, ""));
  const validModel = /^glm-[\w.-]{1,100}$/i.test(model);
  const recent = entry.timestamp <= now && now - entry.timestamp < 5 * 60_000;
  const verified = recent && entry.provider === "zai-plan" && last?.provider === "zai-plan" && last?.adapter === "zai-plan"
    && (last.sendCount ?? 0) > 0 && !!account && account.credential.access.split(".").length === 3 && validModel;
  return {
    requestId: entry.requestId, status: entry.status, elapsedMs: entry.durationMs,
    model: validModel ? model : null, verified, plan: verified ? "start-plan" : null,
    accountId: verified ? account!.id : null,
    sends: (entry.attempts ?? []).reduce((sum, attempt) => sum + Math.max(0, attempt.sendCount), 0),
    ...(typeof entry.firstOutputMs === "number" ? { firstOutputMs: entry.firstOutputMs } : {}),
  };
}
