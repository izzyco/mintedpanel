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
// then an organization override, may name one IANA time zone instead, so every
// coordinator's activity is filed under that zone's day
// (resolveActivityDateRules). Nothing stores an override yet, so every caller
// resolves to the default (activityDateRules); the setting is Mission Control
// MINT-129.
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

// Only a place's zone ("America/Denver", "Pacific/Auckland") or UTC. That
// rules out every zone that ignores daylight saving or is not in tzdata: fixed
// offsets ("+05:00", "Etc/GMT+7"), legacy abbreviations ("EST", "MST", "HST",
// "GMT", "Zulu", "CET", "PST8PDT"), backward links outside the place areas
// ("US/Mountain"), and ICU-only names ("AET", "SystemV/AST4").
const ZONE_AREAS: ReadonlySet<string> = new Set([
  "africa",
  "america",
  "antarctica",
  "arctic",
  "asia",
  "atlantic",
  "australia",
  "europe",
  "indian",
  "pacific",
]);
const UTC_NAMES: ReadonlySet<string> = new Set(["utc", "etc/utc"]);
const PLACE_ZONE_RE = /^([A-Za-z]+)(?:\/[A-Za-z0-9_+-]+)+$/;

function hasZoneShape(value: string): boolean {
  if (UTC_NAMES.has(value.toLowerCase())) return true;
  const area = PLACE_ZONE_RE.exec(value)?.[1];
  return area !== undefined && ZONE_AREAS.has(area.toLowerCase());
}

/** The runtime's canonical name for an IANA time zone ("america/denver" is
 * "America/Denver", "Etc/UTC" is "UTC"), or null when the value is not a
 * place's zone or UTC, or the runtime does not know it. */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !hasZoneShape(value)) return null;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return hasZoneShape(canonical) ? canonical : null;
}

/** An IANA time zone this module accepts (see canonicalTimeZone). */
export function isIanaTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}

/** "viewer" stays "viewer"; a zone comes back canonical; anything else is null. */
function activityDateZoneOf(value: unknown): ActivityDateZone | null {
  return value === VIEWER_ZONE ? VIEWER_ZONE : canonicalTimeZone(value);
}

/** The organization's zone, else the platform's, else the default, with a
 * zone in its canonical spelling. A value of the wrong shape (an unknown zone,
 * an offset, an abbreviation, a number) is skipped like a missing one. */
export function resolveActivityDateRules(
  platform?: ActivityDateRulesOverride | null,
  organization?: ActivityDateRulesOverride | null,
): ActivityDateRules {
  for (const override of [organization, platform]) {
    const zone = override?.zone == null ? null : activityDateZoneOf(override.zone);
    if (zone !== null) return { zone };
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
    } else if (value != null && activityDateZoneOf(value) === null) {
      errors.push(
        `"${String(value)}" is not a time zone this setting takes. Use "viewer" (each person's own time zone), "UTC", or a place's time zone such as "America/Denver"; offsets and abbreviations such as "EST" ignore daylight saving.`,
      );
    }
  }
  return errors;
}

let warnedUnknownZone = false;

/** Today's calendar date (`yyyy-MM-dd`) at `now`, in the rules' zone: the day
 * a panel write files an activity under. A zone this module does not accept
 * falls back to the viewer's day, with one console warning per page load. */
export function todayForActivity(
  now: Date = new Date(),
  rules: ActivityDateRules = DEFAULT_ACTIVITY_DATE_RULES,
): string {
  if (rules.zone !== VIEWER_ZONE) {
    const zone = canonicalTimeZone(rules.zone);
    if (zone !== null) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((entry) => entry.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    }
    if (!warnedUnknownZone) {
      warnedUnknownZone = true;
      console.warn(
        "[activityDate] The activity time zone setting is not a time zone this browser accepts; activity is filed under the viewer's own day.",
      );
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
