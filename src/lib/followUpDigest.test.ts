import { describe, expect, it } from "vitest";
import { resolveActiveFollowUp } from "./followUps";
import * as digest from "./followUpDigest";
import {
  CATCH_UP_UNTIL_MIDNIGHT,
  DEFAULT_FOLLOW_UP_DIGEST_RULES,
  MAX_DIGEST_SECTION_ROWS,
  digestSlot,
  digestSlotKey,
  dueFollowUps,
  isoWeekday,
  planFollowUpDigests,
  resolveFollowUpDigestRules,
  touchCanResolveFollowUp,
  zonedDateHour,
  type DigestCase,
  type DigestMember,
  type DigestSchedule,
  type DigestSlot,
  type DigestSlotState,
  type DigestTouchpoint,
  type FollowUpDigestPlanInput,
} from "./followUpDigest";

// MINT-108 digest rules. "Today" is the org's local date 2026-10-31 unless a
// test says otherwise.
const TODAY = "2026-10-31";
const BASE = "https://app.example.test";

const JANE = "11111111-1111-4111-8111-111111111111";
const OMAR = "22222222-2222-4222-8222-222222222222";
const ADA = "33333333-3333-4333-8333-333333333333";
const FORMER = "99999999-9999-4999-8999-999999999999";

function member(userId: string, first: string): DigestMember {
  return { userId, firstName: first, email: `${first.toLowerCase()}@example.test` };
}

const MEMBERS: DigestMember[] = [member(JANE, "Jane"), member(OMAR, "Omar"), member(ADA, "Ada")];

let caseSeq = 0;
function kase(overrides: Partial<DigestCase> = {}): DigestCase {
  caseSeq += 1;
  return {
    id: `case-${caseSeq}`,
    caseNumber: 1000 + caseSeq,
    assignedTo: JANE,
    caseStatus: "in_progress",
    providerName: `Provider ${caseSeq}`,
    payerName: "Aetna",
    ...overrides,
  };
}

let touchSeq = 0;
function touch(
  caseId: string,
  touchDate: string,
  nextFollowUpDate: string | null,
  clearsFollowUp = false,
): DigestTouchpoint {
  touchSeq += 1;
  return {
    id: `t-${String(touchSeq).padStart(4, "0")}`,
    caseId,
    touchDate,
    createdAt: `${touchDate}T12:00:00Z`,
    nextFollowUpDate,
    clearsFollowUp,
  };
}

function plan(overrides: Partial<FollowUpDigestPlanInput>) {
  return planFollowUpDigests({
    practiceName: "Shelby Rehab",
    today: TODAY,
    appBaseUrl: BASE,
    cases: [],
    touchpoints: [],
    members: MEMBERS,
    ...overrides,
  });
}

/** A daily schedule as Minted sets it on an org's row: all five together (A10, G2). */
function daily(sendHour: number | null, sendTimeZone: string | null): DigestSchedule {
  return { digestFrequency: "daily", digestWeekday: 1, sendHour, sendTimeZone, secondSendHour: 23 };
}

const CHICAGO = daily(8, "America/Chicago");
const at = (iso: string) => new Date(iso);

/** A once-a-day slot (daily, or weekly on its day): its one send, keyed by the local date. */
function once(state: DigestSlotState, localDate: string, localHour: number): DigestSlot {
  return { due: state === "due", state, localDate, localHour, send: 1, slot: localDate };
}

describe("zonedDateHour: the org's wall clock", () => {
  it("reads the local date and hour in the zone, not the server's or UTC's", () => {
    // 04:30 UTC on Nov 1 is still Oct 31 in Chicago (CDT, UTC-5) and already
    // Nov 1 in Tokyo.
    expect(zonedDateHour(at("2026-11-01T04:30:00Z"), "America/Chicago")).toEqual({
      date: "2026-10-31",
      hour: 23,
    });
    expect(zonedDateHour(at("2026-10-31T23:30:00Z"), "Asia/Tokyo")).toEqual({
      date: "2026-11-01",
      hour: 8,
    });
    expect(zonedDateHour(at("2026-10-31T00:00:00Z"), "UTC")).toEqual({
      date: "2026-10-31",
      hour: 0,
    });
  });

  it("repeats the 1 am hour on the same date when DST ends (Chicago, Nov 1 2026)", () => {
    expect(zonedDateHour(at("2026-11-01T05:59:00Z"), "America/Chicago")).toEqual({
      date: "2026-11-01",
      hour: 0,
    });
    // 1:00 CDT, then 1:00 CST an hour later.
    expect(zonedDateHour(at("2026-11-01T06:00:00Z"), "America/Chicago").hour).toBe(1);
    expect(zonedDateHour(at("2026-11-01T07:00:00Z"), "America/Chicago")).toEqual({
      date: "2026-11-01",
      hour: 1,
    });
    expect(zonedDateHour(at("2026-11-01T08:00:00Z"), "America/Chicago").hour).toBe(2);
  });

  it("skips the 2 am hour when DST starts (Chicago, Mar 14 2027)", () => {
    expect(zonedDateHour(at("2027-03-14T07:00:00Z"), "America/Chicago").hour).toBe(1);
    expect(zonedDateHour(at("2027-03-14T08:00:00Z"), "America/Chicago")).toEqual({
      date: "2027-03-14",
      hour: 3,
    });
  });

  it("refuses a zone that is not an IANA name this runtime knows", () => {
    expect(() => zonedDateHour(at("2026-10-31T12:00:00Z"), "Mars/Olympus")).toThrow(RangeError);
    expect(() => zonedDateHour(at("2026-10-31T12:00:00Z"), "CST")).toThrow(RangeError);
  });
});

