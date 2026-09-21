/**
 * WorkBuddy / CodeBuddy CN daily check-in (Buddy 加油站).
 *
 * Uses the same billing endpoints the desktop client calls, against accounts already
 * stored in auth.json. Idempotent: an already-claimed day is a no-op.
 *
 * Not on the request path. The composition root may start a timer; router / lifecycle /
 * responses/core must not import this module.
 */
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";
import { CODEBUDDY_PROVIDER_ID, refreshCodebuddyToken } from "./codebuddy";
import { setWorkbuddyPoolCredits } from "./workbuddy-pool";
import { listAccounts, saveAccountCredential } from "./store";
import type { OAuthCredentials, ProviderAccount } from "./types";

export const WORKBUDDY_BILLING_ORIGIN = "https://copilot.tencent.com";
export const WORKBUDDY_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
export const WORKBUDDY_CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
export const WORKBUDDY_CHECKIN_HOUR = 9;
export const WORKBUDDY_CHECKIN_MINUTE = 10;
export const WORKBUDDY_CHECKIN_EVENING_HOUR = 21;

const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export type WorkbuddyCheckinResultCode =
  | "CLAIMED"
  | "ALREADY_CLAIMED"
  | "INACTIVE"
  | "STATUS"
  | "SKIPPED_GLOBAL"
  | "AUTH_REQUIRED"
  | "STATUS_ERROR"
  | "CLAIM_ERROR"
  | "VERIFY_FAILED"
  | "NO_ACCOUNTS"
  | "WRONG_PROVIDER"
  | "ERROR";

export interface WorkbuddyCheckinAccountResult {
  accountId: string;
  label: string;
  result: WorkbuddyCheckinResultCode;
  http?: number;
  msg?: string;
  credit?: unknown;
  active?: boolean;
  today_checked_in?: boolean;
  today_credit?: unknown;
  daily_credit?: unknown;
  streak_days?: unknown;
  total_credits?: unknown;
  end_time?: unknown;
}

export interface WorkbuddyCheckinRun {
  when: string;
  results: WorkbuddyCheckinAccountResult[];
}

