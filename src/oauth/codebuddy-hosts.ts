/**
 * WorkBuddy / CodeBuddy dual-site hosts and login platforms.
 *
 * CN chat is copilot.tencent.com; CN login Origin is www.codebuddy.cn.
 * Global chat, login, and Origin are all www.workbuddy.ai.
 * Chat path is /v2/chat/completions on both sites — never /console (WAF 403).
 */
import type { WorkbuddyRealm } from "./codebuddy-realm";

export const WORKBUDDY_CN_AUTH_ORIGIN = "https://www.codebuddy.cn";
export const WORKBUDDY_CN_CHAT_BASE = "https://copilot.tencent.com/v2";
export const WORKBUDDY_CN_CHAT_ORIGIN = "https://copilot.tencent.com";
export const WORKBUDDY_CN_BILLING_ORIGIN = "https://copilot.tencent.com";

export const WORKBUDDY_GLOBAL_ORIGIN = "https://www.workbuddy.ai";
export const WORKBUDDY_GLOBAL_CHAT_BASE = "https://www.workbuddy.ai/v2";

export const WORKBUDDY_PLUGIN_PREFIX = "/v2/plugin";
export const WORKBUDDY_CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
export const WORKBUDDY_MODELS_PATH = "/v2/enterprises/personal/models";
export const WORKBUDDY_CN_LOGIN_PLATFORM = "ide";
export const WORKBUDDY_GLOBAL_LOGIN_PLATFORMS = ["workbuddy-ai", "CLI"] as const;

export const WORKBUDDY_CN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const WORKBUDDY_GLOBAL_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export const WORKBUDDY_CLIENT_VERSION = "5.5.4";
export const WORKBUDDY_CLI_VERSION = "2.137.1";

export interface WorkbuddySiteProfile {
  realm: WorkbuddyRealm;
  authOrigin: string;
  chatOrigin: string;
  chatBase: string;
  billingOrigin: string;
  webOrigin: string;
  loginPlatforms: readonly string[];
  loginTimeoutMs: number;
}

const CN_PROFILE: WorkbuddySiteProfile = {
  realm: "cn",
  authOrigin: WORKBUDDY_CN_AUTH_ORIGIN,
  chatOrigin: WORKBUDDY_CN_CHAT_ORIGIN,
  chatBase: WORKBUDDY_CN_CHAT_BASE,
  billingOrigin: WORKBUDDY_CN_BILLING_ORIGIN,
  webOrigin: WORKBUDDY_CN_AUTH_ORIGIN,
  loginPlatforms: [WORKBUDDY_CN_LOGIN_PLATFORM],
  loginTimeoutMs: WORKBUDDY_CN_LOGIN_TIMEOUT_MS,
};

const GLOBAL_PROFILE: WorkbuddySiteProfile = {
  realm: "global",
  authOrigin: WORKBUDDY_GLOBAL_ORIGIN,
  chatOrigin: WORKBUDDY_GLOBAL_ORIGIN,
  chatBase: WORKBUDDY_GLOBAL_CHAT_BASE,
  billingOrigin: WORKBUDDY_GLOBAL_ORIGIN,
  webOrigin: WORKBUDDY_GLOBAL_ORIGIN,
  loginPlatforms: WORKBUDDY_GLOBAL_LOGIN_PLATFORMS,
  loginTimeoutMs: WORKBUDDY_GLOBAL_LOGIN_TIMEOUT_MS,
};

export function workbuddySiteProfile(realm: WorkbuddyRealm): WorkbuddySiteProfile {
  return realm === "global" ? GLOBAL_PROFILE : CN_PROFILE;
}

export function workbuddyAuthStateUrl(realm: WorkbuddyRealm, platform: string): string {
  const origin = workbuddySiteProfile(realm).authOrigin;
  return `${origin}${WORKBUDDY_PLUGIN_PREFIX}/auth/state?platform=${encodeURIComponent(platform)}`;
}

export function workbuddyAuthTokenUrl(realm: WorkbuddyRealm, state: string): string {
  const origin = workbuddySiteProfile(realm).authOrigin;
  return `${origin}${WORKBUDDY_PLUGIN_PREFIX}/auth/token?state=${encodeURIComponent(state)}`;
}

export function workbuddyLoginAccountUrl(realm: WorkbuddyRealm, state: string): string {
  const origin = workbuddySiteProfile(realm).authOrigin;
  return `${origin}${WORKBUDDY_PLUGIN_PREFIX}/login/account?state=${encodeURIComponent(state)}`;
}

export function workbuddyTokenRefreshUrl(realm: WorkbuddyRealm): string {
  const origin = workbuddySiteProfile(realm).authOrigin;
  return `${origin}${WORKBUDDY_PLUGIN_PREFIX}/auth/token/refresh`;
}

export function workbuddyChatCompletionsUrl(realm: WorkbuddyRealm): string {
  return `${workbuddySiteProfile(realm).chatOrigin}${WORKBUDDY_CHAT_COMPLETIONS_PATH}`;
}

export function workbuddyModelsUrl(realm: WorkbuddyRealm): string {
  return `${workbuddySiteProfile(realm).chatOrigin}${WORKBUDDY_MODELS_PATH}`;
}

export function workbuddyAccountsUrl(realm: WorkbuddyRealm): string {
  const origin = workbuddySiteProfile(realm).authOrigin;
  return `${origin}${WORKBUDDY_PLUGIN_PREFIX}/accounts`;
}

/** Billing meter paths: Global tries unprefixed first, then /v2 (P10). CN is /v2 only. */
export function workbuddyBillingMeterPaths(realm: WorkbuddyRealm, leaf: string): string[] {
  const trimmed = leaf.replace(/^\/+/, "");
  if (realm === "global") {
    return [`/billing/meter/${trimmed}`, `/v2/billing/meter/${trimmed}`];
  }
  return [`/v2/billing/meter/${trimmed}`];
}

export function isCanonicalWorkbuddyChatBase(baseUrl: string): boolean {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed === WORKBUDDY_CN_CHAT_BASE || trimmed === WORKBUDDY_GLOBAL_CHAT_BASE;
}
