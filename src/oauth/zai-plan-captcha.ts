/**
 * Aliyun traceless captcha for ZCode Plan. Headed Chrome + CDP on a private
 * profile — headless Chrome returns F001 on this machine. Protocol only; not
 * copied from AGPL gateways.
 *
 * Captcha needs a visible headed window. After the param is issued the window
 * is parked and /messages is streamed through the same Chrome so a long GLM
 * think/search cannot hit a 90s body abort (502 AbortError) or a closed CDP.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { cp as cpAsync } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logOAuthEvent } from "./log";
import {
  isZaiPlanChromeSeedPath,
  parkChromeWindowsForPid,
  revealChromeWindowsForPid,
  writeZaiPlanChromePreferences,
  ZAI_PLAN_CHROME_WINDOW,
} from "./zai-plan-chrome-park";

export { ZAI_PLAN_CHROME_WINDOW } from "./zai-plan-chrome-park";

export const ZAI_CAPTCHA_SCENE = "11xygtvd";
export const ZAI_CAPTCHA_REGION = "cn";
export const ZAI_CAPTCHA_PREFIX = "no8xfe";
export const ZAI_CAPTCHA_HEADER = "X-Aliyun-Captcha-Verify-Param";
export const ZAI_CAPTCHA_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";
export const ZAI_PLAN_PROVIDER_LOG = "zai-plan";

const SOLVE_TIMEOUT_MS = 40_000;
const PARAM_TTL_MS = 45_000;
const CHROME_IDLE_MS = 90_000;
const SEED_COPY_TIMEOUT_MS = 2_500;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const PAGE_LOAD_TIMEOUT_MS = 8_000;
const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const HEADER_WAIT_MS = 45_000;

type CdpHandler = (params: Record<string, unknown>) => void;

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  on: (method: string, handler: CdpHandler) => () => void;
  close: () => void;
};

type ChromeSlot = {
  child: ChildProcess;
  session: CdpSession;
  pid: number;
  port: number;
  param?: { value: string; born: number };
  idleTimer?: ReturnType<typeof setTimeout>;
};

export type ZaiPlanChromeResponse = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
};

let slot: ChromeSlot | null = null;
let solving: Promise<string> | null = null;
let launching: Promise<ChromeSlot> | null = null;
let exclusiveTail: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function holdExclusive(): { wait: Promise<void>; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = exclusiveTail;
  exclusiveTail = wait.then(() => held);
  return { wait, release };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function seedOfficialElectronProfile(profile: string): Promise<void> {
  const src = join(homedir(), "AppData", "Roaming", "ZCode", "session", "Partitions", "zcode-coding-plan");
  if (!existsSync(src)) return;
  const dest = join(profile, "Default");
  mkdirSync(dest, { recursive: true });
  try {
    await Promise.race([
      cpAsync(src, dest, { recursive: true, filter: isZaiPlanChromeSeedPath }),
      sleep(SEED_COPY_TIMEOUT_MS).then(() => {
        throw new Error("seed timeout");
      }),
    ]);
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

export function zaiPlanChromeLaunchArgs(port: number, profile: string): string[] {
  const { width, height, left, top } = ZAI_PLAN_CHROME_WINDOW;
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${width},${height}`,
    `--window-position=${left},${top}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "about:blank",
  ];
}

async function waitJson(url: string, child: ChildProcess, ms: number): Promise<unknown> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chrome exited ${child.exitCode}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(400) });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error("chrome debug port did not come up");
}

function connectCdp(wsUrl: string): CdpSession {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  let readySettled = false;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  const events = new Map<string, Set<CdpHandler>>();
  const failAll = (err: Error) => {
    for (const waiter of pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      reject(new Error("cdp websocket timeout"));
    }, CDP_CONNECT_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      reject(new Error("cdp websocket error"));
    });
  });
  ws.addEventListener("close", () => failAll(new Error("cdp closed")));
  ws.addEventListener("message", (ev) => {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.method) {
      const handlers = events.get(msg.method);
      if (handlers) {
        for (const handler of handlers) handler(msg.params ?? {});
      }
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error.message || "cdp error"));
    else waiter.resolve(msg.result ?? {});
  });
  return {
    async send(method, params = {}, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
      await ready;
      const id = ++n;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`cdp timeout ${method}`));
          }, timeoutMs)
          : undefined;
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    on(method, handler) {
      let set = events.get(method);
      if (!set) {
        set = new Set();
        events.set(method, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    close() {
      failAll(new Error("cdp closed"));
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

async function attachPage(port: number, child: ChildProcess): Promise<CdpSession> {
  let wsUrl: string | undefined;
  for (let i = 0; i < 30; i++) {
    const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`, child, 2_000);
    const page = (Array.isArray(tabs) ? tabs : []).find((t: { type?: string; webSocketDebuggerUrl?: string }) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl;
      break;
    }
    await sleep(150);
  }
  if (!wsUrl) throw new Error("no chrome page websocket");
  const session = connectCdp(wsUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  return session;
}

async function readEvaluateValue<T>(result: Record<string, unknown>): Promise<T> {
  const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) {
    throw new Error(details.exception?.description || details.text || "chrome evaluate failed");
  }
  return (result.result as { value?: T } | undefined)?.value as T;
}

function scheduleIdleClose(target: ChromeSlot): void {
  if (target.idleTimer) clearTimeout(target.idleTimer);
  parkChromeWindowsForPid(target.pid);
  target.idleTimer = setTimeout(() => {
    if (slot === target) {
      closeSlot();
    }
  }, CHROME_IDLE_MS);
}

function closeSlot(): void {
  if (!slot) return;
  const current = slot;
  slot = null;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  try { current.session.close(); } catch { /* ignore */ }
  try { current.child.kill(); } catch { /* ignore */ }
}

