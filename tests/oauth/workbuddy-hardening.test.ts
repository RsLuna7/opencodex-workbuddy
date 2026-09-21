import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorkbuddyChatHeaders } from "../../src/oauth/codebuddy-headers";
import {
  WORKBUDDY_DEVICE_TOKEN_FILE_ENV,
  resetWorkbuddyDeviceTokenCacheForTests,
  resolveWorkbuddyDeviceToken,
} from "../../src/oauth/workbuddy-device-token";
import { resetWorkbuddyFetchForTests, workbuddyFetch } from "../../src/oauth/workbuddy-fetch";
import {
  isWorkbuddyWafBlock,
  isWorkbuddyWafIpBlocked,
  noteWorkbuddyWafHit,
  resetWorkbuddyWafForTests,
} from "../../src/oauth/workbuddy-waf";
import {
  isGenericFailoverCooled,
  shouldAttemptGenericOAuthFailover,
  clearGenericFailoverHealth,
} from "../../src/oauth/generic-account-failover";
import { getCredential, saveCredential } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("workbuddy device token file", () => {
  const previous = process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV];
  afterEach(() => {
    resetWorkbuddyDeviceTokenCacheForTests();
    if (previous === undefined) delete process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV];
    else process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV] = previous;
  });

  test("credential value wins over the file", () => {
    expect(resolveWorkbuddyDeviceToken("from-cred")).toBe("from-cred");
  });

  test("reads OPENCODEX_WORKBUDDY_DEVICE_TOKEN_FILE when credential is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-wb-dt-"));
    const path = join(dir, "device_token");
    writeFileSync(path, " desktop-token \n");
    process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV] = path;
    resetWorkbuddyDeviceTokenCacheForTests();
    expect(resolveWorkbuddyDeviceToken()).toBe("desktop-token");
    const headers: Record<string, string> = {};
    applyWorkbuddyChatHeaders(headers, "global", { uid: "g1", realm: "global" });
    expect(headers["X-Device-Token"]).toBe("desktop-token");
    removeTreeWithRetry(dir);
  });
});

describe("workbuddy credential persist", () => {
  let home = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-wb-store-"));
    process.env.OPENCODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  test("round-trips realm, platform, and deviceToken", async () => {
    await saveCredential("workbuddy", {
      access: "a",
      refresh: "r",
      expires: Date.now() + 86_400_000,
      accountId: "uid-g",
      source: "oauth",
      codebuddy: {
        uid: "uid-g",
        domain: "www.workbuddy.ai",
        realm: "global",
        platform: "workbuddy-ai",
        deviceToken: "dt-1",
      },
    });
    const cred = getCredential("workbuddy");
    expect(cred?.codebuddy).toEqual({
      uid: "uid-g",
      domain: "www.workbuddy.ai",
      realm: "global",
      platform: "workbuddy-ai",
      deviceToken: "dt-1",
    });
  });
});

describe("workbuddy WAF", () => {
  let home = "";
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-wb-waf-"));
    process.env.OPENCODEX_HOME = home;
    await saveCredential("workbuddy", {
      access: "a1",
      refresh: "r1",
      expires: Date.now() + 86_400_000,
      accountId: "uid-1",
      source: "oauth",
      codebuddy: { uid: "uid-1", domain: "www.workbuddy.ai", realm: "global" },
    });
    await saveCredential("workbuddy", {
      access: "a2",
      refresh: "r2",
      expires: Date.now() + 86_400_000,
      accountId: "uid-2",
      source: "oauth",
      codebuddy: { uid: "uid-2", domain: "www.workbuddy.ai", realm: "global" },
    });
  });

  afterEach(() => {
    resetWorkbuddyWafForTests();
    clearGenericFailoverHealth("workbuddy");
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  test("403 without a business envelope is WAF; JSON code/msg is not", () => {
    expect(isWorkbuddyWafBlock(403, "")).toBe(true);
    expect(isWorkbuddyWafBlock(403, "<html>403 Forbidden</html>")).toBe(true);
    expect(isWorkbuddyWafBlock(403, '{"code":11140,"msg":"request illegal"}')).toBe(false);
    expect(isWorkbuddyWafBlock(401, "")).toBe(false);
  });

  test("two UIDs in the window trip the IP fail-fast", () => {
    expect(noteWorkbuddyWafHit("u1")).toBe(false);
    expect(isWorkbuddyWafIpBlocked()).toBe(false);
    expect(noteWorkbuddyWafHit("u2")).toBe(true);
    expect(isWorkbuddyWafIpBlocked()).toBe(true);
  });

  test("generic failover rotates WorkBuddy 403 until the IP gate trips", () => {
    const config = {
      providers: {
        workbuddy: { adapter: "codebuddy", baseUrl: "https://www.workbuddy.ai/v2", authMode: "oauth" },
      },
    } as unknown as OcxConfig;
    expect(shouldAttemptGenericOAuthFailover(config, "workbuddy", 403, "a1", 0)).toBe(true);
    noteWorkbuddyWafHit("u1");
    noteWorkbuddyWafHit("u2");
    expect(shouldAttemptGenericOAuthFailover(config, "workbuddy", 403, "a1", 0)).toBe(false);
    expect(isGenericFailoverCooled("workbuddy", "a1")).toBe(false);
  });
});

describe("workbuddy HTTP/1.1 fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkbuddyFetchForTests();
  });

  test("pins protocol http1.1 on https targets", async () => {
    let protocol: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      protocol = (init as { protocol?: string } | undefined)?.protocol;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await workbuddyFetch("https://www.workbuddy.ai/v2/chat/completions", { method: "POST" });
    expect(protocol).toBe("http1.1");
  });
});
