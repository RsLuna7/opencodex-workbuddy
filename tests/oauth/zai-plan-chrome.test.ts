import { describe, expect, test } from "bun:test";
import {
  isZaiPlanChromeTransientError,
  isZaiPlanPageReady,
  runZaiPlanChromeAttempt,
  ZAI_PLAN_FETCH_SAFETY_TIMEOUT_MS,
  zaiPlanBrowserFetchTimeoutMs,
} from "../../src/oauth/zai-plan-captcha";
import { ZAI_ORIGIN } from "../../src/oauth/zai-plan";

describe("zai-plan Chrome fetch helpers", () => {
  test("default fetch safety timeout is 300s, not 90s", () => {
    expect(ZAI_PLAN_FETCH_SAFETY_TIMEOUT_MS).toBe(300_000);
    expect(zaiPlanBrowserFetchTimeoutMs()).toBe(300_000);
    expect(zaiPlanBrowserFetchTimeoutMs(180_000)).toBe(180_000);
  });

  test("page is ready only on zcode.z.ai after load", () => {
    expect(isZaiPlanPageReady(ZAI_ORIGIN, "complete")).toBe(true);
    expect(isZaiPlanPageReady(ZAI_ORIGIN, "interactive")).toBe(true);
    expect(isZaiPlanPageReady(ZAI_ORIGIN, "loading")).toBe(false);
    expect(isZaiPlanPageReady("about:blank", "complete")).toBe(false);
    expect(isZaiPlanPageReady("https://example.com", "complete")).toBe(false);
  });

  test("Failed to fetch and dead Chrome are transient; abort is not", () => {
    expect(isZaiPlanChromeTransientError(new Error("TypeError: Failed to fetch"))).toBe(true);
    expect(isZaiPlanChromeTransientError(new Error("Failed to fetch\n    at <anonymous>:2:23"))).toBe(true);
    expect(isZaiPlanChromeTransientError(new Error("chrome exited 1"))).toBe(true);
    expect(isZaiPlanChromeTransientError(new Error("cdp websocket error"))).toBe(true);
    expect(isZaiPlanChromeTransientError(new Error("zcode.z.ai did not load"))).toBe(true);
    expect(isZaiPlanChromeTransientError(new DOMException("The user aborted a request.", "AbortError"))).toBe(false);
    expect(isZaiPlanChromeTransientError(new DOMException("The operation was aborted", "AbortError"))).toBe(false);
    expect(isZaiPlanChromeTransientError(new Error("Provider error 405"))).toBe(false);
  });

  test("transient Chrome error restarts once then succeeds", async () => {
    const calls: string[] = [];
    const result = await runZaiPlanChromeAttempt({
      restart: () => calls.push("restart"),
      run: async () => {
        calls.push("run");
        if (calls.filter((c) => c === "run").length === 1) throw new Error("TypeError: Failed to fetch");
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toEqual(["run", "restart", "run"]);
  });

  test("abort is not retried", async () => {
    const signal = AbortSignal.abort(new DOMException("The operation was aborted", "AbortError"));
    let runs = 0;
    await expect(runZaiPlanChromeAttempt({
      abortSignal: signal,
      restart: () => {
        throw new Error("should not restart");
      },
      run: async () => {
        runs += 1;
        throw new Error("TypeError: Failed to fetch");
      },
    })).rejects.toMatchObject({ message: "TypeError: Failed to fetch" });
    expect(runs).toBe(1);
  });

  test("non-transient errors are not retried", async () => {
    let runs = 0;
    await expect(runZaiPlanChromeAttempt({
      restart: () => {
        throw new Error("should not restart");
      },
      run: async () => {
        runs += 1;
        throw new Error("Provider error 405");
      },
    })).rejects.toMatchObject({ message: "Provider error 405" });
    expect(runs).toBe(1);
  });
});
