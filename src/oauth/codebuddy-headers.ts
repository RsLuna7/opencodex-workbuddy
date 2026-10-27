/**
 * WorkBuddy chat / billing / refresh header tables.
 *
 * CN keeps CodeBuddyIDE + SaaS (existing overlay).
 * Global uses WorkBuddy desktop attribution + WorkBuddy AI UA platform segment
 * (Sliverkiss/workbuddy2api headers.go; 11140 if the platform segment is wrong).
 */
import { createHash } from "node:crypto";
import type { CodebuddyOAuthMetadata } from "./types";
import type { WorkbuddyRealm } from "./codebuddy-realm";
import {
  WORKBUDDY_CLI_VERSION,
  WORKBUDDY_CLIENT_VERSION,
  workbuddySiteProfile,
} from "./codebuddy-hosts";
import { resolveWorkbuddyDeviceToken } from "./workbuddy-device-token";

export interface WorkbuddyChatMeta {
  conversationId?: string;
  conversationRequestId?: string;
  traceId?: string;
  deviceToken?: string;
}

function deriveAccountStableId(uid: string, purpose: "machine" | "session"): string {
  const sum = createHash("sha256").update(`wb2a:${purpose}:${uid}`).digest("hex");
  return sum.slice(0, 36);
}

function validTraceId(value: string): boolean {
  return /^(?:[0-9a-fA-F]{16}|[0-9a-fA-F]{32})$/.test(value);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Shape a 32-hex id as a UUIDv4-looking string.
 *
 * The WorkBuddy desktop client's `X-Conversation-ID` is its session id, a dashed
 * UUID; `X-Request-ID` / `X-Conversation-Message-ID` are 32-hex without dashes.
 * Probed 2026-10-23 on the global site: the dash shape is what the capture shows,
 * and a bare 32-hex value was also accepted, so this matches the observed client
 * without depending on the leniency.
 */
function uuidShaped(hex32: string): string {
  const h = (hex32 + randomHex(16)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Stable `X-Conversation-ID` for one client conversation, without putting the client's own
 * thread id on the wire. A hashed seed keeps multi-turn requests inside one desktop-shaped
 * session while the raw identifier stays local.
 */
export function workbuddyConversationIdFrom(seed: string): string {
  return uuidShaped(createHash("sha256").update(`wbconv:${seed}`).digest("hex").slice(0, 32));
}

export function workbuddyDesktopUserAgent(realm: WorkbuddyRealm): string {
  const platform = realm === "global" ? "WorkBuddy AI" : "WorkBuddy";
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} ${platform}/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`;
}

export function applyWorkbuddyChatHeaders(
  headers: Record<string, string>,
  realm: WorkbuddyRealm,
  routing?: CodebuddyOAuthMetadata | null,
  meta?: WorkbuddyChatMeta,
): void {
  const profile = workbuddySiteProfile(realm);
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json, text/event-stream";
  headers["X-Requested-With"] = "XMLHttpRequest";
  headers["X-CodeBuddy-Request"] = "1";
  headers["Origin"] = profile.webOrigin;
  headers["Referer"] = `${profile.webOrigin}/`;
  headers["Accept-Language"] = realm === "global" ? "en-US" : "zh-CN";

  const uid = routing?.uid;
  if (uid) headers["X-User-Id"] = uid;
  else headers["X-No-User-Id"] = "1";

  if (realm === "global") {
    headers["User-Agent"] = workbuddyDesktopUserAgent("global");
    headers["X-Product"] = "WorkBuddy";
    headers["X-IDE-Name"] = "WorkBuddy";
    headers["X-IDE-Type"] = "WorkBuddy";
    headers["X-IDE-Version"] = WORKBUDDY_CLIENT_VERSION;
    headers["X-Agent-Purpose"] = "conversation";
    headers["X-No-Enterprise-Id"] = "1";
    headers["X-Domain"] = "www.workbuddy.ai";
  } else {
    headers["User-Agent"] = "CodeBuddyIDE";
    headers["X-Product"] = "SaaS";
    headers["X-IDE-Name"] = "CodeBuddyIDE";
    if (routing?.enterpriseId) {
      headers["X-Enterprise-Id"] = routing.enterpriseId;
      headers["X-Tenant-Id"] = routing.enterpriseId;
    } else {
      headers["X-No-Enterprise-Id"] = "1";
    }
    if (routing?.domain) headers["X-Domain"] = routing.domain;
    else headers["X-No-Department-Info"] = "1";
  }

  if (uid) {
    headers["X-Machine-ID"] = deriveAccountStableId(uid, "machine");
    headers["X-Session-ID"] = deriveAccountStableId(uid, "session");
  }
  const deviceToken = meta?.deviceToken ?? routing?.deviceToken
    ?? resolveWorkbuddyDeviceToken();
  if (deviceToken) headers["X-Device-Token"] = deviceToken;

  const messageId = randomHex(16);
  /**
   * All three conversation headers are mandatory on the global site.
   *
   * Probed 2026-10-23 against www.workbuddy.ai with a live global account and the rest
   * of this table held constant: omitting `X-Conversation-ID` answers HTTP 400
   * `{"code":"11-128","msg":"request illegal"}`; adding it answers 200. A missing id was
   * the normal case for every caller without `prompt_cache_key` (Codex, DSH, plain Chat
   * clients), which is why all global traffic looked like a channel-verification failure.
   *
   * The value is the desktop client's session id: stable inside one conversation, distinct
   * across conversations. A supplied seed is hashed so the client's own thread identifier
   * never reaches the wire; without a seed each request mints its own id.
   */
  const seed = meta?.conversationId?.trim();
  const conversationId = seed ? workbuddyConversationIdFrom(seed) : uuidShaped(randomHex(16));
  const conversationRequestId = seed && meta?.conversationRequestId?.trim()
    ? conversationId.replace(/-/g, "")
    : randomHex(16);
  headers["X-Conversation-ID"] = conversationId;
  headers["X-Conversation-Request-ID"] = conversationRequestId;
  headers["X-Conversation-Message-ID"] = messageId;
  headers["X-Request-ID"] = messageId;
  headers["X-Root-Request-ID"] = conversationRequestId;
  const traceId = meta?.traceId?.trim() || conversationRequestId;
  headers["X-Trace-ID"] = traceId;
  const b3Trace = validTraceId(conversationRequestId) ? conversationRequestId : messageId;
  headers["X-B3-TraceId"] = b3Trace;
  headers["X-B3-SpanId"] = messageId.slice(0, 16);
  headers["X-B3-Sampled"] = "1";
}

export function applyWorkbuddyRefreshHeaders(
  headers: Record<string, string>,
  realm: WorkbuddyRealm,
  routing?: CodebuddyOAuthMetadata | null,
): void {
  const profile = workbuddySiteProfile(realm);
  headers["Content-Type"] = "application/json";
  headers["Origin"] = profile.webOrigin;
  headers["Referer"] = `${profile.webOrigin}/`;
  headers["X-Auth-Refresh-Source"] = "plugin";
  if (routing?.enterpriseId) headers["X-Enterprise-Id"] = routing.enterpriseId;
  if (routing?.domain) headers["X-Domain"] = routing.domain;
}

export function applyWorkbuddyLoginOriginHeaders(
  headers: Record<string, string>,
  realm: WorkbuddyRealm,
): void {
  const origin = workbuddySiteProfile(realm).webOrigin;
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json, text/plain, */*";
  headers["X-Requested-With"] = "XMLHttpRequest";
  headers["Origin"] = origin;
  headers["Referer"] = `${origin}/`;
}

/** Official desktop billing UA (`WorkBuddy/<clientVersion>`, no CLI segment). */
export function workbuddyBillingUserAgent(): string {
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION}`;
}

/**
 * Billing / check-in / trial / growth headers.
 * Matches workbuddy2api BillingHeaders: short desktop UA, Origin, X-CodeBuddy-Request.
 */
export function applyWorkbuddyBillingHeaders(
  headers: Record<string, string>,
  realm: WorkbuddyRealm,
  routing?: CodebuddyOAuthMetadata | null,
): void {
  const profile = workbuddySiteProfile(realm);
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json";
  headers["X-Requested-With"] = "XMLHttpRequest";
  headers["X-CodeBuddy-Request"] = "1";
  headers["Origin"] = profile.webOrigin;
  headers["Referer"] = `${profile.webOrigin}/`;
  headers["Accept-Language"] = realm === "global" ? "en-US" : "zh-CN";
  headers["User-Agent"] = workbuddyBillingUserAgent();
  const uid = routing?.uid;
  if (uid) headers["X-User-Id"] = uid;
  if (routing?.enterpriseId) {
    headers["X-Enterprise-Id"] = routing.enterpriseId;
    headers["X-Tenant-Id"] = routing.enterpriseId;
  }
  if (routing?.domain) headers["X-Domain"] = routing.domain;
  const deviceToken = routing?.deviceToken ?? resolveWorkbuddyDeviceToken();
  if (deviceToken) headers["X-Device-Token"] = deviceToken;
}
