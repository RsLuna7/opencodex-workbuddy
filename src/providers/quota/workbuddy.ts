/**
 * WorkBuddy per-account quota probe (remaining inference credits).
 *
 * Loaded only from the explicit OAuth quota reader — not on the inference path.
 */
import type { OAuthCredentials } from "../../oauth/types";
import {
  fetchWorkbuddyDashboardSnapshot,
  WORKBUDDY_CREDITS_WINDOW_LABEL,
  type WorkbuddyAccountActivity,
} from "../../oauth/workbuddy-credits";
import { setWorkbuddyPoolCredits } from "../../oauth/workbuddy-pool";
import { report, type ProviderQuotaReport } from "./report-cache";
import type { ProviderQuota } from "../quota-types";

export interface WorkbuddyQuotaProbe {
  report: ProviderQuotaReport | null;
  activity?: WorkbuddyAccountActivity;
}

export function workbuddyQuotaFromCredits(
  remain: number,
  used: number,
  size: number,
  expiresAt?: number,
  now = Date.now(),
): ProviderQuota | null {
  if (!(size > 0) && !(remain >= 0 && used >= 0)) return null;
  const limit = size > 0 ? size : remain + used;
  if (!(limit > 0)) return null;
  const boundedRemain = Math.max(0, remain);
  const boundedUsed = Math.max(0, used);
  const percent = Math.max(0, Math.min(100, (boundedUsed / limit) * 100));
  return {
    customWindows: [{
      label: WORKBUDDY_CREDITS_WINDOW_LABEL,
      percent,
      ...(expiresAt !== undefined ? { resetAt: expiresAt } : {}),
    }],
    creditsUsd: {
      used: boundedUsed,
      limit,
      remaining: boundedRemain,
      percent,
      unit: "points",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    updatedAt: now,
  };
}

export async function fetchWorkbuddyQuotaReport(
  provider: string,
  credential: OAuthCredentials,
  accountId?: string,
): Promise<WorkbuddyQuotaProbe> {
  const snapshot = await fetchWorkbuddyDashboardSnapshot(credential);
  const credits = snapshot.credits;
  if (credits && accountId && Number.isFinite(credits.remain)) {
    setWorkbuddyPoolCredits(accountId, credits.remain);
  }
  const quota = credits
    ? workbuddyQuotaFromCredits(credits.remain, credits.used, credits.size, credits.expiresAt)
    : null;
  return {
    report: quota ? report(provider, "workbuddy:get-user-resource", quota) : null,
    ...(snapshot.activity ? { activity: snapshot.activity } : {}),
  };
}
