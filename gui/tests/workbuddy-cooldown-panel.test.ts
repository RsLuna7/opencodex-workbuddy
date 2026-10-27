/**
 * WorkBuddy pool cooldown panel — the projection the dashboard renders.
 *
 * The pool file is a wall-clock record written by the routing path; this panel only reads it.
 * These cases pin the two judgments that go wrong silently: which accounts deserve a row at
 * all, and whether the countdown counts the model cooldown or the account-wide breaker when
 * both apply (the later of the two, because the earlier one does not release the account).
 */
import { expect, test } from "bun:test";
import {
  buildWorkbuddyCooldownRows,
  formatCooldownDuration,
  workbuddyCooldownReasonKey,
} from "../src/components/provider-workspace/workbuddy-cooldown-model";

const NOW = 1_792_940_000_000;

test("a cooling model produces one row carrying credits and the model cooldown", () => {
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-a",
    alias: "4ever",
    active: true,
    workbuddyPool: {
      realm: "cn",
      credits: 2600,
      creditsExpiring: 400,
      modelCooldowns: { "deepseek-v4.1-flash": { until: NOW + 3_600_000, reason: "quota" } },
    },
  }], NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    accountId: "acct-a",
    label: "4ever",
    model: "deepseek-v4.1-flash",
    credits: 2600,
    creditsExpiring: 400,
    realm: "cn",
    until: NOW + 3_600_000,
  });
});

test("an expired cooldown is reported as a ready row, not dropped", () => {
  // Hiding it would answer "what is blocked" while discarding the credit balance beside it.
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-a",
    active: false,
    workbuddyPool: {
      credits: 2600,
      modelCooldowns: { "deepseek-v4.1-flash": { until: NOW - 1, reason: "quota" } },
    },
  }], NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ accountId: "acct-a", model: "", cooling: false, credits: 2600, until: 0 });
});

test("an idle account stays listed with its credits", () => {
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-b",
    active: false,
    workbuddyPool: { credits: 100, modelCooldowns: {} },
  }], NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cooling: false, credits: 100 });
});

test("the account-wide breaker wins when it outlasts the model cooldown", () => {
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-c",
    active: false,
    workbuddyPool: {
      modelCooldowns: { "deepseek-v4.1-flash": { until: NOW + 60_000, reason: "quota" } },
      breakerUntil: NOW + 1_800_000,
    },
  }], NOW);
  // The model row still names its model, but the account does not free up until the breaker
  // expires — reporting the earlier timestamp would tell an operator to retry too soon.
  expect(rows[0]).toMatchObject({
    model: "deepseek-v4.1-flash",
    until: NOW + 1_800_000,
    breakerUntil: NOW + 1_800_000,
    cooling: true,
  });
});

test("a breaker alone still gets a cooling row, with no model named", () => {
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-d",
    active: false,
    workbuddyPool: { breakerUntil: NOW + 900_000 },
  }], NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model: "", until: NOW + 900_000, cooling: true });
});

test("cooling rows sort first by recovery, ready rows follow alphabetically", () => {
  const rows = buildWorkbuddyCooldownRows([
    { id: "idle-b", alias: "beta", active: false, workbuddyPool: { modelCooldowns: {} } },
    { id: "slow", alias: "zeta", active: false, workbuddyPool: { modelCooldowns: { m: { until: NOW + 9_000_000 } } } },
    { id: "idle-a", alias: "alpha", active: false, workbuddyPool: { modelCooldowns: {} } },
    { id: "fast", alias: "gamma", active: false, workbuddyPool: { modelCooldowns: { m: { until: NOW + 60_000 } } } },
  ], NOW);
  expect(rows.map(row => row.label)).toEqual(["gamma", "zeta", "alpha", "beta"]);
  expect(rows.map(row => row.cooling)).toEqual([true, true, false, false]);
});

test("an account with only a masked email keeps that email as its label", () => {
  // The pool keeps the server's already-masked label; the panel must not unmask or re-derive it.
  const masked = "a***9@example.test";
  const rows = buildWorkbuddyCooldownRows([{
    id: "acct-e",
    email: masked,
    active: false,
    workbuddyPool: { modelCooldowns: { m: { until: NOW + 1_000 } } },
  }], NOW);
  expect(rows[0]?.label).toBe(masked);
});

test("durations degrade to the largest meaningful unit", () => {
  const t = (key: string) => key;
  expect(formatCooldownDuration(43_000, t)).toBe("pws.workbuddyPool.durationSeconds");
  expect(formatCooldownDuration(43 * 60_000, t)).toBe("pws.workbuddyPool.durationMinutes");
  expect(formatCooldownDuration(10 * 3_600_000, t)).toBe("pws.workbuddyPool.durationHours");
  expect(formatCooldownDuration(14 * 24 * 3_600_000, t)).toBe("pws.workbuddyPool.durationDays");
});

test("unknown upstream reason text never reaches the UI verbatim", () => {
  expect(workbuddyCooldownReasonKey("quota")).toBe("pws.workbuddyPool.reason.quota");
  expect(workbuddyCooldownReasonKey("rate_limited")).toBe("pws.workbuddyPool.reason.rate");
  expect(workbuddyCooldownReasonKey("something-new")).toBe("pws.workbuddyPool.reason.other");
  expect(workbuddyCooldownReasonKey(undefined)).toBe("pws.workbuddyPool.reason.other");
});
