/**
 * WorkBuddy remaining-credit snapshot and CN daily-status reads.
 *
 * Management / CLI only. Do not import from router, lifecycle, or responses/core.
 */
import { workbuddyCheckinHeaders, WORKBUDDY_CHECKIN_STATUS_PATH } from "./codebuddy-checkin";
import {
  workbuddyBillingMeterPaths,
  workbuddySiteProfile,
  WORKBUDDY_CN_BILLING_ORIGIN,
} from "./codebuddy-hosts";
import { credentialWorkbuddyRealm } from "./codebuddy-realm";
import { workbuddyFetch } from "./workbuddy-fetch";
import type { OAuthCredentials } from "./types";
import type { WorkbuddyAccountActivity } from "../providers/quota-types";

export type { WorkbuddyAccountActivity };

export const WORKBUDDY_CREDITS_WINDOW_LABEL = "WorkBuddy credits";
export const WORKBUDDY_HEATMAP_PATH = "/activity/growth/heatmap";

const REQUEST_TIMEOUT_MS = 20_000;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface WorkbuddyCreditPackage {
  name: string;
  remain: number;
  used: number;
  size: number;
  end?: string;
}

export interface WorkbuddyCreditSnapshot {
  remain: number;
  used: number;
  size: number;
  packs: number;
  expiresAt?: number;
  packages: WorkbuddyCreditPackage[];
}

