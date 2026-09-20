/** `ocx account checkin workbuddy` — claim CN daily credits without talking to the proxy. */
import {
  CODEBUDDY_PROVIDER_ID,
} from "../oauth/codebuddy";
import {
  runWorkbuddyCheckin,
  workbuddyCheckinExitCode,
  type WorkbuddyCheckinDeps,
} from "../oauth/codebuddy-checkin";

export const ACCOUNT_CHECKIN_USAGE = `Usage:
  ocx account checkin workbuddy [--status] [--json]

Claim WorkBuddy / CodeBuddy CN daily check-in for every stored account.
Runs locally against auth.json; the proxy does not need to be up.
Already-claimed days are skipped. Global (workbuddy.ai) accounts are skipped.`;

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

export async function cmdCheckin(
  rest: string[],
  deps: WorkbuddyCheckinDeps = {},
): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const statusOnly = consumeFlag(rest, "--status");
  const provider = rest.shift() ?? CODEBUDDY_PROVIDER_ID;
  const unknown = rest.filter(a => a.startsWith("-"));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    console.error(ACCOUNT_CHECKIN_USAGE);
    return 1;
  }
  if (rest.length > 0) {
    console.error(`Unexpected argument(s): ${rest.join(", ")}`);
    console.error(ACCOUNT_CHECKIN_USAGE);
    return 1;
  }
  if (provider !== CODEBUDDY_PROVIDER_ID) {
    const message = `checkin is only implemented for ${CODEBUDDY_PROVIDER_ID}, not ${provider}`;
    if (wantsJson) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(`Error: ${message}`);
      console.error(ACCOUNT_CHECKIN_USAGE);
    }
    return 2;
  }

  const run = await runWorkbuddyCheckin({ ...deps, statusOnly, provider });
  if (wantsJson) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    for (const row of run.results) {
      const extra = row.credit !== undefined
        ? ` +${row.credit}`
        : row.streak_days !== undefined
          ? ` streak=${row.streak_days}`
          : "";
      const msg = row.msg ? ` (${row.msg})` : "";
      console.log(`${row.label}: ${row.result}${extra}${msg}`);
    }
  }
  return workbuddyCheckinExitCode(run);
}
