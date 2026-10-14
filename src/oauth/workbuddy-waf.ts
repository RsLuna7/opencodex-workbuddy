/**
 * WorkBuddy WAF 403: account-level soft cooldown plus IP-level fail-fast.
 *
 * Ported from Sliverkiss/workbuddy2api IsWafBlocked + wafip.go (MIT):
 * 403 without a business envelope (no `"code":` / `"msg":`) is WAF;
 * two different UIDs in 60s means the exit IP is blocked — stop rotating.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";

export const WORKBUDDY_WAF_WINDOW_MS = 60_000;
export const WORKBUDDY_WAF_IP_THRESHOLD = 2;
export const WORKBUDDY_WAF_ACCOUNT_COOLDOWN_MS = 60_000;

const hits = new Map<string, number>();
let ipBlockedUntil = 0;

export function resetWorkbuddyWafForTests(): void {
  hits.clear();
  ipBlockedUntil = 0;
}

export function hasWorkbuddyBusinessEnvelope(body: string): boolean {
  return body.includes('"code":') || body.includes('"msg":');
}

export function isWorkbuddyWafBlock(status: number, body: string): boolean {
  return status === 403 && !hasWorkbuddyBusinessEnvelope(body);
}

export function isWorkbuddyWafIpBlocked(now = Date.now()): boolean {
  return now < ipBlockedUntil;
}

/** Record one WAF 403. Returns true when the IP-level gate is active afterwards. */
export function noteWorkbuddyWafHit(uid: string, now = Date.now()): boolean {
  if (!uid) return isWorkbuddyWafIpBlocked(now);
  if (now < ipBlockedUntil) return true;
  hits.set(uid, now);
  for (const [id, at] of hits) {
    if (now - at > WORKBUDDY_WAF_WINDOW_MS) hits.delete(id);
  }
  if (hits.size >= WORKBUDDY_WAF_IP_THRESHOLD) {
    ipBlockedUntil = now + WORKBUDDY_WAF_WINDOW_MS;
    hits.clear();
    return true;
  }
  return false;
}

export async function inspectWorkbuddyWafBlock(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 403) return false;
  let text = "";
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    text = body.displaySafe ? body.text : "";
  } catch {
    return true;
  }
  return isWorkbuddyWafBlock(403, text);
}
