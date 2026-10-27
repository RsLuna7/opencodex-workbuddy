import { getAccountSet } from "../oauth/store";
import { readZaiPlanBalance } from "../oauth/zai-plan-balance";

/** A model's name is not evidence of entitlement: discover only from this bearer account. */
export async function fetchZaiPlanUsableModels(access: string, readBalance = readZaiPlanBalance): Promise<{ ok: boolean; models: string[] }> {
  const account = getAccountSet("zai-plan")?.accounts.find(row => row.credential.access === access && !row.paused && !row.needsReauth);
  if (!account) return { ok: false, models: [] };
  const generation = account.credential.access;
  const balance = await readBalance(account.credential);
  const current = getAccountSet("zai-plan")?.accounts.find(row => row.id === account.id);
  if (!current || current.paused || current.needsReauth || current.credential.access !== generation
    || current.credential.zaiPlan?.deviceMid !== account.credential.zaiPlan?.deviceMid || balance.state === "unknown") return { ok: false, models: [] };
  return { ok: true, models: balance.models.filter(row => row.remaining > 0).map(row => row.model) };
}