describe("digestSlot: the hour gate", () => {
  it("is not due before the send hour, and due at it and every hour after, the same local date", () => {
    // Oct 31 is CDT (UTC-5): 8 am Central is 13:00 UTC.
    expect(digestSlot(CHICAGO, at("2026-10-31T12:59:59Z"))).toEqual(
      once("not_yet", "2026-10-31", 7),
    );
    expect(digestSlot(CHICAGO, at("2026-10-31T13:00:00Z"))).toEqual(once("due", "2026-10-31", 8));
    // A run missed at 8 catches up at 9, and as late as 11 pm, same date.
    expect(digestSlot(CHICAGO, at("2026-10-31T14:00:00Z"))).toMatchObject({
      due: true,
      localDate: "2026-10-31",
    });
    expect(digestSlot(CHICAGO, at("2026-11-01T04:59:00Z"))).toEqual(once("due", "2026-10-31", 23));
    // Local midnight starts the next date, not yet due.
    expect(digestSlot(CHICAGO, at("2026-11-01T05:00:00Z"))).toEqual(
      once("not_yet", "2026-11-01", 0),
    );
  });

  it("follows the zone across DST ending: 8 am Central is 13:00 UTC on Oct 31, 14:00 UTC on Nov 1", () => {
    expect(digestSlot(CHICAGO, at("2026-11-01T13:00:00Z"))).toEqual(
      once("not_yet", "2026-11-01", 7),
    );
    expect(digestSlot(CHICAGO, at("2026-11-01T14:00:00Z"))).toEqual(once("due", "2026-11-01", 8));
    // A 1 am send hour is due in both 1 am hours, for the same local date.
    const oneAm = daily(1, "America/Chicago");
    expect(digestSlot(oneAm, at("2026-11-01T06:00:00Z"))).toMatchObject({
      due: true,
      localDate: "2026-11-01",
    });
    expect(digestSlot(oneAm, at("2026-11-01T07:00:00Z"))).toMatchObject({
      due: true,
      localDate: "2026-11-01",
    });
  });

  it("follows the zone across DST starting, and a send hour that does not exist that day goes at the next hour", () => {
    expect(digestSlot(CHICAGO, at("2027-03-13T13:00:00Z"))).toMatchObject({ due: false });
    expect(digestSlot(CHICAGO, at("2027-03-13T14:00:00Z"))).toMatchObject({ due: true });
    expect(digestSlot(CHICAGO, at("2027-03-14T13:00:00Z"))).toMatchObject({
      due: true,
      localHour: 8,
    });
    const twoAm = daily(2, "America/Chicago");
    expect(digestSlot(twoAm, at("2027-03-14T07:00:00Z"))).toMatchObject({
      due: false,
      localHour: 1,
    });
    expect(digestSlot(twoAm, at("2027-03-14T08:00:00Z"))).toEqual(once("due", "2027-03-14", 3));
  });

  it("uses the org's own hour and zone, as Minted set them", () => {
    const now = at("2026-10-31T15:30:00Z");
    expect(digestSlot(daily(8, "America/Los_Angeles"), now)).toEqual(once("due", "2026-10-31", 8));
    expect(digestSlot(daily(11, "America/New_York"), now)).toEqual(once("due", "2026-10-31", 11));
    expect(digestSlot(daily(12, "America/New_York"), now)).toMatchObject({
      due: false,
    });
    expect(digestSlot(daily(0, "UTC"), now)).toMatchObject({ due: true });
  });

  it("is null when the digest is not set up: no schedule, a partial one, or one it cannot use (G2)", () => {
    const now = at("2026-10-31T13:00:00Z");
    const none: DigestSchedule = {
      digestFrequency: null,
      digestWeekday: null,
      sendHour: null,
      sendTimeZone: null,
      secondSendHour: null,
    };
    // No default: an org Minted has not set up is not due, at any hour.
    expect(digestSlot(none, now)).toBeNull();
    expect(digestSlot({ ...CHICAGO, digestFrequency: null }, now)).toBeNull();
    expect(digestSlot({ ...CHICAGO, digestWeekday: null }, now)).toBeNull();
    expect(digestSlot({ ...CHICAGO, secondSendHour: null }, now)).toBeNull();
    expect(digestSlot(daily(null, "America/Chicago"), now)).toBeNull();
    expect(digestSlot(daily(8, null), now)).toBeNull();
    expect(digestSlot(daily(24, "America/Chicago"), now)).toBeNull();
    expect(digestSlot(daily(-1, "America/Chicago"), now)).toBeNull();
    expect(digestSlot(daily(7.5, "America/Chicago"), now)).toBeNull();
    expect(digestSlot(daily(8, "Mars/Olympus"), now)).toBeNull();
  });
});

