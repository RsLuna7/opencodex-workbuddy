/**
 * WorkBuddy dedicated account pool (Q1–Q9).
 *
 * Persist is the source of truth for cooldowns, breaker, credits, and cost
 * observations. Pick / sticky / inflight sit on that state.
 *
 * Algorithms ported from Sliverkiss/workbuddy2api `internal/pool` (MIT).
 */
import { createHash } from "node:crypto";
import { CODEBUDDY_PROVIDER_ID } from "./codebuddy";
import { credentialWorkbuddyRealm, type WorkbuddyRealm } from "./codebuddy-realm";
import { getAccountSet } from "./store";
import type { OcxConfig } from "../types";
import {
  WORKBUDDY_MODEL_COST_TTL_MS,
  WORKBUDDY_SESSION_TTL_MS,
  emptyWorkbuddyPoolFile,
  ensureWorkbuddyPoolShutdownHook,
  loadWorkbuddyPoolFile,
  parseWorkbuddyPoolFile,
  resetWorkbuddyPoolShutdownHookForTests,
  saveWorkbuddyPoolFile,
  type WorkbuddyPersistedAccount,
  type WorkbuddyPersistedModelCooldown,
  type WorkbuddyPersistedModelCost,
  type WorkbuddyPersistedSession,
  type WorkbuddyPoolFile,
} from "./workbuddy-pool-state";

const EXPIRING_WEIGHT = 8;
const CREDITS_SCALE = 10;
const IDLE_PER_HOUR = 0.5;
const IDLE_MAX = 5;
const TOP_N = 5;
const MIN_PICK_GAP_MS = 100;
const MAX_IN_FLIGHT_CN = 3;
const MAX_IN_FLIGHT_GLOBAL = 2;
const BREAKER_THRESHOLD = 3;
const BREAKER_BASE_MS = 30 * 60_000;
const BREAKER_MAX_MS = 6 * 60 * 60_000;
const COST_EXPLORE_INTERVAL_MS = 30 * 60_000;
const FLUSH_DEBOUNCE_MS = 5_000;

interface AccountRuntime {
  credits: number;
  creditsExpiring: number;
  until: number;
  reason?: string;
  modelCooldowns: Map<string, WorkbuddyPersistedModelCooldown>;
  modelCosts: Map<string, WorkbuddyPersistedModelCost>;
  breakerUntil: number;
  retryCount: number;
  consecutiveFails: number;
  successCount: number;
  errTotal: number;
  lastUsed: number;
  lastSuccess: number;
  lastErr: number;
}

const accounts = new Map<string, AccountRuntime>();
const sessions = new Map<string, WorkbuddyPersistedSession>();
const inFlight = new Map<string, number>();
const exploreLast = new Map<string, number>();
let loaded = false;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let rng: () => number = Math.random;

function ensureAccount(id: string): AccountRuntime {
  let row = accounts.get(id);
  if (row) return row;
  row = {
    credits: 0,
    creditsExpiring: 0,
    until: 0,
    modelCooldowns: new Map(),
    modelCosts: new Map(),
    breakerUntil: 0,
    retryCount: 0,
    consecutiveFails: 0,
    successCount: 0,
    errTotal: 0,
    lastUsed: 0,
    lastSuccess: 0,
    lastErr: 0,
  };
  accounts.set(id, row);
  return row;
}

