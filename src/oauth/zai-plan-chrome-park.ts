/**
 * Park/reveal the captcha Chrome HWND. Chromium on Windows clips
 * --window-position / CDP bounds back onto the visible work area, so those
 * flags alone cannot hide the window — and hiding it during captcha stalls
 * Aliyun traceless verification (no paint, throttled timers, no popup).
 */
import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** On-screen headed window. Headless Chrome returns F001; minimized can set document.hidden. */
export const ZAI_PLAN_CHROME_WINDOW = {
  width: 900,
  height: 700,
  left: 80,
  top: 80,
} as const;

/** Off-screen rest position used only after captcha+fetch, never during solve. */
export const ZAI_PLAN_CHROME_PARK = {
  left: -32_000,
  top: -32_000,
} as const;

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x0008_0000;
const WS_EX_TOOLWINDOW = 0x0000_0080;
const LWA_ALPHA = 0x02;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SW_SHOWNOACTIVATE = 4;
const SHOW_ALPHA = 255;
const TH32CS_SNAPPROCESS = 0x0000_0002;
const PROCESSENTRY32W_SIZE = 568;
/** 1/255 — still composited (alpha 0 can skip painting) but invisible. */
const HIDE_ALPHA = 1;

type User32 = {
  EnumWindows: (cb: Pointer, lParam: Pointer) => number;
  GetWindowThreadProcessId: (hwnd: Pointer, pid: Pointer) => number;
  GetClassNameW: (hwnd: Pointer, buf: Pointer, max: number) => number;
  GetWindowLongPtrW: (hwnd: Pointer, index: number) => bigint;
  SetWindowLongPtrW: (hwnd: Pointer, index: number, value: bigint) => bigint;
  SetLayeredWindowAttributes: (hwnd: Pointer, key: number, alpha: number, flags: number) => number;
  SetWindowPos: (
    hwnd: Pointer,
    insertAfter: Pointer | null,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ) => number;
  ShowWindow: (hwnd: Pointer, cmd: number) => number;
};

type Kernel32 = {
  CreateToolhelp32Snapshot: (flags: number, pid: number) => Pointer;
  Process32FirstW: (snap: Pointer, entry: Pointer) => number;
  Process32NextW: (snap: Pointer, entry: Pointer) => number;
  CloseHandle: (handle: Pointer) => number;
};

let user32: User32 | null | undefined;
let kernel32: Kernel32 | null | undefined;

