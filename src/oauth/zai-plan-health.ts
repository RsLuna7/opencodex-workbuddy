import type { OAuthCredentials } from "./types";
import { credentialGeneration, getAccountCredentialWithStatus, markAccountNeedsReauthIfGeneration } from "./store";
import { applyGenericFailoverCooldown, genericFailoverRetryAfterSeconds } from "./generic-account-failover";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { parseRetryAfterMs } from "../combos/failover";

export interface ZaiPlanRequestAccount {
  id: string;
  credential: OAuthCredentials;
  model: string;
  writerGeneration: number;
}
type Dependencies = {
  account: (id: string) => { credential: OAuthCredentials; paused?: boolean; needsReauth?: boolean } | null;
  cool: (id: string, ms: number, auth: boolean) => void;
  remaining: (id: string, now: number) => number | null;
  reauthenticate: (account: ZaiPlanRequestAccount) => Promise<void>;
  now?: () => number;
};
function refusal(status: number, type: string, message: string, retryAfter?: number): Response {
  return Response.json({ error: { type, message } }, { status, headers: retryAfter ? { "retry-after": String(retryAfter) } : {} });
}

/** Model exhaustion stays model-scoped; account risk/rate/auth cooling uses the shared pool. */
export function createZaiPlanHealth(deps: Dependencies) {
  const models = new Map<string, number>();
  const serverFailures = new Map<string, { count: number; at: number }>();
  const now = deps.now ?? Date.now;
  const identity = (account: ZaiPlanRequestAccount) => `${account.id}\u0000${credentialGeneration(account.credential)}`;
  const current = (account: ZaiPlanRequestAccount) => {
    const row = deps.account(account.id);
    return !!row && !row.paused && !row.needsReauth && credentialGeneration(row.credential) === credentialGeneration(account.credential)
      && row.credential.zaiPlan?.deviceMid === account.credential.zaiPlan?.deviceMid;
  };
  const trim = () => {
    if (models.size > 256) models.delete(models.keys().next().value!);
    if (serverFailures.size > 128) serverFailures.delete(serverFailures.keys().next().value!);
  };
  return {
    before(account: ZaiPlanRequestAccount): Response | null {
      if (!current(account)) return refusal(401, "authentication_error", "ZCode account changed or is unavailable. Retry after checking the selected account.");
      const seconds = deps.remaining(account.id, now());
      if (seconds) return refusal(429, "rate_limit_error", "ZCode Start Plan account is cooling down. Wait before retrying.", seconds);
      const key = `${identity(account)}\u0000${account.model.toLowerCase()}`;
      const until = models.get(key);
      if (until && until > now()) return refusal(402, "insufficient_quota", "ZCode Start Plan model quota is exhausted.", Math.ceil((until - now()) / 1000));
      models.delete(key);
      return null;
    },
    async observe(account: ZaiPlanRequestAccount, response: Response, signal?: AbortSignal): Promise<void> {
      if (response.ok) { serverFailures.delete(identity(account)); return; }
      if (!current(account)) return;
      let code: unknown;
      if ([400, 403, 405].includes(response.status)) {
        try {
          const read = await readBoundedResponseBody(response.clone(), { signal, maxBytes: 65_536, totalTimeoutMs: 5_000 });
          if (read.displaySafe) code = (JSON.parse(read.text) as { code?: unknown }).code;
        } catch { signal?.throwIfAborted(); }
      }
      if (!current(account) || code === 3007) return;
      if (code === 3012 || response.status === 405) deps.cool(account.id, 15 * 60_000, false);
      else if ([401, 403].includes(response.status)) {
        deps.cool(account.id, 60_000, true);
        await deps.reauthenticate(account);
      } else if (response.status === 429) {
        deps.cool(account.id, Math.min(60 * 60_000, Math.max(1000, parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000)), false);
      } else if (response.status === 402) {
        models.set(`${identity(account)}\u0000${account.model.toLowerCase()}`, now() + 60_000);
      } else if (response.status >= 500) {
        const key = identity(account), previous = serverFailures.get(key);
        const count = previous && now() - previous.at < 60_000 ? previous.count + 1 : 1;
        serverFailures.set(key, { count, at: now() });
        if (count >= 3) deps.cool(account.id, 60_000, false);
      }
      trim();
    },
  };
}

export const zaiPlanHealth = createZaiPlanHealth({
  account: id => getAccountCredentialWithStatus("zai-plan", id),
  cool: (id, ms, auth) => applyGenericFailoverCooldown({ providerName: "zai-plan", accountId: id, cooldownMs: ms, source: auth ? "auth" : "default" }),
  remaining: (id, now) => genericFailoverRetryAfterSeconds("zai-plan", now, id),
  reauthenticate: async account => { await markAccountNeedsReauthIfGeneration("zai-plan", account.id,
    credentialGeneration(account.credential), account.writerGeneration); },
});