export interface WorkbuddyCheckinDeps {
  fetchImpl?: typeof fetch;
  listAccountsImpl?: typeof listAccounts;
  saveAccountCredentialImpl?: typeof saveAccountCredential;
  refreshImpl?: typeof refreshCodebuddyToken;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

type BillingPayload = Record<string, unknown>;

function stringField(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const raw = record[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

export function isCnWorkbuddyCredential(cred: OAuthCredentials): boolean {
  const domain = cred.codebuddy?.domain ?? "";
  return !domain.includes("workbuddy.ai");
}

export function workbuddyCheckinLabel(account: ProviderAccount): string {
  const cred = account.credential;
  return account.alias
    || cred.email
    || cred.codebuddy?.uid
    || cred.accountId
    || account.id;
}

export function workbuddyCheckinHeaders(cred: OAuthCredentials): Record<string, string> {
  const uid = cred.codebuddy?.uid ?? cred.accountId;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${cred.access}`,
    "User-Agent": "opencodex-workbuddy-checkin",
  };
  if (uid) headers["X-User-Id"] = uid;
  if (cred.codebuddy?.domain) headers["X-Domain"] = cred.codebuddy.domain;
  if (cred.codebuddy?.enterpriseId) {
    headers["X-Enterprise-Id"] = cred.codebuddy.enterpriseId;
    headers["X-Tenant-Id"] = cred.codebuddy.enterpriseId;
  }
  return headers;
}

export function compactCheckinStatus(data: Record<string, unknown>): Partial<WorkbuddyCheckinAccountResult> {
  const keys = [
    "active",
    "today_checked_in",
    "today_credit",
    "daily_credit",
    "streak_days",
    "total_credits",
    "end_time",
  ] as const;
  const out: Partial<WorkbuddyCheckinAccountResult> = {};
  for (const key of keys) {
    if (key in data) (out as Record<string, unknown>)[key] = data[key];
  }
  return out;
}

function delayUntilCst(now: number, hour: number, minute: number): number {
  const local = new Date(now + CST_OFFSET_MS);
  let target = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ) - CST_OFFSET_MS;
  if (target <= now) target += DAY_MS;
  return target - now;
}

/** Milliseconds until the next 09:10 or 21:10 Asia/Shanghai slot. A named hour:minute is that slot only. */
export function nextWorkbuddyCheckinDelayMs(
  now = Date.now(),
  hour?: number,
  minute = WORKBUDDY_CHECKIN_MINUTE,
): number {
  if (hour !== undefined) return delayUntilCst(now, hour, minute);
  return Math.min(
    delayUntilCst(now, WORKBUDDY_CHECKIN_HOUR, WORKBUDDY_CHECKIN_MINUTE),
    delayUntilCst(now, WORKBUDDY_CHECKIN_EVENING_HOUR, WORKBUDDY_CHECKIN_MINUTE),
  );
}

function envelopeOk(payload: BillingPayload, httpStatus: number): boolean {
  const code = payload.code;
  return httpStatus < 400 && (code === 0 || code === 200 || code === undefined);
}

async function postBilling(
  path: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ http: number; payload: BillingPayload }> {
  const response = await fetchImpl(`${WORKBUDDY_BILLING_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: BillingPayload = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") payload = parsed as BillingPayload;
    } catch {
      throw new Error(`WorkBuddy billing returned non-JSON HTTP ${response.status}`);
    }
  }
  return { http: response.status, payload };
}

async function maybeRefreshAccount(
  account: ProviderAccount,
  deps: WorkbuddyCheckinDeps,
): Promise<OAuthCredentials> {
  const cred = account.credential;
  const access = cred.access?.trim();
  const refresh = cred.refresh?.trim();
  if (!access) return cred;
  const now = deps.now?.() ?? Date.now();
  const due = !Number.isFinite(cred.expires) || cred.expires - now < REFRESH_SKEW_MS;
  if (!due || !refresh || refresh === access) return cred;
  const refreshImpl = deps.refreshImpl ?? refreshCodebuddyToken;
  const next = await refreshImpl(refresh, undefined, cred);
  const save = deps.saveAccountCredentialImpl ?? saveAccountCredential;
  await save(CODEBUDDY_PROVIDER_ID, account.id, next);
  return next;
}

export async function checkinWorkbuddyCredential(
  account: ProviderAccount,
  opts: { statusOnly?: boolean } & WorkbuddyCheckinDeps = {},
): Promise<WorkbuddyCheckinAccountResult> {
  const label = workbuddyCheckinLabel(account);
  const base = { accountId: account.id, label };
  try {
    if (!isCnWorkbuddyCredential(account.credential)) {
      if (opts.statusOnly) return { ...base, result: "SKIPPED_GLOBAL" };
      const { claimWorkbuddyTrial } = await import("./workbuddy-growth");
      const trial = await claimWorkbuddyTrial(account, opts);
      if (trial.result === "CLAIMED") return { ...base, result: "CLAIMED" };
      if (trial.result === "ALREADY_CLAIMED") return { ...base, result: "ALREADY_CLAIMED", http: trial.http };
      return { ...base, result: "SKIPPED_GLOBAL", http: trial.http, msg: trial.msg };
    }
    const cred = await maybeRefreshAccount(account, opts);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const headers = workbuddyCheckinHeaders(cred);
    const status = await postBilling(WORKBUDDY_CHECKIN_STATUS_PATH, headers, fetchImpl);
    if (status.http === 401 || status.http === 403) {
      return { ...base, result: "AUTH_REQUIRED", http: status.http };
    }
    if (!envelopeOk(status.payload, status.http)) {
      return {
        ...base,
        result: "STATUS_ERROR",
        http: status.http,
        msg: stringField(status.payload, ["msg", "message"]),
      };
    }
    const data = status.payload.data && typeof status.payload.data === "object"
      ? status.payload.data as Record<string, unknown>
      : {};
    const summary = compactCheckinStatus(data);
    if (opts.statusOnly) return { ...base, result: "STATUS", ...summary };
    if (data.active === false) return { ...base, result: "INACTIVE", ...summary };
    if (data.today_checked_in === true) return { ...base, result: "ALREADY_CLAIMED", ...summary };

    const claim = await postBilling(WORKBUDDY_CHECKIN_CLAIM_PATH, headers, fetchImpl);
    const msg = stringField(claim.payload, ["msg", "message"]) ?? "";
    const already = msg.includes("已签到") || msg.toLowerCase().includes("already");
    if (envelopeOk(claim.payload, claim.http) || already) {
      const verified = await postBilling(WORKBUDDY_CHECKIN_STATUS_PATH, headers, fetchImpl);
      const verifiedData = verified.payload.data && typeof verified.payload.data === "object"
        ? verified.payload.data as Record<string, unknown>
        : {};
      const verifiedSummary = compactCheckinStatus(verifiedData);
      if (verifiedData.today_checked_in === true || already) {
        const claimData = claim.payload.data && typeof claim.payload.data === "object"
          ? claim.payload.data as Record<string, unknown>
          : {};
        const credit = claimData.credit ?? claimData.credits ?? verifiedData.today_credit;
        const total = verifiedData.total_credits ?? credit;
        if (typeof total === "number" && Number.isFinite(total)) {
          setWorkbuddyPoolCredits(account.id, total);
        }
        return {
          ...base,
          result: already && claimData.credit === undefined ? "ALREADY_CLAIMED" : "CLAIMED",
          credit,
          ...verifiedSummary,
        };
      }
      return {
        ...base,
        result: "VERIFY_FAILED",
        msg: msg || "claim succeeded but status did not flip",
        ...verifiedSummary,
      };
    }
    if (claim.http === 401 || claim.http === 403) {
      return { ...base, result: "AUTH_REQUIRED", http: claim.http, msg };
    }
    return { ...base, result: "CLAIM_ERROR", http: claim.http, msg, ...summary };
  } catch (err) {
    return { ...base, result: "ERROR", msg: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWorkbuddyCheckin(
  opts: { statusOnly?: boolean; provider?: string } & WorkbuddyCheckinDeps = {},
): Promise<WorkbuddyCheckinRun> {
  const provider = opts.provider ?? CODEBUDDY_PROVIDER_ID;
  const when = new Date((opts.now?.() ?? Date.now()) + CST_OFFSET_MS).toISOString().replace("Z", "+08:00");
  if (provider !== CODEBUDDY_PROVIDER_ID) {
    return { when, results: [{ accountId: "", label: provider, result: "WRONG_PROVIDER" }] };
  }
  const accounts = (opts.listAccountsImpl ?? listAccounts)(provider);
  if (accounts.length === 0) {
    return { when, results: [{ accountId: "", label: provider, result: "NO_ACCOUNTS" }] };
  }
  const results: WorkbuddyCheckinAccountResult[] = [];
  for (const account of accounts) {
    results.push(await checkinWorkbuddyCredential(account, opts));
  }
  return { when, results };
}

export function workbuddyCheckinExitCode(run: WorkbuddyCheckinRun): number {
  let worst = 0;
  for (const row of run.results) {
    if (row.result === "NO_ACCOUNTS" || row.result === "WRONG_PROVIDER" || row.result === "AUTH_REQUIRED") {
      worst = Math.max(worst, 2);
    } else if (
      row.result === "CLAIMED"
      || row.result === "ALREADY_CLAIMED"
      || row.result === "INACTIVE"
      || row.result === "STATUS"
      || row.result === "SKIPPED_GLOBAL"
    ) {
      continue;
    } else {
      worst = Math.max(worst, 1);
    }
  }
  return worst;
}

export function workbuddyCheckinActivationRequired(config: Pick<OcxConfig, "workbuddyCheckin" | "providers">): boolean {
  if (config.workbuddyCheckin?.auto === false) return false;
  const provider = config.providers?.[CODEBUDDY_PROVIDER_ID];
  if (provider && provider.disabled !== true) return true;
  return listAccounts(CODEBUDDY_PROVIDER_ID).length > 0;
}

export function formatWorkbuddyCheckinLog(run: WorkbuddyCheckinRun): string {
  const parts = run.results.map(row => `${row.accountId || row.label}:${row.result}`);
  return `[workbuddy-checkin] ${parts.join(" ")}`;
}

export function activateWorkbuddyCheckinScheduler(
  _config: Pick<OcxConfig, "workbuddyCheckin" | "providers">,
  deps: WorkbuddyCheckinDeps = {},
): { stop: () => void } {
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const warn = deps.warn ?? ((line: string) => { console.warn(line); });
  let handle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    handle = setTimer(() => { void tick(); }, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const run = await runWorkbuddyCheckin(deps);
      log(formatWorkbuddyCheckinLog(run));
    } catch (err) {
      warn(`[workbuddy-checkin] ${err instanceof Error ? err.message : String(err)}`);
    }
    const delay = nextWorkbuddyCheckinDelayMs(deps.now?.() ?? Date.now());
    scheduleNext(delay);
  };

  const stop = () => {
    stopped = true;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const unregister = registerOptionalShutdownHook("workbuddy-checkin", () => {
    stop();
    unregister();
  });
  scheduleNext(STARTUP_DELAY_MS);
  return { stop };
}