function hydrateFromFile(file: WorkbuddyPoolFile): void {
  accounts.clear();
  sessions.clear();
  for (const [id, persisted] of Object.entries(file.accounts)) {
    const row = ensureAccount(id);
    row.credits = persisted.credits ?? 0;
    row.creditsExpiring = Math.min(persisted.creditsExpiring ?? 0, row.credits);
    row.until = persisted.until ?? 0;
    row.reason = persisted.reason;
    row.breakerUntil = persisted.breakerUntil ?? 0;
    row.retryCount = persisted.retryCount ?? 0;
    row.consecutiveFails = persisted.consecutiveFails ?? 0;
    row.successCount = persisted.successCount ?? 0;
    row.errTotal = persisted.errTotal ?? 0;
    row.lastUsed = persisted.lastUsed ?? 0;
    row.lastSuccess = persisted.lastSuccess ?? 0;
    row.lastErr = persisted.lastErr ?? 0;
    if (persisted.modelCooldowns) {
      for (const [model, cooldown] of Object.entries(persisted.modelCooldowns)) {
        row.modelCooldowns.set(model, cooldown);
      }
    }
    if (persisted.modelCosts) {
      for (const [model, cost] of Object.entries(persisted.modelCosts)) {
        row.modelCosts.set(model, cost);
      }
    }
  }
  if (file.sessions) {
    for (const [key, session] of Object.entries(file.sessions)) sessions.set(key, session);
  }
}

export function ensureWorkbuddyPoolLoaded(now = Date.now()): void {
  if (loaded) return;
  loaded = true;
  hydrateFromFile(loadWorkbuddyPoolFile(now));
  ensureWorkbuddyPoolShutdownHook(() => flushWorkbuddyPool());
}

function snapshotFile(now = Date.now()): WorkbuddyPoolFile {
  const file = emptyWorkbuddyPoolFile();
  for (const [id, row] of accounts) {
    const persisted: WorkbuddyPersistedAccount = {};
    if (row.credits > 0) persisted.credits = row.credits;
    if (row.creditsExpiring > 0) persisted.creditsExpiring = Math.min(row.creditsExpiring, row.credits);
    if (row.until > now) {
      persisted.until = row.until;
      if (row.reason) persisted.reason = row.reason;
    }
    const modelCooldowns: Record<string, WorkbuddyPersistedModelCooldown> = {};
    for (const [model, cooldown] of row.modelCooldowns) {
      if (cooldown.until > now) modelCooldowns[model] = cooldown;
    }
    if (Object.keys(modelCooldowns).length > 0) persisted.modelCooldowns = modelCooldowns;
    const modelCosts: Record<string, WorkbuddyPersistedModelCost> = {};
    for (const [model, cost] of row.modelCosts) {
      if (now - cost.lastSeen <= WORKBUDDY_MODEL_COST_TTL_MS) modelCosts[model] = cost;
    }
    if (Object.keys(modelCosts).length > 0) persisted.modelCosts = modelCosts;
    if (row.breakerUntil > now) {
      persisted.breakerUntil = row.breakerUntil;
      if (row.retryCount > 0) persisted.retryCount = row.retryCount;
    }
    if (row.consecutiveFails > 0) persisted.consecutiveFails = row.consecutiveFails;
    if (row.successCount > 0) persisted.successCount = row.successCount;
    if (row.errTotal > 0) persisted.errTotal = row.errTotal;
    if (row.lastUsed > 0) persisted.lastUsed = row.lastUsed;
    if (row.lastSuccess > 0) persisted.lastSuccess = row.lastSuccess;
    if (row.lastErr > 0) persisted.lastErr = row.lastErr;
    if (Object.keys(persisted).length > 0) file.accounts[id] = persisted;
  }
  const sessionOut: Record<string, WorkbuddyPersistedSession> = {};
  for (const [key, session] of sessions) {
    if (now - session.lastActive <= WORKBUDDY_SESSION_TTL_MS) sessionOut[key] = session;
  }
  if (Object.keys(sessionOut).length > 0) file.sessions = sessionOut;
  return parseWorkbuddyPoolFile(JSON.stringify(file), now);
}

export function flushWorkbuddyPool(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  saveWorkbuddyPoolFile(snapshotFile());
}

function markDirty(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWorkbuddyPool();
  }, FLUSH_DEBOUNCE_MS);
}

export function resetWorkbuddyPoolForTests(): void {
  accounts.clear();
  sessions.clear();
  inFlight.clear();
  exploreLast.clear();
  loaded = false;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  resetWorkbuddyPoolShutdownHookForTests();
}

