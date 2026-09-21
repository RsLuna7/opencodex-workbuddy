/**
 * WorkBuddy optional growth jobs: Global trial pack, CN activity map, streak
 * rewards, gifts, and cat travel. Not on the request path.
 *
 * Endpoints from Sliverkiss/workbuddy2api (MIT). School/cat Python jobs are not ported.
 */
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";
import { CODEBUDDY_PROVIDER_ID, refreshCodebuddyToken } from "./codebuddy";
import { workbuddyCheckinHeaders } from "./codebuddy-checkin";
import { workbuddySiteProfile } from "./codebuddy-hosts";
import { credentialWorkbuddyRealm } from "./codebuddy-realm";
import { listAccounts } from "./store";
import { setWorkbuddyPoolCredits } from "./workbuddy-pool";
import type { OAuthCredentials, ProviderAccount } from "./types";

const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_DELAY_MS = 8_000;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_REPORTS = 5;

export const WORKBUDDY_TRIAL_PATH = "/billing/ide/trial";
export const WORKBUDDY_REPORT_PATH = "/v2/report";
export const WORKBUDDY_STREAK_PATH = "/activity/growth/streak";
export const WORKBUDDY_REDEEM_PATH = "/activity/growth/redeem";
export const WORKBUDDY_LOTTERY_CHANCES_PATH = "/activity/growth/lottery/chances";
export const WORKBUDDY_LOTTERY_DRAW_PATH = "/activity/growth/lottery/draw";
export const WORKBUDDY_HEATMAP_PATH = "/activity/growth/heatmap";
export const WORKBUDDY_MAKEUP_PATH = "/activity/growth/makeup-cards/use";
export const WORKBUDDY_GIFT_PATH = "/billing/meter/claim-gift";
export const WORKBUDDY_COMPENSATION_PATH = "/billing/meter/claim-compensation";
export const WORKBUDDY_BUDDY_INFO_PATH = "/activity/growth/buddy/info";
export const WORKBUDDY_BUDDY_AGREE_PATH = "/activity/growth/buddy/agreement";
export const WORKBUDDY_BUDDY_FIRST_PATH = "/activity/growth/buddy/first";
export const WORKBUDDY_TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
export const WORKBUDDY_TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";
export const WORKBUDDY_TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";

export type WorkbuddyGrowthKind = "trial" | "activity" | "rewards" | "travel";

export interface WorkbuddyGrowthResult {
  accountId: string;
  kind: WorkbuddyGrowthKind;
  result: string;
  http?: number;
  msg?: string;
}

export interface WorkbuddyGrowthDeps {
  fetchImpl?: typeof fetch;
  listAccountsImpl?: typeof listAccounts;
  refreshImpl?: typeof refreshCodebuddyToken;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

function envelopeOk(payload: Record<string, unknown>, http: number): boolean {
  const code = payload.code;
  return http < 400 && (code === 0 || code === 200 || code === undefined || code === 14051);
}

function trialAlready(payload: Record<string, unknown>, http: number, text: string): boolean {
  if (payload.code === 14051) return true;
  return http >= 400 && (text.includes("14051") || text.toLowerCase().includes("already"));
}

async function callJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ http: number; payload: Record<string, unknown>; text: string }> {
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      payload = { msg: text.slice(0, 200) };
    }
  }
  return { http: response.status, payload, text };
}

function originFor(cred: OAuthCredentials, kind: "billing" | "chat"): string {
  const realm = credentialWorkbuddyRealm(cred);
  const profile = workbuddySiteProfile(realm);
  return kind === "chat" ? profile.chatOrigin : profile.billingOrigin;
}

