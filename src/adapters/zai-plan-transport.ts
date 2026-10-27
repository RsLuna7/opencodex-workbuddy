import type { AdapterFetchContext, AdapterRequest } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import { createZaiPlanPolicy } from "../oauth/zai-plan-policy";
import { readBoundedResponseBody } from "../lib/bounded-body";

type Captcha = Pick<typeof import("../oauth/zai-plan-captcha"), "getZaiPlanVerifyParam" | "zaiPlanBrowserFetch"
  | "invalidateZaiPlanCaptcha" | "ZAI_CAPTCHA_HEADER" | "ZAI_CAPTCHA_REGION_HEADER" | "ZAI_CAPTCHA_REGION">;
type Dependencies = { fetch?: typeof fetch; captcha?: () => Promise<Captcha> };
class PreflightRefusal extends Error { constructor(readonly response: Response) { super("ZCode request is no longer eligible"); } }

export async function isZaiPlanCaptchaChallenge(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.ok) return false;
  if (![400, 403].includes(response.status)) return false;
  const challenged = Boolean(response.headers.get("x-aliyun-captcha-verify-param")?.trim());
  try {
    const read = await readBoundedResponseBody(response.clone(), { signal, maxBytes: 65_536, totalTimeoutMs: 5_000 });
    if (!read.displaySafe) return challenged;
    const body = JSON.parse(read.text) as { code?: unknown; error?: { code?: unknown } } | null;
    const code = body?.code ?? body?.error?.code;
    return code === 3012 ? false : code === 3007 || challenged;
  } catch { signal?.throwIfAborted(); return challenged; }
}

/** No browser is imported or started until public policy or an explicit refusal requires it. */
export function createZaiPlanTransport(dependencies: Dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const policy = createZaiPlanPolicy(fetcher);
  const loadCaptcha = dependencies.captcha ?? (() => import("../oauth/zai-plan-captcha"));
  return async (request: AdapterRequest, ctx: AdapterFetchContext = {}, guard?: () => Response | null): Promise<Response> => {
    ctx.abortSignal?.throwIfAborted();
    const refused = guard?.();
    if (refused) return refused;
    let browser = await policy.required(ctx.abortSignal);
    let captcha: Captcha | undefined;
    const executor = (ctx.executor ?? fetcher) as typeof fetch & {
      unpacedFetch?: typeof fetch; waitForPacing?: (signal?: AbortSignal) => Promise<import("../providers/request-pacing").ProviderRequestSlot | void>;
    };
    let param: string | undefined;
    const dispatch = (async (input, init) => {
      if (!browser) return (executor.unpacedFetch ?? executor)(input, init);
      const result = await captcha!.zaiPlanBrowserFetch({
        url: request.url, body: request.body,
        headers: { ...request.headers, [captcha!.ZAI_CAPTCHA_HEADER]: param!,
          [captcha!.ZAI_CAPTCHA_REGION_HEADER]: captcha!.ZAI_CAPTCHA_REGION },
        signal: init?.signal ?? ctx.abortSignal,
      });
      return new Response(result.body, { status: result.status, headers: result.headers });
    }) as typeof fetch;
    Object.assign(dispatch, { waitForPacing: executor.waitForPacing?.bind(executor) });
    const send = createAdapterPhysicalSend({ ...ctx, executor: dispatch });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.abortSignal?.throwIfAborted();
      try { response = await send({ url: request.url, sendClass: attempt ? "auth-recovery" : "initial",
        beforeDispatch: async () => {
          const refused = guard?.();
          if (refused) throw new PreflightRefusal(refused);
          if (browser) {
            captcha ??= await loadCaptcha();
            param = await captcha.getZaiPlanVerifyParam(ctx.abortSignal);
            const refused = guard?.();
            if (refused) throw new PreflightRefusal(refused);
          }
        },
        dispatch: async (physicalFetch) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 45_000);
          try {
            return await physicalFetch(request.url, {
              method: request.method, headers: request.headers, body: request.body, redirect: "error",
              signal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, controller.signal]) : controller.signal,
            });
          } finally { clearTimeout(timer); }
        },
      }); } catch (error) { if (error instanceof PreflightRefusal) return error.response; throw error; }
      if (!await isZaiPlanCaptchaChallenge(response, ctx.abortSignal) || attempt === 2) return response;
      await response.body?.cancel();
      policy.challenge();
      browser = true;
      captcha?.invalidateZaiPlanCaptcha();
    }
    return response!;
  };
}
