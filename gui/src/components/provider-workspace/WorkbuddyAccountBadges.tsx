/**
 * Square completion badges on a WorkBuddy account row (check-in / daily task).
 * Green = done today; muted = probed and still open. Missing flags stay hidden.
 */
import { useT } from "../../i18n/shared";
import type { WorkbuddyAccountActivity } from "../../../../src/providers/quota-types";

function SquareBadge({ done, doneKey, openKey, doneValue, openValue }: {
  done: boolean;
  doneKey: "checked-in" | "daily-task";
  openKey: "not-checked-in" | "daily-task-open";
  doneValue: string;
  openValue: string;
}) {
  return (
    <span
      className={`badge pwi-auth-task-badge ${done ? "badge-green" : "badge-muted"}`}
      data-workbuddy-badge={done ? doneKey : openKey}
    >
      {done ? doneValue : openValue}
    </span>
  );
}

export default function WorkbuddyAccountBadges({ activity }: { activity?: WorkbuddyAccountActivity }) {
  const t = useT();
  if (activity?.checkedIn === undefined && activity?.dailyTask === undefined) return null;
  return (
    <span className="pwi-auth-task-badges">
      {activity.checkedIn !== undefined && (
        <SquareBadge
          done={activity.checkedIn}
          doneKey="checked-in"
          openKey="not-checked-in"
          doneValue={t("pws.workbuddy.checkedIn")}
          openValue={t("pws.workbuddy.notCheckedIn")}
        />
      )}
      {activity.dailyTask !== undefined && (
        <SquareBadge
          done={activity.dailyTask}
          doneKey="daily-task"
          openKey="daily-task-open"
          doneValue={t("pws.workbuddy.dailyTask")}
          openValue={t("pws.workbuddy.dailyTaskOpen")}
        />
      )}
    </span>
  );
}
