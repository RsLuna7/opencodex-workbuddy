import type { UsageReadMetadata } from "./usage-summary-resource";

export type InsightRange = "today" | "7d" | "30d" | "all";
export type InsightSurface = "all" | "codex" | "claude" | "grok";
export type InsightMetric = "tokens" | "requests" | "cost";

export interface InsightRow {
  provider: string;
  model?: string;
  requests: number;
  measuredRequests?: number;
  requestCountUnavailable?: true;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
}

export interface InsightDay {
  date: string;
  requests: number;
  totalTokens: number;
  measuredRequests?: number;
  estimatedCostUsd?: number;
  models: InsightRow[];
}

export interface InsightReport extends UsageReadMetadata {
  generatedAt: number;
  summary: {
    requests: number;
    measuredRequests: number;
    reportedRequests: number;
    estimatedRequests: number;
    unreportedRequests: number;
    unsupportedRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheObservedInputTokens?: number;
    coverageRatio: number;
    estimatedCostUsd?: number;
    pricedRequests?: number;
    unpricedRequests?: number;
    unmeteredRequests?: number;
  };
  days: InsightDay[];
  providers: InsightRow[];
  models: InsightRow[];
  historyTruncated?: boolean;
  entriesTruncated?: boolean;
  error?: string;
}

export function insightQuery(range: InsightRange, surface: InsightSurface, connected: boolean, scope: "machine" | "hub", apiKeyId?: string): string {
  const query = new URLSearchParams({ range, surface });
  if (connected && scope === "machine" && apiKeyId) query.set("apiKeyId", apiKeyId);
  return query.toString();
}

export function availableCost(row: Pick<InsightRow, "estimatedCostUsd" | "pricedRequests">): number | null {
  const cost = row.estimatedCostUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && row.pricedRequests !== 0 ? cost : null;
}

export function insightValue(row: InsightRow | InsightDay, metric: InsightMetric): number | null {
  if (metric === "cost") {
    if ("models" in row && row.requests > 0 && !row.models.some(model => availableCost(model) !== null)) return null;
    return availableCost(row);
  }
  if (metric === "tokens" && row.requests > 0 && (row.measuredRequests === 0 || (row.measuredRequests === undefined && row.totalTokens === 0))) return null;
  if (metric === "requests" && "requestCountUnavailable" in row && row.requestCountUnavailable) return null;
  return metric === "tokens" ? row.totalTokens : row.requests;
}

export function rankInsights(rows: InsightRow[], metric: InsightMetric): InsightRow[] {
  return rows.toSorted((a, b) => {
    const av = insightValue(a, metric), bv = insightValue(b, metric);
    if (av === null) return bv === null ? a.provider.localeCompare(b.provider) : 1;
    if (bv === null) return -1;
    return bv - av || (a.model ?? a.provider).localeCompare(b.model ?? b.provider);
  });
}

/** Day rows do not include pricing coverage counts; do not invent them during projection. */
export function dayProviders(day: InsightDay): InsightRow[] {
  const providers = new Map<string, InsightRow>();
  for (const model of day.models) {
    let row = providers.get(model.provider);
    if (!row) {
      row = { provider: model.provider, requests: 0, totalTokens: 0 };
      providers.set(model.provider, row);
    } else row.requestCountUnavailable = true;
    row.requests += model.requests;
    row.totalTokens += model.totalTokens;
    const cost = availableCost(model);
    if (cost !== null) row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + cost;
  }
  return [...providers.values()];
}

/** Civil dates come from the proxy. UTC arithmetic preserves them across browser time zones and DST. */
export function civilDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

export function activityWeeks(days: InsightDay[]): (InsightDay | null)[][] {
  if (!days.length) return [];
  const sorted = days.toSorted((a, b) => a.date.localeCompare(b.date));
  const lookup = new Map(sorted.map(day => [day.date, day]));
  const cursor = civilDate(sorted[0].date);
  const end = civilDate(sorted[sorted.length - 1].date);
  const cells: (InsightDay | null)[] = Array.from({ length: (cursor.getUTCDay() + 6) % 7 }, () => null);
  // The API bounds its day grid to 366 days; defend against malformed or old responses too.
  for (let count = 0; cursor <= end && count < 366; count++) {
    const date = cursor.toISOString().slice(0, 10);
    cells.push(lookup.get(date) ?? { date, requests: 0, totalTokens: 0, models: [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

export function cacheReadRate(summary: InsightReport["summary"]): number | null {
  const observed = summary.cacheObservedInputTokens;
  if (observed === undefined || !Number.isFinite(observed) || observed <= 0) return null;
  return Math.min(1, Math.max(0, (summary.cacheReadInputTokens ?? summary.cachedInputTokens) / observed));
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  let text = String(value);
  // Provider/model names are operator-controlled. Prevent spreadsheet formula execution.
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Machine headers carry units; unknown prices stay empty, and read diagnostics travel with the file. */
export function insightCsv(report: InsightReport, range: InsightRange, surface: InsightSurface, scope: "machine" | "hub"): string {
  const excluded = (report.summary.unpricedRequests ?? 0) + (report.summary.unmeteredRequests ?? 0);
  const records: (string | number | undefined)[][] = [
    ["range", range, "surface", surface, "scope", scope],
    ["generated_at", new Date(report.generatedAt).toISOString(), "usage_incomplete", report.usageIncomplete === true ? "true" : "unknown", "history_truncated", String(!!report.historyTruncated || !!report.entriesTruncated)],
    ["cost_basis", "API list-price estimate, not a billing receipt", "excluded_requests", excluded],
    ["date", "provider", "model", "requests", "tokens", "estimated_cost_usd"],
  ];
  for (const day of report.days) {
    for (const model of day.models) records.push([day.date, model.provider, model.model, model.requests, insightValue(model, "tokens") ?? undefined, availableCost(model) ?? undefined]);
  }
  return "\uFEFF" + records.map(row => row.map(csvCell).join(",")).join("\r\n");
}

export function insightCsvFilename(range: InsightRange, surface: InsightSurface): string {
  return `opencodex-usage-${surface}-${range}.csv`;
}
