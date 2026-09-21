import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateWorkbuddyCheckinScheduler,
  checkinWorkbuddyCredential,
  nextWorkbuddyCheckinDelayMs,
  runWorkbuddyCheckin,
  workbuddyCheckinActivationRequired,
  workbuddyCheckinExitCode,
  WORKBUDDY_CHECKIN_CLAIM_PATH,
  WORKBUDDY_CHECKIN_STATUS_PATH,
} from "../../src/oauth/codebuddy-checkin";
import { resetOptionalShutdownHooksForTests } from "../../src/lib/optional-shutdown-hooks";
import { saveCredential } from "../../src/oauth/store";
import type { OAuthCredentials, ProviderAccount } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function account(partial: Partial<OAuthCredentials> & { id?: string } = {}): ProviderAccount {
  const { id, ...cred } = partial;
  return {
    id: id ?? "acct-1",
    credential: {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      email: "tester",
      accountId: "uid-1",
      source: "oauth",
      codebuddy: { uid: "uid-1", domain: "copilot.tencent.com" },
      ...cred,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("nextWorkbuddyCheckinDelayMs", () => {
  test("before 09:10 Asia/Shanghai waits until that morning", () => {
    const now = Date.parse("2026-09-21T09:00:00+08:00");
    expect(nextWorkbuddyCheckinDelayMs(now)).toBe(10 * 60 * 1000);
  });

  test("at 09:10 Asia/Shanghai waits until 21:10", () => {
    const now = Date.parse("2026-09-21T09:10:00+08:00");
    expect(nextWorkbuddyCheckinDelayMs(now)).toBe(12 * 60 * 60 * 1000);
  });

  test("at 21:10 Asia/Shanghai waits until tomorrow 09:10", () => {
    const now = Date.parse("2026-09-21T21:10:00+08:00");
    expect(nextWorkbuddyCheckinDelayMs(now)).toBe(12 * 60 * 60 * 1000);
  });
});

describe("checkinWorkbuddyCredential", () => {
  test("status-only never posts the claim endpoint", async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      return jsonResponse({
        code: 0,
        data: { active: true, today_checked_in: false, today_credit: 100 },
      });
    };
    const result = await checkinWorkbuddyCredential(account(), { statusOnly: true, fetchImpl });
    expect(result.result).toBe("STATUS");
    expect(paths).toEqual([WORKBUDDY_CHECKIN_STATUS_PATH]);
  });

  test("claims when today is open, then verifies", async () => {
    let statusCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === WORKBUDDY_CHECKIN_STATUS_PATH) {
        statusCalls += 1;
        return jsonResponse({
          code: 0,
          data: {
            active: true,
            today_checked_in: statusCalls > 1,
            today_credit: 100,
            streak_days: statusCalls > 1 ? 1 : 0,
          },
        });
      }
      expect(path).toBe(WORKBUDDY_CHECKIN_CLAIM_PATH);
      return jsonResponse({ code: 0, data: { credit: 100 } });
    };
    const result = await checkinWorkbuddyCredential(account(), { fetchImpl });
    expect(result.result).toBe("CLAIMED");
    expect(result.credit).toBe(100);
    expect(result.today_checked_in).toBe(true);
  });

  test("already claimed does not post daily-checkin", async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return jsonResponse({
        code: 0,
        data: { active: true, today_checked_in: true, streak_days: 3 },
      });
    };
    const result = await checkinWorkbuddyCredential(account(), { fetchImpl });
    expect(result.result).toBe("ALREADY_CLAIMED");
    expect(paths).toEqual([WORKBUDDY_CHECKIN_STATUS_PATH]);
  });

  test("status-only still skips Global workbuddy.ai accounts", async () => {
    const result = await checkinWorkbuddyCredential(account({
      codebuddy: { uid: "uid-g", domain: "www.workbuddy.ai" },
    }), {
      statusOnly: true,
      fetchImpl: async () => {
        throw new Error("must not call billing");
      },
    });
    expect(result.result).toBe("SKIPPED_GLOBAL");
  });

  test("Global accounts claim the one-shot trial pack", async () => {
    const paths: string[] = [];
    const result = await checkinWorkbuddyCredential(account({
      codebuddy: { uid: "uid-g", domain: "www.workbuddy.ai", realm: "global" },
    }), {
      fetchImpl: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return jsonResponse({ code: 14051, msg: "already claimed" });
      },
    });
    expect(result.result).toBe("ALREADY_CLAIMED");
    expect(paths).toEqual(["/billing/ide/trial"]);
  });
});

describe("runWorkbuddyCheckin", () => {
  test("wrong provider is a hard error", async () => {
    const run = await runWorkbuddyCheckin({ provider: "openai" });
    expect(run.results[0]?.result).toBe("WRONG_PROVIDER");
    expect(workbuddyCheckinExitCode(run)).toBe(2);
  });

  test("empty store is a hard error", async () => {
    const run = await runWorkbuddyCheckin({ listAccountsImpl: () => [] });
    expect(run.results[0]?.result).toBe("NO_ACCOUNTS");
    expect(workbuddyCheckinExitCode(run)).toBe(2);
  });
});

describe("workbuddyCheckinActivationRequired", () => {
  let home = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-wb-checkin-"));
    process.env.OPENCODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  test("stays off for an openai-only install", () => {
    expect(workbuddyCheckinActivationRequired({ providers: { openai: { type: "openai" } } as never })).toBe(false);
  });

  test("turns on when the workbuddy provider is configured", () => {
    expect(workbuddyCheckinActivationRequired({
      providers: { workbuddy: { type: "openai", authMode: "oauth" } } as never,
    })).toBe(true);
  });

  test("auto false wins even with a configured provider", () => {
    expect(workbuddyCheckinActivationRequired({
      workbuddyCheckin: { auto: false },
      providers: { workbuddy: { type: "openai", authMode: "oauth" } } as never,
    })).toBe(false);
  });

  test("turns on when accounts exist even without a provider block", async () => {
    await saveCredential("workbuddy", account().credential);
    expect(workbuddyCheckinActivationRequired({ providers: {} })).toBe(true);
  });
});

describe("activateWorkbuddyCheckinScheduler", () => {
  afterEach(() => {
    resetOptionalShutdownHooksForTests();
  });

  test("registers a timer and stop clears it", () => {
    const delays: number[] = [];
    let cleared = 0;
    const scheduler = activateWorkbuddyCheckinScheduler({ providers: {} }, {
      setTimeoutImpl: ((cb: () => void, ms: number) => {
        delays.push(ms);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: (() => {
        cleared += 1;
      }) as typeof clearTimeout,
      listAccountsImpl: () => [],
    });
    expect(delays).toEqual([5_000]);
    scheduler.stop();
    expect(cleared).toBe(1);
  });
});
