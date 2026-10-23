/**
 * WorkBuddy credential guard: stop sending traffic through an account the gateway has
 * rejected. A revoked session answers every request with an APISIX HTML 401, and a
 * restricted account answers business code 11140. Repeating requests against either
 * only adds failed calls to an account that is already flagged, so the pool cools it
 * instead and lets the next pick move on.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";

export const WORKBUDDY_ACCOUNT_RESTRICTED_CODE = "11140";
/** A revoked session needs a fresh login; probe again rarely rather than hammer it. */
export const WORKBUDDY_CREDENTIAL_REJECTED_COOLDOWN_MS = 5 * 60_000;
/** "Unusual activity" restrictions do not lift on their own within a session. */
export const WORKBUDDY_ACCOUNT_RESTRICTED_COOLDOWN_MS = 6 * 60 * 60_000;

export type WorkbuddyCredentialRejection = {
  kind: "restricted" | "rejected";
  cooldownMs: number;
  reason: "restricted" | "credential-rejected";
};

function businessCode(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === "number" || typeof code === "string" ? String(code) : undefined;
  } catch {
    return undefined;
  }
}

/** 11140 wins over the status line; a bare 401 means the session itself was rejected. */
export function classifyWorkbuddyCredentialRejection(
  status: number,
  body: string,
): WorkbuddyCredentialRejection | undefined {
  if (businessCode(body) === WORKBUDDY_ACCOUNT_RESTRICTED_CODE) {
    return { kind: "restricted", cooldownMs: WORKBUDDY_ACCOUNT_RESTRICTED_COOLDOWN_MS, reason: "restricted" };
  }
  if (status === 401) {
    return { kind: "rejected", cooldownMs: WORKBUDDY_CREDENTIAL_REJECTED_COOLDOWN_MS, reason: "credential-rejected" };
  }
  return undefined;
}

/** Reads a clone, so the caller's response stays readable. Only 400/401/403 are worth a read. */
export async function inspectWorkbuddyCredentialRejection(
  response: Response,
  signal?: AbortSignal,
): Promise<WorkbuddyCredentialRejection | undefined> {
  const status = response.status;
  if (status !== 400 && status !== 401 && status !== 403) return undefined;
  let text = "";
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    text = body.displaySafe ? body.text : "";
  } catch {
    // An unreadable 401 is still a rejected session.
    return status === 401 ? classifyWorkbuddyCredentialRejection(401, "") : undefined;
  }
  return classifyWorkbuddyCredentialRejection(status, text);
}
