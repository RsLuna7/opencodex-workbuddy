import { describe, expect, test } from "bun:test";
import {
  extractWorkbuddyResourceAccounts,
  fetchWorkbuddyDashboardSnapshot,
  packageRemainUsed,
  parseWorkbuddyCstMillis,
  summarizeWorkbuddyPackages,
  workbuddyCstDate,
} from "../../src/oauth/workbuddy-credits";
import { workbuddyQuotaFromCredits } from "../../src/providers/quota/workbuddy";
import { explicitAccountReader, explicitQuotaDestination } from "../../src/providers/quota/account-cache";
import type { OAuthCredentials } from "../../src/oauth/types";

describe("workbuddy credit parse", () => {
  test("packageRemainUsed prefers cycle fields and clamps remain", () => {
    expect(packageRemainUsed({
      CycleCapacitySize: 100,
      CycleCapacityRemain: 140,
      CycleCapacityUsed: 0,
    })).toEqual({ remain: 100, used: 0, size: 100 });
    expect(packageRemainUsed({
      CapacitySize: 50,
      CapacityRemain: 20,
      CapacityUsed: 0,
    })).toEqual({ remain: 20, used: 30, size: 50 });
  });

  test("summarizeWorkbuddyPackages aggregates remain/used/size and soonest expiry", () => {
    const snapshot = summarizeWorkbuddyPackages([
      {
        PackageName: "A",
        CycleCapacitySize: 100,
        CycleCapacityRemain: 100,
        CycleCapacityUsed: 0,
        CycleEndTime: "2026-10-21 09:09:57",
      },
      {
        PackageName: "B",
        CycleCapacitySize: 1500,
        CycleCapacityRemain: 200,
        CycleCapacityUsed: 1300,
        CycleEndTime: "2026-10-20 12:47:19",
      },
    ], 1600);
    expect(snapshot.remain).toBe(300);
    expect(snapshot.size).toBe(1600);
    expect(snapshot.packs).toBe(2);
    expect(snapshot.expiresAt).toBe(parseWorkbuddyCstMillis("2026-10-20 12:47:19"));
  });

  test("extractWorkbuddyResourceAccounts unwraps the billing envelope", () => {
    const { accounts, totalDosage } = extractWorkbuddyResourceAccounts({
      code: 0,
      data: { Response: { Data: { TotalDosage: 1500, Accounts: [{ PackageName: "x" }] } } },
    });
    expect(totalDosage).toBe(1500);
    expect(accounts).toHaveLength(1);
  });

  test("workbuddyQuotaFromCredits is integer points, not USD", () => {
    const quota = workbuddyQuotaFromCredits(200, 1300, 1500, 1_700_000_000_000);
    expect(quota?.creditsUsd?.unit).toBe("points");
    expect(quota?.creditsUsd?.remaining).toBe(200);
    expect(quota?.creditsUsd?.percent).toBeCloseTo(1300 / 1500 * 100);
    expect(quota?.customWindows?.[0]?.label).toBe("WorkBuddy credits");
  });
});

describe("workbuddy quota reader registration", () => {
  test("workbuddy is an explicit per-account reader", () => {
    expect(explicitAccountReader("workbuddy")).toBe(true);
    expect(explicitQuotaDestination("workbuddy", { adapter: "codebuddy", authMode: "oauth", baseUrl: "https://copilot.tencent.com/v2" })).toBe(true);
    expect(explicitQuotaDestination("workbuddy", { adapter: "codebuddy", authMode: "oauth", baseUrl: "https://copilot.tencent.com/v2", disabled: true })).toBe(false);
  });
});

describe("fetchWorkbuddyDashboardSnapshot", () => {
  function cred(): OAuthCredentials {
    return {
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 86_400_000,
      accountId: "uid-1",
      source: "oauth",
      codebuddy: { uid: "uid-1", domain: "copilot.tencent.com", realm: "cn" },
    };
  }

  test("CN snapshot fills credits, checked-in, and daily-task from heatmap", async () => {
    const paths: string[] = [];
    const snapshot = await fetchWorkbuddyDashboardSnapshot(cred(), async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/get-user-resource")) {
        return Response.json({
          code: 0,
          data: { Response: { Data: { TotalDosage: 1500, Accounts: [{
            PackageName: "裂变包",
            CycleCapacitySize: 1500,
            CycleCapacityRemain: 200,
            CycleCapacityUsed: 1300,
            CycleEndTime: "2026-10-21 09:09:57",
          }] } } },
        });
      }
      if (url.pathname.endsWith("/checkin-activity-status")) {
        return Response.json({ code: 0, data: { today_checked_in: true, active: true } });
      }
      if (url.pathname.endsWith("/heatmap")) {
        return Response.json({ code: 0, data: { cells: [{ date: workbuddyCstDate(), score: 5 }] } });
      }
      return Response.json({ code: 1 }, { status: 404 });
    });
    expect(snapshot.credits?.remain).toBe(200);
    expect(snapshot.activity?.checkedIn).toBe(true);
    expect(snapshot.activity?.dailyTask).toBe(true);
    expect(paths.some(path => path.includes("get-user-resource"))).toBe(true);
  });

  test("Global snapshot skips CN check-in and heatmap", async () => {
    const paths: string[] = [];
    const global: OAuthCredentials = {
      ...cred(),
      codebuddy: { uid: "g1", domain: "www.workbuddy.ai", realm: "global" },
    };
    const snapshot = await fetchWorkbuddyDashboardSnapshot(global, async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({
        code: 0,
        data: { Response: { Data: { TotalDosage: 350, Accounts: [{
          PackageName: "Bonus Pack",
          CycleCapacitySize: 350,
          CycleCapacityRemain: 350,
          CycleCapacityUsed: 0,
        }] } } },
      });
    });
    expect(snapshot.credits?.remain).toBe(350);
    expect(snapshot.activity).toBeUndefined();
    expect(paths.every(path => path.includes("get-user-resource"))).toBe(true);
  });

  test("CN open day reports checkedIn and dailyTask as false", async () => {
    const snapshot = await fetchWorkbuddyDashboardSnapshot(cred(), async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/get-user-resource")) {
        return Response.json({
          code: 0,
          data: { Response: { Data: { TotalDosage: 100, Accounts: [{
            CycleCapacitySize: 100, CycleCapacityRemain: 100, CycleCapacityUsed: 0,
          }] } } },
        });
      }
      if (path.endsWith("/checkin-activity-status")) {
        return Response.json({ code: 0, data: { today_checked_in: false, active: true } });
      }
      if (path.endsWith("/heatmap")) {
        return Response.json({ code: 0, data: { cells: [{ date: workbuddyCstDate(), score: 0 }] } });
      }
      return Response.json({ code: 1 }, { status: 404 });
    });
    expect(snapshot.activity).toEqual({ checkedIn: false, dailyTask: false });
  });
});
