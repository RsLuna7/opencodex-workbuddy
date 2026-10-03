/**
 * WorkBuddy outbound fetch: pin HTTP/1.1 and abandon a pooled socket after a
 * transport failure (workbuddy2api transport.go: disable h2, close idle on error).
 */
import { withUpstreamHttpVersionValue } from "../lib/upstream-http-version";

let freshSocket = false;

export function resetWorkbuddyFetchForTests(): void {
  freshSocket = false;
}

function targetHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function workbuddyFetchImpl(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let next = withUpstreamHttpVersionValue(targetHref(input), init, "http1.1") ?? init ?? {};
  if (freshSocket) {
    next = { ...next, keepalive: false };
    freshSocket = false;
  }
  try {
    return await fetch(input, next);
  } catch (error) {
    freshSocket = true;
    throw error;
  }
}

export const workbuddyFetch: typeof fetch = Object.assign(workbuddyFetchImpl, {
  preconnect: globalThis.fetch.preconnect?.bind(globalThis.fetch),
});