describe("dueFollowUps: what is listed", () => {
  it("lists overdue and due-today follow-ups, and leaves out upcoming and none", () => {
    const overdue = kase();
    const dueToday = kase();
    const upcoming = kase();
    const none = kase();
    const due = dueFollowUps(
      [overdue, dueToday, upcoming, none],
      [
        touch(overdue.id, "2026-10-20", "2026-10-28"),
        touch(dueToday.id, "2026-10-20", TODAY),
        touch(upcoming.id, "2026-10-20", "2026-11-01"),
        touch(none.id, "2026-10-20", null),
      ],
      TODAY,
    );
    expect(Object.fromEntries(due)).toEqual({
      [overdue.id]: { dueDate: "2026-10-28", status: "overdue" },
      [dueToday.id]: { dueDate: TODAY, status: "due_today" },
    });
  });

  it("measures overdue and due today against the local date it is given", () => {
    const c = kase();
    const touches = [touch(c.id, "2026-10-20", "2026-10-31")];
    expect(dueFollowUps([c], touches, "2026-10-31").get(c.id)?.status).toBe("due_today");
    expect(dueFollowUps([c], touches, "2026-11-01").get(c.id)?.status).toBe("overdue");
    expect(dueFollowUps([c], touches, "2026-10-30").has(c.id)).toBe(false);
  });

  it("uses the carry-forward reducer: a date-less touch keeps the follow-up, a clear ends it", () => {
    const carried = kase();
    const cleared = kase();
    const rescheduled = kase();
    const due = dueFollowUps(
      [carried, cleared, rescheduled],
      [
        touch(carried.id, "2026-10-20", "2026-10-25"),
        touch(carried.id, "2026-10-29", null),
        touch(cleared.id, "2026-10-20", "2026-10-25"),
        touch(cleared.id, "2026-10-29", null, true),
        touch(rescheduled.id, "2026-10-20", "2026-10-25"),
        touch(rescheduled.id, "2026-10-29", "2026-11-05"),
      ],
      TODAY,
    );
    expect([...due.keys()]).toEqual([carried.id]);
    expect(due.get(carried.id)).toEqual({ dueDate: "2026-10-25", status: "overdue" });
  });

  it("considers open cases only", () => {
    const approved = kase({ caseStatus: "approved" });
    const denied = kase({ caseStatus: "denied" });
    const stopped = kase({ caseStatus: "not_pursuing" });
    const legacy = kase({ caseStatus: "in_network" });
    const due = dueFollowUps(
      [approved, denied, stopped, legacy],
      [approved, denied, stopped, legacy].map((c) => touch(c.id, "2026-10-20", "2026-10-25")),
      TODAY,
    );
    expect(due.size).toBe(0);
  });

  it("refuses a today that is not a calendar date", () => {
    expect(() => dueFollowUps([], [], "2026-02-30")).toThrow(RangeError);
    expect(() => dueFollowUps([], [], "2026-10-31T00:00:00Z")).toThrow(RangeError);
  });
});

