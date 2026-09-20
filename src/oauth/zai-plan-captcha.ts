/**
 * Aliyun traceless captcha for ZCode Plan. Headed Chrome + CDP on a private
 * profile — headless Chrome returns F001 on this machine. Protocol only; not
 * copied from AGPL gateways.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ZAI_ORIGIN } from "./zai-plan";

export const ZAI_CAPTCHA_SCENE = "11xygtvd";
export const ZAI_CAPTCHA_REGION = "cn";
export const ZAI_CAPTCHA_PREFIX = "no8xfe";
export const ZAI_CAPTCHA_HEADER = "X-Aliyun-Captcha-Verify-Param";
export const ZAI_CAPTCHA_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";
/** Safety cap for the buffered Chrome fetch. Client abort uses `abortSignal`. */
export const ZAI_PLAN_FETCH_SAFETY_TIMEOUT_MS = 300_000;

const SOLVE_TIMEOUT_MS = 40_000;
const PARAM_TTL_MS = 45_000;
const CHROME_IDLE_MS = 90_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
};

type ChromeSlot = {
  child: ChildProcess;
  session: CdpSession;
  param?: { value: string; born: number };
  idleTimer?: ReturnType<typeof setTimeout>;
};

let slot: ChromeSlot | null = null;
let solving: Promise<string> | null = null;

function seedOfficialElectronProfile(profile: string): void {
  const src = join(homedir(), "AppData", "Roaming", "ZCode", "session", "Partitions", "zcode-coding-plan");
  if (!existsSync(src)) return;
  const dest = join(profile, "Default");
  mkdirSync(dest, { recursive: true });
  try {
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => !/[/\\](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|WebStorage)([/\\]|$)/i.test(p),
    });
  } catch {
    /* live ZCode may lock files; empty profile still works for captcha */
  }
}

function chromePath(): string {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("ZCode Plan captcha needs Chrome or Edge installed");
  return found;
}

async function waitJson(url: string, child: ChildProcess, ms: number): Promise<unknown> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chrome exited ${child.exitCode}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(400) });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("chrome debug port did not come up");
}

function connectCdp(wsUrl: string): CdpSession {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("cdp websocket error")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (!msg.id || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || "cdp error"));
    else waiter.resolve(msg.result ?? {});
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++n;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

function scheduleIdleClose(target: ChromeSlot): void {
  if (target.idleTimer) clearTimeout(target.idleTimer);
  target.idleTimer = setTimeout(() => {
    if (slot === target) {
      closeSlot();
    }
  }, CHROME_IDLE_MS);
}

function clearIdleTimer(target: ChromeSlot): void {
  if (!target.idleTimer) return;
  clearTimeout(target.idleTimer);
  target.idleTimer = undefined;
}

function closeSlot(): void {
  if (!slot) return;
  const current = slot;
  slot = null;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  try { current.session.close(); } catch { /* ignore */ }
  try { current.child.kill(); } catch { /* ignore */ }
}

export function restartZaiPlanChrome(): void {
  closeSlot();
}

export function zaiPlanBrowserFetchTimeoutMs(timeoutMs?: number): number {
  return timeoutMs ?? ZAI_PLAN_FETCH_SAFETY_TIMEOUT_MS;
}

export function isZaiPlanPageReady(origin: string, readyState: string): boolean {
  return origin === ZAI_ORIGIN && (readyState === "complete" || readyState === "interactive");
}

export function isZaiPlanChromeTransientError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/AbortError|The user aborted a request|The operation was aborted/i.test(text)) return false;
  return /Failed to fetch/i.test(text)
    || /chrome exited/i.test(text)
    || /cdp websocket/i.test(text)
    || /no chrome page websocket/i.test(text)
    || /chrome debug port did not come up/i.test(text)
    || /zcode\.z\.ai did not load/i.test(text);
}

export async function runZaiPlanChromeAttempt<T>(input: {
  abortSignal?: AbortSignal;
  run: () => Promise<T>;
  restart: () => void;
}): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    if (!isZaiPlanChromeTransientError(error)) throw error;
    input.restart();
    return await input.run();
  }
}

async function evalString(session: CdpSession, expression: string): Promise<string> {
  const result = await session.send("Runtime.evaluate", { expression, returnByValue: true });
  const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) throw new Error(details.exception?.description || details.text || "chrome evaluate failed");
  const value = (result.result as { value?: unknown } | undefined)?.value;
  return typeof value === "string" ? value : "";
}

