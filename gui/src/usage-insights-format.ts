import type { TFn, Locale } from "./i18n/shared";
import { cachedNumberFormat } from "./intl-formatters";
import { formatTokens } from "./format-tokens";
import { civilDate, type InsightMetric } from "./usage-insights-data";

export function metricLabel(metric: InsightMetric, t: TFn): string {
  return t(metric === "tokens" ? "usage.col.tokens" : metric === "requests" ? "usage.col.requests" : "usage.col.apiListPrice");
}

export function formatInsightValue(value: number | null, metric: InsightMetric, locale: Locale): string {
  if (value === null) return "—";
  if (metric === "tokens") return formatTokens(value, locale);
  return cachedNumberFormat(locale, metric === "cost"
    ? { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }
    : { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatInsightDate(date: string, locale: Locale, short = false): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: short ? "numeric" : "short", day: "numeric", ...(!short ? { year: "numeric" } as const : {}) }).format(civilDate(date));
}
