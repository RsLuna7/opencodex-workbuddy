/**
 * WorkBuddy pool disk format (`~/.opencodex/workbuddy-pool.json`).
 *
 * Schema is a TypeScript port of Sliverkiss/workbuddy2api `internal/pool` persist
 * (MIT): cooldowns, breaker, credits, cost ledger. No Redis. Epoch ms, not Go times.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir, hardenConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";

export const WORKBUDDY_POOL_FILE = "workbuddy-pool.json";
export const WORKBUDDY_POOL_VERSION = 1;
export const WORKBUDDY_MODEL_COST_TTL_MS = 6 * 60 * 60_000;
export const WORKBUDDY_SESSION_TTL_MS = 30 * 60_000;

export interface WorkbuddyPersistedModelCooldown {
  until: number;
  resetAt?: number;
  reason?: string;
}

export interface WorkbuddyPersistedModelCost {
  costPer1k: number;
  lastSeen: number;
  samples?: number;
}

export interface WorkbuddyPersistedAccount {
  credits?: number;
  creditsExpiring?: number;
  until?: number;
  reason?: string;
  modelCooldowns?: Record<string, WorkbuddyPersistedModelCooldown>;
  modelCosts?: Record<string, WorkbuddyPersistedModelCost>;
  breakerUntil?: number;
  retryCount?: number;
  consecutiveFails?: number;
  successCount?: number;
  errTotal?: number;
  lastUsed?: number;
  lastSuccess?: number;
  lastErr?: number;
}

export interface WorkbuddyPersistedSession {
  accountId: string;
  lastActive: number;
}

export interface WorkbuddyPoolFile {
  version: number;
  accounts: Record<string, WorkbuddyPersistedAccount>;
  sessions?: Record<string, WorkbuddyPersistedSession>;
}

export function workbuddyPoolPath(): string {
  return join(getConfigDir(), WORKBUDDY_POOL_FILE);
}

export function emptyWorkbuddyPoolFile(): WorkbuddyPoolFile {
  return { version: WORKBUDDY_POOL_VERSION, accounts: {} };
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseModelCooldowns(
  raw: unknown,
  now: number,
): Record<string, WorkbuddyPersistedModelCooldown> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const out: Record<string, WorkbuddyPersistedModelCooldown> = {};
  for (const [model, entry] of Object.entries(record)) {
    const row = asRecord(entry);
    const until = finitePositive(row?.until);
    if (!until || until <= now) continue;
    const resetAt = finitePositive(row?.resetAt);
    const reason = typeof row?.reason === "string" ? row.reason : undefined;
    out[model] = { until, ...(resetAt ? { resetAt } : {}), ...(reason ? { reason } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseModelCosts(
  raw: unknown,
  now: number,
): Record<string, WorkbuddyPersistedModelCost> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const out: Record<string, WorkbuddyPersistedModelCost> = {};
  for (const [model, entry] of Object.entries(record)) {
    const row = asRecord(entry);
    const lastSeen = finitePositive(row?.lastSeen);
    const costPer1k = finiteNonNeg(row?.costPer1k);
    if (lastSeen === undefined || costPer1k === undefined) continue;
    if (now - lastSeen > WORKBUDDY_MODEL_COST_TTL_MS) continue;
    const samples = finitePositive(row?.samples);
    out[model] = { costPer1k, lastSeen, ...(samples ? { samples } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseWorkbuddyPoolFile(raw: string, now = Date.now()): WorkbuddyPoolFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyWorkbuddyPoolFile();
  }
  const root = asRecord(parsed);
  if (!root) return emptyWorkbuddyPoolFile();
  const accountsIn = asRecord(root.accounts) ?? {};
  const accounts: Record<string, WorkbuddyPersistedAccount> = {};
  for (const [id, entry] of Object.entries(accountsIn)) {
    const row = asRecord(entry);
    if (!row || !id.trim()) continue;
    const until = finitePositive(row.until);
    const breakerUntil = finitePositive(row.breakerUntil);
    const account: WorkbuddyPersistedAccount = {};
    const credits = finiteNonNeg(row.credits);
    const creditsExpiring = finiteNonNeg(row.creditsExpiring);
    if (credits !== undefined) account.credits = credits;
    if (creditsExpiring !== undefined) {
      account.creditsExpiring = Math.min(creditsExpiring, credits ?? creditsExpiring);
    }
    if (until && until > now) {
      account.until = until;
      if (typeof row.reason === "string" && row.reason.trim()) account.reason = row.reason;
    }
    const modelCooldowns = parseModelCooldowns(row.modelCooldowns, now);
    if (modelCooldowns) account.modelCooldowns = modelCooldowns;
    const modelCosts = parseModelCosts(row.modelCosts, now);
    if (modelCosts) account.modelCosts = modelCosts;
    if (breakerUntil && breakerUntil > now) {
      account.breakerUntil = breakerUntil;
      const retryCount = finitePositive(row.retryCount);
      if (retryCount !== undefined) account.retryCount = retryCount;
    }
    const consecutiveFails = finiteNonNeg(row.consecutiveFails);
    if (consecutiveFails !== undefined) account.consecutiveFails = consecutiveFails;
    const successCount = finiteNonNeg(row.successCount);
    if (successCount !== undefined) account.successCount = successCount;
    const errTotal = finiteNonNeg(row.errTotal);
    if (errTotal !== undefined) account.errTotal = errTotal;
    const lastUsed = finitePositive(row.lastUsed);
    if (lastUsed) account.lastUsed = lastUsed;
    const lastSuccess = finitePositive(row.lastSuccess);
    if (lastSuccess) account.lastSuccess = lastSuccess;
    const lastErr = finitePositive(row.lastErr);
    if (lastErr) account.lastErr = lastErr;
    if (Object.keys(account).length > 0) accounts[id] = account;
  }
  const sessions: Record<string, WorkbuddyPersistedSession> = {};
  const sessionsIn = asRecord(root.sessions);
  if (sessionsIn) {
    for (const [key, entry] of Object.entries(sessionsIn)) {
      const row = asRecord(entry);
      const accountId = typeof row?.accountId === "string" ? row.accountId.trim() : "";
      const lastActive = finitePositive(row?.lastActive);
      if (!key.trim() || !accountId || !lastActive || now - lastActive > WORKBUDDY_SESSION_TTL_MS) continue;
      sessions[key] = { accountId, lastActive };
    }
  }
  return {
    version: WORKBUDDY_POOL_VERSION,
    accounts,
    ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
  };
}

export function loadWorkbuddyPoolFile(now = Date.now()): WorkbuddyPoolFile {
  const path = workbuddyPoolPath();
  if (!existsSync(path)) return emptyWorkbuddyPoolFile();
  try {
    return parseWorkbuddyPoolFile(readFileSync(path, "utf8"), now);
  } catch {
    return emptyWorkbuddyPoolFile();
  }
}

export function saveWorkbuddyPoolFile(file: WorkbuddyPoolFile): void {
  const dir = getConfigDir();
  hardenConfigDir();
  recordOwnedConfigPath(dir, WORKBUDDY_POOL_FILE);
  const pruned = parseWorkbuddyPoolFile(JSON.stringify(file), Date.now());
  atomicWriteFile(workbuddyPoolPath(), `${JSON.stringify(pruned, null, 2)}\n`);
}

let flushHookRegistered = false;

export function ensureWorkbuddyPoolShutdownHook(flush: () => void): void {
  if (flushHookRegistered) return;
  flushHookRegistered = true;
  registerOptionalShutdownHook("workbuddy-pool", flush);
}

export function resetWorkbuddyPoolShutdownHookForTests(): void {
  flushHookRegistered = false;
}
