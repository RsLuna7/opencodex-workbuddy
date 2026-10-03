import { useCallback, useMemo, useState } from "react";
import { useI18n, type TKey } from "../i18n/shared";
import { IconActivity, IconRefresh } from "../icons";
import { Notice } from "../ui";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import { UsageIncompleteNotice } from "../components/usage-incomplete-notice";
import { InsightCalendar, InsightRanking, InsightTrend } from "../components/usage-insights-charts";
import { formatInsightDate, formatInsightValue, metricLabel } from "../usage-insights-format";
import { availableCost, cacheReadRate, dayProviders, insightCsv, insightCsvFilename, insightQuery, type InsightMetric, type InsightRange, type InsightReport, type InsightSurface } from "../usage-insights-data";
import { cachedNumberFormat } from "../intl-formatters";
import "../styles/usage-insights.css";

const RANGES: { value: InsightRange; label: TKey }[] = [
  { value: "today", label: "insights.today" }, { value: "7d", label: "usage.range.7d" },
  { value: "30d", label: "usage.range.30d" }, { value: "all", label: "usage.range.all" },
];
const SURFACES: InsightSurface[] = ["all", "codex", "claude", "grok"];
const METRICS: InsightMetric[] = ["tokens", "requests", "cost"];

export default function UsageInsights({ apiBase, connected = false, apiKeyId }: { apiBase: string; connected?: boolean; apiKeyId?: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<InsightRange>("30d");
  const [surface, setSurface] = useState<InsightSurface>("all");
  const [scope, setScope] = useState<"machine" | "hub">("machine");
  const [metric, setMetric] = useState<InsightMetric>("tokens");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const query = insightQuery(range, surface, connected, scope, apiKeyId);
  const resourceKey = JSON.stringify(["usage-insights", apiBase, connected, scope, apiKeyId, query]);
  const load = useCallback(async (signal: AbortSignal): Promise<InsightReport> => {
    const response = await fetch(`${apiBase}/api/usage?${query}`, { signal });
    if (!response.ok) throw new Error(String(response.status));
    const report = await response.json() as InsightReport;
    if (report.error || !report.summary || !Array.isArray(report.days) || !Array.isArray(report.models) || !Array.isArray(report.providers)) throw new Error("Invalid usage report");
    return report;
  }, [apiBase, query]);
  const resource = useDataSurface(resourceKey, [apiBase, query, connected, scope, apiKeyId], load, {
    isEmpty: report => report.summary.requests === 0, pollMs: 60_000, pauseWhenHidden: true,
  });
  const { state } = resource;
  const data = state.data;
  const hasTokens = !!data && (data.summary.measuredRequests > 0 || data.summary.requests === 0);
  const cacheReads = data ? data.summary.cacheReadInputTokens ?? data.summary.cachedInputTokens : 0;
  const hasCacheReads = !!data && (cacheReads > 0 || (data.summary.cacheObservedInputTokens ?? 0) > 0 || data.summary.requests === 0);
  const selectedDay = data?.days.find(day => day.date === selectedDate);
  const providerRows = useMemo(() => selectedDay ? dayProviders(selectedDay) : data?.providers ?? [], [selectedDay, data?.providers]);
  const modelRows = selectedDay?.models ?? data?.models ?? [];
  const number = cachedNumberFormat(locale);
  const value = (amount: number | null, mode: InsightMetric = "tokens") => formatInsightValue(amount, mode, locale);
  const chooseDate = (date: string) => setSelectedDate(current => current === date ? null : date);
  const clearSelection = () => { setSelectedDate(null); setExportFailed(false); };
  const download = () => {
    if (!data) return;
    try {
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([insightCsv(data, range, surface, scope)], { type: "text/csv;charset=utf-8" }));
      try {
        link.href = url;
        link.download = insightCsvFilename(range, surface);
        document.body.append(link); link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      setExportFailed(false);
    } catch {
      setExportFailed(true);
    }
  };

  return <div className="usage-insights">
    <div className="page-head insight-page-head">
      <div><h2>{t("insights.title")}</h2><p className="insight-intro">{t("insights.subtitle")}</p></div>
      <div className="insight-actions">
        <button type="button" className="btn btn-sm" onClick={() => resource.refresh()} disabled={state.refreshing}>
          <IconRefresh aria-hidden="true" />{t("insights.refresh")}
        </button>
        <button type="button" className="btn btn-sm" onClick={download} disabled={!data || state.refreshing || state.showError}>{t("insights.export")}</button>
      </div>
    </div>

    <div className="insight-toolbar">
      <div className="insight-segmented" role="group" aria-label={t("logs.filter.surface.label")}>
        {SURFACES.map(item => <button type="button" key={item} aria-pressed={surface === item}
          onClick={() => { setSurface(item); clearSelection(); }}>
          {item !== "all" && <img src={`/provider-icons/${item === "claude" ? "claude-color" : item === "codex" ? "openai" : "grok"}.svg`} alt="" width={14} height={14} />}
          {t(`logs.filter.surface.${item}`)}
        </button>)}
      </div>
      <div className="insight-segmented" role="group" aria-label={t("logs.filter.time.label")}>
        {RANGES.map(item => <button type="button" key={item.value} aria-pressed={range === item.value} onClick={() => { setRange(item.value); clearSelection(); }}>{t(item.label)}</button>)}
      </div>
    </div>
    <div className="insight-source-line">
      <span><IconActivity aria-hidden="true" />{t(connected ? "insights.hubSource" : "insights.localSource")}</span>
      {connected && <div className="insight-segmented" role="group" aria-label={t("usage.scope.label")}>
        {(["machine", "hub"] as const).map(item => <button type="button" key={item} aria-pressed={scope === item} onClick={() => { setScope(item); clearSelection(); }}>{t(`usage.scope.${item}`)}</button>)}
      </div>}
      {data && <span>{t("insights.updated", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(data.generatedAt) })}</span>}
    </div>
    {state.showError && <Notice tone="err">{t(connected ? "usage.hubOffline" : "usage.loadError")} <button type="button" className="insight-text-button" onClick={() => resource.refresh()}>{t("common.retry")}</button></Notice>}
    {exportFailed && <Notice tone="err">{t("insights.exportError")}</Notice>}
    {state.showSkeleton ? <DataSurfaceSkeleton label={t("usage.loading")} rows={6} className="insight-skeleton" /> : data && <>
      {state.refreshing && <DataSurfaceStatus live={!state.showError}>{t("usage.loading")}</DataSurfaceStatus>}
      <UsageIncompleteNotice data={data} />
      {(data.historyTruncated || data.entriesTruncated) && <Notice tone="warn">{t("usage.historyTruncated")}</Notice>}
      <dl className="insight-summary" aria-label={t("usage.section.overview")}>
        <div><dt>{t("usage.card.requests")}</dt><dd>{value(data.summary.requests, "requests")}</dd><p>{t("insights.coverageHint", { measured: number.format(data.summary.measuredRequests), total: number.format(data.summary.requests) })}</p></div>
        <div><dt>{t("usage.card.totalTokens")}</dt><dd>{value(hasTokens ? data.summary.totalTokens : null)}</dd><p>{t("usage.col.inputTokens")} {value(hasTokens ? data.summary.inputTokens : null)} · {t("usage.col.outputTokens")} {value(hasTokens ? data.summary.outputTokens : null)}</p></div>
        <div><dt>{t("usage.col.apiListPrice")}</dt><dd>{value(availableCost(data.summary), "cost")}</dd><p>{t("insights.pricingHint", { priced: data.summary.pricedRequests === undefined ? t("usage.unavailable") : number.format(data.summary.pricedRequests), total: number.format(data.summary.requests) })}</p></div>
        <div><dt>{t("usage.card.cachedTokens")}</dt><dd>{value(hasCacheReads ? cacheReads : null)}</dd><p>{t("insights.cacheRate")} {cacheReadRate(data.summary) === null ? t("usage.unavailable") : cachedNumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(cacheReadRate(data.summary)!)}</p></div>
        <div><dt>{t("usage.card.activeDays")}</dt><dd>{number.format(data.days.filter(day => day.requests > 0).length)}</dd><p>{t("insights.activeHint")}</p></div>
        <div><dt>{t("usage.section.models")}</dt><dd>{number.format(data.models.length)}</dd><p>{t("insights.modelsHint", { count: number.format(data.providers.length) })}</p></div>
      </dl>
      {data.summary.requests === 0 ? <div className="insight-empty"><IconActivity aria-hidden="true" /><p>{t("usage.empty")}</p></div> : <>
        <section className="insight-panel insight-trend-panel">
          <div className="insight-panel-head"><h3>{t("insights.dailyTrend")}</h3>
            <div className="insight-segmented" role="group" aria-label={t("insights.dailyTrend")}>
              {METRICS.map(item => <button type="button" key={item} aria-pressed={metric === item} onClick={() => setMetric(item)} disabled={item === "cost" && availableCost(data.summary) === null}>{metricLabel(item, t)}</button>)}
            </div>
          </div>
          <InsightTrend days={data.days} metric={metric} selectedDate={selectedDay?.date ?? null} onSelect={chooseDate} />
        </section>
        <div className="insight-selection" aria-live="polite">
          <span>{selectedDay ? formatInsightDate(selectedDay.date, locale) : t("insights.periodTotal")}</span>
          {selectedDay && <button type="button" className="insight-text-button" onClick={() => setSelectedDate(null)}>{t("insights.clearDay")}</button>}
          {selectedDay && metric === "requests" && providerRows.some(row => row.requestCountUnavailable) && <span>{t("insights.dayProviderRequests")}</span>}
        </div>
        <div className="insight-two-columns" key={selectedDay?.date ?? "period"}>
          <InsightRanking title={t("usage.section.providers")} rows={providerRows} metric={metric} />
          <InsightRanking title={t("usage.section.models")} rows={modelRows} metric={metric} />
        </div>
        <div className="insight-bottom-grid">
          <section className="insight-panel insight-activity-panel">
            <div className="insight-panel-head"><h3>{t("usage.section.heatmap")}</h3><span>{t("usage.card.requests")}</span></div>
            <InsightCalendar days={data.days} selectedDate={selectedDay?.date ?? null} onSelect={chooseDate} />
          </section>
          <section className="insight-panel insight-composition-panel">
            <div className="insight-panel-head"><h3>{t("insights.tokenMix")}</h3><span>{t("usage.section.coverage")}</span></div>
            <div className="insight-composition-bar" aria-hidden="true">
              <span style={{ flexGrow: data.summary.inputTokens }} /><span style={{ flexGrow: data.summary.outputTokens }} />
            </div>
            <div className="insight-composition-values">
              <span><i />{t("usage.col.inputTokens")}<strong>{value(hasTokens ? data.summary.inputTokens : null)}</strong></span>
              <span><i />{t("usage.col.outputTokens")}<strong>{value(hasTokens ? data.summary.outputTokens : null)}</strong></span>
            </div>
            <p className="insight-fine-print">{t("insights.tokenHint")}</p>
            <div className="insight-quality-rows">
              <div><span>{t("usage.card.coverage")}</span><strong>{cachedNumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(data.summary.coverageRatio)}</strong></div>
              <div><span>{t("insights.cacheRate")}</span><strong>{cacheReadRate(data.summary) === null ? t("usage.unavailable") : cachedNumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(cacheReadRate(data.summary)!)}</strong></div>
            </div>
            <p className="insight-fine-print">{t("insights.cacheHint")}</p>
          </section>
        </div>
      </>}
      <footer className="insight-footnotes">
        <p>{t("usage.cost.disclaimer")} {((data.summary.unpricedRequests ?? 0) + (data.summary.unmeteredRequests ?? 0)) > 0 && t("usage.cost.unpricedNote", { count: (data.summary.unpricedRequests ?? 0) + (data.summary.unmeteredRequests ?? 0) })}</p>
        {range === "all" && <p>{t("insights.historyNote")}</p>}
      </footer>
    </>}
  </div>;
}
