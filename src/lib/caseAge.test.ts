import { describe, expect, it } from "vitest";
import {
  caseDaysOpen,
  caseAgeStopStatuses,
  caseAgeStopTimes,
  caseDaysOpenFor,
  caseDaysOpenStop,
  caseDaysOpenWhenKnown,
  DEFAULT_CASE_AGE_RULES,
  resolveCaseAgeRules,
  type CaseAgeRules,
  type CaseAgeTransition,
} from "./caseAge";
import { PAYER_DECISION_CASE_STATUSES, TERMINAL_CASE_STATUSES } from "./caseStatus";

// Offset-less timestamps parse as local time, so these hold in any CI timezone.
const now = new Date(2026, 9, 19, 23, 25); // Oct 19, 2026, 11:25 PM local

describe("caseDaysOpen", () => {
  it("is 0 on the day the case was created", () => {
    expect(caseDaysOpen("2026-10-19T08:00:00", now)).toBe(0);
  });

  it("counts calendar days since creation", () => {
    expect(caseDaysOpen("2026-09-27T12:00:00", now)).toBe(22);
  });

  it("counts calendar days, not 24-hour periods", () => {
    const nextMorning = new Date(2026, 9, 20, 1, 0);
    expect(caseDaysOpen("2026-10-19T23:00:00", nextMorning)).toBe(1);
  });

  it("reads offset timestamps (as the database returns them) on the local calendar", () => {
    const createdLateEvening = new Date(2026, 9, 19, 23, 0).toISOString();
    const nextMorning = new Date(2026, 9, 20, 1, 0);
    expect(caseDaysOpen(createdLateEvening, nextMorning)).toBe(1);
  });

  it("never goes negative when the creation time is ahead of the clock", () => {
    expect(caseDaysOpen("2026-10-21T09:00:00", now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D22 (Sowmya, Oct 30): "Days open" stops when the case is approved or denied.

const NEVER: CaseAgeRules = { freezeAt: "never" };

const move = (
  caseId: string,
  fromStatus: string | null,
  toStatus: string,
  changedAt: string,
  actorKind = "user",
): CaseAgeTransition => ({ caseId, fromStatus, toStatus, actorKind, changedAt });

// Created Sep 1; approved Sep 15 (14 days later); today is Oct 19.
const created = "2026-09-01T12:00:00";
const approvedCase = { id: "c1", createdAt: created, caseStatus: "approved" as const };

describe("CaseAgeRules", () => {
  it("defaults to stopping at approval or denial (D22)", () => {
    expect(DEFAULT_CASE_AGE_RULES).toEqual({ freezeAt: "approved_or_denied" });
    expect(Object.isFrozen(DEFAULT_CASE_AGE_RULES)).toBe(true);
    expect(resolveCaseAgeRules()).toEqual(DEFAULT_CASE_AGE_RULES);
  });

  it("stops at the payer's two answers, taken from caseStatus.ts, and never stops under 'never'", () => {
    expect(caseAgeStopStatuses(DEFAULT_CASE_AGE_RULES)).toBe(PAYER_DECISION_CASE_STATUSES);
    expect([...PAYER_DECISION_CASE_STATUSES]).toEqual(["approved", "denied"]);
    for (const status of PAYER_DECISION_CASE_STATUSES) {
      expect(TERMINAL_CASE_STATUSES).toContain(status);
    }
    expect(caseAgeStopStatuses(NEVER)).toEqual([]);
  });

  it("resolves field by field: organization over platform over default", () => {
    expect(resolveCaseAgeRules({ freezeAt: "never" })).toEqual(NEVER);
    expect(resolveCaseAgeRules({ freezeAt: "never" }, { freezeAt: "approved_or_denied" })).toEqual(
      DEFAULT_CASE_AGE_RULES,
    );
    expect(resolveCaseAgeRules(null, { freezeAt: "never" })).toEqual(NEVER);
    expect(resolveCaseAgeRules({ freezeAt: "never" }, { freezeAt: null })).toEqual(NEVER);
  });

  it("ignores a stored value of the wrong shape, like a missing one", () => {
    const bad = { freezeAt: "closed" } as unknown as CaseAgeRules;
    expect(resolveCaseAgeRules(bad)).toEqual(DEFAULT_CASE_AGE_RULES);
    expect(resolveCaseAgeRules({ freezeAt: "never" }, bad)).toEqual(NEVER);
  });
});

describe("caseAgeStopTimes", () => {
  it("is the recorded move into Approved or Denied", () => {
    const stops = caseAgeStopTimes(
      [
        move("c1", "not_started", "in_progress", "2026-09-02T09:00:00"),
        move("c1", "in_review", "approved", "2026-09-15T10:00:00"),
        move("c2", "submitted", "denied", "2026-09-20T10:00:00"),
      ],
      DEFAULT_CASE_AGE_RULES,
    );
    expect(stops).toEqual(
      new Map([
        ["c1", "2026-09-15T10:00:00"],
        ["c2", "2026-09-20T10:00:00"],
      ]),
    );
  });

  it("skips a status-history seed: it records where the case stood, not when it closed", () => {
    const seed = move("c1", null, "approved", "2026-07-19T00:00:00", "system");
    expect(caseAgeStopTimes([seed], DEFAULT_CASE_AGE_RULES).size).toBe(0);
  });

  it("keeps the first close when a correction moves the case between Approved and Denied", () => {
    const stops = caseAgeStopTimes(
      [
        move("c1", "in_review", "approved", "2026-09-15T10:00:00"),
        move("c1", "approved", "denied", "2026-10-01T10:00:00"),
      ],
      DEFAULT_CASE_AGE_RULES,
    );
    expect(stops.get("c1")).toBe("2026-09-15T10:00:00");
  });

  it("restarts at the next close after a reapply, in any row order", () => {
    const stops = caseAgeStopTimes(
      [
        move("c1", "in_progress", "approved", "2026-10-10T10:00:00"),
        move("c1", "submitted", "denied", "2026-09-10T10:00:00"),
        move("c1", "denied", "in_progress", "2026-09-12T10:00:00"),
      ],
      DEFAULT_CASE_AGE_RULES,
    );
    expect(stops.get("c1")).toBe("2026-10-10T10:00:00");
  });

  it("ignores Not Pursuing and unreadable timestamps, and stops nothing under 'never'", () => {
    const rows = [
      move("c1", "in_review", "not_pursuing", "2026-09-15T10:00:00"),
      move("c2", "in_review", "approved", "not a time"),
      move("c3", "in_review", "approved", "2026-09-15T10:00:00"),
    ];
    expect([...caseAgeStopTimes(rows, DEFAULT_CASE_AGE_RULES).keys()]).toEqual(["c3"]);
    expect(caseAgeStopTimes(rows, NEVER).size).toBe(0);
  });
});

describe("caseDaysOpenFor", () => {
  const stops = new Map([["c1", "2026-09-15T10:00:00"]]);

  it("stops at approval by default (D22), however long ago that was", () => {
    expect(caseDaysOpenFor(approvedCase, now, stops)).toBe(14);
    expect(caseDaysOpenFor(approvedCase, new Date(2027, 0, 1), stops)).toBe(14);
    expect(caseDaysOpenStop(approvedCase, stops)).toBe("2026-09-15T10:00:00");
  });

  it("stops at denial by default", () => {
    const denied = { ...approvedCase, caseStatus: "denied" as const };
    expect(caseDaysOpenFor(denied, now, stops)).toBe(14);
  });

  it("keeps counting under 'never' (the behaviour before D22)", () => {
    expect(caseDaysOpenFor(approvedCase, now, stops, NEVER)).toBe(48);
    expect(caseDaysOpenStop(approvedCase, stops, NEVER)).toBeNull();
  });

  it("keeps counting while the case is open, even with an earlier close on file (reapplied)", () => {
    const reopened = { ...approvedCase, caseStatus: "in_progress" as const };
    expect(caseDaysOpenFor(reopened, now, stops)).toBe(48);
  });

  it("keeps counting for Not Pursuing, which D22 does not stop", () => {
    const optedOut = { ...approvedCase, caseStatus: "not_pursuing" as const };
    expect(caseDaysOpenFor(optedOut, now, stops)).toBe(48);
  });

  it("keeps counting a closed case with no recorded close, rather than guess a date", () => {
    expect(caseDaysOpenFor(approvedCase, now, new Map())).toBe(48);
    expect(caseDaysOpenStop(approvedCase, new Map())).toBeNull();
  });

  it("counts calendar days to the stop, and never past the clock", () => {
    const lateClose = new Map([["c1", "2026-09-15T23:30:00"]]);
    expect(caseDaysOpenFor(approvedCase, now, lateClose)).toBe(14);
    const futureClose = new Map([["c1", "2026-12-01T10:00:00"]]);
    expect(caseDaysOpenFor(approvedCase, now, futureClose)).toBe(48);
  });

  it("matches caseDaysOpen exactly while nothing stops it", () => {
    const open = { id: "c9", createdAt: "2026-09-27T12:00:00", caseStatus: "submitted" as const };
    expect(caseDaysOpenFor(open, now, new Map())).toBe(caseDaysOpen(open.createdAt, now));
  });
});

describe("caseDaysOpenWhenKnown", () => {
  const stops = new Map([["c1", "2026-09-15T10:00:00"]]);

  it("is caseDaysOpenFor whenever the stops were read", () => {
    expect(caseDaysOpenWhenKnown(approvedCase, now, stops)).toBe(14);
    expect(caseDaysOpenWhenKnown(approvedCase, now, new Map())).toBe(48);
  });

  it("is unknown for an approved or denied case when the stops could not be read", () => {
    expect(caseDaysOpenWhenKnown(approvedCase, now, null)).toBeNull();
    expect(caseDaysOpenWhenKnown({ ...approvedCase, caseStatus: "denied" }, now, null)).toBeNull();
  });

  it("still counts an open or Not Pursuing case, and anything under 'never', without the stops", () => {
    expect(caseDaysOpenWhenKnown({ ...approvedCase, caseStatus: "in_review" }, now, null)).toBe(48);
    expect(caseDaysOpenWhenKnown({ ...approvedCase, caseStatus: "not_pursuing" }, now, null)).toBe(
      48,
    );
    expect(caseDaysOpenWhenKnown(approvedCase, now, null, NEVER)).toBe(48);
  });
});