export async function claimWorkbuddyTrial(
  account: ProviderAccount,
  deps: WorkbuddyGrowthDeps = {},
): Promise<WorkbuddyGrowthResult> {
  const base = { accountId: account.id, kind: "trial" as const };
  if (credentialWorkbuddyRealm(account.credential) !== "global") {
    return { ...base, result: "SKIPPED_CN" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = workbuddyCheckinHeaders(account.credential);
  const origin = originFor(account.credential, "billing");
  try {
    const { http, payload, text } = await callJson(
      `${origin}${WORKBUDDY_TRIAL_PATH}`,
      "POST",
      headers,
      {},
      fetchImpl,
    );
    if (trialAlready(payload, http, text)) return { ...base, result: "ALREADY_CLAIMED", http };
    if (envelopeOk(payload, http)) return { ...base, result: "CLAIMED", http };
    return { ...base, result: "ERROR", http, msg: String(payload.msg ?? payload.message ?? http) };
  } catch (err) {
    return { ...base, result: "ERROR", msg: err instanceof Error ? err.message : String(err) };
  }
}

async function postReports(account: ProviderAccount, fetchImpl: typeof fetch): Promise<WorkbuddyGrowthResult> {
  const headers = workbuddyCheckinHeaders(account.credential);
  const origin = originFor(account.credential, "billing");
  const uid = account.credential.codebuddy?.uid ?? account.credential.accountId ?? account.id;
  const conversationId = `ocx-${account.id}-${Date.now()}`;
  for (let i = 0; i < ACTIVITY_REPORTS; i++) {
    const now = Date.now();
    const event = {
      eventCode: "chat_request_send",
      timestamp: now,
      reportDelay: 0,
      mode: "craft",
      conversationId,
      requestId: `${conversationId}-${i}`,
      inputLength: 12,
      requestModelId: "deepseek-v4.1-flash",
      requestModelName: "DeepSeek V4 Flash",
      userId: uid,
      presentAt: now,
      rootRequestId: conversationId,
      parentConversationId: conversationId,
      agentName: "default",
      agentType: "conversation",
    };
    const { http, payload } = await callJson(
      `${origin}${WORKBUDDY_REPORT_PATH}`,
      "POST",
      headers,
      [event],
      fetchImpl,
    );
    if (!envelopeOk(payload, http)) {
      return { accountId: account.id, kind: "activity", result: "ERROR", http, msg: String(payload.msg ?? http) };
    }
  }
  return { accountId: account.id, kind: "activity", result: "REPORTED" };
}

async function runRewards(account: ProviderAccount, fetchImpl: typeof fetch): Promise<WorkbuddyGrowthResult> {
  const headers = workbuddyCheckinHeaders(account.credential);
  const origin = originFor(account.credential, "chat");
  await callJson(`${origin}${WORKBUDDY_STREAK_PATH}`, "GET", headers, undefined, fetchImpl);
  await callJson(`${origin}${WORKBUDDY_REDEEM_PATH}`, "POST", headers, { tier: "7d" }, fetchImpl);
  const chances = await callJson(`${origin}${WORKBUDDY_LOTTERY_CHANCES_PATH}`, "GET", headers, undefined, fetchImpl);
  const data = chances.payload.data && typeof chances.payload.data === "object"
    ? chances.payload.data as Record<string, unknown>
    : {};
  const balance = typeof data.balance === "number" ? data.balance : 0;
  if (balance > 0) {
    await callJson(`${origin}${WORKBUDDY_LOTTERY_DRAW_PATH}`, "POST", headers, {}, fetchImpl);
  }
  const heatmap = await callJson(`${origin}${WORKBUDDY_HEATMAP_PATH}`, "GET", headers, undefined, fetchImpl);
  const heat = heatmap.payload.data && typeof heatmap.payload.data === "object"
    ? heatmap.payload.data as { cells?: Array<{ date?: string; score?: number }> }
    : {};
  const miss = (heat.cells ?? []).find(cell => cell.score === 0 && typeof cell.date === "string");
  if (miss?.date) {
    await callJson(`${origin}${WORKBUDDY_MAKEUP_PATH}`, "POST", headers, { target_date: miss.date }, fetchImpl);
  }
  const billing = originFor(account.credential, "billing");
  await callJson(`${billing}${WORKBUDDY_GIFT_PATH}`, "POST", headers, {}, fetchImpl);
  await callJson(`${billing}${WORKBUDDY_COMPENSATION_PATH}`, "POST", headers, {}, fetchImpl);
  return { accountId: account.id, kind: "rewards", result: "RAN" };
}

async function runTravel(account: ProviderAccount, fetchImpl: typeof fetch): Promise<WorkbuddyGrowthResult> {
  const headers = workbuddyCheckinHeaders(account.credential);
  const origin = originFor(account.credential, "chat");
  await callJson(`${origin}${WORKBUDDY_BUDDY_AGREE_PATH}`, "POST", headers, { agree: true }, fetchImpl);
  const info = await callJson(`${origin}${WORKBUDDY_BUDDY_INFO_PATH}`, "GET", headers, undefined, fetchImpl);
  const infoData = info.payload.data && typeof info.payload.data === "object"
    ? info.payload.data as { buddy?: unknown }
    : {};
  if (infoData.buddy == null) {
    await callJson(`${origin}${WORKBUDDY_BUDDY_FIRST_PATH}`, "POST", headers, {}, fetchImpl);
  }
  const status = await callJson(`${origin}${WORKBUDDY_TRAVEL_STATUS_PATH}`, "GET", headers, undefined, fetchImpl);
  const st = status.payload.data && typeof status.payload.data === "object"
    ? status.payload.data as { state?: string; record_id?: number; daily_limit_reached?: boolean }
    : {};
  if (st.state === "arrived" && typeof st.record_id === "number") {
    await callJson(`${origin}${WORKBUDDY_TRAVEL_CLAIM_PATH}`, "POST", headers, { record_id: st.record_id }, fetchImpl);
  } else if (st.state === "idle" && st.daily_limit_reached !== true) {
    await callJson(`${origin}${WORKBUDDY_TRAVEL_DEPART_PATH}`, "POST", headers, { location_id: 1 }, fetchImpl);
  }
  return { accountId: account.id, kind: "travel", result: st.state ?? "RAN" };
}

export async function runWorkbuddyGrowthTick(
  jobs: WorkbuddyGrowthKind[],
  deps: WorkbuddyGrowthDeps = {},
): Promise<WorkbuddyGrowthResult[]> {
  const accounts = (deps.listAccountsImpl ?? listAccounts)(CODEBUDDY_PROVIDER_ID);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: WorkbuddyGrowthResult[] = [];
  for (const account of accounts) {
    const realm = credentialWorkbuddyRealm(account.credential);
    try {
      if (jobs.includes("trial") && realm === "global") {
        const trial = await claimWorkbuddyTrial(account, deps);
        out.push(trial);
        continue;
      }
      if (realm === "global") continue;
      if (jobs.includes("activity")) out.push(await postReports(account, fetchImpl));
      if (jobs.includes("rewards")) out.push(await runRewards(account, fetchImpl));
      if (jobs.includes("travel")) out.push(await runTravel(account, fetchImpl));
    } catch (err) {
      out.push({
        accountId: account.id,
        kind: jobs[0] ?? "activity",
        result: "ERROR",
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function jobsForCstHour(hour: number): WorkbuddyGrowthKind[] {
  if (hour === 9 || hour === 21) return ["trial", "travel"];
  if (hour === 10) return ["activity", "rewards"];
  return ["trial"];
}

export function formatWorkbuddyGrowthLog(results: WorkbuddyGrowthResult[]): string {
  if (results.length === 0) return "[workbuddy-growth] none";
  return `[workbuddy-growth] ${results.map(row => `${row.accountId}:${row.kind}:${row.result}`).join(" ")}`;
}

export function activateWorkbuddyGrowthScheduler(
  _config: Pick<OcxConfig, "workbuddyCheckin" | "providers">,
  deps: WorkbuddyGrowthDeps = {},
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
    const now = deps.now?.() ?? Date.now();
    const hour = new Date(now + CST_OFFSET_MS).getUTCHours();
    try {
      const results = await runWorkbuddyGrowthTick(jobsForCstHour(hour), deps);
      log(formatWorkbuddyGrowthLog(results));
    } catch (err) {
      warn(`[workbuddy-growth] ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleNext(nextGrowthDelayMs(deps.now?.() ?? Date.now()));
  };

  const stop = () => {
    stopped = true;
    if (handle !== null) clearTimer(handle);
  };
  registerOptionalShutdownHook("workbuddy-growth", stop);
  scheduleNext(STARTUP_DELAY_MS);
  return { stop };
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

export function nextGrowthDelayMs(now = Date.now()): number {
  return Math.min(
    delayUntilCst(now, 9, 10),
    delayUntilCst(now, 10, 0),
    delayUntilCst(now, 21, 10),
  );
}

/** Best-effort: when checkin returns a credit total, remember it for weighted pick. */
export function rememberWorkbuddyCredits(accountId: string, total: unknown): void {
  if (typeof total === "number" && Number.isFinite(total)) {
    setWorkbuddyPoolCredits(accountId, total);
  }
}
