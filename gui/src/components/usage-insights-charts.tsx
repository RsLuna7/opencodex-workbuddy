import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { cachedNumberFormat } from "../intl-formatters";
import { formatTokens } from "../format-tokens";
import { formatProviderDisplayName } from "../provider-icons";
import { activityWeeks, availableCost, civilDate, insightValue, rankInsights, type InsightDay, type InsightMetric, type InsightRow } from "../usage-insights-data";
import { formatInsightDate, formatInsightValue, metricLabel } from "../usage-insights-format";

function moveChartFocus(event: KeyboardEvent<HTMLElement>, index: number, total: number, grid = false) {
  const step = event.key === "Home" ? -index : event.key === "End" ? total - index - 1
    : event.key === "ArrowRight" ? (grid ? 7 : 1) : event.key === "ArrowLeft" ? (grid ? -7 : -1)
    : grid && event.key === "ArrowDown" ? 1 : grid && event.key === "ArrowUp" ? -1 : null;
  if (step === null) return;
  event.preventDefault();
  const buttons = event.currentTarget.closest("[data-insight-chart]")?.querySelectorAll<HTMLButtonElement>("button[data-date]");
  const next = buttons?.[Math.max(0, Math.min(total - 1, index + step))];
  next?.focus();
}

function dayDescription(day: InsightDay, t: TFn, locale: Locale): string {
  return t("usage.chart.dayDetail", { date: formatInsightDate(day.date, locale), requests: cachedNumberFormat(locale).format(day.requests), tokens: formatInsightValue(insightValue(day, "tokens"), "tokens", locale) });
}

export function InsightTrend({ days, metric, selectedDate, onSelect }: {
  days: InsightDay[]; metric: InsightMetric; selectedDate: string | null; onSelect: (date: string) => void;
}) {
  const { t, locale } = useI18n();
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const sorted = useMemo(() => days.toSorted((a, b) => a.date.localeCompare(b.date)), [days]);
  const maximum = Math.max(0, ...sorted.map(day => insightValue(day, metric) ?? 0)) || 1;
  const detail = sorted.find(day => day.date === (hovered ?? focused ?? selectedDate));
  const axis = [...new Set([0, Math.floor((sorted.length - 1) / 2), sorted.length - 1])].filter(i => i >= 0);
  return (
    <>
      <div className="insight-trend" aria-label={t("insights.dailyTrend")}>
        <div className="insight-y-axis" aria-hidden="true">
          {[1, 0.5, 0].map(factor => <span key={factor}>{formatInsightValue(maximum * factor, metric, locale)}</span>)}
        </div>
        <div className="insight-chart-scroll">
          <div className="insight-plot" style={{ minWidth: sorted.length > 62 ? `${sorted.length * 6}px` : undefined }}>
            <div className="insight-grid-lines" aria-hidden="true"><i /><i /><i /></div>
            <div className="insight-bars" data-insight-chart onMouseLeave={() => setHovered(null)}>
              {sorted.map((day, index) => {
                const value = insightValue(day, metric);
                const label = `${dayDescription(day, t, locale)} · ${metricLabel(metric, t)}: ${formatInsightValue(value, metric, locale)}`;
                return <button type="button" key={day.date} data-date={day.date}
                  className={`insight-bar${selectedDate === day.date ? " is-selected" : ""}`}
                  aria-label={label} title={label} aria-pressed={selectedDate === day.date}
                  tabIndex={day.date === (focused ?? sorted[0]?.date) ? 0 : -1}
                  onKeyDown={event => moveChartFocus(event, index, sorted.length)}
                  onFocus={() => setFocused(day.date)} onMouseEnter={() => setHovered(day.date)}
                  onClick={() => onSelect(day.date)}>
                  <span style={{ height: `${Math.max(value !== null && value > 0 ? 2 : 0, (value ?? 0) / maximum * 100)}%` }} />
                </button>;
              })}
            </div>
            <div className="insight-x-axis" aria-hidden="true">
              {axis.map(index => <span key={index}>{formatInsightDate(sorted[index].date, locale, true)}</span>)}
            </div>
          </div>
        </div>
      </div>
      <p className="insight-chart-caption">{detail ? dayDescription(detail, t, locale) : t("insights.chartHint")}</p>
    </>
  );
}

