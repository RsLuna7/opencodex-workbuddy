import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdAccount } from "../../src/cli/account";
import { saveCredential } from "../../src/oauth/store";
import { WORKBUDDY_CHECKIN_CLAIM_PATH, WORKBUDDY_CHECKIN_STATUS_PATH } from "../../src/oauth/codebuddy-checkin";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ocx account checkin", () => {
  let home = "";
  let previousHome: string | undefined;
  let originalFetch: typeof fetch;
  let logs: string[] = [];
  let errors: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-wb-checkin-cli-"));
    process.env.OPENCODEX_HOME = home;
    originalFetch = globalThis.fetch;
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  test("claims every stored CN account and prints JSON", async () => {
    await saveCredential("workbuddy", {
      access: "a",
      refresh: "r",
      expires: Date.now() + 7 * 86_400_000,
      email: "one",
      accountId: "uid-1",
      source: "oauth",
      codebuddy: { uid: "uid-1", domain: "copilot.tencent.com" },
    });
    let statusCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === WORKBUDDY_CHECKIN_STATUS_PATH) {
        statusCalls += 1;
        return jsonResponse({
          code: 0,
          data: { active: true, today_checked_in: statusCalls > 1, today_credit: 100 },
        });
      }
      expect(path).toBe(WORKBUDDY_CHECKIN_CLAIM_PATH);
      return jsonResponse({ code: 0, data: { credit: 100 } });
    }) as typeof fetch;

    const code = await cmdAccount(["checkin", "workbuddy", "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n")) as { results: Array<{ result: string; credit?: number }> };
    expect(payload.results[0]?.result).toBe("CLAIMED");
    expect(payload.results[0]?.credit).toBe(100);
  });

  test("refuses a non-workbuddy provider", async () => {
    const code = await cmdAccount(["checkin", "openai", "--json"]);
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("workbuddy");
  });
});
