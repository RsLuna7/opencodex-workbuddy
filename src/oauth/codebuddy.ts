/**
 * CodeBuddy / WorkBuddy China-site login (www.codebuddy.cn).
 *
 * Unofficial IDE-shaped contract: browser state poll, then Bearer + product headers
 * against copilot.tencent.com. Rewritten in TypeScript from the public protocol
 * surface (not a copy of CodeRelay's desktop/sidecar). Xiaomi-style risk: the
 * vendor can change or restrict this at any time.
 */
import type { OAuthController, OAuthCredentials } from "./types";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBody } from "../lib/bounded-body";
import { applyWorkbuddyLoginOriginHeaders, applyWorkbuddyRefreshHeaders } from "./codebuddy-headers";
import {
  WORKBUDDY_CN_AUTH_ORIGIN,
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_PLUGIN_PREFIX,
  workbuddyAccountsUrl,
  workbuddyAuthStateUrl,
  workbuddyAuthTokenUrl,
  workbuddyLoginAccountUrl,
  workbuddySiteProfile,
  workbuddyTokenRefreshUrl,
} from "./codebuddy-hosts";
import { resolveWorkbuddyRealm, type WorkbuddyRealm } from "./codebuddy-realm";

export const CODEBUDDY_AUTH_ORIGIN = WORKBUDDY_CN_AUTH_ORIGIN;
export const CODEBUDDY_CHAT_BASE_URL = WORKBUDDY_CN_CHAT_BASE;
export const CODEBUDDY_PROVIDER_ID = "workbuddy";

export function applyCodebuddyAccountHeaders(
  headers: Record<string, string>,
  cred?: { access?: string; accountId?: string; codebuddy?: { uid?: string; enterpriseId?: string; domain?: string } } | null,
): void {
  const uid = cred?.codebuddy?.uid ?? cred?.accountId;
  const enterpriseId = cred?.codebuddy?.enterpriseId;
  const domain = cred?.codebuddy?.domain;
  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }
  if (domain) headers["X-Domain"] = domain;
}

/** 6004 = this model on this account; 14018 = the whole account. */
export type CodebuddyQuotaCode = "6004" | "14018";

export interface CodebuddyFailoverHint {
  code: CodebuddyQuotaCode;
  scope: "account" | "model";
  resetAtMs?: number;
}

const codebuddyFailoverHints = new WeakMap<Response, CodebuddyFailoverHint>();

/** Observed 2026-09-11: "将在 2026-09-11 18:52:21 UTC+8 重置". */
const CODEBUDDY_RESET_AT_RE = /将在\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC\+8/;
/** Global 6004: "will reset at 2026-09-19 04:23:04 UTC+8, alternatively…" (buddy-proxy). */
const CODEBUDDY_RESET_AT_EN_RE =
  /will reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*(?:UTC|GMT)\s*\+\s*0?8(?::?00)?)?/i;

export function parseCodebuddyResetAtMs(text: string, now = Date.now()): number | undefined {
  const match = CODEBUDDY_RESET_AT_RE.exec(text) ?? CODEBUDDY_RESET_AT_EN_RE.exec(text);
  if (!match) return undefined;
  const ms = Date.parse(`${match[1]}T${match[2]}+08:00`);
  if (!Number.isFinite(ms) || ms <= now) return undefined;
  return ms;
}

export function codebuddyFailoverHintFromQuotaCode(
  code: string,
  message: string,
  now = Date.now(),
): CodebuddyFailoverHint | undefined {
  if (code !== "6004" && code !== "14018") return undefined;
  const resetAtMs = parseCodebuddyResetAtMs(message, now);
  return {
    code,
    scope: code === "6004" ? "model" : "account",
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
  };
}

export function rememberCodebuddyFailoverHint(response: Response, hint: CodebuddyFailoverHint): void {
  codebuddyFailoverHints.set(response, hint);
}

export function getCodebuddyFailoverHint(response: Response): CodebuddyFailoverHint | undefined {
  return codebuddyFailoverHints.get(response);
}

/** Client-facing 402 envelope written by the codebuddy adapter. */
const CODEBUDDY_QUOTA_MESSAGE_RE = /CodeBuddy quota exhausted \((6004|14018)\)/;

/**
 * Rebuild the rotation hint from a 402 body.
 *
 * The adapter also stashes the hint on the Response via WeakMap, but anything that
 * clones or rebuilds that object (tee, combo preflight, a second `new Response`)
 * drops it. The rewritten JSON already carries the quota code in `error.message`,
 * which is what Codex sees, so this is the durable copy.
 */
