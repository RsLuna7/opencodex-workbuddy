import type { OAuthCredentials } from "../../oauth/types";
import { readZaiPlanBalance } from "../../oauth/zai-plan-balance";
import { TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";

export async function fetchZaiPlanQuota(provider: string, credential: OAuthCredentials, readBalance = readZaiPlanBalance): Promise<ProviderQuotaProbeResult> {
  const balance = await readBalance(credential, { force: true });
  if (balance.state === "unknown") return TERMINAL_QUOTA_FAILURE;
  return { provider, label: "ZCode Start Plan", source: "ZCode Start Plan billing balance", updatedAt: balance.sampledAt,
    reverseEngineered: true, quota: { updatedAt: balance.sampledAt, customWindows: balance.models.map(row => ({
      label: row.model, modelId: row.model, percent: row.total > 0 ? Math.max(0, Math.min(100, (1 - row.remaining / row.total) * 100)) : 100,
      scope: "model" as const, ...(row.expiresAt ? { resetAt: row.expiresAt } : {}),
    })) } };
}