async function waitForZcodePage(session: CdpSession, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
  const origin = await evalString(session, "location.origin");
  const ready = await evalString(session, "document.readyState");
  if (isZaiPlanPageReady(origin, ready)) return;

  await session.send("Page.navigate", { url: `${ZAI_ORIGIN}/` });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chrome exited ${child.exitCode}`);
    const nowOrigin = await evalString(session, "location.origin");
    const nowReady = await evalString(session, "document.readyState");
    if (isZaiPlanPageReady(nowOrigin, nowReady)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("zcode.z.ai did not load");
}

async function ensureChrome(): Promise<ChromeSlot> {
  if (slot && slot.child.exitCode === null) {
    try {
      await waitForZcodePage(slot.session, slot.child);
      return slot;
    } catch {
      closeSlot();
    }
  }
  closeSlot();
  const exe = chromePath();
  const port = 19222 + Math.floor(Math.random() * 400);
  const profile = join(tmpdir(), `ocx-zai-plan-chrome-${port}`);
  mkdirSync(profile, { recursive: true });
  seedOfficialElectronProfile(profile);
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-blink-features=AutomationControlled",
    "--window-size=900,700",
    "--window-position=80,80",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await waitJson(`http://127.0.0.1:${port}/json/version`, child, 15_000);
  let wsUrl: string | undefined;
  for (let i = 0; i < 30; i++) {
    const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`, child, 2_000);
    const page = (Array.isArray(tabs) ? tabs : []).find((t: { type?: string; webSocketDebuggerUrl?: string }) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!wsUrl) {
    child.kill();
    throw new Error("no chrome page websocket");
  }
  const session = connectCdp(wsUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,
  });
  await waitForZcodePage(session, child);
  const created: ChromeSlot = { child, session };
  slot = created;
  return created;
}

async function evaluate<T>(expression: string): Promise<T> {
  const current = await ensureChrome();
  const result = await current.session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) {
    throw new Error(details.exception?.description || details.text || "chrome evaluate failed");
  }
  return (result.result as { value?: T } | undefined)?.value as T;
}

export function invalidateZaiPlanCaptcha(): void {
  if (slot) slot.param = undefined;
}

export async function getZaiPlanVerifyParam(): Promise<string> {
  const current = slot;
  if (current?.param && Date.now() - current.param.born < PARAM_TTL_MS) {
    return current.param.value;
  }
  if (solving) return solving;
  solving = (async () => {
    const chrome = await ensureChrome();
    const expression = `new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("captcha timeout")), ${SOLVE_TIMEOUT_MS});
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      const s = document.createElement("script");
      s.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
      s.onload = () => {
        const cap = document.createElement("div"); cap.id = "cap-" + Date.now();
        const btn = document.createElement("button"); btn.id = "btn-" + cap.id;
        document.body.append(cap, btn);
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(ZAI_CAPTCHA_SCENE)},
          mode: "popup",
          region: ${JSON.stringify(ZAI_CAPTCHA_REGION)},
          prefix: ${JSON.stringify(ZAI_CAPTCHA_PREFIX)},
          element: "#" + cap.id,
          button: "#" + btn.id,
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance(inst) {
            const fn = inst.startTracelessVerification || inst.show;
            try { fn.call(inst); } catch (e) { done(reject)(e); }
          },
          success(param) { done(resolve)(param); },
          fail(m) { done(reject)(new Error(typeof m === "string" ? m : JSON.stringify(m))); },
          onError(m) { done(reject)(new Error(typeof m === "string" ? m : JSON.stringify(m))); }
        });
      };
      s.onerror = () => done(reject)(new Error("AliyunCaptcha.js load failed"));
      document.head.appendChild(s);
    })`;
    const param = await evaluate<string>(expression);
    if (typeof param !== "string" || param.length < 20) throw new Error("empty verifyParam");
    chrome.param = { value: param, born: Date.now() };
    scheduleIdleClose(chrome);
    return param;
  })();
  try {
    return await solving;
  } finally {
    solving = null;
  }
}

async function abortPageFetch(): Promise<void> {
  if (!slot || slot.child.exitCode !== null) return;
  try {
    await slot.session.send("Runtime.evaluate", {
      expression: "window.__ocxAbort && window.__ocxAbort.abort()",
      returnByValue: true,
    });
  } catch { /* ignore */ }
}

export async function zaiPlanBrowserFetch(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  if (input.abortSignal?.aborted) {
    throw input.abortSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  await ensureChrome();
  if (slot) clearIdleTimer(slot);
  const timeoutMs = zaiPlanBrowserFetchTimeoutMs(input.timeoutMs);
  const onAbort = () => { void abortPageFetch(); };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const got = await evaluate<{ status: number; text: string }>(`(async () => {
      window.__ocxAbort = new AbortController();
      const signal = AbortSignal.any([window.__ocxAbort.signal, AbortSignal.timeout(${timeoutMs})]);
      const res = await fetch(${JSON.stringify(input.url)}, {
        method: "POST",
        headers: ${JSON.stringify(input.headers)},
        body: ${JSON.stringify(input.body)},
        signal,
      });
      return { status: res.status, text: await res.text() };
    })()`);
    return { status: got.status, text: got.text, headers: { "content-type": "application/json" } };
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
    if (slot) scheduleIdleClose(slot);
  }
}
