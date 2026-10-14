import { describe, expect, test } from "bun:test";
import { activityWeeks, availableCost, cacheReadRate, civilDate, dayProviders, insightCsv, insightQuery, insightValue, rankInsights, type InsightDay, type InsightReport } from "../src/usage-insights-data";
import { readPageFromHash, resolveAppHashChange } from "../src/app-routing";

const models = [
  { provider: "a", model: "first", requests: 4, totalTokens: 100, estimatedCostUsd: 0.2 },
  { provider: "a", model: "second", requests: 3, totalTokens: 50 },
  { provider: "b", model: "third", requests: 2, totalTokens: 20, estimatedCostUsd: 0 },
];
const day: InsightDay = { date: "2026-10-01", requests: 6, totalTokens: 170, models };

describe("usage insight accounting", () => {
  test("unknown and excluded pricing never becomes free", () => {
    expect(availableCost({})).toBeNull();
    expect(availableCost({ estimatedCostUsd: 0, pricedRequests: 0 })).toBeNull();
    expect(availableCost({ estimatedCostUsd: 0, pricedRequests: 1 })).toBe(0);
    expect(availableCost({ estimatedCostUsd: Number.NaN })).toBeNull();
    expect(insightValue({ ...day, estimatedCostUsd: 0, models: [models[1]] }, "cost")).toBeNull();
  });

  test("cache ratios only use observed cache telemetry", () => {
    const summary = { inputTokens: 1000, cachedInputTokens: 300, cacheReadInputTokens: 200 } as InsightReport["summary"];
    expect(cacheReadRate(summary)).toBeNull();
    expect(cacheReadRate({ ...summary, cacheObservedInputTokens: 0 })).toBeNull();
    expect(cacheReadRate({ ...summary, cacheObservedInputTokens: 400 })).toBe(0.5);
  });

  test("unmeasured token counts and overlapping daily provider request counts stay unknown", () => {
    expect(insightValue({ ...models[0], measuredRequests: 0, totalTokens: 0 }, "tokens")).toBeNull();
    expect(insightValue({ ...models[0], measuredRequests: 1, totalTokens: 0 }, "tokens")).toBe(0);
    const providers = dayProviders(day);
    expect(providers[0]).toMatchObject({ provider: "a", totalTokens: 150, estimatedCostUsd: 0.2 });
    expect(insightValue(providers[0], "requests")).toBeNull();
    expect(insightValue(providers[1], "requests")).toBe(2);
    expect(providers[1].estimatedCostUsd).toBe(0);
  });

  test("rankings change with the metric and put unavailable prices last without mutation", () => {
    expect(rankInsights(models, "tokens").map(row => row.model)).toEqual(["first", "second", "third"]);
    expect(rankInsights(models, "cost").map(row => row.model)).toEqual(["first", "third", "second"]);
    expect(models.map(row => row.model)).toEqual(["first", "second", "third"]);
  });
});

describe("usage insight boundaries", () => {
  test("machine key attribution is used only for the connected machine scope", () => {
    expect(insightQuery("7d", "codex", true, "machine", "key-a")).toBe("range=7d&surface=codex&apiKeyId=key-a");
    expect(insightQuery("all", "all", true, "hub", "key-a")).not.toContain("apiKeyId");
    expect(insightQuery("today", "grok", false, "machine", "key-a")).not.toContain("apiKeyId");
  });

  test("civil dates retain proxy day order across DST and have Monday-first padding", () => {
    const start = { ...day, date: "2026-03-07" }, end = { ...day, date: "2026-03-10" };
    const weeks = activityWeeks([end, start]);
    expect(weeks[0].slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(weeks.flat().filter(Boolean).map(row => row!.date)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    expect(civilDate("2026-03-08").getUTCDate()).toBe(8);
    expect(activityWeeks([])).toEqual([]);
    expect(activityWeeks([{ ...day, date: "1970-01-01" }, end]).flat().filter(Boolean)).toHaveLength(366);
  });

  test("CSV preserves missing prices, incomplete metadata and formula-safe identifiers", () => {
    const report = { generatedAt: Date.UTC(2026, 9, 2), summary: { unpricedRequests: 2, unmeteredRequests: 1 }, usageIncomplete: true,
      days: [{ ...day, models: [{ ...models[0], provider: "=DANGEROUS()", model: 'quote,"here' }, models[1]] }] } as InsightReport;
    const csv = insightCsv(report, "all", "codex", "machine");
    expect(csv).toContain('"usage_incomplete","true"');
    expect(csv).toContain('"excluded_requests","3"');
    expect(csv).toContain('"\'=DANGEROUS()"');
    expect(csv).toContain('"quote,""here"');
    expect(csv).toContain('"2026-10-01","a","second","3","50",');
    expect(insightCsv({ ...report, usageIncomplete: undefined }, "30d", "all", "hub")).toContain('"usage_incomplete","unknown"');
  });

  test("new insights route survives reload and invalid descendants normalize passively", () => {
    expect(readPageFromHash("#insights")).toBe("insights");
    expect(resolveAppHashChange("insights")).toEqual({ page: "insights", replaceTo: null });
    expect(resolveAppHashChange("insights/nope")).toEqual({ page: "insights", replaceTo: "insights" });
  });
});
