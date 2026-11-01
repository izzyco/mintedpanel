// The calendar day a coordinator's activity is filed under (MINT-75), and the
// "today" the panel judges that activity against.
//
// Its callers, by branch. MINT-75 part 1 (#547): task completions
// (updateTaskStatus: the task row's Complete circle, the drawer's Mark
// complete, a Payer PDF marked sent), notes (logNote), the Add touch form's
// default date, and the touchlog's "today" (follow-up status, the CSV's name).
// MINT-75 part 2 (#557): ticking a task's last SOP step (completeTaskStep).
// Until both land, a branch carries only its own callers.
//
// Business policy is configuration. The zone whose day counts is Sowmya's
// decision of Oct 30, 2026: the viewer's own (the browser's time zone), with
// no backfill of rows already stored under the UTC day. A platform override,
// then an organization override, may name one time zone instead, so every
// coordinator's activity is filed under that zone's day
// (resolveActivityDateRules). Nothing stores an override yet, so every caller
// resolves to the default (activityDateRules); the setting is Mission Control
// MINT-129. A zone the browser does not know files under the viewer's day.
//
// Not configurable: a change applies from the day it is made and never
// re-dates a stored row; the moment an activity happened (audit timestamps, a
// step's completedAt) is always the instant itself; and the database keeps its
// own guard, using a client date only within one day of its UTC date, which
// the day in every real time zone satisfies.
//
// This file and its test are byte-identical on both MINT-75 branches so they
// merge cleanly.
import { format } from "date-fns";

export interface ActivityDateRules {
  /** Whose calendar day an activity is filed under. "viewer" (default): the
   * browser's own time zone, the day on the coordinator's clock. A time zone
   * name such as "America/Denver": that zone's day, whatever zone the viewer
   * is in. */
  zone: "viewer" | string;
}

/** The platform default: the PM's decision of Oct 30, 2026. */
export const DEFAULT_ACTIVITY_DATE_RULES: Readonly<ActivityDateRules> = Object.freeze({
  zone: "viewer",
});

/** A platform or organization override. A null or missing field inherits. */
export type ActivityDateRulesOverride = {
  readonly zone?: string | null;
};

/** The organization's zone, else the platform's, else the default. */
export function resolveActivityDateRules(
  platform?: ActivityDateRulesOverride | null,
  organization?: ActivityDateRulesOverride | null,
): ActivityDateRules {
  return { zone: organization?.zone ?? platform?.zone ?? DEFAULT_ACTIVITY_DATE_RULES.zone };
}

/** Today's calendar date (`yyyy-MM-dd`) at `now`, in the rules' zone: the day
 * a panel write files an activity under. A zone the browser does not know
 * falls back to the viewer's day. */
export function todayForActivity(
  now: Date = new Date(),
  rules: ActivityDateRules = DEFAULT_ACTIVITY_DATE_RULES,
): string {
  if (rules.zone !== "viewer") {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: rules.zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((entry) => entry.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      // Not a time zone this browser knows: the viewer's day.
    }
  }
  return format(now, "yyyy-MM-dd");
}

const RESOLVED_RULES: ActivityDateRules = Object.freeze(resolveActivityDateRules());

/** The rules in force for an activity write. No platform or organization
 * override is stored yet, so this is the default; the Mission Control setting
 * (MINT-129) reads its overrides here and passes them to
 * resolveActivityDateRules. */
export function activityDateRules(): ActivityDateRules {
  return RESOLVED_RULES;
}