describe("touchCanResolveFollowUp: the touches read can skip the rest", () => {
  // Every sequence of up to four touches drawn from: a date, another date, a
  // date-less touch, a clear, with touch dates that tie. Reading only the
  // touches that set or clear a follow-up must give the reducer's same answer.
  const kinds = ["date_a", "date_b", "none", "clear"] as const;
  const sequences: (typeof kinds)[number][][] = [[]];
  for (let length = 1; length <= 4; length += 1) {
    for (const prefix of sequences.filter((seq) => seq.length === length - 1)) {
      for (const kind of kinds) sequences.push([...prefix, kind]);
    }
  }

  it.each([false, true])(
    "matches resolveActiveFollowUp over every touch (tied dates: %s)",
    (tied) => {
      let checked = 0;
      for (const seq of sequences) {
        const touches = seq.map((kind, i) => ({
          id: `t${i}`,
          touchDate: tied ? "2026-10-01" : `2026-10-0${i + 1}`,
          createdAt: `2026-10-01T0${i}:00:00Z`,
          nextFollowUpDate:
            kind === "date_a" ? "2026-10-20" : kind === "date_b" ? "2026-11-20" : null,
          clearsFollowUp: kind === "clear",
        }));
        expect(resolveActiveFollowUp(touches.filter(touchCanResolveFollowUp))).toEqual(
          resolveActiveFollowUp(touches),
        );
        checked += 1;
      }
      expect(checked).toBe(1 + 4 + 16 + 64 + 256);
    },
  );

  it("keeps exactly the touches that set or clear a follow-up", () => {
    const base = { nextFollowUpDate: null, clearsFollowUp: false };
    expect(touchCanResolveFollowUp(base)).toBe(false);
    expect(touchCanResolveFollowUp({ ...base, nextFollowUpDate: "2026-10-20" })).toBe(true);
    expect(touchCanResolveFollowUp({ ...base, clearsFollowUp: true })).toBe(true);
  });
});

describe("planFollowUpDigests", () => {
  it("sends a coordinator their own overdue and due-today rows, oldest overdue first", () => {
    const a = kase({ caseNumber: 2002 });
    const b = kase({ caseNumber: 2001 });
    const c = kase({ caseNumber: 2003 });
    const later = kase({ caseNumber: 2004 });
    const result = plan({
      cases: [a, b, c, later],
      touchpoints: [
        touch(a.id, "2026-10-01", TODAY),
        touch(b.id, "2026-10-01", "2026-10-29"),
        touch(c.id, "2026-10-01", "2026-10-20"),
        touch(later.id, "2026-10-01", "2026-11-02"),
      ],
    });
    expect(result.digests).toHaveLength(1);
    const [only] = result.digests;
    expect(only.recipientUserId).toBe(JANE);
    expect(only.email).toBe("jane@example.test");
    expect(only.data.followUps.rows.map((r) => [r.caseNumber, r.status])).toEqual([
      [2003, "overdue"],
      [2001, "overdue"],
      [2002, "due_today"],
    ]);
    expect(only.data.followUps).toMatchObject({ overdue: 2, dueToday: 1, more: 0 });
    expect(only.data.followUps.rows[0]).toEqual({
      caseNumber: 2003,
      caseLink: `${BASE}/cases/${c.id}`,
      providerName: c.providerName,
      payerName: "Aetna",
      dueDate: "2026-10-20",
      status: "overdue",
    });
    expect(only.data).toMatchObject({
      practiceName: "Shelby Rehab",
      recipientFirstName: "Jane",
      digestDate: TODAY,
      workQueueLink: `${BASE}/work`,
    });
  });

  it("gives each coordinator one email with only their own rows, in member order", () => {
    const janes = kase({ assignedTo: JANE });
    const omars = kase({ assignedTo: OMAR });
    const result = plan({
      cases: [omars, janes],
      touchpoints: [
        touch(janes.id, "2026-10-01", TODAY),
        touch(omars.id, "2026-10-01", "2026-10-02"),
      ],
    });
    expect(result.digests.map((d) => d.recipientUserId)).toEqual([JANE, OMAR]);
    expect(result.digests[0].data.followUps.rows.map((r) => r.caseNumber)).toEqual([
      janes.caseNumber,
    ]);
    expect(result.digests[1].data.followUps.rows.map((r) => r.caseNumber)).toEqual([
      omars.caseNumber,
    ]);
  });

  it("sends unassigned and former-member follow-ups to no one, and counts them", () => {
    const mine = kase({ assignedTo: JANE });
    const nobody = kase({ assignedTo: null });
    const leaver = kase({ assignedTo: FORMER });
    const notDue = kase({ assignedTo: null });
    const result = plan({
      cases: [mine, nobody, leaver, notDue],
      touchpoints: [
        ...[mine, nobody, leaver].map((c) => touch(c.id, "2026-10-01", "2026-10-30")),
        touch(notDue.id, "2026-10-01", "2026-11-30"),
      ],
    });
    // Ada is an admin with no cases: nothing, not even the unassigned rows.
    expect(result.digests.map((d) => d.recipientUserId)).toEqual([JANE]);
    expect(result.digests[0].data.followUps.rows.map((r) => r.caseNumber)).toEqual([
      mine.caseNumber,
    ]);
    expect(result.unassignedFollowUps).toBe(2);
    expect(JSON.stringify(result.digests)).not.toContain(nobody.id);
    expect(JSON.stringify(result.digests)).not.toContain(leaver.id);
  });

  it("suppresses a coordinator with nothing due, and plans nothing for a member with no case", () => {
    const upcoming = kase({ assignedTo: JANE });
    const closed = kase({ assignedTo: OMAR, caseStatus: "approved" });
    const result = plan({
      cases: [upcoming, closed],
      touchpoints: [
        touch(upcoming.id, "2026-10-01", "2026-11-10"),
        touch(closed.id, "2026-10-01", "2026-10-02"),
      ],
    });
    expect(result.digests).toEqual([]);
    // Only Jane coordinates an open case; Omar's is closed, Ada has none.
    expect(result.suppressed).toBe(1);
    expect(result.unassignedFollowUps).toBe(0);
  });

  it("caps the rows and counts the rest", () => {
    const cases = Array.from({ length: MAX_DIGEST_SECTION_ROWS + 7 }, () => kase());
    const result = plan({
      cases,
      touchpoints: cases.map((c) => touch(c.id, "2026-10-01", "2026-10-15")),
    });
    const { followUps } = result.digests[0].data;
    expect(followUps.rows).toHaveLength(MAX_DIGEST_SECTION_ROWS);
    expect(followUps.more).toBe(7);
    expect(followUps.overdue).toBe(MAX_DIGEST_SECTION_ROWS + 7);
  });

  it("carries only the declared fields: no case id, provider id, at-risk or team data", () => {
    const c = kase();
    const result = plan({ cases: [c], touchpoints: [touch(c.id, "2026-10-01", TODAY)] });
    const data = result.digests[0].data;
    expect(Object.keys(data).sort()).toEqual([
      "digestDate",
      "followUps",
      "practiceName",
      "recipientFirstName",
      "workQueueLink",
    ]);
    expect(Object.keys(data.followUps).sort()).toEqual(["dueToday", "more", "overdue", "rows"]);
    expect(Object.keys(data.followUps.rows[0]).sort()).toEqual([
      "caseLink",
      "caseNumber",
      "dueDate",
      "payerName",
      "providerName",
      "status",
    ]);
    expect(Object.keys(result).sort()).toEqual(["digests", "suppressed", "unassignedFollowUps"]);
  });

  it("exports no at-risk or cc routing (Sowmya, Oct 30)", () => {
    for (const gone of [
      "caseAtRisk",
      "AWAITING_DECISION_STATUSES",
      "resolveDigestCc",
      "memberDisplayName",
    ]) {
      expect(Object.hasOwn(digest, gone), gone).toBe(false);
    }
  });
});