export interface WorkbuddyDashboardSnapshot {
  credits?: WorkbuddyCreditSnapshot;
  activity?: WorkbuddyAccountActivity;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatWorkbuddyCstWall(d: Date): string {
  const cst = new Date(d.getTime() + CST_OFFSET_MS);
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())}`;
}

export function workbuddyCstDate(d = new Date()): string {
  return formatWorkbuddyCstWall(d).slice(0, 10);
}

export function parseWorkbuddyCstMillis(raw: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 8,
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isFinite(ms) ? ms : undefined;
}

export function packageRemainUsed(acct: Record<string, unknown>): { remain: number; used: number; size: number } {
  const num = (key: string) => {
    const value = acct[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const cycleSize = num("CycleCapacitySize");
  if (cycleSize > 0) {
    let remain = num("CycleCapacityRemain");
    const size = cycleSize;
    if (remain < 0) remain = 0;
    if (remain > size) remain = size;
    let used = size - remain;
    const cycleUsed = num("CycleCapacityUsed");
    if (cycleUsed > used) {
      used = cycleUsed;
      if (size >= used) remain = size - used;
    }
    return { remain, used, size };
  }
  const remain = num("CapacityRemain");
  const size = num("CapacitySize");
  let used = num("CapacityUsed");
  if (used === 0 && size > remain) used = size - remain;
  return { remain, used, size };
}

export function extractWorkbuddyResourceAccounts(payload: Record<string, unknown>): {
  accounts: Record<string, unknown>[];
  totalDosage?: number;
} {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
  const response = data.Response && typeof data.Response === "object" ? data.Response as Record<string, unknown> : data;
  const inner = response.Data && typeof response.Data === "object" ? response.Data as Record<string, unknown> : response;
  const accounts = Array.isArray(inner.Accounts) ? inner.Accounts as Record<string, unknown>[] : [];
  const totalDosage = typeof inner.TotalDosage === "number" ? inner.TotalDosage : undefined;
  return { accounts, totalDosage };
}

export function summarizeWorkbuddyPackages(
  accounts: Record<string, unknown>[],
  totalDosage?: number,
): WorkbuddyCreditSnapshot {
  let remain = 0;
  let used = 0;
  let size = 0;
  let expiresAt: number | undefined;
  const packages = accounts.map(acct => {
    const nums = packageRemainUsed(acct);
    remain += nums.remain;
    used += nums.used;
    size += nums.size;
    const end = typeof acct.CycleEndTime === "string" ? acct.CycleEndTime : undefined;
    if (nums.remain > 0 && end) {
      const ms = parseWorkbuddyCstMillis(end);
      if (ms !== undefined && (expiresAt === undefined || ms < expiresAt)) expiresAt = ms;
    }
    return {
      name: typeof acct.PackageName === "string" ? acct.PackageName : "?",
      remain: nums.remain,
      used: nums.used,
      size: nums.size,
      ...(end ? { end } : {}),
    };
  });
  if (size > 0 && size - remain > used) used = size - remain;
  if (totalDosage !== undefined && totalDosage > size) {
    size = totalDosage;
    if (size - remain > used) used = size - remain;
  }
  return {
    remain,
    used,
    size,
    packs: packages.length,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    packages,
  };
}

async function readJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ http: number; payload: Record<string, unknown> }> {
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
  return { http: response.status, payload };
}

async function fetchCredits(
  cred: OAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<WorkbuddyCreditSnapshot | undefined> {
  const realm = credentialWorkbuddyRealm(cred);
  const origin = workbuddySiteProfile(realm).billingOrigin;
  const paths = workbuddyBillingMeterPaths(realm, "get-user-resource");
  const headers = workbuddyCheckinHeaders(cred);
  const now = new Date();
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatWorkbuddyCstWall(now),
    PackageEndTimeRangeEnd: formatWorkbuddyCstWall(new Date(now.getTime() + 365 * 101 * 24 * 60 * 60 * 1000)),
  };
  for (const path of paths) {
    const { http, payload } = await readJson(`${origin}${path}`, "POST", headers, body, fetchImpl);
    if (http === 404) continue;
    if (http === 401 || http === 403) return undefined;
    const code = payload.code;
    if (http >= 400 || (code !== undefined && code !== 0 && code !== 200)) return undefined;
    const { accounts, totalDosage } = extractWorkbuddyResourceAccounts(payload);
    return summarizeWorkbuddyPackages(accounts, totalDosage);
  }
  return undefined;
}

async function fetchCnCheckin(
  cred: OAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<boolean | undefined> {
  const headers = workbuddyCheckinHeaders(cred);
  const { http, payload } = await readJson(
    `${WORKBUDDY_CN_BILLING_ORIGIN}${WORKBUDDY_CHECKIN_STATUS_PATH}`,
    "POST",
    headers,
    {},
    fetchImpl,
  );
  if (http >= 400) return undefined;
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  return data.today_checked_in === true;
}

async function fetchCnHeatmapToday(
  cred: OAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<boolean | undefined> {
  const origin = workbuddySiteProfile(credentialWorkbuddyRealm(cred)).chatOrigin;
  const headers = workbuddyCheckinHeaders(cred);
  const { http, payload } = await readJson(`${origin}${WORKBUDDY_HEATMAP_PATH}`, "GET", headers, undefined, fetchImpl);
  if (http >= 400) return undefined;
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
  const cells = Array.isArray(data.cells) ? data.cells as Array<{ date?: string; score?: number }> : [];
  const today = workbuddyCstDate();
  const hit = cells.find(cell => typeof cell.date === "string" && cell.date.slice(0, 10) === today);
  if (!hit) return false;
  return typeof hit.score === "number" && hit.score > 0;
}

export async function fetchWorkbuddyDashboardSnapshot(
  cred: OAuthCredentials,
  fetchImpl: typeof fetch = workbuddyFetch,
): Promise<WorkbuddyDashboardSnapshot> {
  const credits = await fetchCredits(cred, fetchImpl);
  const realm = credentialWorkbuddyRealm(cred);
  const activity: WorkbuddyAccountActivity = {};
  if (realm === "cn") {
    const [checkedIn, dailyTask] = await Promise.all([
      fetchCnCheckin(cred, fetchImpl),
      fetchCnHeatmapToday(cred, fetchImpl),
    ]);
    if (checkedIn !== undefined) activity.checkedIn = checkedIn;
    if (dailyTask !== undefined) activity.dailyTask = dailyTask;
  }
  return {
    ...(credits ? { credits } : {}),
    ...(activity.checkedIn !== undefined || activity.dailyTask !== undefined ? { activity } : {}),
  };
}
