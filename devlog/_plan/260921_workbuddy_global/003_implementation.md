# Implementation plan (frozen 2026-09-21)

Source of truth: checked rows in `001_decision_list.md` plus §7 answers.

## In

- A1 A2 A4. A3 sidecar out.
- P1–P11, R1–R6, R8 (CN IDE / Global WorkBuddy AI desktop).
- Q1–Q9, Q12 (with Q3). Q10 Q11 out.
- G1 G3 G4 G5 G6 G7 G8 G9 G10. G2 G11 G12 G13 out.
- Picker stays `workbuddy/<model>`. Realm is the **active account**. Failover stays in-realm.
- Global login platform: `workbuddy-ai`, then `CLI`. CN stays `ide`.

## Module split

Do not grow `codebuddy.ts` / `generic-account-failover.ts` / `request-transport.ts`. New leaves:

| File | Owns |
|---|---|
| `src/oauth/codebuddy-realm.ts` | cn/global, domain suffix, `global.enabled` |
| `src/oauth/codebuddy-hosts.ts` | origins, chat/billing/auth URLs, login platforms |
| `src/oauth/codebuddy-headers.ts` | CN IDE vs Global desktop chat/billing/refresh headers |
| `src/oauth/codebuddy-payload.ts` | 11128 leading system, fingerprint rewrite |
| `src/oauth/workbuddy-pool.ts` | pick/sticky/breaker/inflight/persist (Q1–Q9) |
| `src/oauth/workbuddy-growth.ts` | trial + CN growth + 21:00 checkin (optional hook) |

MIT: algorithms from Sliverkiss/workbuddy2api; 6004 English clock from wnddd839/buddy-proxy. Record in CREDITS.

## Construction order

1. Realm + hosts + headers + payload + English 6004. Tests first.
2. Login/refresh/CLI/API `--realm`. Adapter dual canonical URL.
3. Same-realm filter on generic rotation (Q1) without weighted logic in that file.
4. Dedicated pool + persist file `~/.opencodex/workbuddy-pool.json`.
5. Growth scheduler as optional hook (must not import from router/lifecycle/responses/core).

## Catalog

No `workbuddy/global:hy3` row. Live discovery uses the **active account** host.