/* -------- FollowUpDigestRules (policy as configuration, MINT-113) -------- */

describe("FollowUpDigestRules: the decided default", () => {
  it("catches up until local midnight (D77): null", () => {
    expect(DEFAULT_FOLLOW_UP_DIGEST_RULES).toEqual({ catchUpUntilLocalHour: null });
    expect(Object.isFrozen(DEFAULT_FOLLOW_UP_DIGEST_RULES)).toBe(true);
    expect(CATCH_UP_UNTIL_MIDNIGHT).toBe(24);
  });
});

describe("resolveFollowUpDigestRules: org over platform over default", () => {
  it("gives the defaults with no layers", () => {
    expect(resolveFollowUpDigestRules()).toEqual(DEFAULT_FOLLOW_UP_DIGEST_RULES);
    expect(resolveFollowUpDigestRules(null, null)).toEqual(DEFAULT_FOLLOW_UP_DIGEST_RULES);
  });

  it("takes the platform over the default, and the org over the platform", () => {
    expect(resolveFollowUpDigestRules({ catchUpUntilLocalHour: 18 })).toEqual({
      catchUpUntilLocalHour: 18,
    });
    expect(
      resolveFollowUpDigestRules({ catchUpUntilLocalHour: 18 }, { catchUpUntilLocalHour: 12 }),
    ).toEqual({ catchUpUntilLocalHour: 12 });
    expect(resolveFollowUpDigestRules(null, { catchUpUntilLocalHour: 20 })).toEqual({
      catchUpUntilLocalHour: 20,
    });
  });

  it("inherits on null or undefined, and spells an explicit midnight 24", () => {
    expect(
      resolveFollowUpDigestRules({ catchUpUntilLocalHour: 18 }, { catchUpUntilLocalHour: null }),
    ).toMatchObject({ catchUpUntilLocalHour: 18 });
    // An org can go back to midnight under a platform cut-off: 24, resolved as null.
    expect(
      resolveFollowUpDigestRules(
        { catchUpUntilLocalHour: 18 },
        { catchUpUntilLocalHour: CATCH_UP_UNTIL_MIDNIGHT },
      ),
    ).toMatchObject({ catchUpUntilLocalHour: null });
  });

  it("skips a value of the wrong shape like a missing one", () => {
    const junk = { catchUpUntilLocalHour: 25 } as never;
    expect(resolveFollowUpDigestRules(junk)).toEqual(DEFAULT_FOLLOW_UP_DIGEST_RULES);
    for (const bad of [0, -1, 7.5, "18", true]) {
      expect(
        resolveFollowUpDigestRules({ catchUpUntilLocalHour: 18 }, {
          catchUpUntilLocalHour: bad,
        } as never).catchUpUntilLocalHour,
      ).toBe(18);
    }
  });
});

