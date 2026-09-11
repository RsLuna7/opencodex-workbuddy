/**
 * Generic OAuth multi-account 429 failover (#2568).
 *
 * The API-key twin (`providers/key-failover.ts`) rotates by default for any key provider with a
 * 2+ pool, but it returns false for `authMode === "oauth"`, and the only OAuth rotator that
 * exists is Anthropic's — behind its own opt-in. So xAI, Cursor, Kimi, GitHub Copilot,
 * Antigravity and Nous have no recovery path on a 429 even with several accounts logged in.
 *
 * Deliberately narrower than the Anthropic pool: no session affinity, no quota-ranked selection,
 * no probe leases. Those carry provider-specific meaning; this module only answers "the account
 * that just 429'd is cooled, is there another one we may use".
 *
 * NOT a home for Codex (`codex/routing.ts` owns quota scopes and probe leases) or Anthropic
 * (`oauth/anthropic-routing.ts` owns affinity and a fail-closed local-cli credential rule).
 * Both are excluded by `isGenericFailoverProvider`.
 */
import { getAccountSet } from "./store";
import { getValidAccessSnapshotForAccount, type OAuthAccessSnapshot } from "./index";
import { exhaustedCooldownMs, hasHeadroomEvidence, isAccountQuotaExhausted, rankAccountsByHeadroom } from "./account-quota-rank";
import { parseRetryAfterMs } from "../combos/failover";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import type { OcxConfig, OcxProviderConfig } from "../types";

/** Cap same-request rotations so a short Retry-After cannot spin. Mirrors the Anthropic bound. */
export const GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST = 3;

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
/** WorkBuddy 6004/14018 windows are ~24h; keep a small ceiling above that. */
const QUOTA_RESET_COOLDOWN_DEFAULT_MS = 24 * 60 * 60_000;
const QUOTA_RESET_COOLDOWN_MAX_MS = 26 * 60 * 60_000;

export interface GenericOAuthRotateOptions {
  /** Default account-wide, matching today's 429 path. */
  scope?: "account" | "model";
  /** Required when `scope` is `model`; stripped of `provider/` if present. */
  modelId?: string;
  /** Absolute epoch ms from an upstream reset clock. */
  cooldownUntilMs?: number;
  /** Quota exhaustion (6004/14018): 24h default instead of the 15-minute 429 cap. */
  quotaExhausted?: boolean;
}

/**
 * How long a presence answer may be reused before the store is consulted again.
 *
 * `loadAuthStore` has no cache: every call chmods the config dir and the secret, reads the whole
 * file, parses it and normalizes the store (store.ts:136-151). Since presence now decides
 * activation, this predicate runs on paths that have not seen a 429 at all — the streaming and
 * non-streaming runTurn entry points evaluate it once per request — so an uncached check would put
 * a synchronous file read in front of every request for every OAuth provider.
 *
 * Two seconds is short enough that a login in another window is picked up before the operator can
 * switch back and send a prompt, and long enough that a burst of requests shares one read. The
 * cache holds a COUNT, never a credential.
 */
const PRESENCE_CACHE_TTL_MS = 2_000;

/**
 * Providers whose rotation is owned elsewhere and must not be handled here.
 *
 * `openai` is the Codex pool: quota scopes, probe leases and affinity semantics that this
 * module deliberately does not reimplement. `anthropic` has its own pool with a fail-closed
 * rule about background local-cli credential slots.
 */
const EXCLUDED_PROVIDERS = new Set(["openai", "anthropic"]);

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "reset-derived" | "default";
}

interface PresenceEntry {
  eligible: number;
  readAt: number;
}

/** Process-local, like the Anthropic pool's: a restart is allowed to forget a cooldown. */
const health = new Map<string, AccountHealth>();

/** Provider -> recent eligible-account count. TTL-bounded; never holds credential material. */
const presence = new Map<string, PresenceEntry>();

const healthKey = (provider: string, accountId: string, modelId?: string) => (
  modelId ? `${provider}\u0000${accountId}\u0000model\u0000${modelId}` : `${provider}\u0000${accountId}`
);

function readHealth(key: string, now: number): AccountHealth | undefined {
  const entry = health.get(key);
  if (!entry) return undefined;
  if (entry.cooldownUntil <= now) {
    health.delete(key);
    return undefined;
  }
  return entry;
}

function isCooled(provider: string, accountId: string, now: number, modelId?: string): boolean {
  if (readHealth(healthKey(provider, accountId), now)) return true;
  if (!modelId) return false;
  return readHealth(healthKey(provider, accountId, modelId), now) !== undefined;
}

