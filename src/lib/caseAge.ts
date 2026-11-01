// MINT-73 — the one definition of a case's age. The Cases list, the Matrix
// cell popover and the case Details card all read "Days open" from here, so
// the same case never shows two different numbers. Whole calendar days in the
// viewer's local time, not 24-hour periods, and never negative. No I/O.
//
// The count starts when the case was created. When it stops is policy, so it
// is configuration (CaseAgeRules), resolved field by field: the
// organization's value, else the platform's, else the default. The default is
// Sowmya's decision: stop counting once the case is approved or denied (Oct
// 30, D22). Nothing stores an override yet; the Mission Control setting is
// MINT-129. Counting from submission is an open question and is not built.
//
// The stop is a fact, never a guess. It is the recorded case_status_history
// transition that closed the case: its first move into Approved or Denied, or,
// when the case was reopened since (a denial reapplied, or an admin correction
// out of Approved), its first move back in after that. A correction between
// the two (Approved to Denied) is not a new close and does not move the stop.
// A status-history seed is not a transition (isStatusHistorySeed): it records
// where the case stood on the day the row was written. So an approved or
// denied case whose history holds no recorded move into that status (a case
// closed before the July 19, 2026 unified-status migration) keeps counting;
// it is never stopped at updated_at or at the seed's migration day.
import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  isStatusHistorySeed,
  PAYER_DECISION_CASE_STATUSES,
  type CaseStatus,
} from "@/lib/caseStatus";

/** Whole calendar days from `createdAt` to `now`; never negative. */
export function caseDaysOpen(createdAt: string, now: Date): number {
  return Math.max(0, differenceInCalendarDays(now, parseISO(createdAt)));
}

// ---------------------------------------------------------------------------
// Rules

/** When "Days open" stops counting. */
export type CaseAgeFreezeAt = "approved_or_denied" | "never";

export interface CaseAgeRules {
  /** "approved_or_denied" (default): the count stops at the recorded
   * transition that closed the case as Approved or Denied, and stays there
   * while the case stays closed. "never": it keeps counting whatever the
   * status. */
  freezeAt: CaseAgeFreezeAt;
}

/** The platform default: Sowmya's decision (D22, Oct 30, 2026). */
export const DEFAULT_CASE_AGE_RULES: Readonly<CaseAgeRules> = Object.freeze({
  freezeAt: "approved_or_denied",
});

/** A platform or organization override. A null or missing field inherits. */
export type CaseAgeRulesOverride = {
  readonly [K in keyof CaseAgeRules]?: CaseAgeRules[K] | null;
};

const FREEZE_CHOICES: readonly CaseAgeFreezeAt[] = ["approved_or_denied", "never"];

/** The statuses at which each freeze choice stops the count. */
const FREEZE_STATUSES: Record<CaseAgeFreezeAt, readonly CaseStatus[]> = {
  approved_or_denied: PAYER_DECISION_CASE_STATUSES,
  never: [],
};

const RULE_CHECKS: { [K in keyof CaseAgeRules]: (value: unknown) => boolean } = {
  freezeAt: (value) => (FREEZE_CHOICES as readonly unknown[]).includes(value),
};

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveCaseAgeRules(
  platform?: CaseAgeRulesOverride | null,
  organization?: CaseAgeRulesOverride | null,
): CaseAgeRules {
  const pick = <K extends keyof CaseAgeRules>(key: K): CaseAgeRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && RULE_CHECKS[key](value)) return value as CaseAgeRules[K];
    }
    return DEFAULT_CASE_AGE_RULES[key];
  };
  return { freezeAt: pick("freezeAt") };
}

/** The statuses at which "Days open" stops under these rules. */
export function caseAgeStopStatuses(rules: CaseAgeRules): readonly CaseStatus[] {
  return FREEZE_STATUSES[rules.freezeAt];
}

// ---------------------------------------------------------------------------
// The stop, from status history

/** One case_status_history row, as much of it as the stop needs. */
export interface CaseAgeTransition {
  caseId: string;
  fromStatus: string | null | undefined;
  toStatus: string;
  actorKind: string | null | undefined;
  changedAt: string;
}

/** Per case, when it last moved into a stopping status from outside them: a
 * recorded transition, never a seed. A case with no such row is absent. Rows
 * for other statuses are ignored, so a caller may pass a case's whole history
 * or only the rows into the stopping statuses. */
export function caseAgeStopTimes(
  transitions: readonly CaseAgeTransition[],
  rules: CaseAgeRules,
): Map<string, string> {
  const stopStatuses: readonly string[] = caseAgeStopStatuses(rules);
  const latest = new Map<string, { at: string; ms: number }>();
  if (stopStatuses.length === 0) return new Map();
  for (const row of transitions) {
    if (!stopStatuses.includes(row.toStatus)) continue;
    // A move between stopping statuses (an Approved to Denied correction) is
    // not a new close.
    if (row.fromStatus != null && stopStatuses.includes(row.fromStatus)) continue;
    if (isStatusHistorySeed(row)) continue;
    const ms = Date.parse(row.changedAt);
    if (!Number.isFinite(ms)) continue;
    const current = latest.get(row.caseId);
    if (!current || ms > current.ms) latest.set(row.caseId, { at: row.changedAt, ms });
  }
  return new Map([...latest].map(([caseId, { at }]) => [caseId, at]));
}

/** The case fields "Days open" reads. */
export interface CaseAgeCase {
  id: string;
  createdAt: string;
  caseStatus: CaseStatus;
}

/** When this case's count stops under the rules, or null while it counts:
 * the case is not in a stopping status, or no transition into it is recorded. */
export function caseDaysOpenStop(
  c: CaseAgeCase,
  stopTimes: ReadonlyMap<string, string>,
  rules: CaseAgeRules = DEFAULT_CASE_AGE_RULES,
): string | null {
  if (!caseAgeStopStatuses(rules).includes(c.caseStatus)) return null;
  return stopTimes.get(c.id) ?? null;
}

/** "Days open" under the rules: calendar days from creation to `now`, or to
 * the stop when the case has one. */
export function caseDaysOpenFor(
  c: CaseAgeCase,
  now: Date,
  stopTimes: ReadonlyMap<string, string>,
  rules: CaseAgeRules = DEFAULT_CASE_AGE_RULES,
): number {
  const stop = caseDaysOpenStop(c, stopTimes, rules);
  if (stop === null) return caseDaysOpen(c.createdAt, now);
  const stoppedAt = parseISO(stop);
  return caseDaysOpen(c.createdAt, stoppedAt < now ? stoppedAt : now);
}

const NO_STOPS: ReadonlyMap<string, string> = new Map();

/** caseDaysOpenFor when the stops could not be read (`stopTimes` null):
 * an open case still counts, because no stop applies to it; a case in a
 * stopping status is null (unknown), never a still-counting number. */
export function caseDaysOpenWhenKnown(
  c: CaseAgeCase,
  now: Date,
  stopTimes: ReadonlyMap<string, string> | null,
  rules: CaseAgeRules = DEFAULT_CASE_AGE_RULES,
): number | null {
  if (stopTimes === null) {
    if (caseAgeStopStatuses(rules).includes(c.caseStatus)) return null;
    return caseDaysOpenFor(c, now, NO_STOPS, rules);
  }
  return caseDaysOpenFor(c, now, stopTimes, rules);
}
