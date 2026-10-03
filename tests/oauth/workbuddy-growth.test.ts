import { describe, expect, test } from "bun:test";
import {
  claimWorkbuddyTrial,
  jobsForCstHour,
  nextGrowthDelayMs,
  runWorkbuddyGrowthTick,
  WORKBUDDY_REPORT_PATH,
  WORKBUDDY_TRIAL_PATH,
} from "../../src/oauth/workbuddy-growth";
import type { ProviderAccount } from "../../src/oauth/types";

function account(realm: "cn" | "global"): ProviderAccount {
  return {
    id: realm === "global" ? "g1" : "c1",
    credential: {
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 86_400_000,
      accountId: `${realm}-uid`,
      source: "oauth",
      codebuddy: {
        uid: `${realm}-uid`,
        realm,
        domain: realm === "global" ? "www.workbuddy.ai" : "copilot.tencent.com",
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("workbuddy growth", () => {
  test("jobsForCstHour splits checkin travel from activity", () => {
    expect(jobsForCstHour(9)).toEqual(["trial", "travel"]);
    expect(jobsForCstHour(10)).toEqual(["activity", "rewards"]);
    expect(jobsForCstHour(21)).toEqual(["trial", "travel"]);
  });

  test("nextGrowthDelayMs after 09:10 waits until 10:00", () => {
    const now = Date.parse("2026-09-21T09:10:00+08:00");
    expect(nextGrowthDelayMs(now)).toBe(50 * 60 * 1000);
  });

  test("trial is global-only and treats 14051 as already claimed", async () => {
    const cn = await claimWorkbuddyTrial(account("cn"));
    expect(cn.result).toBe("SKIPPED_CN");
    const global = await claimWorkbuddyTrial(account("global"), {
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe(WORKBUDDY_TRIAL_PATH);
        return jsonResponse({ code: 14051 });
      },
    });
    expect(global.result).toBe("ALREADY_CLAIMED");
  });

  test("activity tick reports five chat_request_send events for CN accounts", async () => {
    const paths: string[] = [];
    const results = await runWorkbuddyGrowthTick(["activity"], {
      listAccountsImpl: () => [account("cn"), account("global")],
      fetchImpl: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return jsonResponse({ code: 0 });
      },
    });
    expect(results).toEqual([{ accountId: "c1", kind: "activity", result: "REPORTED" }]);
    expect(paths.filter(path => path === WORKBUDDY_REPORT_PATH)).toHaveLength(5);
  });
});