/** Strip `provider/` so catalog ids and wire ids share one cooldown key. */
export function normalizeGenericFailoverModelId(
  providerName: string,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  const prefix = `${providerName}/`;
  if (trimmed.length > prefix.length && trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    return trimmed.slice(prefix.length);
  }
  return trimmed;
}

export function isGenericFailoverCooled(
  providerName: string,
  accountId: string,
  now = Date.now(),
  modelId?: string,
): boolean {
  return isCooled(providerName, accountId, now, normalizeGenericFailoverModelId(providerName, modelId));
}

export function applyGenericFailoverCooldown(opts: {
  providerName: string;
  accountId: string;
  cooldownMs: number;
  now?: number;
  modelId?: string;
  source?: AccountHealth["cooldownSource"];
}): void {
  const now = opts.now ?? Date.now();
  const modelId = normalizeGenericFailoverModelId(opts.providerName, opts.modelId);
  health.set(healthKey(opts.providerName, opts.accountId, modelId), {
    cooldownUntil: now + Math.max(opts.cooldownMs, 1),
    cooldownSource: opts.source ?? "default",
  });
}

/** True when this provider participates in generic rotation at all. */
export function isGenericFailoverProvider(providerName: string, provider: OcxProviderConfig): boolean {
  return provider.authMode === "oauth" && !EXCLUDED_PROVIDERS.has(providerName);
}

/**
 * Stored accounts that could serve traffic if asked, ignoring cooldowns.
 *
 * Cooldowns are excluded on purpose: they are transient and per-request, while this answers the
 * durable question "did the operator log in more than one account". Treating a cooled account as
 * absent would switch the feature off for the rest of the cooldown, which is exactly when it is
 * needed.
 */
function eligibleAccountCount(providerName: string, now: number): number {
  const cached = presence.get(providerName);
  if (cached && now >= cached.readAt && now - cached.readAt < PRESENCE_CACHE_TTL_MS) return cached.eligible;
  const set = getAccountSet(providerName);
  const eligible = set ? set.accounts.filter(account => account.needsReauth !== true).length : 0;
  presence.set(providerName, { eligible, readAt: now });
  return eligible;
}

/**
 * Presence IS consent (#2568d).
 *
 * `hasKeyPoolFailover` already reads a 2+ key pool as the operator asking for rotation, and a
 * second OAuth login is the same statement. One account stays a strict no-op either way, so this
 * only changes behaviour for someone who deliberately logged in twice.
 */
export function hasFailoverAccountQuorum(providerName: string, now = Date.now()): boolean {
  return eligibleAccountCount(providerName, now) >= 2;
}

/**
 * Whether REACTIVE 429 rotation is active for this provider.
 *
 * Presence is the only rule: two or more eligible stored accounts. The
 * `oauthAccountFailover.enabled` booleans no longer suppress it.
 *
 * That is a deliberate narrowing of #2568d. Rotation here runs only after upstream has already
 * refused the request, so the choice the old knob offered was between "retry on the second
 * account you deliberately logged in" and "return a 429 while that account sits idle". The
 * second is a defect, not a preference — and an operator who does not want rotation expresses
 * that by not storing a second account, exactly as they do for `apiKeyPool`.
 *
 * The knob is not gone. It still governs {@link isProactivePreferenceEnabled}, which decides
 * whether a HEALTHY request may be steered to a different account before dispatch — a real
 * behavioural choice that remains refusable — and it still carries `strategy` and
 * `autoSwitchThreshold`.
 */
export function isGenericOAuthFailoverEnabled(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  return hasFailoverAccountQuorum(providerName, now);
}

/**
 * Whether the pre-dispatch account PREFERENCE may run for this provider.
 *
 * Unlike reactive rotation, this moves a request that upstream has not refused, so it stays
 * refusable: an explicit provider value wins over the global default, and a global `false`
 * turns it off only when the provider has no override. A malformed value falls through rather
 * than taking a provider out of service.
 */
function isProactivePreferenceEnabled(config: OcxConfig, providerName: string, now: number): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  const perProvider = provider.oauthAccountFailover?.enabled;
  // Preserve the published narrow-over-broad precedence. A provider-specific true may
  // opt this provider into proactive preference even when the global default is false;
  // a provider-specific false refuses it even when the global setting is true.
  if (typeof perProvider === "boolean") {
    return perProvider && hasFailoverAccountQuorum(providerName, now);
  }
  return config.oauthAccountFailover?.enabled === true && hasFailoverAccountQuorum(providerName, now);
}

