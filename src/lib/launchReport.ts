// E6.6 F6.6.2 — the Launches report derivation. DATE-ONLY by design: the
// location status machine is gone (E6.2 made go-live a plain
// `facilities.effective_date`), so this report reads facility dates +
// provider assignments + open cases (with their case_facilities links) and
// NOTHING else; the designated test provider is excluded throughout. It
// restores the old Home "Launches at risk" read: a location is flagged
// at-risk when its go-live date approaches (within 30 days by default) with
// open cases still pending or zero providers assigned, and Overdue when the
// date passed within the overdue window (90 days by default) with either
// still true (an opened location with nothing outstanding shows for the
// recent window, 30 days by default, unflagged); dateless locations list
// apart, never flagged. All date math is date-only against a passed-in `today` (never a
// clock read in the lib — the enrollmentReadiness idiom). Pure, no I/O.
//
// The three windows are business policy, so they are configuration
// (LaunchReportRules), never constants: they resolve from the decided
// default, then a platform override, then an organization override, field by
// field (resolveLaunchReportRules), and validateLaunchReportRules is the
// check an override must pass before it goes live. Nothing stores an
// override yet; the Mission Control setting is MINT-116. The rule text and
// the empty state are built from the resolved rules, so the page always
// states the rule it applies.
import type { CaseStatus } from "./caseStatus";
import { isOpenCaseStatus } from "./caseStatus";
import { isTestProvider, testProviderIds, type HasTestProviderFlag } from "./testProvider";

// ---------------------------------------------------------------------------
// Rules

/** The report's windows, in whole days. Each field names its default. */
export interface LaunchReportRules {
  /** An at-risk location whose go-live passed within this many days still
   * shows, flagged Overdue; past it the location drops off (a mature
   * location with a routine new-payer case is not a launch at risk).
   * Default 90 (Sowmya, Oct 30, D29). */
  overdueWindowDays: number;
  /** A location launched within this many days back still shows, unflagged,
   * when nothing is outstanding ("recently launched", carried from the
   * retired launchLocations window). Default 30. */
  recentWindowDays: number;
  /** A go-live date within this many days ahead counts as "approaching" for
   * the at-risk flag. Default 30. */
  upcomingWindowDays: number;
}

/** The platform default: the decided windows. */
export const DEFAULT_LAUNCH_REPORT_RULES: Readonly<LaunchReportRules> = Object.freeze({
  overdueWindowDays: 90,
  recentWindowDays: 30,
  upcomingWindowDays: 30,
});

/** The longest any window can be set to: a year. */
export const LAUNCH_REPORT_MAX_WINDOW_DAYS = 365;

/** A platform or organization override. A null or missing field inherits. */
export type LaunchReportRulesOverride = {
  readonly [K in keyof LaunchReportRules]?: LaunchReportRules[K] | null;
};

const isWindowDays = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= LAUNCH_REPORT_MAX_WINDOW_DAYS;

const RULE_LABELS: { [K in keyof LaunchReportRules]: string } = {
  overdueWindowDays: "The overdue window",
  recentWindowDays: "The recently launched window",
  upcomingWindowDays: "The approaching window",
};

const RULE_KEYS = Object.keys(RULE_LABELS) as Array<keyof LaunchReportRules>;

// Field by field: the organization's value, else the platform's, else the
// default. A stored value of the wrong shape (not a whole number of days from
// 1 to LAUNCH_REPORT_MAX_WINDOW_DAYS) is skipped like a missing one.
function mergeLaunchReportRules(
  platform?: LaunchReportRulesOverride | null,
  organization?: LaunchReportRulesOverride | null,
): LaunchReportRules {
  const pick = (key: keyof LaunchReportRules): number => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && isWindowDays(value)) return value;
    }
    return DEFAULT_LAUNCH_REPORT_RULES[key];
  };
  return {
    overdueWindowDays: pick("overdueWindowDays"),
    recentWindowDays: pick("recentWindowDays"),
    upcomingWindowDays: pick("upcomingWindowDays"),
  };
}

/** The rules in force, field by field (organization, else platform, else
 * default; a malformed value inherits). The layers can each be valid and
 * still combine into an overdue window shorter than the recent one (an
 * organization sets overdue 45, the platform later sets recent 60). That
 * would drop a location still at risk before one with nothing outstanding,
 * so the overdue window in force is never shorter than the recent window:
 * it is raised to match. validateLaunchReportRules still refuses to store
 * such an override. */
