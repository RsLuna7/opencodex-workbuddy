/**
 * WorkBuddy cooldown panel — DOM contract.
 *
 * The projection tests already pin the row arithmetic. What they cannot see is whether the
 * panel actually renders an account-wide breaker with no model named, and whether a live
 * countdown is present at all — the two things an operator reads first. Rendering the
 * component is the only way to catch a column that quietly renders nothing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import WorkbuddyCooldownPanel from "../src/components/provider-workspace/WorkbuddyCooldownPanel";
import { LanguageProvider } from "../src/i18n/provider";

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

async function mountPanel(accounts: Array<Record<string, unknown>>): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <WorkbuddyCooldownPanel accounts={accounts as never} locale="en-GB" />
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

test("a cooling model renders a countdown row with the model id and its credits", async () => {
  const host = await mountPanel([{
    id: "acct-1",
    alias: "130****7424",
    active: false,
    workbuddyPool: {
      realm: "cn",
      credits: 2600,
      modelCooldowns: { "deepseek-v4.1-flash": { until: Date.now() + 43 * 60_000, reason: "quota" } },
    },
  }]);
  const row = host.querySelector("[data-wb-pool-row='deepseek-v4.1-flash']");
  expect(row).not.toBeNull();
  expect(row?.getAttribute("data-wb-pool-state")).toBe("cooling");
  expect(row?.textContent).toContain("deepseek-v4.1-flash");
  expect(row?.textContent).toContain("2600");
  expect(host.querySelector("[data-wb-pool-remaining]")).not.toBeNull();
});

test("an account with nothing cooling renders a ready row carrying its credits", async () => {
  // The panel answers two questions, not one: what is blocked, and how many credits are left.
  // Dropping the row to keep the table clean would silently drop the second answer.
  const host = await mountPanel([{
    id: "acct-1",
    alias: "4ever",
    active: true,
    workbuddyPool: { realm: "cn", credits: 327 },
  }]);
  const row = host.querySelector("[data-wb-pool-row='idle']");
  expect(row).not.toBeNull();
  expect(row?.getAttribute("data-wb-pool-state")).toBe("ready");
  expect(row?.textContent).toContain("4ever");
  expect(row?.textContent).toContain("327");
  expect(host.querySelector("[data-wb-pool-remaining]")).toBeNull();
});

test("an account-wide breaker alone still renders a row", async () => {
  const host = await mountPanel([{
    id: "acct-1",
    alias: "ppopios",
    active: false,
    workbuddyPool: { realm: "global", credits: 97, breakerUntil: Date.now() + 18 * 60_000 },
  }]);
  const row = host.querySelector("[data-wb-pool-row='breaker']");
  expect(row).not.toBeNull();
  expect(row?.textContent).toContain("ppopios");
});

test("no accounts renders the empty state, not a broken panel", async () => {
  const host = await mountPanel([]);
  expect(host.textContent).not.toBe("");
  expect(host.querySelector("table")).toBeNull();
});