/** Accounts that may serve traffic right now: not cooled, not flagged for reauth. */
export function eligibleFailoverAccounts(
  providerName: string,
  now = Date.now(),
  modelId?: string,
): string[] {
  const set = getAccountSet(providerName);
  if (!set) return [];
  const normalizedModel = normalizeGenericFailoverModelId(providerName, modelId);
  return set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(providerName, account.id, now, normalizedModel))
    .map(account => account.id);
}

function resolveGenericCooldown(
  providerName: string,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  now: number,
  options?: GenericOAuthRotateOptions,
): { cooldownMs: number; source: AccountHealth["cooldownSource"] } {
  if (typeof options?.cooldownUntilMs === "number" && Number.isFinite(options.cooldownUntilMs)) {
    const ms = Math.min(Math.max(options.cooldownUntilMs - now, 1), QUOTA_RESET_COOLDOWN_MAX_MS);
    return { cooldownMs: ms, source: "reset-derived" };
  }
  if (options?.quotaExhausted === true || options?.scope === "model") {
    return { cooldownMs: QUOTA_RESET_COOLDOWN_DEFAULT_MS, source: "default" };
  }
  const parsed = parseRetryAfterMs(retryAfterHeader, now, { preserveImmediate: true });
  const exhausted = parsed === undefined ? exhaustedCooldownMs(providerName, failedAccountId, now) : null;
  return {
    cooldownMs: exhausted ?? Math.min(parsed ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS),
    source: parsed ? "retry-after" : "default",
  };
}

/**
 * Cool the account that actually 429'd (or quota-exhausted) and name the next eligible one, or null.
 *
 * Returns the id only; the caller mints the credential so a failed refresh does not leave the
 * cooldown applied to an account we then could not use.
 */
export function rotateGenericOAuthAccountOn429(
  config: OcxConfig,
  providerName: string,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  options?: GenericOAuthRotateOptions,
): string | null {
  if (!isGenericOAuthFailoverEnabled(config, providerName)) return null;
  const set = getAccountSet(providerName);
  // A single stored account has nowhere to go; rotating to itself would just replay the 429.
  if (!set || set.accounts.length < 2) return null;

  const modelId = options?.scope === "model"
    ? normalizeGenericFailoverModelId(providerName, options.modelId)
    : undefined;
  const { cooldownMs, source } = resolveGenericCooldown(
    providerName, failedAccountId, retryAfterHeader, now, options,
  );
  applyGenericFailoverCooldown({
    providerName,
    accountId: failedAccountId,
    cooldownMs,
    now,
    modelId,
    source,
  });
  sweepExpiredOnWrite(now);

  const eligible = eligibleFailoverAccounts(providerName, now, modelId).filter(id => id !== failedAccountId);
  if (eligible.length === 0) return null;
  // A rotation means the roster in use just changed; do not answer the next activation question
  // from a count read before the failure.
  presence.delete(providerName);
  // Deterministic: start after the failed account so repeated 429s walk the roster instead of
  // hammering whichever id happens to sort first. The ring is built BEFORE ranking — ranking
  // the store's own order would change which account a quota-less provider rotates to.
  const order = set.accounts.map(account => account.id);
  const start = order.indexOf(failedAccountId);
  const ring = start >= 0 ? [...order.slice(start + 1), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id));
  if (candidates.length === 0) return null;
  // With no quota evidence this returns the ring untouched, so providers without
  // per-account quota keep exactly the traversal they have today.
  return rankAccountsByHeadroom(providerName, candidates)[0] ?? null;
}

/** True when this response should enter the generic OAuth rotation loop. */
export function shouldAttemptGenericOAuthFailover(
  config: OcxConfig,
  providerName: string,
  status: number,
  accountId: string | null | undefined,
  failovers: number,
  quotaHint?: { scope: "account" | "model" } | null,
): boolean {
  if (!accountId || failovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST) return false;
  if (!isGenericOAuthFailoverEnabled(config, providerName)) return false;
  if (status === 429) return true;
  return quotaHint != null && status === 402;
}

/**
 * Full credential snapshot for a rotated account.
 *
 * Returns the snapshot rather than a bare bearer: Antigravity pairs an account-matched
 * `projectId` with its token and Kiro carries routing metadata, so a token-only swap would mix
 * one account's bearer with another's routing data.
 */
