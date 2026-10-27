import { ZAI_ORIGIN, ZAI_PLAN_APP_VERSION } from "./zai-plan";
import { readBoundedResponseBody } from "../lib/bounded-body";

/** Public client policy only: never include account credentials in this request or cache. */
export function createZaiPlanPolicy(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: { required: boolean; until: number } | undefined;
  return {
    challenge() { cached = { required: true, until: now() + 60_000 }; },
    async required(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      if (cached && cached.until > now()) return cached.required;
      const deadline = AbortSignal.timeout(5_000);
      try {
        const response = await fetcher(`${ZAI_ORIGIN}/api/v1/client/configs?app_version=${ZAI_PLAN_APP_VERSION}`, {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error",
        });
        const body = await readBoundedResponseBody(response, { signal, maxBytes: 262_144, totalTimeoutMs: 5_000 });
        const data = response.ok && body.displaySafe ? JSON.parse(body.text) as {
          data?: { configs?: { captcha?: { enabled?: boolean; skip_model_request?: boolean } } };
        } : undefined;
        const captcha = data?.data?.configs?.captcha;
        const required = captcha?.enabled === true && captcha.skip_model_request === false;
        cached = { required, until: now() + (captcha ? 60_000 : 5_000) };
        return required;
      } catch {
        signal?.throwIfAborted();
        // Unknown policy permits one ordinary request; only an explicit challenge triggers recovery.
        cached = { required: false, until: now() + 5_000 };
        return false;
      }
    },
  };
}