export function resolveLaunchReportRules(
  platform?: LaunchReportRulesOverride | null,
  organization?: LaunchReportRulesOverride | null,
): LaunchReportRules {
  const merged = mergeLaunchReportRules(platform, organization);
  return {
    ...merged,
    overdueWindowDays: Math.max(merged.overdueWindowDays, merged.recentWindowDays),
  };
}

/** Plain-language problems with an override; empty when it can go live.
 * `base` is what the override sits on (for an organization override, the
 * resolved platform rules), so the windows are checked together as they
 * would apply. */
export function validateLaunchReportRules(
  override: unknown,
  base: LaunchReportRules = DEFAULT_LAUNCH_REPORT_RULES,
): string[] {
  if (override == null) return [];
  if (typeof override !== "object" || Array.isArray(override))
    return ["The Launches report rules must be a set of named windows."];
  const errors: string[] = [];
  const given = override as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(RULE_KEYS as string[]).includes(key))
      errors.push(`"${key}" is not a Launches report rule.`);
  }
  for (const key of RULE_KEYS) {
    const value = given[key];
    if (value != null && !isWindowDays(value))
      errors.push(
        `${RULE_LABELS[key]} must be a whole number of days from 1 to ${LAUNCH_REPORT_MAX_WINDOW_DAYS}.`,
      );
  }
  if (errors.length > 0) return errors;
  const rules = mergeLaunchReportRules(base, given as LaunchReportRulesOverride);
  if (rules.overdueWindowDays < rules.recentWindowDays)
    errors.push(
      "The overdue window must be at least as long as the recently launched window, or a location still at risk would leave the report before one with nothing outstanding.",
    );
  return errors;
}

const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** The inline at-risk explanation (F6.6.2 AC: the rule is explained on the
 * report, built here from the rules it applies so the e2e pins the same
 * text). */
export function launchAtRiskRuleText(
  rules: LaunchReportRules = DEFAULT_LAUNCH_REPORT_RULES,
): string {
  return `At risk = go-live within ${dayCount(rules.upcomingWindowDays)} with open cases still pending or no providers assigned. Overdue = go-live passed within the last ${dayCount(rules.overdueWindowDays)} and either is still true. Opened locations with neither show for ${dayCount(rules.recentWindowDays)}.`;
}

/** The report's empty state, naming the same windows. */
export function launchEmptyStateText(
  rules: LaunchReportRules = DEFAULT_LAUNCH_REPORT_RULES,
): string {
  return `No locations opening soon, opened in the last ${dayCount(rules.recentWindowDays)}, overdue within the last ${dayCount(rules.overdueWindowDays)}, or waiting for a go-live date.`;
}

// ---------------------------------------------------------------------------
// Rows

/** Which marker an at-risk row carries: go-live today or ahead ("upcoming"),
 * or already passed ("overdue"). */
export type LaunchRiskKind = "upcoming" | "overdue";

export interface LaunchFacilityInput {
  id: string;
  name: string;
  groupId: string | null;
  effectiveDate: string | null;
  isActive: boolean;
  referenceOnly: boolean;
  city?: string | null;
  state?: string | null;
}

export interface LaunchCaseInput {
  id: string;
  providerId: string;
  /** The `credential_cases.facility_id` primary mirror. */
  facilityId: string | null;
  status: CaseStatus;
}

/** One `case_facilities` row: a location the case holds. */
export interface LaunchCaseFacilityInput {
  caseId: string;
  facilityId: string;
}

export interface LaunchAssignmentInput {
  providerId: string;
  facilityId: string;
  /** provider_facility_assignments.start_date — a future start is not yet
   * staffing the location. Legacy rows may carry none. */
  startDate?: string | null;
}

export interface LaunchProviderInput extends HasTestProviderFlag {
  id: string;
  status: string | null;
}

export interface LaunchReportRow {
  facilityId: string;
  name: string;
  groupId: string | null;
  city: string | null;
  state: string | null;
  effectiveDate: string;
  /** Negative = launched N days ago; 0 = today. */
  daysUntil: number;
  providerCount: number;
  openCaseCount: number;
  atRisk: boolean;
  /** null when the row is not at risk. */
  riskKind: LaunchRiskKind | null;
  atRiskReasons: string[];
}

