/**
 * Per-account OAuth quota readers that talk to a vendor billing endpoint.
 *
 * Split from `quota.ts` so a new reader (WorkBuddy) does not grow that file's cap.
 */
import { getAccountCredential, getAccountSet } from "../../oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { WorkbuddyAccountActivity } from "../quota-types";
import { ACCOUNT_QUOTA_TTL_MS } from "../quota-wire";
import {
  accountCacheKey,
  accountQuotaCache,
  accountQuotaInflight,
  explicitAccountEpoch,
  explicitQuotaConfig,
  explicitQuotaDestination,
  explicitQuotaIdentity,
  getTokenForAccountQuotaProbe,
  type AccountQuotaCacheEntry,
} from "./account-cache";
import {
  accountReportCurrent,
  AUTHORITATIVE_EMPTY_QUOTA,
  LAST_GOOD_MAX_AGE_MS,
  TERMINAL_QUOTA_FAILURE,
  type ProviderQuotaProbeResult,
} from "./report-cache";
import { fetchCursorQuota, fetchXaiQuota } from "./vendor-probes-oauth";
import { fetchCommandCodeQuota, fetchKimiQuota } from "./vendor-probes-key";

type ExplicitRead = {
  result: ProviderQuotaProbeResult;
  identity: string | undefined;
  isCurrent: () => boolean;
  workbuddy?: WorkbuddyAccountActivity;
};

export async function readExplicitAccountQuota(
  provider: string,
  accountId: string,
  configured?: OcxProviderConfig,
): Promise<ExplicitRead | null> {
  const target = explicitQuotaConfig(provider, configured);
  if (!target || !explicitQuotaDestination(provider, target)) return null;
  const config = { ...target };
  const epoch = explicitAccountEpoch;
  const accessToken = await getTokenForAccountQuotaProbe(provider, accountId);
  const credential = getAccountCredential(provider, accountId);
  if (!credential || credential.access !== accessToken) return null;
  const identity = explicitQuotaIdentity(provider, accountId, config);
  const isCurrent = () => epoch === explicitAccountEpoch
    && identity === explicitQuotaIdentity(provider, accountId, configured);
  if (!isCurrent()) return null;
  let result: ProviderQuotaProbeResult;
  let workbuddy: WorkbuddyAccountActivity | undefined;
  switch (provider) {
    case "xai": result = await fetchXaiQuota(provider, { accessToken, upstreamAccountId: credential.accountId }); break;
    case "cursor": result = await fetchCursorQuota(provider, accessToken); break;
    case "kimi": result = await fetchKimiQuota(provider, config, accessToken); break;
    case "command-code": result = await fetchCommandCodeQuota(provider, config, accessToken); break;
    case "workbuddy": {
      const { fetchWorkbuddyQuotaReport } = await import("./workbuddy");
      const probed = await fetchWorkbuddyQuotaReport(provider, credential, accountId);
      result = probed.report;
      workbuddy = probed.activity;
      break;
    }
    default: return null;
  }
  return { result, identity, isCurrent, ...(workbuddy ? { workbuddy } : {}) };
}

export async function fetchExplicitAccountQuota(
  provider: string,
  accountId: string,
  force: boolean,
  configured?: OcxProviderConfig,
): Promise<AccountQuotaCacheEntry> {
  const key = accountCacheKey(provider, accountId);
  const identity = explicitQuotaIdentity(provider, accountId, configured);
  const previous = accountQuotaCache.get(key);
  const cached = identity && previous?.identity === identity && previous.isCurrent?.() ? previous : undefined;
  if (!force && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS
    && (!cached.quota || Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS)) return cached;
  const flightKey = `${key}\u0000${identity ?? "missing"}`;
  const running = accountQuotaInflight.get(flightKey);
  if (running) return running;
  const epoch = explicitAccountEpoch;
  const lastGood = cached?.quota && Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS ? cached.quota : null;
  const flight = (async (): Promise<AccountQuotaCacheEntry> => {
    let read: ExplicitRead | null = null;
    try { read = await readExplicitAccountQuota(provider, accountId, configured); } catch { /* unavailable */ }
    const isCurrent = read?.isCurrent ?? (() => epoch === explicitAccountEpoch && !!identity
      && identity === explicitQuotaIdentity(provider, accountId, configured));
    const result = read?.result;
    const current = epoch === explicitAccountEpoch && isCurrent();
    const quota = current && result && typeof result !== "symbol" ? result.quota : null;
    const empty = result === AUTHORITATIVE_EMPTY_QUOTA;
    const entry: AccountQuotaCacheEntry = {
      ts: Date.now(),
      quota: quota ?? (current && result !== TERMINAL_QUOTA_FAILURE && !empty
        && lastGood && Date.now() - lastGood.updatedAt < LAST_GOOD_MAX_AGE_MS ? lastGood : null),
      ...(!current || (!quota && !empty) ? { unavailable: true as const } : {}),
      identity: read?.identity ?? identity,
      isCurrent: () => epoch === explicitAccountEpoch && isCurrent(),
      ...(read?.workbuddy ? { workbuddy: read.workbuddy } : {}),
    };
    if (entry.isCurrent?.()) accountQuotaCache.set(key, entry);
    return entry;
  })().finally(() => { if (accountQuotaInflight.get(flightKey) === flight) accountQuotaInflight.delete(flightKey); });
  accountQuotaInflight.set(flightKey, flight);
  return flight;
}

export async function fetchExplicitCurrentQuota(
  provider: string,
  config: OcxProviderConfig,
  liveConfig: OcxConfig,
): Promise<ProviderQuotaProbeResult> {
  const id = getAccountSet(provider)?.activeAccountId;
  if (!id) return null;
  const read = await readExplicitAccountQuota(provider, id, config);
  if (!read) return null;
  const isCurrent = () => liveConfig.providers[provider] === config
    && read.isCurrent() && getAccountSet(provider)?.activeAccountId === id;
  if (!isCurrent()) return TERMINAL_QUOTA_FAILURE;
  if (read.result && typeof read.result !== "symbol") accountReportCurrent.set(read.result, isCurrent);
  return read.result;
}