export async function failoverAccountSnapshot(
  providerName: string,
  accountId: string,
): Promise<OAuthAccessSnapshot> {
  return getValidAccessSnapshotForAccount(providerName, accountId);
}

/**
 * Which account should serve the FIRST attempt of a request.
 *
 * Rotation only ever ran after a 429, so a turn still opened on whichever account happened
 * to be active — including one a previous probe already measured as spent. That costs a
 * full upstream round trip and one of three rotations to rediscover what the cache knew.
 *
 * Returns null whenever the ordinary active-account path should be used unchanged.
 * Proactive ranking still needs quota evidence. Cooldown avoidance does not: an account
 * already cooled for this model (or the whole account) is skipped even when the
 * proactive knob is off. An empty answer means "carry on", not "refuse".
 */
function pickUncooledFromRing(
  providerName: string,
  order: string[],
  active: string | undefined,
  now: number,
  modelId: string | undefined,
  rank: boolean,
): string | null {
  const eligible = order.filter(id => !isCooled(providerName, id, now, modelId));
  if (eligible.length === 0) return null;
  const start = active ? order.indexOf(active) : -1;
  const ring = start >= 0 ? [...order.slice(start), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => eligible.includes(id));
  if (candidates.length === 0) return null;
  const best = rank
    ? rankAccountsByHeadroom(providerName, candidates)[0] ?? null
    : candidates[0] ?? null;
  return best && best !== active ? best : null;
}

export function preferredInitialAccount(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  modelId?: string,
): string | null {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return null;
  const selected = getAccountSet(providerName);
  if (!selected) return null;
  const active = selected.activeAccountId;
  const order = selected.accounts.filter(account => account.needsReauth !== true).map(account => account.id);
  if (order.length < 2) return null;
  const normalizedModel = normalizeGenericFailoverModelId(providerName, modelId);

  // The PROACTIVE predicate, not the reactive one: this steers a request upstream has not
  // refused, so `oauthAccountFailover.enabled: false` must still be able to refuse it.
  if (isProactivePreferenceEnabled(config, providerName, now)) {
    const activeRow = selected.accounts.find(account => account.id === active);
    if (activeRow && activeRow.needsReauth !== true
      && !isCooled(providerName, activeRow.id, now, normalizedModel)
      && !isAccountQuotaExhausted(providerName, activeRow.id)) return null;

    // Evidence is required BEFORE eligibility narrows the field. Without this, a provider
    // with no quota data at all could still be redirected: cool the active account with a
    // 429 and the eligible list collapses to one candidate, which any ranking returns
    // unchanged — an answer that looks ranked but was never measured. The no-op guarantee
    // for quota-less providers has to be checked on the full roster.
    if (!hasHeadroomEvidence(providerName, order)) return null;

    return pickUncooledFromRing(providerName, order, active, now, normalizedModel, true);
  }

  // Cooldown avoidance is not proactive ranking: we already refused this account×model
  // (or the whole account) on a previous request. Presence is still required.
  if (!hasFailoverAccountQuorum(providerName, now)) return null;
  const activeRow = selected.accounts.find(account => account.id === active);
  if (activeRow && activeRow.needsReauth !== true
    && !isCooled(providerName, activeRow.id, now, normalizedModel)
    && !isAccountQuotaExhausted(providerName, activeRow.id)) return null;
  return pickUncooledFromRing(providerName, order, active, now, normalizedModel, false);
}

/** Earliest remaining cooldown, for a client-facing Retry-After when every account is cooled. */
export function genericFailoverRetryAfterSeconds(providerName: string, now = Date.now()): number | null {
  const set = getAccountSet(providerName);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const entry = health.get(healthKey(providerName, account.id));
    if (!entry || entry.cooldownUntil <= now) continue;
    if (earliest === null || entry.cooldownUntil < earliest) earliest = entry.cooldownUntil;
  }
  return earliest === null ? null : Math.max(1, Math.ceil((earliest - now) / 1000));
}

/** Test seam and manual-recovery hook. */
export function forgetGenericFailoverRoster(providerName: string): void {
  presence.delete(providerName);
}

/** Test seam and manual-recovery hook. */
export function clearGenericFailoverHealth(providerName?: string): void {
  if (!providerName) {
    health.clear();
    presence.clear();
    return;
  }
  presence.delete(providerName);
  for (const key of [...health.keys()]) {
    if (key.startsWith(`${providerName}\u0000`)) health.delete(key);
  }
}
