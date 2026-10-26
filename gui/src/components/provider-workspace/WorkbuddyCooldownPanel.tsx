/**
 * WorkbuddyCooldownPanel — per-account model cooldowns and credits for the WorkBuddy pool.
 *
 * The pool state is server-owned (`~/.opencodex/workbuddy-pool.json`), so this panel is a
 * projection, not a scheduler: it never writes a cooldown. Two clocks are involved and they
 * are deliberately different. The countdown ticks locally every second, because the cooldown
 * boundary is the thing an operator is waiting on; the credits figure changes only when an
 * explicit quota read re-probes upstream, because re-probing on a timer would spend the very
 * quota being reported. Each cooling row shows its own recovery timestamp so the two claims
 * stay separable instead of presenting a cached credit count as a live one.
 *
 * Accounts are listed whether or not they are cooling. Hiding the available ones would answer
 * "what is blocked" while dropping the credit balance the same operator came to read.
 */
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import { oauthAccountDisplayLabel } from "../../provider-workspace/auth";
import {
  buildWorkbuddyCooldownRows,
  formatCooldownDuration,
  workbuddyCooldownReasonKey,
  type WorkbuddyCooldownAccount,
} from "./workbuddy-cooldown-model";

/** Whole-second clock; a cooldown boundary is not meaningfully finer than this. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatWallClock(value: number, locale: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export default function WorkbuddyCooldownPanel({
  accounts,
  locale,
}: {
  accounts: readonly WorkbuddyCooldownAccount[];
  locale: string;
}) {
  const t = useT();
  const now = useNow();
  const rows = useMemo(() => buildWorkbuddyCooldownRows(accounts, now), [accounts, now]);
  // One label map so the masked-label rules match every other account surface.
  const labels = useMemo(
    () => new Map(accounts.map(account => [account.id, oauthAccountDisplayLabel(accounts, account, t)])),
    [accounts, t],
  );

  if (accounts.length === 0) {
    return (
      <section className="pws-section" aria-labelledby="workbuddy-pool-title">
        <h3 className="pws-section-title" id="workbuddy-pool-title">{t("pws.workbuddyPool.title")}</h3>
        <p className="muted">{t("pws.workbuddyPool.empty")}</p>
      </section>
    );
  }

  return (
    <section className="pws-section wb-pool" aria-labelledby="workbuddy-pool-title">
      <div className="wb-pool-head">
        <h3 className="pws-section-title" id="workbuddy-pool-title">{t("pws.workbuddyPool.title")}</h3>
        <p className="muted wb-pool-subtitle">{t("pws.workbuddyPool.subtitle")}</p>
      </div>
      <div className="tbl-wrap">
        <table className="tbl wb-pool-table" aria-label={t("pws.workbuddyPool.title")}>
          <thead>
            <tr>
              <th scope="col">{t("pws.workbuddyPool.colAccount")}</th>
              <th scope="col">{t("pws.workbuddyPool.colModel")}</th>
              <th scope="col">{t("pws.workbuddyPool.colCredits")}</th>
              <th scope="col">{t("pws.workbuddyPool.colCooldown")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const remaining = row.cooling ? row.until - now : 0;
              const recoveredAt = formatWallClock(row.until, locale);
              return (
                <tr
                  key={`${row.accountId}:${row.model || (row.cooling ? "breaker" : "idle")}`}
                  data-wb-pool-row={row.model || (row.cooling ? "breaker" : "idle")}
                  data-wb-pool-state={row.cooling ? "cooling" : "ready"}
                >
                  <td>
                    <span className="wb-pool-account">{labels.get(row.accountId) ?? row.label}</span>
                    <span className="wb-pool-meta">
                      {row.realm === "global"
                        ? t("pws.workbuddyPool.realmGlobal")
                        : t("pws.workbuddyPool.realmCn")}
                      {row.active && <> · {t("prov.accountActive")}</>}
                      {row.paused && <> · {t("codexAuth.paused")}</>}
                      {row.needsReauth && <> · {t("pws.reauth")}</>}
                    </span>
                  </td>
                  <td className="mono">
                    {row.model || (
                      <span className="muted">
                        {row.cooling
                          ? t("pws.workbuddyPool.breaker", { when: recoveredAt ?? "—" })
                          : t("pws.workbuddyPool.allModels")}
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    {typeof row.credits === "number" ? (
                      <>
                        <span className="wb-pool-credits">{row.credits}</span>
                        {row.creditsExpiring !== undefined && (
                          <span className="wb-pool-meta">
                            {t("pws.workbuddyPool.creditsExpiring", { count: row.creditsExpiring })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">{t("pws.workbuddyPool.creditsUnknown")}</span>
                    )}
                  </td>
                  <td>
                    {row.cooling ? (
                      <>
                        <span className="wb-pool-countdown" data-wb-pool-remaining={remaining}>
                          {t("pws.workbuddyPool.remaining", { duration: formatCooldownDuration(remaining, t) })}
                        </span>
                        <span className="wb-pool-meta">
                          {row.cooldown?.reason ? `${t(workbuddyCooldownReasonKey(row.cooldown.reason))} · ` : ""}
                          {recoveredAt ? t("pws.workbuddyPool.until", { when: recoveredAt }) : "—"}
                        </span>
                      </>
                    ) : (
                      <span className="badge badge-green wb-pool-ready">{t("pws.workbuddyPool.ready")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted wb-pool-hint">{t("pws.workbuddyPool.autoRefreshHint")}</p>
    </section>
  );
}