export function setWorkbuddyPoolRngForTests(next: () => number): void {
  rng = next;
}

function modelIdOf(modelId?: string | null): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  const prefix = `${CODEBUDDY_PROVIDER_ID}/`;
  if (trimmed.length > prefix.length && trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function accountRealm(accountId: string): WorkbuddyRealm {
  const row = getAccountSet(CODEBUDDY_PROVIDER_ID)?.accounts.find(account => account.id === accountId);
  return credentialWorkbuddyRealm(row?.credential);
}

export function isWorkbuddyPoolCooled(
  accountId: string,
  modelId?: string | null,
  now = Date.now(),
): boolean {
  ensureWorkbuddyPoolLoaded(now);
  const row = accounts.get(accountId);
  if (!row) return false;
  if (row.breakerUntil > now) return true;
  if (row.until > now) return true;
  const model = modelIdOf(modelId);
  if (!model) return false;
  const cooldown = row.modelCooldowns.get(model);
  return !!cooldown && cooldown.until > now;
}

export function noteWorkbuddyPoolCooldown(opts: {
  accountId: string;
  modelId?: string | null;
  untilMs: number;
  reason?: string;
  now?: number;
}): void {
  const now = opts.now ?? Date.now();
  ensureWorkbuddyPoolLoaded(now);
  const row = ensureAccount(opts.accountId);
  const until = Math.max(opts.untilMs, now + 1);
  const model = modelIdOf(opts.modelId);
  if (model) {
    row.modelCooldowns.set(model, {
      until,
      resetAt: until,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
  } else {
    row.until = until;
    row.reason = opts.reason;
    row.modelCooldowns.clear();
  }
  markDirty();
}

export function noteWorkbuddyPoolSuccess(opts: {
  accountId: string;
  modelId?: string | null;
  costPer1k?: number;
  now?: number;
}): void {
  const now = opts.now ?? Date.now();
  ensureWorkbuddyPoolLoaded(now);
  const row = ensureAccount(opts.accountId);
  row.consecutiveFails = 0;
  row.breakerUntil = 0;
  row.retryCount = 0;
  row.successCount += 1;
  row.lastSuccess = now;
  row.lastUsed = now;
  const model = modelIdOf(opts.modelId);
  if (model && typeof opts.costPer1k === "number" && Number.isFinite(opts.costPer1k)) {
    const prev = row.modelCosts.get(model);
    const samples = (prev?.samples ?? 0) + 1;
    const blended = prev
      ? prev.costPer1k + (opts.costPer1k - prev.costPer1k) / samples
      : opts.costPer1k;
    row.modelCosts.set(model, { costPer1k: blended, lastSeen: now, samples });
  }
  markDirty();
}

export function noteWorkbuddyPoolFailure(opts: { accountId: string; now?: number }): void {
  const now = opts.now ?? Date.now();
  ensureWorkbuddyPoolLoaded(now);
  const row = ensureAccount(opts.accountId);
  row.consecutiveFails += 1;
  row.errTotal += 1;
  row.lastErr = now;
  if (row.consecutiveFails >= BREAKER_THRESHOLD) {
    const exp = Math.min(row.retryCount, 6);
    const cooldown = Math.min(BREAKER_BASE_MS * (2 ** exp), BREAKER_MAX_MS);
    row.retryCount += 1;
    row.breakerUntil = now + cooldown;
    row.consecutiveFails = 0;
  }
  markDirty();
}

export function setWorkbuddyPoolCredits(
  accountId: string,
  credits: number,
  creditsExpiring = 0,
  now = Date.now(),
): void {
  ensureWorkbuddyPoolLoaded(now);
  const row = ensureAccount(accountId);
  row.credits = Math.max(0, credits);
  row.creditsExpiring = Math.min(Math.max(0, creditsExpiring), row.credits);
  markDirty();
}

function maxInFlight(accountId: string): number {
  return accountRealm(accountId) === "global" ? MAX_IN_FLIGHT_GLOBAL : MAX_IN_FLIGHT_CN;
}

export function acquireWorkbuddyLease(accountId: string): boolean {
  ensureWorkbuddyPoolLoaded();
  const current = inFlight.get(accountId) ?? 0;
  if (current >= maxInFlight(accountId)) return false;
  inFlight.set(accountId, current + 1);
  return true;
}

export function releaseWorkbuddyLease(accountId: string): void {
  const current = inFlight.get(accountId) ?? 0;
  if (current <= 1) inFlight.delete(accountId);
  else inFlight.set(accountId, current - 1);
}

export function workbuddyLeaseCountForTests(accountId: string): number {
  return inFlight.get(accountId) ?? 0;
}

function inFlightFull(accountId: string): boolean {
  return (inFlight.get(accountId) ?? 0) >= maxInFlight(accountId);
}

function costTier(row: AccountRuntime, model: string | undefined, now: number): 0 | 1 | 2 {
  if (!model) return 1;
  const cost = row.modelCosts.get(model);
  if (!cost || now - cost.lastSeen > WORKBUDDY_MODEL_COST_TTL_MS) return 1;
  return cost.costPer1k <= 0 ? 0 : 2;
}

function weightOf(row: AccountRuntime, maxCredits: number, now: number): number {
  let w = 1;
  if (maxCredits > 0) w += (row.credits / maxCredits) * CREDITS_SCALE;
  if (row.credits > 0 && row.creditsExpiring > 0) {
    w += (row.creditsExpiring / row.credits) * EXPIRING_WEIGHT;
  }
  if (row.lastUsed <= 0) w += IDLE_MAX;
  else {
    const hours = (now - row.lastUsed) / 3_600_000;
    w += Math.min(Math.max(hours * IDLE_PER_HOUR, 0), IDLE_MAX);
  }
  return w;
}

function healthy(accountId: string, model: string | undefined, now: number): boolean {
  const set = getAccountSet(CODEBUDDY_PROVIDER_ID);
  const stored = set?.accounts.find(account => account.id === accountId);
  if (!stored || stored.needsReauth === true) return false;
  if (inFlightFull(accountId)) return false;
  return !isWorkbuddyPoolCooled(accountId, model, now);
}

export function extractWorkbuddySessionKey(
  parsed: { options?: { promptCacheKey?: string } },
): string | undefined {
  const key = parsed.options?.promptCacheKey?.trim();
  return key || undefined;
}

export function bindWorkbuddySession(sessionKey: string, accountId: string, now = Date.now()): void {
  ensureWorkbuddyPoolLoaded(now);
  sessions.set(sessionKey, { accountId, lastActive: now });
  markDirty();
}

function stickyAccount(sessionKey: string | undefined, model: string | undefined, now: number): string | undefined {
  if (!sessionKey) return undefined;
  const bound = sessions.get(sessionKey);
  if (!bound) return undefined;
  if (now - bound.lastActive > WORKBUDDY_SESSION_TTL_MS) {
    sessions.delete(sessionKey);
    return undefined;
  }
  if (!healthy(bound.accountId, model, now)) {
    sessions.delete(sessionKey);
    return undefined;
  }
  bound.lastActive = now;
  markDirty();
  return bound.accountId;
}

function pickWeighted(ids: string[], model: string | undefined, now: number, realm: WorkbuddyRealm): string | null {
  const rows = ids.map(id => ({ id, row: ensureAccount(id) }));
  let maxCredits = 0;
  for (const item of rows) if (item.row.credits > maxCredits) maxCredits = item.row.credits;
  let bestTier: 0 | 1 | 2 = 2;
  for (const item of rows) {
    const tier = costTier(item.row, model, now);
    if (tier < bestTier) bestTier = tier;
  }
  if (bestTier === 0 && model) {
    const hasUnknown = rows.some(item => costTier(item.row, model, now) === 1);
    const exploreKey = `${realm}\u001f${model}`;
    const last = exploreLast.get(exploreKey) ?? 0;
    if (hasUnknown && now - last >= COST_EXPLORE_INTERVAL_MS) {
      exploreLast.set(exploreKey, now);
      bestTier = 1;
    }
  }
  const layered = rows.filter(item => costTier(item.row, model, now) === bestTier);
  const ranked = layered
    .map(item => ({ id: item.id, row: item.row, w: weightOf(item.row, maxCredits, now) }))
    .sort((a, b) => b.w - a.w);
  const shortlist = ranked.slice(0, TOP_N);
  const fresh = shortlist.filter(item => now - item.row.lastUsed >= MIN_PICK_GAP_MS);
  const pool = fresh.length > 0 ? fresh : [...shortlist].sort((a, b) => a.row.lastUsed - b.row.lastUsed);
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, item) => sum + item.w, 0);
  let cursor = rng() * total;
  for (const item of pool) {
    cursor -= item.w;
    if (cursor <= 0) return item.id;
  }
  return pool[pool.length - 1]?.id ?? null;
}

export function pickWorkbuddyAccount(opts: {
  modelId?: string | null;
  exclude?: Iterable<string>;
  realmPeerAccountId?: string;
  now?: number;
  sessionKey?: string;
}): string | null {
  const now = opts.now ?? Date.now();
  ensureWorkbuddyPoolLoaded(now);
  const set = getAccountSet(CODEBUDDY_PROVIDER_ID);
  if (!set) return null;
  const model = modelIdOf(opts.modelId);
  const excluded = new Set(opts.exclude ?? []);
  const peer = opts.realmPeerAccountId ?? set.activeAccountId;
  const realm = peer ? accountRealm(peer) : "cn";
  const sticky = stickyAccount(opts.sessionKey, model, now);
  if (sticky && !excluded.has(sticky) && accountRealm(sticky) === realm) return sticky;
  const candidates = set.accounts
    .filter(account => account.needsReauth !== true)
    .filter(account => !excluded.has(account.id))
    .filter(account => !peer || credentialWorkbuddyRealm(account.credential) === realm)
    .map(account => account.id)
    .filter(id => healthy(id, model, now));
  if (candidates.length === 0) return null;
  const picked = pickWeighted(candidates, model, now, realm);
  if (picked) {
    ensureAccount(picked).lastUsed = now;
    markDirty();
  }
  return picked;
}

/**
 * First-attempt preference. Keeps the operator's active account when it is
 * healthy. Session sticky and cooldown avoidance may name a spare.
 */
export function preferredWorkbuddyAccount(
  _config: OcxConfig,
  now = Date.now(),
  requestedModelId?: string | null,
  sessionKey?: string,
): string | null {
  const set = getAccountSet(CODEBUDDY_PROVIDER_ID);
  if (!set) return null;
  const usable = set.accounts.filter(account => account.needsReauth !== true);
  if (usable.length < 2) return null;
  const active = set.activeAccountId;
  const model = modelIdOf(requestedModelId);
  const sticky = stickyAccount(sessionKey, model, now);
  if (sticky && sticky !== active) return sticky;
  if (active && healthy(active, model, now)) return null;
  const picked = pickWorkbuddyAccount({
    modelId: requestedModelId,
    realmPeerAccountId: active,
    now,
    sessionKey,
  });
  return picked && picked !== active ? picked : null;
}

export function workbuddyAccountIdForUid(uid: string | undefined): string | undefined {
  if (!uid) return undefined;
  return getAccountSet(CODEBUDDY_PROVIDER_ID)?.accounts.find(
    account => account.credential.codebuddy?.uid === uid || account.credential.accountId === uid,
  )?.id;
}

export function hashWorkbuddySessionFallback(text: string): string {
  return `fb:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}