export function InsightCalendar({ days, selectedDate, onSelect }: { days: InsightDay[]; selectedDate: string | null; onSelect: (date: string) => void }) {
  const { t, locale } = useI18n();
  const [focused, setFocused] = useState<string | null>(null);
  const weeks = useMemo(() => activityWeeks(days), [days]);
  const actual = weeks.flat().filter((day): day is InsightDay => day !== null);
  const indexByDate = new Map(actual.map((day, index) => [day.date, index]));
  const maximum = Math.max(1, ...days.map(day => day.requests));
  const weekdays = ["usage.dayMon", "usage.dayWed", "usage.dayFri"] as const;
  return (
    <>
      <div className="insight-calendar-wrap">
        <div className="insight-weekdays" aria-hidden="true">{weekdays.map(key => <span key={key}>{t(key)}</span>)}</div>
        <div className="insight-calendar-scroll" tabIndex={0} role="group" aria-label={t("usage.section.heatmap")}>
          <div className="insight-calendar" data-insight-chart style={{ "--insight-weeks": weeks.length } as CSSProperties}>
            {weeks.map((week, weekIndex) => <div className="insight-week" key={weekIndex}>
              <span className="insight-month" aria-hidden="true">{week.find(day => day && (weekIndex === 0 || day.date.endsWith("-01")))
                ? new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(civilDate(week.find(day => day && (weekIndex === 0 || day.date.endsWith("-01")))!.date)) : ""}</span>
              {week.map((day, index) => {
                if (!day) return <span key={index} className="insight-day-placeholder" />;
                const level = day.requests === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(day.requests / maximum * 4)));
                const label = dayDescription(day, t, locale);
                return <button type="button" key={day.date} data-date={day.date} data-level={level}
                  className={`insight-day${selectedDate === day.date ? " is-selected" : ""}`}
                  title={label} aria-label={label} aria-pressed={selectedDate === day.date}
                  tabIndex={day.date === (focused ?? actual[0]?.date) ? 0 : -1}
                  onFocus={() => setFocused(day.date)} onKeyDown={event => moveChartFocus(event, indexByDate.get(day.date)!, actual.length, true)}
                  onClick={() => onSelect(day.date)} />;
              })}
            </div>)}
          </div>
        </div>
      </div>
      <div className="insight-calendar-footer">
        <span>{t("insights.calendarHint")}</span>
        <div className="insight-legend"><span>{t("usage.heatmap.less")}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} aria-hidden="true" />)}<span>{t("usage.heatmap.more")}</span></div>
      </div>
      <span className="sr-only">{t("usage.heatmap.keyboardLabel")}</span>
    </>
  );
}

export function InsightRanking({ title, rows, metric }: { title: string; rows: InsightRow[]; metric: InsightMetric }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => rankInsights(rows, metric), [rows, metric]);
  const visible = expanded ? sorted : sorted.slice(0, 6);
  const maximum = Math.max(0, ...sorted.map(row => insightValue(row, metric) ?? 0)) || 1;
  return <section className="insight-panel insight-ranking">
    <div className="insight-panel-head"><h3>{title}</h3><span>{t("insights.rankingMeta", { count: rows.length, metric: metricLabel(metric, t) })}</span></div>
    {!rows.length ? <p className="insight-panel-empty">{t("insights.noRows")}</p> : <ol className="insight-rank-list">
      {visible.map((row, index) => <li key={JSON.stringify([row.provider, row.model])}>
        <span className="insight-rank-position" aria-hidden="true">{index + 1}</span>
        <div className="insight-rank-name" title={row.model ? `${row.provider} / ${row.model}` : row.provider}>
          <span className={row.model ? "insight-model-name" : undefined}>{row.model ?? formatProviderDisplayName(row.provider, t)}</span>
          {row.model && <small>{formatProviderDisplayName(row.provider, t)}</small>}
        </div>
        <span className="insight-rank-track" aria-hidden="true"><i style={{ width: `${(insightValue(row, metric) ?? 0) / maximum * 100}%` }} /></span>
        <span className="insight-rank-value">{formatInsightValue(insightValue(row, metric), metric, locale)}
          <small>{metric === "cost" ? formatTokens(row.totalTokens, locale) : formatInsightValue(availableCost(row), "cost", locale)}</small>
        </span>
      </li>)}
    </ol>}
    {sorted.length > 6 && <button type="button" className="insight-text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? "insights.showLess" : "insights.showAll", { count: sorted.length })}</button>}
  </section>;
}
