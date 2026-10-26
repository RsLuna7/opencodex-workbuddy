/**
 * WorkBuddy pool cooldown projection — pure helpers behind the dashboard panel.
 *
 * Kept out of the component file so the panel module exports components only (fast refresh),
 * and so the row-building rules are testable without a DOM.
 */
import type { WorkbuddyAccountPoolView, WorkbuddyModelCooldownView } from "../../../../src/providers/quota-types";
import type { TKey, TFn } from "../../i18n/shared";

export interface WorkbuddyCooldownAccount {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  paused?: boolean;
  workbuddyPool?: WorkbuddyAccountPoolView;
}

export interface WorkbuddyCooldownRow {
  accountId: string;
  label: string;
  active: boolean;
  paused: boolean;
  needsReauth: boolean;
  realm?: "cn" | "global";
  credits?: number;
  creditsExpiring?: number;
  /** Empty when the row reports the account-wide breaker or an idle account. */
  model: string;
  cooldown?: WorkbuddyModelCooldownView;
  breakerUntil?: number;
  /** Recovery boundary for this row; 0 when nothing is cooling. */
  until: number;
  cooling: boolean;
}

export function formatCooldownDuration(ms: number, t: TFn): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return t("pws.workbuddyPool.durationDays", { d: days, h: hours });
  if (hours > 0) return t("pws.workbuddyPool.durationHours", { h: hours, m: minutes });
  if (minutes > 0) return t("pws.workbuddyPool.durationMinutes", { m: minutes, s: seconds });
  return t("pws.workbuddyPool.durationSeconds", { s: seconds });
}

/** Closed set of upstream cooldown reasons; unknown text never reaches the UI. */
export function workbuddyCooldownReasonKey(reason: string | undefined): TKey {
  if (reason === "quota") return "pws.workbuddyPool.reason.quota";
  if (reason === "rate" || reason === "rate_limit" || reason === "rate_limited") {
    return "pws.workbuddyPool.reason.rate";
  }
  return "pws.workbuddyPool.reason.other";
}

/**
 * Flatten the pool projection into rows the operator can scan: one per cooling model, plus a
 * row for every account that is not cooling.
 *
 * Cooling rows come first, soonest recovery ahead, because that is what an operator is waiting
 * on. An account whose only pressure is the account-wide breaker still gets a cooling row —
 * that breaker gates every model, so reporting the earlier model timestamp would invite a
 * retry that cannot succeed. Idle accounts are kept rather than hidden: the credit balance is
 * half of what this panel is for, and dropping the row would drop the ledger with it.
 */
export function buildWorkbuddyCooldownRows(
  accounts: readonly WorkbuddyCooldownAccount[],
  now: number,
): WorkbuddyCooldownRow[] {
  const cooling: WorkbuddyCooldownRow[] = [];
  const idle: WorkbuddyCooldownRow[] = [];
  for (const account of accounts) {
    const pool = account.workbuddyPool;
    const breakerUntil = pool?.breakerUntil !== undefined && pool.breakerUntil > now ? pool.breakerUntil : undefined;
    const base = {
      accountId: account.id,
      label: account.alias?.trim() || account.email?.trim() || account.id,
      active: account.active === true,
      paused: account.paused === true,
      needsReauth: account.needsReauth === true,
      ...(pool?.realm ? { realm: pool.realm } : {}),
      ...(typeof pool?.credits === "number" ? { credits: pool.credits } : {}),
      ...(breakerUntil !== undefined ? { breakerUntil } : {}),
      ...(typeof pool?.creditsExpiring === "number" && pool.creditsExpiring > 0
        ? { creditsExpiring: pool.creditsExpiring }
        : {}),
    };
    const cooldowns = Object.entries(pool?.modelCooldowns ?? {})
      .filter(([, cooldown]) => typeof cooldown?.until === "number" && cooldown.until > now)
      .sort((a, b) => a[1].until - b[1].until || a[0].localeCompare(b[0]));
    if (cooldowns.length === 0) {
      idle.push({
        ...base,
        model: "",
        until: breakerUntil ?? 0,
        cooling: breakerUntil !== undefined,
      });
      continue;
    }
    for (const [model, cooldown] of cooldowns) {
      cooling.push({
        ...base,
        model,
        cooldown,
        until: Math.max(cooldown.until, breakerUntil ?? 0),
        cooling: true,
      });
    }
  }
  cooling.sort((a, b) => a.until - b.until || a.label.localeCompare(b.label));
  idle.sort((a, b) => a.label.localeCompare(b.label));
  return [...cooling, ...idle];
}
