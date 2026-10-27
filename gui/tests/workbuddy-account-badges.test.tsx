import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

const ITEM: WorkspaceItem = {
  name: "workbuddy",
  adapter: "codebuddy",
  baseUrl: "https://copilot.tencent.com/v2",
  authMode: "oauth",
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

async function mountPanel(
  accounts: Array<Record<string, unknown>>,
  onLogin: (provider: string, addAccount?: boolean, realm?: "cn" | "global") => void = () => {},
  loggedIn = true,
  busyProvider?: string,
): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const handlers = {
    onLogin,
    onLogout: async () => {},
    onReauth: async () => {},
    onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {},
    onRemoveAccount: async () => {},
    onRemoveApiKey: async () => {},
    onAddApiKey: async () => {},
    onEditAlias: async () => {},
  } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase="http://proxy"
          oauth={{ loggedIn }}
          busy={busyProvider === "workbuddy"}
          accounts={accounts as never}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("completed check-in and daily-task render square badges on the account row", async () => {
  const host = await mountPanel([{
    id: "acct-1",
    alias: "4ever",
    email: "4ever",
    active: false,
    quotaMode: "probe",
    workbuddy: { checkedIn: true, dailyTask: true },
  }]);
  expect(host.querySelector("[data-workbuddy-badge='checked-in']")).not.toBeNull();
  expect(host.querySelector("[data-workbuddy-badge='daily-task']")).not.toBeNull();
});

test("unknown WorkBuddy status renders no badges", async () => {
  const host = await mountPanel([{
    id: "acct-1",
    alias: "4ever",
    active: false,
    quotaMode: "probe",
  }]);
  expect(host.querySelector("[data-workbuddy-badge]")).toBeNull();
});

test("incomplete WorkBuddy days render muted square badges", async () => {
  const host = await mountPanel([{
    id: "acct-1",
    alias: "4ever",
    active: false,
    quotaMode: "probe",
    workbuddy: { checkedIn: false, dailyTask: false },
  }]);
  const checkin = host.querySelector("[data-workbuddy-badge='not-checked-in']");
  const task = host.querySelector("[data-workbuddy-badge='daily-task-open']");
  expect(checkin).not.toBeNull();
  expect(task).not.toBeNull();
  expect(checkin?.className).toContain("badge-muted");
  expect(task?.className).toContain("badge-muted");
});

for (const loggedIn of [false, true]) {
  test(`WorkBuddy ${loggedIn ? "additional" : "first"} account offers explicit CN and Global login`, async () => {
    const calls: unknown[][] = [];
    const host = await mountPanel([], (...args) => { calls.push(args); }, loggedIn);
    const buttons = Array.from(host.querySelectorAll("button"));
    const cn = buttons.find(button => button.textContent === "Add CN account");
    const global = buttons.find(button => button.textContent === "Add Global account");
    expect(cn).toBeDefined();
    expect(global).toBeDefined();
    await act(async () => { cn!.click(); global!.click(); });
    expect(calls).toEqual([
      ["workbuddy", loggedIn, "cn"],
      ["workbuddy", true, "global"],
    ]);
  });
}

test("both WorkBuddy login entries are disabled while login is pending", async () => {
  const calls: unknown[][] = [];
  const host = await mountPanel([], (...args) => { calls.push(args); }, true, "workbuddy");
  for (const label of ["Add CN account", "Add Global account"]) {
    const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);
    expect(button?.disabled).toBe(true);
    await act(async () => { button!.click(); });
  }
  expect(calls).toEqual([]);
});
