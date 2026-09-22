import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGenericFailoverCooldown,
  clearGenericFailoverHealth,
  isGenericFailoverCooled,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import {
  acquireWorkbuddyLease,
  bindWorkbuddySession,
  flushWorkbuddyPool,
  isWorkbuddyPoolCooled,
  noteWorkbuddyPoolCooldown,
  noteWorkbuddyPoolFailure,
  pickWorkbuddyAccount,
  preferredWorkbuddyAccount,
  releaseWorkbuddyLease,
  resetWorkbuddyPoolForTests,
  setWorkbuddyPoolCredits,
  setWorkbuddyPoolRngForTests,
  workbuddyLeaseCountForTests,
} from "../../src/oauth/workbuddy-pool";
import { loadWorkbuddyPoolFile, workbuddyPoolPath } from "../../src/oauth/workbuddy-pool-state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-wb-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth("workbuddy");
  resetWorkbuddyPoolForTests();
  setWorkbuddyPoolRngForTests(() => 0);
});

afterEach(() => {
  resetWorkbuddyPoolForTests();
  clearGenericFailoverHealth("workbuddy");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

function config(): OcxConfig {
  return {
    providers: {
      workbuddy: { adapter: "codebuddy", baseUrl: "https://copilot.tencent.com/v2", authMode: "oauth" },
    },
  } as OcxConfig;
}

async function seed(realms: Array<"cn" | "global"> = ["cn", "cn"]): Promise<string[]> {
  for (let i = 0; i < realms.length; i++) {
    const realm = realms[i]!;
    await saveCredential("workbuddy", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uid-${i}`,
      codebuddy: {
        uid: `uid-${i}`,
        realm,
        ...(realm === "global" ? { domain: "www.workbuddy.ai" } : {}),
      },
    } as never, { addAccount: true });
  }
  const ids = getAccountSet("workbuddy")?.accounts.map(account => account.id) ?? [];
  if (ids[0]) await setActiveAccount("workbuddy", ids[0]);
  return ids;
}

describe("workbuddy pool persist", () => {
  test("6004 cooldown survives a process-local reload from disk", async () => {
    const ids = await seed();
    const now = Date.now();
    noteWorkbuddyPoolCooldown({
      accountId: ids[0]!,
      modelId: "hy3",
      untilMs: now + 60_000,
      now,
      reason: "6004",
    });
    flushWorkbuddyPool();
    expect(loadWorkbuddyPoolFile(now).accounts[ids[0]!]?.modelCooldowns?.hy3?.until).toBe(now + 60_000);
    resetWorkbuddyPoolForTests();
    expect(isWorkbuddyPoolCooled(ids[0]!, "hy3", now + 1_000)).toBe(true);
    expect(isWorkbuddyPoolCooled(ids[0]!, "glm-5.3", now + 1_000)).toBe(false);
    expect(isGenericFailoverCooled("workbuddy", ids[0]!, now + 1_000, "hy3")).toBe(true);
  });

  test("expired model cooldowns are not restored", async () => {
    const ids = await seed();
    const now = Date.now();
    noteWorkbuddyPoolCooldown({ accountId: ids[0]!, modelId: "hy3", untilMs: now + 10, now });
    flushWorkbuddyPool();
    resetWorkbuddyPoolForTests();
    expect(isWorkbuddyPoolCooled(ids[0]!, "hy3", now + 11)).toBe(false);
  });

  test("applyGenericFailoverCooldown writes the pool file", async () => {
    const ids = await seed();
    const now = Date.now();
    applyGenericFailoverCooldown({
      providerName: "workbuddy",
      accountId: ids[0]!,
      modelId: "deepseek-v4.1-flash",
      cooldownMs: 24 * 60 * 60_000,
      now,
    });
    flushWorkbuddyPool();
    expect(workbuddyPoolPath()).toContain("workbuddy-pool.json");
    const file = loadWorkbuddyPoolFile(now);
    expect(file.accounts[ids[0]!]?.modelCooldowns?.["deepseek-v4.1-flash"]?.until).toBeGreaterThan(now);
  });
});

describe("workbuddy pool pick", () => {
  test("rotation stays in-realm and uses the pool pick", async () => {
    const ids = await seed(["cn", "global", "cn"]);
    const cn = ids[0]!;
    const next = rotateGenericOAuthAccountOn429(config(), "workbuddy", cn, null, Date.now(), {
      scope: "model",
      modelId: "hy3",
      quotaExhausted: true,
    });
    expect(next).toBe(ids[2]);
  });

  test("weighted pick prefers the account with more expiring credits", async () => {
    const ids = await seed();
    setWorkbuddyPoolCredits(ids[0]!, 100, 5);
    setWorkbuddyPoolCredits(ids[1]!, 100, 90);
    const picked = pickWorkbuddyAccount({ modelId: "hy3", realmPeerAccountId: ids[0]! });
    expect(picked).toBe(ids[1]);
  });

  test("session sticky returns the bound account while it is healthy", async () => {
    const ids = await seed();
    bindWorkbuddySession("conv-1", ids[1]!);
    expect(preferredWorkbuddyAccount(config(), Date.now(), "hy3", "conv-1")).toBe(ids[1]);
  });

  test("in-flight lease skips a full account", async () => {
    const ids = await seed();
    expect(acquireWorkbuddyLease(ids[0]!)).toBe(true);
    expect(acquireWorkbuddyLease(ids[0]!)).toBe(true);
    expect(acquireWorkbuddyLease(ids[0]!)).toBe(true);
    expect(acquireWorkbuddyLease(ids[0]!)).toBe(false);
    expect(workbuddyLeaseCountForTests(ids[0]!)).toBe(3);
    const picked = pickWorkbuddyAccount({ modelId: "hy3", realmPeerAccountId: ids[0]! });
    expect(picked).toBe(ids[1]);
    releaseWorkbuddyLease(ids[0]!);
    releaseWorkbuddyLease(ids[0]!);
    releaseWorkbuddyLease(ids[0]!);
  });

  test("breaker trips after three failures and persists", async () => {
    const ids = await seed();
    const now = Date.now();
    noteWorkbuddyPoolFailure({ accountId: ids[0]!, now });
    noteWorkbuddyPoolFailure({ accountId: ids[0]!, now: now + 1 });
    noteWorkbuddyPoolFailure({ accountId: ids[0]!, now: now + 2 });
    expect(isWorkbuddyPoolCooled(ids[0]!, "hy3", now + 3)).toBe(true);
    flushWorkbuddyPool();
    resetWorkbuddyPoolForTests();
    expect(isWorkbuddyPoolCooled(ids[0]!, "hy3", now + 4)).toBe(true);
  });

  test("a healthy active account is left in place", async () => {
    const ids = await seed();
    expect(preferredInitialAccount(config(), "workbuddy", Date.now(), "hy3")).toBeNull();
    expect(ids[0]).toBeDefined();
  });
});
