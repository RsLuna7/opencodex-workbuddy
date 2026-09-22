/**
 * Optional X-Device-Token for WorkBuddy chat/billing.
 *
 * Credential value wins. Otherwise a desktop-sidecar file path from
 * OPENCODEX_WORKBUDDY_DEVICE_TOKEN_FILE (wb2api device_token.go: 5 min cache, 1 KiB cap).
 * File contents are never written into auth.json.
 */
import { readFileSync, statSync } from "node:fs";

export const WORKBUDDY_DEVICE_TOKEN_FILE_ENV = "OPENCODEX_WORKBUDDY_DEVICE_TOKEN_FILE";
const FILE_TTL_MS = 5 * 60_000;
const FILE_MAX_BYTES = 1024;

let cache: { path: string; token: string; readAt: number } | null = null;

export function resetWorkbuddyDeviceTokenCacheForTests(): void {
  cache = null;
}

export function resolveWorkbuddyDeviceToken(explicit?: string | null): string | undefined {
  const fromCred = explicit?.trim();
  if (fromCred) return fromCred;
  const path = process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV]?.trim();
  if (!path) return undefined;
  const now = Date.now();
  if (cache && cache.path === path && now - cache.readAt < FILE_TTL_MS) {
    return cache.token || undefined;
  }
  let token = "";
  try {
    const info = statSync(path);
    if (info.isFile() && info.size > 0 && info.size <= FILE_MAX_BYTES) {
      token = readFileSync(path, "utf8").trim();
      if (token.length > FILE_MAX_BYTES) token = "";
    }
  } catch {
    token = "";
  }
  cache = { path, token, readAt: now };
  return token || undefined;
}
