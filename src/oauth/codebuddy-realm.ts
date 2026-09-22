/**
 * WorkBuddy / CodeBuddy site realm (cn | global).
 *
 * Protocol table from Sliverkiss/workbuddy2api `internal/auth/auth.go` (MIT):
 * explicit realm wins; otherwise domain suffix `.workbuddy.ai` → global; else cn.
 * `workbuddyGlobal.enabled === false` is a routing lock, never a write-back.
 */
import type { OAuthCredentials } from "./types";
import type { OcxConfig } from "../types";

export type WorkbuddyRealm = "cn" | "global";

export const WORKBUDDY_REALMS = ["cn", "global"] as const;

export function isWorkbuddyRealm(value: unknown): value is WorkbuddyRealm {
  return value === "cn" || value === "global";
}

export function parseWorkbuddyRealm(value: unknown): WorkbuddyRealm | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "intl" || normalized === "international") return "global";
  return isWorkbuddyRealm(normalized) ? normalized : undefined;
}

/** True when `domain` is the WorkBuddy international family. */
export function isWorkbuddyGlobalDomain(domain: string | undefined | null): boolean {
  const value = domain?.trim().toLowerCase() ?? "";
  return value === "workbuddy.ai" || value.endsWith(".workbuddy.ai");
}

/**
 * Normalize realm for storage and routing.
 * Empty explicit + empty domain → cn (legacy CN credentials).
 */
export function resolveWorkbuddyRealm(
  explicit?: string | null,
  domain?: string | null,
): WorkbuddyRealm {
  const parsed = parseWorkbuddyRealm(explicit);
  if (parsed) return parsed;
  return isWorkbuddyGlobalDomain(domain) ? "global" : "cn";
}

export function credentialWorkbuddyRealm(
  cred?: Pick<OAuthCredentials, "codebuddy" | "accountId"> | null,
): WorkbuddyRealm {
  return resolveWorkbuddyRealm(cred?.codebuddy?.realm, cred?.codebuddy?.domain);
}

/** Routing lock: false means even a stored global credential is treated as cn. */
export function workbuddyGlobalRoutingEnabled(
  config?: Pick<OcxConfig, "workbuddyGlobal"> | null,
): boolean {
  return config?.workbuddyGlobal?.enabled !== false;
}

export function routedWorkbuddyRealm(
  cred?: Pick<OAuthCredentials, "codebuddy" | "accountId"> | null,
  config?: Pick<OcxConfig, "workbuddyGlobal"> | null,
): WorkbuddyRealm {
  const stored = credentialWorkbuddyRealm(cred);
  if (stored === "global" && !workbuddyGlobalRoutingEnabled(config)) return "cn";
  return stored;
}

export function workbuddyAccountsShareRealm(
  left?: Pick<OAuthCredentials, "codebuddy"> | null,
  right?: Pick<OAuthCredentials, "codebuddy"> | null,
): boolean {
  return credentialWorkbuddyRealm(left) === credentialWorkbuddyRealm(right);
}