function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32;
  if (process.platform !== "win32") {
    user32 = null;
    return null;
  }
  try {
    const lib = dlopen("user32.dll", {
      EnumWindows: { args: ["ptr", "ptr"], returns: "i32" },
      GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
      GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
      GetWindowLongPtrW: { args: ["ptr", "i32"], returns: "i64" },
      SetWindowLongPtrW: { args: ["ptr", "i32", "i64"], returns: "i64" },
      SetLayeredWindowAttributes: { args: ["ptr", "u32", "i32", "u32"], returns: "i32" },
      SetWindowPos: { args: ["ptr", "ptr", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
      ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
    });
    user32 = lib.symbols as unknown as User32;
  } catch {
    user32 = null;
  }
  return user32;
}

function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") {
    kernel32 = null;
    return null;
  }
  try {
    const lib = dlopen("kernel32.dll", {
      CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "ptr" },
      Process32FirstW: { args: ["ptr", "ptr"], returns: "i32" },
      Process32NextW: { args: ["ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

function isInvalidHandle(handle: Pointer): boolean {
  const n = typeof handle === "bigint" ? handle : BigInt(Number(handle));
  return n === 0n || n === 0xFFFF_FFFF_FFFF_FFFFn;
}

function readUtf16z(buf: ArrayBuffer, offset: number, maxChars: number): string {
  const u16 = new Uint16Array(buf, offset, maxChars);
  const end = u16.indexOf(0);
  return String.fromCharCode(...u16.subarray(0, end < 0 ? maxChars : end));
}

/** Chrome's HWND often lives on a child chrome.exe, not the launcher pid we spawned. */
export function chromeTreePids(rootPid: number): number[] {
  const wanted = new Set([rootPid]);
  const k32 = loadKernel32();
  if (!k32 || !rootPid) return [...wanted];
  const snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (isInvalidHandle(snap)) return [...wanted];
  const buf = new ArrayBuffer(PROCESSENTRY32W_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, PROCESSENTRY32W_SIZE, true);
  const rows: { pid: number; ppid: number; exe: string }[] = [];
  try {
    if (!k32.Process32FirstW(snap, ptr(buf))) return [...wanted];
    do {
      rows.push({
        pid: view.getUint32(8, true),
        ppid: view.getUint32(32, true),
        exe: readUtf16z(buf, 44, 260).toLowerCase(),
      });
    } while (k32.Process32NextW(snap, ptr(buf)));
  } finally {
    k32.CloseHandle(snap);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!wanted.has(row.ppid) || wanted.has(row.pid)) continue;
      if (row.exe !== "chrome.exe" && row.exe !== "msedge.exe") continue;
      wanted.add(row.pid);
      grew = true;
    }
  }
  return [...wanted];
}

function readClassName(api: User32, hwnd: Pointer): string {
  const buf = new Uint16Array(256);
  const n = api.GetClassNameW(hwnd, ptr(buf), buf.length);
  if (n <= 0) return "";
  return String.fromCharCode(...buf.subarray(0, n));
}

function hwndPid(api: User32, hwnd: Pointer): number {
  const out = new Uint32Array(1);
  api.GetWindowThreadProcessId(hwnd, ptr(out));
  return out[0] ?? 0;
}

function listChromeHwnds(api: User32, pids: Set<number>): Pointer[] {
  const found: Pointer[] = [];
  const lParam = ptr(new Uint8Array(8));
  const cb = new JSCallback(
    (hwnd: Pointer) => {
      if (!pids.has(hwndPid(api, hwnd))) return 1;
      const cls = readClassName(api, hwnd);
      if (cls === "Chrome_WidgetWin_1" || cls === "Chrome_WidgetWin_0") found.push(hwnd);
      return 1;
    },
    { args: ["ptr", "ptr"], returns: "i32" },
  );
  try {
    if (cb.ptr) api.EnumWindows(cb.ptr, lParam);
  } finally {
    cb.close();
  }
  return found;
}

function asStyle(prev: bigint | number): bigint {
  return typeof prev === "bigint" ? prev : BigInt(prev);
}

function cloakHwnd(api: User32, hwnd: Pointer): boolean {
  const { width, height } = ZAI_PLAN_CHROME_WINDOW;
  const prev = api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  const next = asStyle(prev) | BigInt(WS_EX_LAYERED | WS_EX_TOOLWINDOW);
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  api.SetLayeredWindowAttributes(hwnd, 0, HIDE_ALPHA, LWA_ALPHA);
  return api.SetWindowPos(
    hwnd,
    null,
    ZAI_PLAN_CHROME_PARK.left,
    ZAI_PLAN_CHROME_PARK.top,
    width,
    height,
    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
  ) !== 0;
}

function revealHwnd(api: User32, hwnd: Pointer): boolean {
  const { left, top, width, height } = ZAI_PLAN_CHROME_WINDOW;
  const prev = api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  const next = (asStyle(prev) & ~BigInt(WS_EX_TOOLWINDOW)) | BigInt(WS_EX_LAYERED);
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  api.SetLayeredWindowAttributes(hwnd, 0, SHOW_ALPHA, LWA_ALPHA);
  api.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return api.SetWindowPos(
    hwnd,
    null,
    left,
    top,
    width,
    height,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
  ) !== 0;
}

function forEachChromeHwnd(pid: number, visit: (api: User32, hwnd: Pointer) => boolean): number {
  if (!pid || pid < 1) return 0;
  const api = loadUser32();
  if (!api) return 0;
  let moved = 0;
  try {
    const pids = new Set(chromeTreePids(pid));
    for (const hwnd of listChromeHwnds(api, pids)) {
      if (visit(api, hwnd)) moved += 1;
    }
  } catch {
    return moved;
  }
  return moved;
}

/** Move + cloak every Chromium frame window owned by `pid` or its chrome.exe children. */
export function parkChromeWindowsForPid(pid: number): number {
  return forEachChromeHwnd(pid, cloakHwnd);
}

/** Restore the captcha Chrome onto the visible work area so Aliyun can paint. */
export function revealChromeWindowsForPid(pid: number): number {
  return forEachChromeHwnd(pid, revealHwnd);
}

export function writeZaiPlanChromePreferences(profile: string): void {
  const dest = join(profile, "Default");
  mkdirSync(dest, { recursive: true });
  const { left, top, width, height } = ZAI_PLAN_CHROME_WINDOW;
  writeFileSync(
    join(dest, "Preferences"),
    JSON.stringify({
      browser: {
        window_placement: {
          bottom: top + height,
          left,
          maximized: false,
          right: left + width,
          top,
          work_area_bottom: top + height,
          work_area_left: left,
          work_area_right: left + width,
          work_area_top: top,
        },
      },
    }),
  );
}

export function isZaiPlanChromeSeedPath(p: string): boolean {
  return !/[/\\](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|WebStorage|Preferences|Secure Preferences|Sessions|Current Session|Current Tabs|Last Session|Last Tabs)([/\\]|$)/i.test(p);
}