/** A location with no go-live date: listed in its own section, never
 * flagged (there is no date to approach or pass). */
export interface LaunchNoDateRow extends Pick<
  LaunchReportRow,
  "facilityId" | "name" | "groupId" | "city" | "state" | "providerCount" | "openCaseCount"
> {
  groupName: string;
}

export interface LaunchReportGroup {
  groupId: string | null;
  groupName: string;
  rows: LaunchReportRow[];
}

const dayMs = 24 * 60 * 60 * 1000;

function toUtcDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `today` to `date` (date-only; negative = past). */
export function daysUntil(date: string, today: string): number | null {
  const d = toUtcDay(date);
  const t = toUtcDay(today);
  if (d === null || t === null) return null;
  return Math.round((d - t) / dayMs);
}

/**
 * Distinct providers staffing each facility: an assignment counts only when
 * its provider is not terminated, not the test provider, and has started
 * (start_date on or before `today`). Also drives Facilities Without
 * Providers, so a location staffed only by a departed, test or future hire
 * reads as unstaffed on both reports. A provider the list does not carry is
 * counted (nothing says it is ineligible).
 */
export function providerCountsByFacility(
  assignments: readonly LaunchAssignmentInput[],
  providers: readonly LaunchProviderInput[],
  today: string,
): Map<string, number> {
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const todayDay = toUtcDay(today);
  const byFacility = new Map<string, Set<string>>();
  for (const a of assignments) {
    const provider = providerById.get(a.providerId);
    if (provider && (provider.status === "terminated" || isTestProvider(provider))) continue;
    const startDay = a.startDate ? toUtcDay(a.startDate) : null;
    if (startDay !== null && todayDay !== null && startDay > todayDay) continue;
    const set = byFacility.get(a.facilityId) ?? new Set<string>();
    set.add(a.providerId);
    byFacility.set(a.facilityId, set);
  }
  return new Map(Array.from(byFacility, ([facilityId, set]) => [facilityId, set.size]));
}

/**
 * Open cases per facility, attributed through `case_facilities`: a case
 * counts once at each location it holds. A case with no `case_facilities`
 * rows falls back to its `facility_id` primary mirror (creation stamps the
 * mirror without writing the child row). Never through the provider's
 * assignments: a provider at two clinics does not make a case pending at
 * both. The test provider's cases never count.
 */