describe("digestSlot with the catch-up rule", () => {
  it("catches up through 11 pm with the default, the same as no rules passed", () => {
    for (const iso of ["2026-10-31T13:00:00Z", "2026-10-31T22:00:00Z", "2026-11-01T04:59:00Z"]) {
      expect(digestSlot(CHICAGO, at(iso), DEFAULT_FOLLOW_UP_DIGEST_RULES)).toEqual(
        digestSlot(CHICAGO, at(iso)),
      );
    }
    expect(digestSlot(CHICAGO, at("2026-11-01T04:59:00Z"), DEFAULT_FOLLOW_UP_DIGEST_RULES)).toEqual(
      once("due", "2026-10-31", 23),
    );
  });

  it("stops catching up at a cut-off hour, on the same local date", () => {
    const noon = { catchUpUntilLocalHour: 12 };
    // 11 am Central (16:00 UTC, CDT) is still due; noon is not.
    expect(digestSlot(CHICAGO, at("2026-10-31T16:59:00Z"), noon)).toEqual(
      once("due", "2026-10-31", 11),
    );
    expect(digestSlot(CHICAGO, at("2026-10-31T17:00:00Z"), noon)).toEqual(
      once("past_catch_up", "2026-10-31", 12),
    );
    // Never before the send hour, cut-off or not.
    expect(digestSlot(CHICAGO, at("2026-10-31T12:00:00Z"), noon)).toMatchObject({ due: false });
  });

  it("is never due when the cut-off is at or before the send hour: nothing checks it (no validator)", () => {
    for (let h = 0; h < 24; h += 1) {
      const now = new Date(Date.UTC(2026, 9, 31, 5 + h));
      expect(digestSlot(CHICAGO, now, { catchUpUntilLocalHour: 8 })?.due).toBe(false);
    }
  });
});

const WEEKLY = { ...CHICAGO, digestFrequency: "weekly" as const, digestWeekday: 1 };
const TWICE = { ...CHICAGO, digestFrequency: "twice_daily" as const, secondSendHour: 14 };

/** The ledger's slot alphabet (notification_sends_slot_check). */
const SLOT_RE = /^[0-9A-Za-z:_-]{1,64}$/;