function revealForWork(pid: number): void {
  if (!pid) return;
  revealChromeWindowsForPid(pid);
}

function cancelIdle(target: ChromeSlot): void {
  if (target.idleTimer) {
    clearTimeout(target.idleTimer);
    target.idleTimer = undefined;
  }
}

async function ensureChrome(opts?: { reveal?: boolean }): Promise<ChromeSlot> {
  if (slot && slot.child.exitCode === null) {
    if (opts?.reveal) revealForWork(slot.pid);
    cancelIdle(slot);
    return slot;
  }
  if (launching) return launching;
  launching = (async () => {
    closeSlot();
    const exe = chromePath();
    const port = 19222 + Math.floor(Math.random() * 400);
    const profile = join(tmpdir(), `ocx-zai-plan-chrome-${port}`);
    mkdirSync(profile, { recursive: true });
    await seedOfficialElectronProfile(profile);
    writeZaiPlanChromePreferences(profile);
    logOAuthEvent("ZCode Plan captcha Chrome starting", { provider: ZAI_PLAN_PROVIDER_LOG });
    const child = spawn(exe, zaiPlanChromeLaunchArgs(port, profile), {
      stdio: "ignore",
      windowsHide: false,
    });
    const pid = child.pid ?? 0;
    child.once("exit", () => {
      if (slot?.child === child) closeSlot();
    });
    await waitJson(`http://127.0.0.1:${port}/json/version`, child, 15_000);
    let session: CdpSession;
    try {
      session = await attachPage(port, child);
    } catch (err) {
      child.kill();
      throw err;
    }
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,
    });
    await session.send("Page.navigate", { url: "https://zcode.z.ai/" });
    revealForWork(pid);
    await session.send("Runtime.evaluate", {
      expression: `new Promise((resolve) => {
        if (document.readyState === "complete") return resolve(document.readyState);
        window.addEventListener("load", () => resolve(document.readyState), { once: true });
        setTimeout(() => resolve(document.readyState), ${PAGE_LOAD_TIMEOUT_MS});
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, PAGE_LOAD_TIMEOUT_MS + 2_000);
    if (opts?.reveal !== false) revealForWork(pid);
    const created: ChromeSlot = { child, session, pid, port };
    slot = created;
    return created;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function evaluate<T>(expression: string, timeoutMs = DEFAULT_CDP_TIMEOUT_MS, reveal = true): Promise<T> {
  const current = await ensureChrome({ reveal });
  if (reveal) revealForWork(current.pid);
  const result = await current.session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  return readEvaluateValue<T>(result);
}

export function invalidateZaiPlanCaptcha(): void {
  if (slot) slot.param = undefined;
}

export function resetZaiPlanChrome(): void {
  closeSlot();
}

export function isZaiPlanCdpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /cdp closed|cdp timeout|cdp websocket|no chrome page websocket|chrome exited|chrome debug port/i.test(msg);
}

export async function getZaiPlanVerifyParam(signal?: AbortSignal): Promise<string> {
  const current = slot;
  if (current?.param && Date.now() - current.param.born < PARAM_TTL_MS) {
    return current.param.value;
  }
  if (!solving) {
    solving = (async () => {
      const { wait, release } = holdExclusive();
      await wait;
      try {
        logOAuthEvent("ZCode Plan captcha solve starting", { provider: ZAI_PLAN_PROVIDER_LOG });
        await ensureChrome({ reveal: true });
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
        const param = await evaluate<string>(expression, SOLVE_TIMEOUT_MS + 5_000, true);
        if (typeof param !== "string" || param.length < 20) throw new Error("empty verifyParam");
        if (slot) {
          slot.param = { value: param, born: Date.now() };
          parkChromeWindowsForPid(slot.pid);
        }
        logOAuthEvent("ZCode Plan captcha solved", { provider: ZAI_PLAN_PROVIDER_LOG });
        return param;
      } catch (err) {
        closeSlot();
        throw err;
      } finally {
        solving = null;
        release();
      }
    })();
  }
  return withAbort(solving, signal);
}

function bindingId(): string {
  return `ocxZai${crypto.randomUUID().replace(/-/g, "")}`;
}

async function zaiPlanBrowserFetchLocked(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  release: () => void;
}): Promise<ZaiPlanChromeResponse> {
  const chrome = await ensureChrome({ reveal: false });
  parkChromeWindowsForPid(chrome.pid);
  logOAuthEvent("ZCode Plan messages via Chrome", { provider: ZAI_PLAN_PROVIDER_LOG });
  const name = bindingId();
  await chrome.session.send("Runtime.addBinding", { name });

  let settleHeaders: (value: { status: number; contentType: string }) => void = () => {};
  let failHeaders: (err: Error) => void = () => {};
  const headersReady = new Promise<{ status: number; contentType: string }>((resolve, reject) => {
    settleHeaders = resolve;
    failHeaders = reject;
  });
  let headersSettled = false;
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;

  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    off();
    if (err) {
      if (!headersSettled) failHeaders(err);
      try { streamCtrl?.error(err); } catch { /* already closed */ }
    } else {
      try { streamCtrl?.close(); } catch { /* already closed */ }
    }
    if (slot === chrome) scheduleIdleClose(chrome);
    input.release();
    void chrome.session.send("Runtime.removeBinding", { name }, 2_000).catch(() => undefined);
  };

  const off = chrome.session.on("Runtime.bindingCalled", (params) => {
    if (params.name !== name) return;
    let payload: { t?: string; s?: number; ct?: string; b?: string; m?: string };
    try {
      payload = JSON.parse(String(params.payload ?? "")) as typeof payload;
    } catch {
      return;
    }
    if (payload.t === "h") {
      if (headersSettled) return;
      headersSettled = true;
      settleHeaders({
        status: typeof payload.s === "number" ? payload.s : 0,
        contentType: typeof payload.ct === "string" && payload.ct ? payload.ct : "application/json",
      });
      return;
    }
    if (payload.t === "d" && typeof payload.b === "string") {
      try {
        streamCtrl?.enqueue(Uint8Array.from(Buffer.from(payload.b, "base64")));
      } catch { /* stream already closed */ }
      return;
    }
    if (payload.t === "e") {
      finish();
      return;
    }
    if (payload.t === "x") {
      finish(new Error(payload.m || "chrome fetch failed"));
    }
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamCtrl = controller;
    },
    cancel() {
      finish(input.signal?.aborted ? new DOMException("aborted", "AbortError") : new Error("stream cancelled"));
      void chrome.session.send("Runtime.evaluate", {
        expression: "void (window.__ocxAbort && window.__ocxAbort.abort())",
      }, 2_000).catch(() => undefined);
    },
  });

  if (input.signal) {
    const onAbort = () => {
      void chrome.session.send("Runtime.evaluate", {
        expression: "void (window.__ocxAbort && window.__ocxAbort.abort())",
      }, 2_000).catch(() => undefined);
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  void chrome.session.send("Runtime.evaluate", {
    expression: `(async () => {
      window.__ocxAbort = new AbortController();
      const send = (p) => { try { window[${JSON.stringify(name)}](JSON.stringify(p)); } catch (e) {} };
      try {
        const res = await fetch(${JSON.stringify(input.url)}, {
          method: "POST",
          headers: ${JSON.stringify(input.headers)},
          body: ${JSON.stringify(input.body)},
          signal: window.__ocxAbort.signal,
        });
        send({ t: "h", s: res.status, ct: res.headers.get("content-type") || "" });
        if (!res.body) { send({ t: "e" }); return "ok"; }
        const reader = res.body.getReader();
        const CHUNK = 24576;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (let i = 0; i < value.length; i += CHUNK) {
            const slice = value.subarray(i, Math.min(i + CHUNK, value.length));
            let bin = "";
            for (let j = 0; j < slice.length; j++) bin += String.fromCharCode(slice[j]);
            send({ t: "d", b: btoa(bin) });
          }
        }
        send({ t: "e" });
        return "ok";
      } catch (e) {
        send({ t: "x", m: String(e && e.message ? e.message : e) });
        throw e;
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, 0).catch((err) => {
    finish(err instanceof Error ? err : new Error(String(err)));
  });

  const headerTimer = setTimeout(() => {
    finish(new Error("chrome fetch header timeout"));
  }, HEADER_WAIT_MS);
  try {
    const headers = await withAbort(headersReady, input.signal);
    clearTimeout(headerTimer);
    return {
      status: headers.status,
      headers: { "content-type": headers.contentType },
      body,
    };
  } catch (err) {
    clearTimeout(headerTimer);
    finish(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

export async function zaiPlanBrowserFetch(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ZaiPlanChromeResponse> {
  const { wait, release } = holdExclusive();
  await wait;
  try {
    return await zaiPlanBrowserFetchLocked({ ...input, release });
  } catch (err) {
    release();
    throw err;
  }
}
