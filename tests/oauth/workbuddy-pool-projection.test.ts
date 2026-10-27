/**
 * WorkBuddy pool projection — the row shape the management API hands the dashboard.
 *
 * The projection is the only place the route can accidentally widen what leaves the server:
 * the pool file also carries per-model cost observations and session bindings, and neither
 * belongs in an account list. These cases pin the leak boundary as well as the expired-record
 * filter, because both fail silently — a stale cooldown reads as a live one, and a leaked cost
 * table reads as nothing at all until someone greps the JSON.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectWorkbuddyAccountPoolView, resetWorkbuddyPoolForTests } from "../../src/oauth/workbuddy-pool";
import type { OAuthCredentials } from "../../src/oauth/types";

const CN_CRED: OAuthCredentials = {
  access: "a",
  refresh: "r",
  expires: Date.now() + 60_000,
  source: "oauth",
  codebuddy: { uid: "u", domain: "copilot.tencent.com", realm: "cn" },
};

const GLOBAL_CRED: OAuthCredentials = {
  ...CN_CRED,
  codebuddy: { uid: "g", domain: "www.workbuddy.ai", realm: "global" },
};

function withPoolFile(document: unknown, run: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "ocx-wb-projection-"));
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "workbuddy-pool.json"), `${JSON.stringify(document, null, 2)}\n`);
    resetWorkbuddyPoolForTests();
    run();
  } finally {
    resetWorkbuddyPoolForTests();
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("workbuddy pool projection", () => {
  test("an unknown account reports only its realm", () => {
    resetWorkbuddyPoolForTests();
    expect(projectWorkbuddyAccountPoolView("never-seen", GLOBAL_CRED)).toEqual({ realm: "global" });
    resetWorkbuddyPoolForTests();
  });

  test("a live cooldown, credits and counters reach the view", () => {
    const now = Date.now();
    withPoolFile({
      version: 1,
      accounts: {
        "acct-1": {
          credits: 2600,
          creditsExpiring: 400,
          modelCooldowns: { "deepseek-v4.1-flash": { until: now + 3_600_000, reason: "quota" } },
          successCount: 7052,
          errTotal: 34,
        },
      },
    }, () => {
      const view = projectWorkbuddyAccountPoolView("acct-1", CN_CRED);
      expect(view.realm).toBe("cn");
      expect(view.credits).toBe(2600);
      expect(view.creditsExpiring).toBe(400);
      expect(view.successCount).toBe(7052);
      expect(view.errTotal).toBe(34);
      expect(view.modelCooldowns?.["deepseek-v4.1-flash"]).toMatchObject({
        until: now + 3_600_000,
        reason: "quota",
      });
    });
  });

  test("an expired cooldown is dropped rather than reported as live", () => {
    withPoolFile({
      version: 1,
      accounts: {
        "acct-1": {
          modelCooldowns: { "deepseek-v4.1-flash": { until: Date.now() - 60_000, reason: "quota" } },
        },
      },
    }, () => {
      const view = projectWorkbuddyAccountPoolView("acct-1", CN_CRED);
      expect(view.modelCooldowns).toBeUndefined();
    });
  });

  test("cost observations and session bindings never leave the server", () => {
    withPoolFile({
      version: 1,
      accounts: {
        "acct-1": {
          credits: 100,
          modelCosts: { "deepseek-v4.1-flash": { costPer1k: 0.12, lastSeen: Date.now(), samples: 9 } },
          modelCooldowns: { "deepseek-v4.1-flash": { until: Date.now() + 60_000, reason: "quota" } },
        },
      },
      sessions: { "session-key": { accountId: "acct-1", lastActive: Date.now() } },
    }, () => {
      const view = projectWorkbuddyAccountPoolView("acct-1", CN_CRED);
      expect(Object.keys(view).sort()).toEqual([
        "credits", "modelCooldowns", "realm",
      ]);
      expect(JSON.stringify(view)).not.toContain("costPer1k");
      expect(JSON.stringify(view)).not.toContain("session-key");
    });
  });

  test("an expired breaker is not projected", () => {
    withPoolFile({
      version: 1,
      accounts: { "acct-1": { breakerUntil: Date.now() - 1_000, retryCount: 2 } },
    }, () => {
      const view = projectWorkbuddyAccountPoolView("acct-1", CN_CRED);
      expect(view.breakerUntil).toBeUndefined();
      expect(view.retryCount).toBeUndefined();
    });
  });
});