describe("digestSlot: daily, weekly or twice a day (A8)", () => {
  it("sends daily once from the send hour; a missing or unknown frequency is not set up (G2)", () => {
    expect(digestSlot(CHICAGO, at("2026-10-31T12:00:00Z"))).toEqual(
      once("not_yet", "2026-10-31", 7),
    );
    expect(digestSlot(CHICAGO, at("2026-10-31T13:00:00Z"))).toEqual(once("due", "2026-10-31", 8));
    for (const iso of ["2026-10-31T12:00:00Z", "2026-10-31T13:00:00Z", "2026-11-01T04:59:00Z"]) {
      expect(digestSlot({ ...CHICAGO, digestFrequency: null }, at(iso))).toBeNull();
      expect(
        digestSlot({ ...CHICAGO, digestFrequency: "hourly" as unknown as "daily" }, at(iso)),
      ).toBeNull();
    }
  });

  it("sends weekly only on its day (Monday here), from the send hour to local midnight", () => {
    // Nov 2 2026 is a Monday; DST has ended, so 8 am Central is 14:00 UTC.
    expect(digestSlot(WEEKLY, at("2026-11-02T13:59:00Z"))).toEqual(
      once("not_yet", "2026-11-02", 7),
    );
    expect(digestSlot(WEEKLY, at("2026-11-02T14:00:00Z"))).toEqual(once("due", "2026-11-02", 8));
    expect(digestSlot(WEEKLY, at("2026-11-03T05:59:00Z"))).toEqual(once("due", "2026-11-02", 23));
    // Tuesday, and every other day, is not its day, whatever the hour.
    expect(digestSlot(WEEKLY, at("2026-11-03T06:00:00Z"))).toEqual(
      once("not_today", "2026-11-03", 0),
    );
    for (let day = 3; day <= 8; day += 1) {
      const now = new Date(Date.UTC(2026, 10, day, 15));
      expect(digestSlot(WEEKLY, now)?.state).toBe("not_today");
    }
    // There is no default day (G2): a missing or unknown one is not set up.
    expect(digestSlot({ ...WEEKLY, digestWeekday: null }, at("2026-11-02T14:00:00Z"))).toBeNull();
    expect(digestSlot({ ...WEEKLY, digestWeekday: 9 }, at("2026-11-02T14:00:00Z"))).toBeNull();
  });

  it("reads the weekday off the org's own wall clock, not UTC's", () => {
    // Sunday 23:00 UTC is already Monday 8 am in Tokyo.
    const tokyo = { ...WEEKLY, sendTimeZone: "Asia/Tokyo" };
    expect(digestSlot(tokyo, at("2026-11-01T23:00:00Z"))).toEqual(once("due", "2026-11-02", 8));
    // Monday 14:00 UTC is 11 pm Monday in Tokyo: still its day.
    expect(digestSlot(tokyo, at("2026-11-02T14:00:00Z"))?.due).toBe(true);
    // Monday 15:00 UTC is Tuesday in Tokyo.
    expect(digestSlot(tokyo, at("2026-11-02T15:00:00Z"))?.state).toBe("not_today");
    // And Monday 03:00 UTC is still Sunday evening in Chicago.
    expect(digestSlot(WEEKLY, at("2026-11-02T03:00:00Z"))).toEqual(
      once("not_today", "2026-11-01", 21),
    );
  });

  it("goes on Minted's chosen day: Friday (5), Sunday (7)", () => {
    expect(digestSlot({ ...WEEKLY, digestWeekday: 5 }, at("2026-11-06T14:00:00Z"))?.due).toBe(true);
    expect(digestSlot({ ...WEEKLY, digestWeekday: 5 }, at("2026-11-02T14:00:00Z"))?.state).toBe(
      "not_today",
    );
    // Sunday Nov 1 2026, the day DST ends: 8 am CST is 14:00 UTC.
    expect(digestSlot({ ...WEEKLY, digestWeekday: 7 }, at("2026-11-01T14:00:00Z"))?.due).toBe(true);
  });

  it("sends twice a day: the first from the send hour until the second hour, the second until midnight", () => {
    const first = (localHour: number, localDate = "2026-10-31") => ({
      due: true,
      state: "due",
      localDate,
      localHour,
      send: 1,
      slot: localDate,
    });
    const second = (localHour: number, localDate = "2026-10-31") => ({
      due: true,
      state: "due",
      localDate,
      localHour,
      send: 2,
      slot: `${localDate}:2`,
    });
    // Oct 31 is CDT: 8 am is 13:00 UTC, 2 pm is 19:00 UTC.
    expect(digestSlot(TWICE, at("2026-10-31T12:59:00Z"))).toEqual(once("not_yet", "2026-10-31", 7));
    expect(digestSlot(TWICE, at("2026-10-31T13:00:00Z"))).toEqual(first(8));
    expect(digestSlot(TWICE, at("2026-10-31T18:59:00Z"))).toEqual(first(13));
    expect(digestSlot(TWICE, at("2026-10-31T19:00:00Z"))).toEqual(second(14));
    expect(digestSlot(TWICE, at("2026-11-01T04:59:00Z"))).toEqual(second(23));
    // Local midnight starts the next date's first send.
    expect(digestSlot(TWICE, at("2026-11-01T05:00:00Z"))).toEqual(once("not_yet", "2026-11-01", 0));
    for (const iso of ["2026-10-31T13:00:00Z", "2026-10-31T19:00:00Z"]) {
      expect(digestSlot(TWICE, at(iso))?.slot).toMatch(SLOT_RE);
    }
  });

  it("is not set up when the second hour is missing, unusable or not after the send hour", () => {
    for (const secondSendHour of [null, 8, 6, 24]) {
      expect(digestSlot({ ...TWICE, secondSendHour }, at("2026-10-31T19:00:00Z"))).toBeNull();
    }
  });

  it("keeps twice a day's two sends across DST ending, the repeated hour on one slot", () => {
    // Nov 1 2026 in Chicago: 1 am CDT (06:00 UTC), then 1 am CST (07:00 UTC).
    const atOne = { ...TWICE, sendHour: 1, secondSendHour: 2 };
    expect(digestSlot(atOne, at("2026-11-01T06:00:00Z"))?.slot).toBe("2026-11-01");
    expect(digestSlot(atOne, at("2026-11-01T07:00:00Z"))?.slot).toBe("2026-11-01");
    // 2 am CST is 08:00 UTC.
    expect(digestSlot(atOne, at("2026-11-01T08:00:00Z"))?.slot).toBe("2026-11-01:2");
    // 8 am and 2 pm CST: 14:00 and 20:00 UTC.
    expect(digestSlot(TWICE, at("2026-11-01T14:00:00Z"))?.slot).toBe("2026-11-01");
    expect(digestSlot(TWICE, at("2026-11-01T19:59:00Z"))?.slot).toBe("2026-11-01");
    expect(digestSlot(TWICE, at("2026-11-01T20:00:00Z"))?.slot).toBe("2026-11-01:2");
  });

  it("across DST starting, a skipped hour is caught by the next: one send each, or only the second", () => {
    // Mar 14 2027 in Chicago: 1:59 am CST (07:59 UTC), then 3:00 am CDT (08:00 UTC).
    const skippedSecond = { ...TWICE, sendHour: 1, secondSendHour: 2 };
    expect(digestSlot(skippedSecond, at("2027-03-14T07:00:00Z"))?.slot).toBe("2027-03-14");
    expect(digestSlot(skippedSecond, at("2027-03-14T08:00:00Z"))).toMatchObject({
      due: true,
      localHour: 3,
      send: 2,
      slot: "2027-03-14:2",
    });
    // When the skipped hour is the first send's and the second comes right
    // after, the day keeps one send: the second, which lists the same.
    const skippedFirst = { ...TWICE, sendHour: 2, secondSendHour: 3 };
    expect(digestSlot(skippedFirst, at("2027-03-14T07:00:00Z"))?.state).toBe("not_yet");
    expect(digestSlot(skippedFirst, at("2027-03-14T08:00:00Z"))).toMatchObject({
      due: true,
      send: 2,
      slot: "2027-03-14:2",
    });
    // A skipped first hour with room before the second: it goes at 3 am.
    const roomy = { ...TWICE, sendHour: 2, secondSendHour: 14 };
    expect(digestSlot(roomy, at("2027-03-14T08:00:00Z"))).toMatchObject({
      due: true,
      send: 1,
      slot: "2027-03-14",
    });
  });

  it("applies the catch-up cut-off to the day's last send only", () => {
    const sixPm = { catchUpUntilLocalHour: 18 };
    // 1 pm: the first send is open; the cut-off does not touch it.
    expect(digestSlot(TWICE, at("2026-10-31T18:00:00Z"), sixPm)).toMatchObject({
      due: true,
      send: 1,
    });
    // 5 pm: the second is open; 6 pm: past the cut-off.
    expect(digestSlot(TWICE, at("2026-10-31T22:00:00Z"), sixPm)).toMatchObject({
      due: true,
      send: 2,
    });
    expect(digestSlot(TWICE, at("2026-10-31T23:00:00Z"), sixPm)).toMatchObject({
      due: false,
      state: "past_catch_up",
      send: 2,
      slot: "2026-10-31:2",
    });
    // A weekly digest past the cut-off on its day.
    expect(digestSlot(WEEKLY, at("2026-11-03T00:00:00Z"), sixPm)?.state).toBe("past_catch_up");
  });
});

describe("the schedule's helpers", () => {
  it("reads ISO weekdays and keys the second send apart", () => {
    expect(["2026-11-01", "2026-11-02", "2026-11-06"].map(isoWeekday)).toEqual([7, 1, 5]);
    expect(() => isoWeekday("2026-02-30")).toThrow(RangeError);
    expect(digestSlotKey("2026-10-31", 1)).toBe("2026-10-31");
    expect(digestSlotKey("2026-10-31", 2)).toBe("2026-10-31:2");
    expect(digestSlotKey("2026-10-31", 2)).toMatch(SLOT_RE);
  });
});

describe("never look ahead (A14)", () => {
  it("lists no upcoming follow-up for any frequency: the plan has no horizon to set", () => {
    const soon = kase({ assignedTo: JANE });
    const result = plan({
      cases: [soon],
      touchpoints: [touch(soon.id, "2026-10-30", "2026-11-01")],
    });
    expect(result.digests).toEqual([]);
    expect(result.suppressed).toBe(1);
    // No rule or input can widen it.
    expect(Object.keys(DEFAULT_FOLLOW_UP_DIGEST_RULES)).toEqual(["catchUpUntilLocalHour"]);
  });
});