export function codebuddyFailoverHintFromErrorPayload(
  text: string,
  now = Date.now(),
): CodebuddyFailoverHint | undefined {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim()) {
      message = parsed.error.message;
    }
  } catch {
    /* plain-text fallback uses the raw body */
  }
  const match = CODEBUDDY_QUOTA_MESSAGE_RE.exec(message);
  if (!match) return undefined;
  return codebuddyFailoverHintFromQuotaCode(match[1]!, message, now);
}

/**
 * WeakMap first (no body read). On a 402 miss, clone and parse the durable envelope.
 * Never consumes the original body: the error path still needs it if rotation fails.
 */
export async function recoverCodebuddyFailoverHint(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<CodebuddyFailoverHint | undefined> {
  const remembered = getCodebuddyFailoverHint(response);
  if (remembered) return remembered;
  if (response.status !== 402) return undefined;
  let text = "";
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || !body.text) return undefined;
    text = body.text;
  } catch {
    return undefined;
  }
  return codebuddyFailoverHintFromErrorPayload(text, now);
}

const POLL_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 20_000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Login cancelled", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Login cancelled", "AbortError"));
    }, { once: true });
  });
}

function stringField(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const raw = record[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

function decodeJwtExpMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof json.exp === "number" && json.exp > 0 ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function expiryFromToken(access: string, expiresAtRaw?: unknown): number {
  if (typeof expiresAtRaw === "number" && expiresAtRaw > 0) {
    const ms = expiresAtRaw > 1e12 ? expiresAtRaw : expiresAtRaw * 1000;
    return ms - OAUTH_EXPIRY_SKEW_MS;
  }
  const jwtExp = decodeJwtExpMs(access);
  if (jwtExp) return jwtExp - OAUTH_EXPIRY_SKEW_MS;
  return Date.now() + DEFAULT_ACCESS_TTL_MS;
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const body = await readBoundedResponseBody(response, {
    signal,
    maxBytes: BOUNDED_BODY_MAX_BYTES,
    totalTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!body.text) return undefined;
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    return undefined;
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Accept", "application/json, text/plain, */*");
  headers.set("User-Agent", BROWSER_UA);
  return headers;
}

async function codebuddyFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const merged = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
    ...(init.signal ? [init.signal] : []),
  ]);
  return fetch(url, { ...init, signal: merged, headers: authHeaders(init.headers) });
}

function envelopeOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  return code === 0 || code === 200 || code === undefined;
}

async function fetchAccountInfo(
  realm: WorkbuddyRealm,
  accessToken: string,
  state: string,
  domain: string | undefined,
  signal?: AbortSignal,
): Promise<{ uid?: string; email?: string; enterpriseId?: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  applyWorkbuddyLoginOriginHeaders(headers, realm);
  if (domain) headers["X-Domain"] = domain;
  const response = await codebuddyFetch(
    workbuddyLoginAccountUrl(realm, state),
    { method: "GET", headers },
    signal,
  );
  const body = await readJson(response, signal);
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  return {
    uid: stringField(data, ["uid", "userId", "user_id"]),
    email: stringField(data, ["email", "accountEmail", "account_email", "nickname"]),
    enterpriseId: stringField(data, ["enterpriseId", "enterprise_id"]),
  };
}

function credentialFromTokens(params: {
  access: string;
  refresh?: string;
  expiresAt?: unknown;
  uid?: string;
  email?: string;
  enterpriseId?: string;
  domain?: string;
  realm?: WorkbuddyRealm;
  platform?: string;
  deviceToken?: string;
  source: OAuthCredentials["source"];
}): OAuthCredentials {
  const refresh = params.refresh?.trim() || params.access;
  const cred: OAuthCredentials = {
    access: params.access,
    refresh,
    expires: expiryFromToken(params.access, params.expiresAt),
    source: params.source,
  };
  if (params.uid) cred.accountId = params.uid;
  if (params.email) cred.email = params.email;
  const uid = params.uid;
  const enterpriseId = params.enterpriseId;
  const domain = params.domain;
  const realm = resolveWorkbuddyRealm(params.realm, domain);
  const platform = params.platform?.trim();
  const deviceToken = params.deviceToken?.trim();
  if (uid || enterpriseId || domain || params.realm || platform || deviceToken) {
    cred.codebuddy = {
      ...(uid ? { uid } : {}),
      ...(enterpriseId ? { enterpriseId } : {}),
      ...(domain ? { domain } : {}),
      realm,
      ...(platform ? { platform } : {}),
      ...(deviceToken ? { deviceToken } : {}),
    };
  }
  return cred;
}

async function validateCodebuddyAccessTokenOnRealm(
  realm: WorkbuddyRealm,
  accessToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials | undefined> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  applyWorkbuddyLoginOriginHeaders(headers, realm);
  const response = await codebuddyFetch(
    workbuddyAccountsUrl(realm),
    { method: "GET", headers },
    signal,
  );
  if (!response.ok) return undefined;
  const body = await readJson(response, signal);
  const accounts = body && typeof body === "object"
    ? (body as { data?: { accounts?: unknown } }).data?.accounts
    : undefined;
  const list = Array.isArray(accounts) ? accounts : [];
  const account = list.find(item => item && typeof item === "object" && (item as { lastLogin?: unknown }).lastLogin === true)
    ?? list[0]
    ?? {};
  const domain = stringField(account, ["domain"]);
  return credentialFromTokens({
    access: accessToken,
    uid: stringField(account, ["uid", "userId", "user_id"]),
    email: stringField(account, ["email", "accountEmail", "account_email", "nickname"]),
    enterpriseId: stringField(account, ["enterpriseId", "enterprise_id"]),
    domain,
    realm: resolveWorkbuddyRealm(realm, domain),
    source: "manual",
  });
}

export async function validateCodebuddyAccessToken(
  accessToken: string,
  signal?: AbortSignal,
  realm?: WorkbuddyRealm,
): Promise<OAuthCredentials> {
  const token = accessToken.trim();
  if (!token) throw new Error("CodeBuddy token is empty");
  const order: WorkbuddyRealm[] = realm === "global" ? ["global", "cn"] : realm === "cn" ? ["cn", "global"] : ["cn", "global"];
  for (const site of order) {
    const cred = await validateCodebuddyAccessTokenOnRealm(site, token, signal);
    if (cred) return cred;
  }
  throw new Error("CodeBuddy token validation failed");
}

async function pollAccessToken(
  realm: WorkbuddyRealm,
  platform: string,
  state: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const deadline = Date.now() + workbuddySiteProfile(realm).loginTimeoutMs;
  const originHeaders: Record<string, string> = {};
  applyWorkbuddyLoginOriginHeaders(originHeaders, realm);
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Login cancelled", "AbortError");
    }
    const response = await codebuddyFetch(
      workbuddyAuthTokenUrl(realm, state),
      { method: "GET", headers: originHeaders },
      signal,
    );
    const body = await readJson(response, signal);
    if (envelopeOk(body)) {
      const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
      const access = stringField(data, ["accessToken", "access_token", "token"]);
      if (access) {
        const domain = stringField(data, ["domain"]);
        const refresh = stringField(data, ["refreshToken", "refresh_token"]);
        let account: { uid?: string; email?: string; enterpriseId?: string } = {};
        try {
          account = await fetchAccountInfo(realm, access, state, domain, signal);
        } catch {
          account = {
            uid: stringField(data, ["uid", "userId", "user_id"]),
            email: stringField(data, ["email", "accountEmail", "account_email"]),
            enterpriseId: stringField(data, ["enterpriseId", "enterprise_id"]),
          };
        }
        return credentialFromTokens({
          access,
          refresh,
          expiresAt: data && typeof data === "object"
            ? (data as { expiresAt?: unknown; expires_at?: unknown }).expiresAt
              ?? (data as { expires_at?: unknown }).expires_at
            : undefined,
          uid: account.uid,
          email: account.email,
          enterpriseId: account.enterpriseId,
          domain,
          realm: resolveWorkbuddyRealm(realm, domain),
          platform,
          source: "oauth",
        });
      }
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("CodeBuddy login timed out. Start the login again.");
}

async function pasteAccessToken(ctrl: OAuthController, realm: WorkbuddyRealm): Promise<OAuthCredentials> {
  while (true) {
    if (ctrl.signal?.aborted) {
      throw ctrl.signal.reason ?? new DOMException("Login cancelled", "AbortError");
    }
    const input = (await ctrl.onManualCodeInput?.())?.trim();
    if (!input) continue;
    return await validateCodebuddyAccessToken(input, ctrl.signal, realm);
  }
}

async function startAuthState(
  realm: WorkbuddyRealm,
  platform: string,
  signal?: AbortSignal,
): Promise<{ state: string; authUrl: string } | undefined> {
  const headers: Record<string, string> = {};
  applyWorkbuddyLoginOriginHeaders(headers, realm);
  const start = await codebuddyFetch(
    workbuddyAuthStateUrl(realm, platform),
    { method: "POST", headers, body: "{}" },
    signal,
  );
  const body = await readJson(start, signal);
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  const state = stringField(data, ["state"]);
  if (!state) return undefined;
  const profile = workbuddySiteProfile(realm);
  const authUrl = stringField(data, ["authUrl", "auth_url", "url"])
    ?? `${profile.webOrigin}/login?state=${encodeURIComponent(state)}`;
  return { state, authUrl };
}

export async function loginCodebuddy(
  ctrl: OAuthController = {},
  opts?: { realm?: WorkbuddyRealm },
): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("Login cancelled", "AbortError");
  }
  const realm = resolveWorkbuddyRealm(opts?.realm);
  const profile = workbuddySiteProfile(realm);
  let started: { state: string; authUrl: string; platform: string } | undefined;
  for (const platform of profile.loginPlatforms) {
    const attempt = await startAuthState(realm, platform, ctrl.signal);
    if (attempt) {
      started = { ...attempt, platform };
      break;
    }
  }
  if (!started) throw new Error("CodeBuddy login did not return a state");

  const pollAbort = new AbortController();
  const onParentAbort = () => pollAbort.abort(ctrl.signal?.reason);
  ctrl.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (ctrl.signal?.aborted) pollAbort.abort(ctrl.signal.reason);

  const siteLabel = realm === "global" ? "WorkBuddy (international)" : "CodeBuddy / WorkBuddy";
  ctrl.onAuth?.({
    url: started.authUrl,
    instructions: `Sign in to ${siteLabel} in the browser, or paste an access token below.`,
  });
  if (pollAbort.signal.aborted) {
    throw pollAbort.signal.reason ?? new DOMException("Login cancelled", "AbortError");
  }
  ctrl.onProgress?.(`Waiting for ${siteLabel} authentication...`);

  try {
    const poll = pollAccessToken(realm, started.platform, started.state, pollAbort.signal);
    if (!ctrl.onManualCodeInput) return await poll;
    const pasted = pasteAccessToken({ ...ctrl, signal: pollAbort.signal }, realm);
    return await Promise.race([poll, pasted]);
  } finally {
    pollAbort.abort();
    ctrl.signal?.removeEventListener("abort", onParentAbort);
  }
}

export async function refreshCodebuddyToken(
  refreshToken: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  const access = credential?.access?.trim();
  const refresh = refreshToken.trim();
  const realm = resolveWorkbuddyRealm(credential?.codebuddy?.realm, credential?.codebuddy?.domain);
  if (!refresh || !access || refresh === access) {
    if (!access) throw new Error("CodeBuddy refresh requires an access token");
    return credentialFromTokens({
      access,
      refresh: refresh || access,
      uid: credential?.codebuddy?.uid ?? credential?.accountId,
      email: credential?.email,
      enterpriseId: credential?.codebuddy?.enterpriseId,
      domain: credential?.codebuddy?.domain,
      realm,
      platform: credential?.codebuddy?.platform,
      deviceToken: credential?.codebuddy?.deviceToken,
      source: credential?.source ?? "oauth",
    });
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "X-Refresh-Token": refresh,
  };
  applyWorkbuddyRefreshHeaders(headers, realm, credential?.codebuddy);
  const response = await codebuddyFetch(
    workbuddyTokenRefreshUrl(realm),
    { method: "POST", headers, body: "{}" },
    signal,
  );
  const body = await readJson(response, signal);
  if (!response.ok || !envelopeOk(body)) {
    const message = stringField(body, ["message", "msg"]) ?? `HTTP ${response.status}`;
    throw new Error(`CodeBuddy token refresh failed: ${message}`);
  }
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  const nextAccess = stringField(data, ["accessToken", "access_token"]) ?? access;
  const nextRefresh = stringField(data, ["refreshToken", "refresh_token"]) ?? refresh;
  const nextDomain = stringField(data, ["domain"]) ?? credential?.codebuddy?.domain;
  return credentialFromTokens({
    access: nextAccess,
    refresh: nextRefresh,
    expiresAt: data && typeof data === "object"
      ? (data as { expiresAt?: unknown; expires_at?: unknown }).expiresAt
        ?? (data as { expires_at?: unknown }).expires_at
      : undefined,
    uid: credential?.codebuddy?.uid ?? credential?.accountId,
    email: credential?.email,
    enterpriseId: credential?.codebuddy?.enterpriseId,
    domain: nextDomain,
    realm: resolveWorkbuddyRealm(realm, nextDomain),
    platform: credential?.codebuddy?.platform,
    deviceToken: credential?.codebuddy?.deviceToken,
    source: credential?.source ?? "oauth",
  });
}
