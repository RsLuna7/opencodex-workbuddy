import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOfficialStartPlanHeaders,
  buildStartPlanSystemBlocks,
  officialMetadataUserId,
} from "../../src/oauth/zai-plan";
import {
  ZAI_PLAN_CHROME_WINDOW,
  zaiPlanChromeLaunchArgs,
} from "../../src/oauth/zai-plan-captcha";
import {
  chromeTreePids,
  isZaiPlanChromeSeedPath,
  parkChromeWindowsForPid,
  revealChromeWindowsForPid,
  writeZaiPlanChromePreferences,
  ZAI_PLAN_CHROME_PARK,
} from "../../src/oauth/zai-plan-chrome-park";
import { repoPath } from "../helpers/repo-root";

describe("zai-plan official fingerprint", () => {
  test("model request headers omit X-Device-Mid and query/session ids", () => {
    const headers = buildOfficialStartPlanHeaders({
      jwt: "aaa.bbb.ccc",
      deviceMid: "device-mid-test",
    });
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["X-Device-Mid"]).toBeUndefined();
    expect(headers["x-query-id"]).toBeUndefined();
    expect(headers["X-Query-Id"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
    expect(headers["X-Session-Id"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer aaa.bbb.ccc");
  });

  test("metadata.user_id is official device JSON, not a JWT sub", () => {
    const raw = officialMetadataUserId("mid-1", "sess_abc-def");
    expect(JSON.parse(raw)).toEqual({
      device_id: "mid-1",
      account_uuid: "",
      session_id: "abc-def",
    });
  });

  test("system blocks include desktop context and powered-by inside Environment", () => {
    const blocks = buildStartPlanSystemBlocks("GLM-5.3-Flash");
    expect(blocks.map((b) => b.text).join("\n")).toContain("# ZCode Desktop Context");
    const env = blocks.at(-1)?.text ?? "";
    expect(env.startsWith("# Environment")).toBe(true);
    expect(env).toContain("- You are powered by the model named GLM-5.3-Flash.");
    expect(blocks.some((b) => b.text === "- You are powered by the model named GLM-5.3-Flash.")).toBe(false);
  });

  test("captcha Chrome stays headed and on-screen so Aliyun can paint", () => {
    const args = zaiPlanChromeLaunchArgs(19222, "C:\\tmp\\ocx-zai-plan-chrome");
    expect(args.some((a) => a === "--headless" || a.startsWith("--headless="))).toBe(false);
    expect(args).toContain(`--window-size=${ZAI_PLAN_CHROME_WINDOW.width},${ZAI_PLAN_CHROME_WINDOW.height}`);
    expect(args).toContain(`--window-position=${ZAI_PLAN_CHROME_WINDOW.left},${ZAI_PLAN_CHROME_WINDOW.top}`);
    expect(ZAI_PLAN_CHROME_WINDOW.left).toBeGreaterThanOrEqual(0);
    expect(ZAI_PLAN_CHROME_WINDOW.top).toBeGreaterThanOrEqual(0);
    expect(ZAI_PLAN_CHROME_PARK.left).toBeLessThan(0);
    expect(args).toContain("--disable-backgrounding-occluded-windows");
  });

  test("seed copy skips Preferences so Electron window placement cannot restore on-screen", () => {
    expect(isZaiPlanChromeSeedPath("C:\\tmp\\Default\\Cookies")).toBe(true);
    expect(isZaiPlanChromeSeedPath("C:\\tmp\\Default\\Preferences")).toBe(false);
    expect(isZaiPlanChromeSeedPath("C:\\tmp\\Default\\Secure Preferences")).toBe(false);
  });

  test("written Chrome Preferences request an on-screen normal window", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-zai-pref-"));
    writeZaiPlanChromePreferences(dir);
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")) as {
      browser: { window_placement: { left: number; top: number; maximized: boolean } };
    };
    expect(prefs.browser.window_placement.left).toBe(ZAI_PLAN_CHROME_WINDOW.left);
    expect(prefs.browser.window_placement.top).toBe(ZAI_PLAN_CHROME_WINDOW.top);
    expect(prefs.browser.window_placement.left).toBeGreaterThanOrEqual(0);
    expect(prefs.browser.window_placement.maximized).toBe(false);
  });

  test("Win32 park/reveal are no-ops for the current non-Chrome process", () => {
    expect(parkChromeWindowsForPid(0)).toBe(0);
    expect(revealChromeWindowsForPid(0)).toBe(0);
    expect(chromeTreePids(process.pid ?? 0)).toContain(process.pid);
    expect(parkChromeWindowsForPid(process.pid ?? 0)).toBe(0);
    expect(revealChromeWindowsForPid(process.pid ?? 0)).toBe(0);
  });

  test("captcha Chrome cannot stall forever on stdio, CDP, or a locked profile copy", () => {
    const source = readFileSync(repoPath("src", "oauth", "zai-plan-captcha.ts"), "utf8");
    expect(source).toContain('stdio: "ignore"');
    expect(source).toContain("windowsHide: false");
    expect(source).toContain("cdp timeout");
    expect(source).toContain("cdp websocket timeout");
    expect(source).toContain("seed timeout");
    expect(source).toContain("revealForWork");
    expect(source).not.toContain("parkUntilFound");
    expect(source).toContain("ZCode Plan captcha Chrome starting");
    expect(source).toContain("ZCode Plan messages via Chrome");
    expect(source).toContain("getZaiPlanVerifyParam(signal?: AbortSignal)");
    expect(source).toContain("Runtime.addBinding");
    expect(source).toContain("Runtime.bindingCalled");
    expect(source).toContain("res.body.getReader()");
    expect(source).toContain("signal: window.__ocxAbort.signal");
    expect(source).not.toContain("await res.text()");
    expect(source).toContain("parkChromeWindowsForPid(slot.pid)");
    expect(source).toContain("ensureChrome({ reveal: false })");
    const adapter = readFileSync(repoPath("src", "adapters", "zai-plan.ts"), "utf8");
    expect(adapter).toContain("getZaiPlanVerifyParam(ctx?.abortSignal)");
    expect(adapter).toContain("signal: ctx?.abortSignal");
    expect(adapter).toContain("return new Response(viaChrome.body");
    expect(adapter).toContain("isZaiPlanCdpError");
    expect(adapter).toContain("resetZaiPlanChrome");
  });
});