export function openCasesByFacility(
  cases: readonly LaunchCaseInput[],
  caseFacilities: readonly LaunchCaseFacilityInput[],
  providers: readonly LaunchProviderInput[],
): Map<string, number> {
  const testIds = testProviderIds(providers);
  const facilitiesByCase = new Map<string, Set<string>>();
  for (const link of caseFacilities) {
    const set = facilitiesByCase.get(link.caseId) ?? new Set<string>();
    set.add(link.facilityId);
    facilitiesByCase.set(link.caseId, set);
  }
  const counts = new Map<string, number>();
  for (const c of cases) {
    if (!isOpenCaseStatus(c.status) || testIds.has(c.providerId)) continue;
    const linked = facilitiesByCase.get(c.id);
    const reached = linked ?? (c.facilityId ? [c.facilityId] : []);
    for (const facilityId of reached) {
      counts.set(facilityId, (counts.get(facilityId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The report rows: ACTIVE, non-reference facilities whose go-live date is in
 * the future, within the recent window, or — when still at risk — within the
 * overdue window (dateless locations are listed apart by
 * buildNoGoLiveDateRows). Sorted date ascending, name tiebreak. The windows
 * come from `rules` (resolved by the caller; the defaults otherwise).
 */
export function buildLaunchReportRows(
  facilities: readonly LaunchFacilityInput[],
  providerCountByFacility: ReadonlyMap<string, number>,
  openCaseCountByFacility: ReadonlyMap<string, number>,
  today: string,
  rules: LaunchReportRules = DEFAULT_LAUNCH_REPORT_RULES,
): LaunchReportRow[] {
  const rows: LaunchReportRow[] = [];
  for (const f of facilities) {
    if (!f.isActive || f.referenceOnly || !f.effectiveDate) continue;
    const days = daysUntil(f.effectiveDate, today);
    if (days === null) continue;
    const providerCount = providerCountByFacility.get(f.id) ?? 0;
    const openCaseCount = openCaseCountByFacility.get(f.id) ?? 0;
    // The same test ahead of go-live (upcoming) and after it (overdue); only a
    // date beyond the upcoming window is exempt.
    const checked = days <= rules.upcomingWindowDays;
    const atRiskReasons: string[] = [];
    if (checked && openCaseCount > 0) atRiskReasons.push("open cases still pending");
    if (checked && providerCount === 0) atRiskReasons.push("no providers assigned");
    const atRisk = atRiskReasons.length > 0;
    // A passed go-live shows within the overdue window while still at risk,
    // and within the recent window otherwise.
    if (days < -(atRisk ? rules.overdueWindowDays : rules.recentWindowDays)) continue;
    rows.push({
      facilityId: f.id,
      name: f.name,
      groupId: f.groupId,
      city: f.city ?? null,
      state: f.state ?? null,
      effectiveDate: f.effectiveDate,
      daysUntil: days,
      providerCount,
      openCaseCount,
      atRisk,
      riskKind: atRisk ? (days < 0 ? "overdue" : "upcoming") : null,
      atRiskReasons,
    });
  }
  return rows.sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      a.name.localeCompare(b.name) ||
      a.facilityId.localeCompare(b.facilityId),
  );
}

/** The Risk pill text: "At risk — reasons" up to go-live, "Overdue by N
 * days — reasons" once it has passed; null when the row is not flagged. */
export function launchRiskLabel(row: LaunchReportRow): string | null {
  if (!row.riskKind) return null;
  const reasons = row.atRiskReasons.join("; ");
  if (row.riskKind === "upcoming") return `At risk — ${reasons}`;
  const days = -row.daysUntil;
  return `Overdue by ${days} day${days === 1 ? "" : "s"} — ${reasons}`;
}

/**
 * The "No go-live date" section: ACTIVE, non-reference facilities with no
 * go-live date, never flagged. Ordered the way the dated report reads: group
 * A→Z by name, ungrouped last (a groupId missing from the map folds into
 * "No group"), then location name.
 */
export function buildNoGoLiveDateRows(
  facilities: readonly LaunchFacilityInput[],
  providerCountByFacility: ReadonlyMap<string, number>,
  openCaseCountByFacility: ReadonlyMap<string, number>,
  groupNameById: ReadonlyMap<string, string>,
): LaunchNoDateRow[] {
  const rows: LaunchNoDateRow[] = [];
  for (const f of facilities) {
    if (!f.isActive || f.referenceOnly || f.effectiveDate) continue;
    rows.push({
      facilityId: f.id,
      name: f.name,
      groupId: f.groupId,
      groupName: (f.groupId ? groupNameById.get(f.groupId) : undefined) ?? "No group",
      city: f.city ?? null,
      state: f.state ?? null,
      providerCount: providerCountByFacility.get(f.id) ?? 0,
      openCaseCount: openCaseCountByFacility.get(f.id) ?? 0,
    });
  }
  const ungrouped = (r: LaunchNoDateRow) => !(r.groupId && groupNameById.has(r.groupId));
  return rows.sort(
    (a, b) =>
      Number(ungrouped(a)) - Number(ungrouped(b)) ||
      a.groupName.localeCompare(b.groupName) ||
      a.name.localeCompare(b.name) ||
      a.facilityId.localeCompare(b.facilityId),
  );
}

/** Group the (already date-sorted) rows by provider group, groups A→Z by
 * name; ungrouped locations trail under "No group". */
export function groupLaunchRows(
  rows: readonly LaunchReportRow[],
  groupNameById: ReadonlyMap<string, string>,
): LaunchReportGroup[] {
  const byGroup = new Map<string | null, LaunchReportRow[]>();
  for (const row of rows) {
    const key = row.groupId && groupNameById.has(row.groupId) ? row.groupId : null;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }
  const groups: LaunchReportGroup[] = Array.from(byGroup, ([groupId, groupRows]) => ({
    groupId,
    groupName: groupId ? (groupNameById.get(groupId) ?? "No group") : "No group",
    rows: groupRows,
  }));
  return groups.sort((a, b) => {
    if (a.groupId === null) return 1;
    if (b.groupId === null) return -1;
    return a.groupName.localeCompare(b.groupName);
  });
}
