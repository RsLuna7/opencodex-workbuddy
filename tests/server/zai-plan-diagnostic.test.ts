import { expect, test } from "bun:test";
import { observedZaiPlanDecrease, projectZaiPlanDiagnostic, recordZaiPlanObservation } from "../../src/server/management/zai-plan-diagnostic";
import { oauthAccountLogLabel } from "../../src/codex/account-label";
import type { RequestLogEntry } from "../../src/server/request-log";
import type { ProviderAccount } from "../../src/oauth/types";

const now = Date.now();
const account: ProviderAccount = { id: "test-account", addedAt: now - 1000, credential: { access: "fake.jwt.test", refresh: "fake.jwt.test", expires: now + 100_000 } };
const row = { requestId: "ocx-test", timestamp: now, provider: "zai-plan", model: "zai-plan/GLM-5.3-Flash", status: 200,
  durationMs: 10, accountLogLabel: oauthAccountLogLabel(account.id, "zai-plan"), attempts: [
    { provider: "zai-plan", adapter: "zai-plan", status: 200, sendCount: 1 },
  ] } as RequestLogEntry;

test("manual diagnostic identifies the served Start Plan account without exposing a credential", () => {
  const result = projectZaiPlanDiagnostic(row, [account], now);
  expect(result).toMatchObject({ verified: true, plan: "start-plan", model: "GLM-5.3-Flash", accountId: account.id, sends: 1 });
  expect(JSON.stringify(result)).not.toContain(account.credential.access);
});

test("stale, redirected, missing or ambiguous account evidence is not reported as verified", () => {
  expect(projectZaiPlanDiagnostic(row, [account], now + 301_000).verified).toBe(false);
  expect(projectZaiPlanDiagnostic({ ...row, provider: "another-provider" }, [account], now).verified).toBe(false);
  expect(projectZaiPlanDiagnostic(row, [], now).verified).toBe(false);
  expect(projectZaiPlanDiagnostic(row, [account, account], now).verified).toBe(false);
  expect(projectZaiPlanDiagnostic({ ...row, attempts: [] }, [account], now).verified).toBe(false);
});

test("balance attribution requires the same credential, device, model window and pre-request observation", () => {
  const before = { plan: "start-plan" as const, state: "available" as const, sampledAt: now, validUntil: now + 60_000,
    models: [{ model: "GLM-5.3-Flash", total: 100, used: 0, remaining: 100 }] };
  const after = { ...before, models: [{ ...before.models[0], used: 20, remaining: 80 }] };
  const id = recordZaiPlanObservation(account, before, now);
  expect(observedZaiPlanDecrease(id, account, after, before.models[0].model, now + 10, now + 20)).toBe(20);
  expect(observedZaiPlanDecrease(id, { ...account, credential: { ...account.credential, access: "new.jwt.test" } }, after, before.models[0].model, now + 10, now + 20)).toBeNull();
  expect(observedZaiPlanDecrease(id, { ...account, loginId: "new-login" }, after, before.models[0].model, now + 10, now + 20)).toBeNull();
  expect(observedZaiPlanDecrease(id, account, after, before.models[0].model, now - 1, now + 20)).toBeNull();
  expect(observedZaiPlanDecrease(id, account, after, before.models[0].model, now + 10, now + 61_000)).toBeNull();
  expect(observedZaiPlanDecrease(id, account, { ...after, models: [{ ...after.models[0], total: 200 }] }, before.models[0].model, now + 10, now + 20)).toBeNull();
});
