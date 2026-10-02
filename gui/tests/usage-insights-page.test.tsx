import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import UsageInsights from "../src/pages/UsageInsights";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import type { InsightReport } from "../src/usage-insights-data";

const globals = ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window, host: HTMLElement, root: Root | null;
let body: InsightReport, requests: string[], status: number;
let pending: ((response: Response) => void) | null, hold: boolean;

function report(): InsightReport {
  const first = { provider: "alpha", model: "model-one", requests: 3, measuredRequests: 3, totalTokens: 600, estimatedCostUsd: 0.6, pricedRequests: 3 };
  const second = { provider: "beta", model: "model-two", requests: 2, measuredRequests: 2, totalTokens: 100, estimatedCostUsd: 0.1, pricedRequests: 2 };
  return {
    generatedAt: Date.UTC(2026, 9, 2), summary: {
      requests: 5, measuredRequests: 5, reportedRequests: 5, estimatedRequests: 0, unreportedRequests: 0, unsupportedRequests: 0,
      inputTokens: 500, outputTokens: 200, totalTokens: 700, cachedInputTokens: 200, cacheReadInputTokens: 200,
      cacheObservedInputTokens: 400, coverageRatio: 1, estimatedCostUsd: 0.7, pricedRequests: 5, unpricedRequests: 0, unmeteredRequests: 0,
    },
    models: [first, second], providers: [{ ...first, model: undefined }, { ...second, model: undefined }],
    days: [
      { date: "2026-10-01", requests: 3, measuredRequests: 3, totalTokens: 600, estimatedCostUsd: 0.6, models: [first] },
      { date: "2026-10-02", requests: 2, measuredRequests: 2, totalTokens: 100, estimatedCostUsd: 0.1, models: [second] },
    ],
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/#insights" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  body = report(); requests = []; status = 200; root = null; pending = null; hold = false;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input));
    if (hold) return new Promise<Response>((resolve, reject) => {
      pending = resolve;
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return Response.json(body, { status });
  } });
  host = document.createElement("div"); document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  clearClientResourceStoresForTests(); win.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(props: { apiBase: string; connected?: boolean; apiKeyId?: string } = { apiBase: "/proxy" }) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(<LanguageProvider><UsageInsights {...props} /></LanguageProvider>);
  });
}

async function click(button: Element | null) {
  expect(button).not.toBeNull();
  await act(async () => { (button as HTMLElement).click(); });
}

function button(text: string) {
  return [...host.querySelectorAll("button")].find(node => node.textContent === text) ?? null;
}

test("loads proxy data and daily selection updates both rankings without changing period totals", async () => {
  await mount();
  expect(requests).toEqual(["/proxy/api/usage?range=30d&surface=all"]);
  expect(host.querySelectorAll(".insight-ranking li")).toHaveLength(4);
  await click(host.querySelector('.insight-bars [data-date="2026-10-02"]'));
  expect(host.querySelectorAll(".insight-ranking li")).toHaveLength(2);
  expect(host.querySelector(".insight-two-columns")?.textContent).toContain("model-two");
  expect(host.querySelector(".insight-two-columns")?.textContent).not.toContain("model-one");
  expect(host.querySelector(".insight-summary")?.textContent).toContain("700");
  expect(host.querySelector('.insight-calendar [data-date="2026-10-02"]')?.getAttribute("aria-pressed")).toBe("true");
  await click(button("Clear day"));
  expect(host.querySelectorAll(".insight-ranking li")).toHaveLength(4);
});

test("calendar selection and arrow-key focus share the daily chart state", async () => {
  await mount();
  const cell = host.querySelector('.insight-calendar [data-date="2026-10-01"]') as HTMLButtonElement;
  await click(cell);
  expect(host.querySelector('.insight-bars [data-date="2026-10-01"]')?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { cell.focus(); cell.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event); });
  expect(document.activeElement?.getAttribute("data-date")).toBe("2026-10-02");
  const first = host.querySelector('.insight-bars [data-date="2026-10-01"]') as HTMLButtonElement;
  await act(async () => { first.focus(); first.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event); });
  expect(document.activeElement?.getAttribute("data-date")).toBe("2026-10-02");
});

