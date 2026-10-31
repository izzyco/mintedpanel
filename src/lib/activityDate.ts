// The calendar day a coordinator's activity is filed under (MINT-75): a task
// completion's completed_date and a note's touch_date, whichever way the panel
// records it (the task row's Complete circle, the drawer's Mark complete, a
// Payer PDF marked sent, ticking a task's last SOP step, Add note).
//
// Business policy is configuration. The zone whose day counts is Sowmya's
// decision of Oct 30, 2026: the viewer's own (the browser's time zone), with
// no backfill of rows already stored under the UTC day. A platform override,
// then an organization override, may name one IANA time zone instead, so every
// coordinator's activity is filed under that zone's day
// (resolveActivityDateRules). Nothing stores an override yet, so every writer
// resolves to the default (activityDateRules); the setting is Mission Control
// MINT-129.
//
// Not configurable: a change applies from the day it is made and never
// re-dates a stored row; the moment an activity happened (audit timestamps, a
// step's completedAt) is always the instant itself; and the database keeps its
// own guard, using a client date only within one day of its UTC date, which
// the day in every real time zone satisfies.
//
// This file is byte-identical on both MINT-75 branches (#547, #557) so they
// merge cleanly; each branch wires only its own writers.
import { format } from "date-fns";

/** The default zone: the browser's own time zone. */
export const VIEWER_ZONE = "viewer";

/** "viewer", or an IANA time zone name such as "America/Denver". */
export type ActivityDateZone = typeof VIEWER_ZONE | (string & {});

export interface ActivityDateRules {
  /** Whose calendar day an activity is filed under. "viewer" (default): the
   * browser's own time zone, the day on the coordinator's clock. An IANA time
   * zone name: that zone's day, whatever zone the viewer is in. */
  zone: ActivityDateZone;
}

/** The platform default: the PM's decision of Oct 30, 2026. */
export const DEFAULT_ACTIVITY_DATE_RULES: Readonly<ActivityDateRules> = Object.freeze({
  zone: VIEWER_ZONE,
});

/** A platform or organization override. A null or missing field inherits. */
export type ActivityDateRulesOverride = {
  readonly zone?: ActivityDateZone | null;
};

// Area/Location names ("America/Denver", "Etc/GMT+7") and bare names ("UTC").
// A fixed offset such as "+05:00" is not one: it ignores daylight saving.
const ZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** An IANA time zone name this runtime knows. */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !ZONE_NAME_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isActivityDateZone(value: unknown): value is ActivityDateZone {
  return value === VIEWER_ZONE || isIanaTimeZone(value);
}

/** The organization's zone, else the platform's, else the default. A value of
 * the wrong shape (an unknown zone, an offset, a number) is skipped like a
 * missing one. */
export function resolveActivityDateRules(
  platform?: ActivityDateRulesOverride | null,
  organization?: ActivityDateRulesOverride | null,
): ActivityDateRules {
  for (const override of [organization, platform]) {
    const zone: unknown = override?.zone;
    if (zone != null && isActivityDateZone(zone)) return { zone };
  }
  return { zone: DEFAULT_ACTIVITY_DATE_RULES.zone };
}

/** Plain-language problems with an override; empty when it can go live. A
 * null or missing field inherits and is fine. */
export function validateActivityDateRules(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return ["Activity date rules must be a set of named settings."];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key !== "zone") {
      errors.push(`"${key}" is not an activity date setting.`);
    } else if (value != null && !isActivityDateZone(value)) {
      errors.push(
        `"${String(value)}" is not a time zone. Use "viewer" (each person's own time zone) or a time zone name such as "America/Denver".`,
      );
    }
  }
  return errors;
}

/** Today's calendar date (`yyyy-MM-dd`) at `now`, in the rules' zone: the day
 * a panel write files an activity under. A zone this runtime does not know
 * falls back to the viewer's day. */
export function todayForActivity(
  now: Date = new Date(),
  rules: ActivityDateRules = DEFAULT_ACTIVITY_DATE_RULES,
): string {
  if (rules.zone === VIEWER_ZONE || !isIanaTimeZone(rules.zone)) {
    return format(now, "yyyy-MM-dd");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: rules.zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const RESOLVED_RULES: ActivityDateRules = Object.freeze(resolveActivityDateRules());

/** The rules in force for an activity write. No platform or organization
 * override is stored yet, so this is the default; the Mission Control setting
 * (MINT-129) reads its overrides here and passes them to
 * resolveActivityDateRules. */
export function activityDateRules(): ActivityDateRules {
  return RESOLVED_RULES;
}
