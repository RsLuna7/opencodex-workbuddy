import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodebuddyAdapter } from "../../src/adapters/codebuddy";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import {
  WORKBUDDY_ACCOUNT_RESTRICTED_COOLDOWN_MS,
  WORKBUDDY_CREDENTIAL_REJECTED_COOLDOWN_MS,
  classifyWorkbuddyCredentialRejection,
  inspectWorkbuddyCredentialRejection,
} from "../../src/oauth/workbuddy-credential-guard";
import { isWorkbuddyPoolCooled, resetWorkbuddyPoolForTests } from "../../src/oauth/workbuddy-pool";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const HTML_401 = "<html><head><title>401 Authorization Required</title></head><body>openresty</body></html>";
const RESTRICTED = JSON.stringify({ code: 11140, msg: "request illegal" });

describe("workbuddy credential rejection classification", () => {
  test("an APISIX HTML 401 means the session was rejected", () => {
    expect(classifyWorkbuddyCredentialRejection(401, HTML_401)).toEqual({
      kind: "rejected",
      cooldownMs: WORKBUDDY_CREDENTIAL_REJECTED_COOLDOWN_MS,
      reason: "credential-rejected",
    });
  });

  test("business code 11140 means restricted, whatever the status", () => {
    for (const status of [400, 401, 403]) {
      expect(classifyWorkbuddyCredentialRejection(status, RESTRICTED)).toEqual({
        kind: "restricted",
        cooldownMs: WORKBUDDY_ACCOUNT_RESTRICTED_COOLDOWN_MS,
        reason: "restricted",
      });
    }
    expect(classifyWorkbuddyCredentialRejection(403, JSON.stringify({ code: "11140" }))?.kind).toBe("restricted");
  });

  test("other failures are left to the existing handling", () => {
    expect(classifyWorkbuddyCredentialRejection(403, "<html>waf</html>")).toBeUndefined();
    expect(classifyWorkbuddyCredentialRejection(400, JSON.stringify({ code: 11133 }))).toBeUndefined();
    expect(classifyWorkbuddyCredentialRejection(500, "boom")).toBeUndefined();
  });

  test("inspection reads a clone and skips statuses that cannot carry a rejection", async () => {
    const response = new Response(RESTRICTED, { status: 403 });
    expect((await inspectWorkbuddyCredentialRejection(response))?.kind).toBe("restricted");
    expect(await response.text()).toBe(RESTRICTED);
    expect(await inspectWorkbuddyCredentialRejection(new Response("x", { status: 502 }))).toBeUndefined();
    expect(await inspectWorkbuddyCredentialRejection(new Response("ok", { status: 200 }))).toBeUndefined();
  });
});

describe("workbuddy adapter cools a rejected account", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  let home = "";
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-wb-guard-"));
    process.env.OPENCODEX_HOME = home;
    resetWorkbuddyPoolForTests();
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    resetWorkbuddyPoolForTests();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  });

  const guardLines = () => warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[workbuddy] account="));

  async function run(status: number, body: string): Promise<{ accountId: string; response: Response }> {
    await saveCredential("workbuddy", {
      access: "access-0",
      refresh: "refresh-0",
      expires: Date.now() + 3_600_000,
      accountId: "uid-0",
      codebuddy: { uid: "uid-0", realm: "cn" },
    } as never, { addAccount: true });
    const accountId = getAccountSet("workbuddy")!.accounts[0]!.id;
    const adapter = createCodebuddyAdapter({ adapter: "codebuddy", baseUrl: "https://copilot.tencent.com/v2", authMode: "oauth" } as never);
    const response = await adapter.fetchResponse!(
      { url: "https://copilot.tencent.com/v2/chat/completions", method: "POST", headers: { "X-User-Id": "uid-0" }, body: "{}" } as never,
      { executor: async () => new Response(body, { status }) } as never,
    );
    return { accountId, response };
  }

  test("HTML 401 pauses the account and the response stays readable", async () => {
    const { accountId, response } = await run(401, HTML_401);
    expect(isWorkbuddyPoolCooled(accountId, "deepseek-v4.1-flash")).toBe(true);
    expect(isWorkbuddyPoolCooled(accountId, "deepseek-v4.1-flash", Date.now() + WORKBUDDY_CREDENTIAL_REJECTED_COOLDOWN_MS + 1_000)).toBe(false);
    expect(await response.text()).toBe(HTML_401);
    expect(guardLines()).toHaveLength(1);
    expect(guardLines()[0]).toContain("rejected");
  });

  test("11140 pauses the account for hours", async () => {
    const { accountId } = await run(403, RESTRICTED);
    expect(isWorkbuddyPoolCooled(accountId, null, Date.now() + WORKBUDDY_ACCOUNT_RESTRICTED_COOLDOWN_MS - 60_000)).toBe(true);
  });

  test("an unrelated 400 leaves the account usable", async () => {
    const { accountId } = await run(400, JSON.stringify({ code: 11133 }));
    expect(isWorkbuddyPoolCooled(accountId, "deepseek-v4.1-flash")).toBe(false);
    expect(guardLines()).toHaveLength(0);
  });
});