test("changing ranges shows loading rather than the previous report and clears day selection", async () => {
  await mount();
  await click(host.querySelector('.insight-bars [data-date="2026-10-02"]'));
  hold = true;
  await click(button("7d"));
  expect(requests.at(-1)).toBe("/proxy/api/usage?range=7d&surface=all");
  expect(host.querySelector(".insight-summary")).toBeNull();
  expect(host.textContent).toContain("Loading usage data");
  const next = report(); next.summary.requests = 2;
  await act(async () => { pending!(Response.json(next)); });
  expect(host.textContent).toContain("Whole period");
  expect(host.querySelectorAll(".insight-ranking li")).toHaveLength(4);
});

test("surface and connected machine scopes isolate requests and account keys", async () => {
  await mount({ apiBase: "/hub", connected: true, apiKeyId: "one" });
  expect(requests.at(-1)).toContain("apiKeyId=one");
  await click(button("Codex"));
  expect(requests.at(-1)).toContain("surface=codex&apiKeyId=one");
  await click(button("Hub-wide"));
  expect(requests.at(-1)).toBe("/hub/api/usage?range=30d&surface=codex");
  await click(button("This machine"));
  await mount({ apiBase: "/hub", connected: true, apiKeyId: "two" });
  expect(requests.at(-1)).toContain("apiKeyId=two");
});

test("refresh failure preserves measurements and exposes retry instead of substituting data", async () => {
  await mount();
  status = 503;
  await click(button("Refresh"));
  expect(host.textContent).toContain("Could not load usage data");
  expect(host.querySelector(".insight-summary")?.textContent).toContain("700");
  expect((button("Export CSV") as HTMLButtonElement).disabled).toBe(true);
  status = 200;
  await click(button("Retry"));
  expect(host.textContent).not.toContain("Could not load usage data");
});

test("incomplete empty history warns and does not masquerade as a failed or priced report", async () => {
  body = { ...body, usageIncomplete: true, historyTruncated: true, days: [], models: [], providers: [],
    summary: { ...body.summary, requests: 0, measuredRequests: 0, totalTokens: 0, estimatedCostUsd: 0, pricedRequests: 0 } };
  await mount();
  expect(host.textContent).toContain("Some usage records could not be included");
  expect(host.textContent).toContain("Totals cover available history only");
  expect(host.textContent).toContain("No usage recorded yet");
  expect(host.querySelectorAll(".insight-summary dd")[2]?.textContent).toBe("—");
  expect(host.textContent).not.toContain("Could not load usage data");
});

test("requests without usable measurements show unknown tokens and cache instead of zeros", async () => {
  body.summary = { ...body.summary, measuredRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheObservedInputTokens: 0, estimatedCostUsd: 0, pricedRequests: 0 };
  await mount();
  const metrics = host.querySelectorAll(".insight-summary dd");
  expect(metrics[1]?.textContent).toBe("—");
  expect(metrics[2]?.textContent).toBe("—");
  expect(metrics[3]?.textContent).toBe("—");
  expect((button("API list-price") as HTMLButtonElement).disabled).toBe(true);
});

test("CSV export uses the visible report and exposes a download failure", async () => {
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  let blob: Blob | undefined;
  URL.createObjectURL = value => { blob = value as Blob; return "blob:usage-test"; };
  URL.revokeObjectURL = () => {};
  try {
    await mount();
    await click(button("Export CSV"));
    expect(await blob!.text()).toContain('"model-one","3","600","0.6"');
    URL.createObjectURL = () => { throw new Error("download unavailable"); };
    await click(button("Export CSV"));
    expect(host.textContent).toContain("CSV export failed");
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});
