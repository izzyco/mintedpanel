// MINT-108 — the coordinator follow-up digest: the pure rules. The job that
// reads the rows and sends the emails is src/server/jobs/followupDigestRun.ts;
// the email body is `followup_digest_daily` in src/server/email/templates.ts,
// which renders FollowUpDigestEmailData below.
//
// What is listed. Open cases only (OPEN_CASE_STATUSES; A15, Oct 31: a
// per-status flag may come later). A case's follow-up is the carry-forward
// reducer's active follow-up over its touchpoints (resolveActiveFollowUp),
// and its status is followUpStatus against `today`. Overdue and due-today
// follow-ups are listed. Never anything ahead (A14, Oct 31): an upcoming
// follow-up is not listed, whatever the frequency, so a weekly digest lists
// what is overdue or due on its own day. A coordinator with nothing listed
// gets nothing (A16, Oct 31).
//
// When it goes out, and what "today" is (digestSlot). The job is called
// every hour. How often and when an org's digest goes out is its schedule
// (A8, Oct 31; resolveNotificationSequence): the frequency, weekday, send
// hour, zone and second send hour that Minted sets on the org's row, all five
// together (A10). There is no default schedule (G2, Nov 1): an org Minted has
// not set up has none, and is not due.
//   * daily: once, from the send hour;
//   * weekly: once, from the send hour, on the weekly weekday in the org's
//     zone;
//   * twice a day: from the send hour, and again from the second send hour,
//     both in the org's zone.
// Each scheduled send is due from its hour ("at or after", so a missed or
// failed run catches up later; never before it) until the next send's hour,
// or for the day's last send until the catch-up cut-off
// (FollowUpDigestRules.catchUpUntilLocalHour; local midnight by default,
// D77). A twice-a-day first send not made by the second hour is not made
// that day: the second carries the same list. "Today" is the org's local date
// at the run. Each scheduled send has its own slot: the local date, and
// `YYYY-MM-DD:2` for twice a day's second send. The per-recipient send claim
// keys on it, so a rerun, a later hour, a changed hour or a changed zone
// cannot send a scheduled send twice. The hour is read off the zone's wall
// clock at the run's instant, so a repeated hour (DST ends) stays the same
// local date, and a skipped hour (DST starts) is caught by "at or after". No
// clock read here: `now` is passed in.
//
// Two edges follow from keying on the local date (D78, accepted). A day's
// last send at 23:00 is due in one hourly call only, so it gets one attempt.
// And a zone change moves the local date with it: moving an org west across
// the date line (Honolulu to Tokyo) can skip a date, and moving it east can
// send a digest for an earlier date hours after the last.
//
// No at-risk flag (Sowmya, Oct 30). `payers.avg_decision_days` has no writer
// yet, so a flag built on it would rarely fire and could not be trusted. It
// returns once MINT-111 ("decision time from closed cases") gives payers a
// real decision time.
//
// Who gets what. Coordinators only (Sowmya, Oct 30; the digest has no cc list
// since MINT-107).
//   * A coordinator is a current member assigned (credential_cases.assigned_to)
//     to at least one open case. Each gets one email with their own rows.
//   * An unassigned follow-up (no coordinator, or a coordinator who is no
//     longer a member) goes to no one, and is always counted (Oct 31; the
//     Work-queue routing is MINT-127).
//   * A coordinator with nothing due gets no email (suppressed).
//
// The catch-up cut-off is a setting (FollowUpDigestRules), resolved from the
// decided default (local midnight, D77), then a platform override, then an
// organization override (resolveFollowUpDigestRules). Nothing stores an
// override yet; the Mission Control setting is MINT-113, and the job reads
// the default through FollowUpDigestDeps.rules
// (src/server/jobs/followupDigestRun.ts).
//
// What an email may carry: the case number and link, the provider's display
// name, the payer's name, and the follow-up date and status. Never a touch
// note, an SSN, a date of birth or document contents: those are not in the
// inputs below.
import { isCaseStatus, isOpenCaseStatus } from "./caseStatus";
import { followUpStatus, resolveActiveFollowUp, type FollowUpTouch } from "./followUps";
import {
  digestScheduleOf,
  isIanaTimeZone,
  type DigestScheduleSettings,
} from "./notificationSequences";
import type { DigestFrequency } from "@/types";

/** The longest list one digest shows; the rest are counted as "more". */
export const MAX_DIGEST_SECTION_ROWS = 100;

/* ----------------------------------- Rules ----------------------------------- */

/** In an override, the explicit spelling of "until local midnight" (null inherits there). */
export const CATCH_UP_UNTIL_MIDNIGHT = 24;

/** The digest's policy rules. Each field names its default. */
export interface FollowUpDigestRules {
  /**
   * How late in the org's local day the day's last scheduled send still goes
   * out when it was missed. null (default, D77: as built): until local
   * midnight, so every hourly run from that send's hour through the 23:00
   * hour catches up. A whole hour H from 1 to 23: only runs whose local hour
   * is before H. A twice-a-day first send's window always ends at the second
   * send hour.
   */
  catchUpUntilLocalHour: number | null;
}

/** The decided default: Sowmya's Oct 31 answer (until midnight, D77). */
export const DEFAULT_FOLLOW_UP_DIGEST_RULES: Readonly<FollowUpDigestRules> = Object.freeze({
  catchUpUntilLocalHour: null,
});

/**
 * A platform or organization override. A null or missing field inherits, so
 * "until local midnight" is spelled CATCH_UP_UNTIL_MIDNIGHT (24) here.
 */
export type FollowUpDigestRulesOverride = {
  readonly [K in keyof FollowUpDigestRules]?: FollowUpDigestRules[K] | null;
};

function isCatchUpHour(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= CATCH_UP_UNTIL_MIDNIGHT
  );
}

/**
 * The organization's value, else the platform's, else the default. null or
 * undefined inherits; a value of the wrong shape is skipped like a missing
 * one. A cut-off of 24 resolves to null (local midnight).
 */
export function resolveFollowUpDigestRules(
  platform?: FollowUpDigestRulesOverride | null,
  organization?: FollowUpDigestRulesOverride | null,
): FollowUpDigestRules {
  let cutOff = DEFAULT_FOLLOW_UP_DIGEST_RULES.catchUpUntilLocalHour;
  for (const override of [platform, organization]) {
    const value = override?.catchUpUntilLocalHour;
    if (isCatchUpHour(value)) cutOff = value;
  }
  return { catchUpUntilLocalHour: cutOff === CATCH_UP_UNTIL_MIDNIGHT ? null : cutOff };
}

export type DigestFollowUpStatus = "overdue" | "due_today";

/** One case as the job reads it. Names are display-ready. */
export interface DigestCase {
  id: string;
  caseNumber: number;
  assignedTo: string | null;
  caseStatus: string;
  providerName: string;
  payerName: string;
}

/** A touchpoint's follow-up fields, with its case. */
export interface DigestTouchpoint extends FollowUpTouch {
  caseId: string;
}

/** A current member of the org. */
export interface DigestMember {
  userId: string;
  /** The memberships row: what an advisory about this member names. */
  membershipId: string;
  firstName: string | null;
  email: string | null;
}

export interface FollowUpDigestRow {
  caseNumber: number;
  caseLink: string;
  providerName: string;
  payerName: string;
  /** YYYY-MM-DD */
  dueDate: string;
  status: DigestFollowUpStatus;
}

export interface FollowUpDigestSection {
  /** At most MAX_DIGEST_SECTION_ROWS, overdue first, oldest first. */
  rows: FollowUpDigestRow[];
  /** Rows beyond the cap. */
  more: number;
  /** Counted over every row, shown or not. */
  overdue: number;
  dueToday: number;
}

/** What the followup_digest_daily email renders: one coordinator's own rows. */
export interface FollowUpDigestEmailData {
  practiceName: string;
  recipientFirstName: string | null;
  /** The org's local date the digest is for, YYYY-MM-DD. */
  digestDate: string;
  workQueueLink: string;
  followUps: FollowUpDigestSection;
}

export interface PlannedDigest {
  recipientUserId: string;
  membershipId: string;
  /** From the member's profile; the sender checks it before sending. */
  email: string | null;
  data: FollowUpDigestEmailData;
}

export interface FollowUpDigestPlan {
  /** One per coordinator with something due, in member order. */
  digests: PlannedDigest[];
  /** Coordinators with nothing due: no email. */
  suppressed: number;
  /** Overdue or due-today follow-ups on unassigned cases: sent to no one. */
  unassignedFollowUps: number;
}

export interface FollowUpDigestPlanInput {
  practiceName: string;
  /** The org's local date, YYYY-MM-DD (digestSlot). */
  today: string;
  /** A bare origin such as https://app.example.com. */
  appBaseUrl: string;
  cases: readonly DigestCase[];
  touchpoints: readonly DigestTouchpoint[];
  members: readonly DigestMember[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

function requireDay(iso: string): void {
  if (!isCalendarDate(iso)) throw new RangeError(`Expected a YYYY-MM-DD date, got "${iso}"`);
}

/* ------------------------------ When it goes out ----------------------------- */

export interface ZonedDateHour {
  /** The wall-clock date in the zone, YYYY-MM-DD. */
  date: string;
  /** The wall-clock hour in the zone, 0 to 23. */
  hour: number;
}

/**
 * The wall-clock date and hour of `now` in an IANA time zone. Throws a
 * RangeError for a zone this runtime cannot format in.
 */
export function zonedDateHour(now: Date, timeZone: string): ZonedDateHour {
  if (!isIanaTimeZone(timeZone)) throw new RangeError(`"${timeZone}" is not a usable time zone`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  // Some engines spell midnight "24" even with h23.
  const hour = Number(part("hour")) % 24;
  if (!isCalendarDate(date) || !Number.isInteger(hour)) {
    throw new RangeError(`Could not read the wall clock in "${timeZone}"`);
  }
  return { date, hour };
}

/**
 * An org's effective digest schedule (resolveNotificationSequence): all five
 * values from the org's own row, set together by Minted (A10), or all null
 * when Minted has not set the digest up for the org (G2: there is no default
 * schedule). Not set up means not due: digestSlot returns null, and the job
 * passes the org by quietly. digestScheduleOf is the one test of "set up".
 */
export interface DigestSchedule {
  sendHour: number | null;
  sendTimeZone: string | null;
  digestFrequency: DigestFrequency | null;
  digestWeekday: number | null;
  secondSendHour: number | null;
}

/** The hours of the day's scheduled sends, in order: one, or two for twice a day. */
function sendHours(schedule: DigestScheduleSettings): number[] {
  return schedule.digestFrequency === "twice_daily"
    ? [schedule.sendHour, schedule.secondSendHour]
    : [schedule.sendHour];
}

/** The ISO weekday (1 = Monday to 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(iso: string): number {
  requireDay(iso);
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The slot of a scheduled send: the local date, or `date:2` for twice a day's second. */
export function digestSlotKey(localDate: string, send: 1 | 2): string {
  return send === 1 ? localDate : `${localDate}:2`;
}

/**
 * Where an org's digest stands at a run:
 *   due            one of the day's scheduled sends is open;
 *   not_yet        before the day's first send hour;
 *   not_today      a weekly digest, on another weekday in the org's zone;
 *   past_catch_up  after the catch-up cut-off, the day's last send unmade.
 */
export type DigestSlotState = "due" | "not_yet" | "not_today" | "past_catch_up";

export interface DigestSlot {
  /** True while one of the day's scheduled sends is open (state "due"). */
  due: boolean;
  state: DigestSlotState;
  /** The org's local date: the digest's "today". */
  localDate: string;
  localHour: number;
  /**
   * Which of the day's sends this is: the open one when due, the last one
   * past the cut-off, else the first. 2 only for twice a day.
   */
  send: 1 | 2;
  /** That send's key for the send claims (digestSlotKey). */
  slot: string;
}

/**
 * Whether an org's digest is due at `now`, which scheduled send, and for which
 * local date. Pass the effective schedule (resolveNotificationSequence) and
 * the resolved rules (resolveFollowUpDigestRules; default
 * DEFAULT_FOLLOW_UP_DIGEST_RULES). A weekly digest is scheduled only on its
 * weekday in the org's zone. Each scheduled send is due from its hour until
 * the next send's hour, and the day's last until the catch-up cut-off, local
 * midnight by default. Null when the org's digest is not set up (G2: no
 * schedule on its row, or one this runtime cannot use).
 */
export function digestSlot(
  schedule: DigestSchedule,
  now: Date,
  rules: Pick<FollowUpDigestRules, "catchUpUntilLocalHour"> = DEFAULT_FOLLOW_UP_DIGEST_RULES,
): DigestSlot | null {
  const set = digestScheduleOf(schedule);
  if (!set) return null;
  const { sendTimeZone } = set;
  let local: ZonedDateHour;
  try {
    local = zonedDateHour(now, sendTimeZone);
  } catch {
    return null;
  }
  const hours = sendHours(set);
  const at = (state: DigestSlotState, index: number): DigestSlot => {
    const send = index === 0 ? 1 : 2;
    return {
      due: state === "due",
      state,
      localDate: local.date,
      localHour: local.hour,
      send,
      slot: digestSlotKey(local.date, send),
    };
  };

  if (set.digestFrequency === "weekly" && isoWeekday(local.date) !== set.digestWeekday) {
    return at("not_today", 0);
  }

  // The send whose window holds this hour: the last one at or before it. Its
  // window ends at the next send's hour, which is after this hour by choice.
  let index = -1;
  hours.forEach((hour, i) => {
    if (local.hour >= hour) index = i;
  });
  if (index < 0) return at("not_yet", 0);
  if (index < hours.length - 1) return at("due", index);

  // The day's last send: due until the catch-up cut-off.
  const cutOff = rules.catchUpUntilLocalHour;
  return at(cutOff == null || local.hour < cutOff ? "due" : "past_catch_up", index);
}

/* -------------------------------- What is listed ------------------------------ */

export interface DueFollowUp {
  dueDate: string;
  status: DigestFollowUpStatus;
}

/**
 * The open cases whose active follow-up is overdue or due today, by case id.
 * Closed cases, upcoming follow-ups and cases with none are left out.
 */
export function dueFollowUps(
  cases: readonly Pick<DigestCase, "id" | "caseStatus">[],
  touchpoints: readonly DigestTouchpoint[],
  today: string,
): Map<string, DueFollowUp> {
  requireDay(today);
  const open = new Set(
    cases
      .filter((c) => isCaseStatus(c.caseStatus) && isOpenCaseStatus(c.caseStatus))
      .map((c) => c.id),
  );
  const byCase = new Map<string, FollowUpTouch[]>();
  for (const t of touchpoints) {
    if (!open.has(t.caseId)) continue;
    const list = byCase.get(t.caseId) ?? [];
    list.push({
      id: t.id,
      touchDate: t.touchDate.slice(0, 10),
      createdAt: t.createdAt,
      nextFollowUpDate: t.nextFollowUpDate ? t.nextFollowUpDate.slice(0, 10) : null,
      clearsFollowUp: t.clearsFollowUp,
    });
    byCase.set(t.caseId, list);
  }
  const due = new Map<string, DueFollowUp>();
  for (const [caseId, list] of byCase) {
    const active = resolveActiveFollowUp(list);
    if (!active) continue;
    const status = followUpStatus(active.date, today);
    if (status === "overdue" || status === "due_today") {
      due.set(caseId, { dueDate: active.date, status });
    }
  }
  return due;
}

/**
 * Whether a touch can decide a case's active follow-up: it sets a date or
 * clears one. resolveActiveFollowUp skips every other touch (a date-less touch
 * carries the prior follow-up forward), so reading only these touches gives
 * the same answer. src/services/followUpDigest.ts asks PostgREST for exactly
 * these (DIGEST_TOUCH_FILTER).
 */
export function touchCanResolveFollowUp(
  touch: Pick<FollowUpTouch, "nextFollowUpDate" | "clearsFollowUp">,
): boolean {
  return Boolean(touch.nextFollowUpDate) || touch.clearsFollowUp;
}

function compareRows(a: FollowUpDigestRow, b: FollowUpDigestRow): number {
  if (a.status !== b.status) return a.status === "overdue" ? -1 : 1;
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return a.caseNumber - b.caseNumber;
}

function buildSection(rows: readonly FollowUpDigestRow[]): FollowUpDigestSection {
  const sorted = [...rows].sort(compareRows);
  return {
    rows: sorted.slice(0, MAX_DIGEST_SECTION_ROWS),
    more: Math.max(0, sorted.length - MAX_DIGEST_SECTION_ROWS),
    overdue: sorted.filter((r) => r.status === "overdue").length,
    dueToday: sorted.filter((r) => r.status === "due_today").length,
  };
}

/** Every digest to send for one org on its local date, and what was held back. */
export function planFollowUpDigests(input: FollowUpDigestPlanInput): FollowUpDigestPlan {
  const { today, appBaseUrl } = input;
  const due = dueFollowUps(input.cases, input.touchpoints, today);
  const memberIds = new Set(input.members.map((m) => m.userId));

  // Every current member assigned an open case, with their due rows (maybe none).
  const rowsByCoordinator = new Map<string, FollowUpDigestRow[]>();
  let unassignedFollowUps = 0;
  for (const c of input.cases) {
    if (!isCaseStatus(c.caseStatus) || !isOpenCaseStatus(c.caseStatus)) continue;
    const owner = c.assignedTo !== null && memberIds.has(c.assignedTo) ? c.assignedTo : null;
    const rows = owner ? (rowsByCoordinator.get(owner) ?? []) : null;
    if (owner && rows) rowsByCoordinator.set(owner, rows);
    const followUp = due.get(c.id);
    if (!followUp) continue;
    if (!rows) {
      // Sent to no one, always counted (MINT-127 adds the Work-queue routing).
      unassignedFollowUps += 1;
      continue;
    }
    rows.push({
      caseNumber: c.caseNumber,
      caseLink: `${appBaseUrl}/cases/${encodeURIComponent(c.id)}`,
      providerName: c.providerName,
      payerName: c.payerName,
      dueDate: followUp.dueDate,
      status: followUp.status,
    });
  }

  const digests: PlannedDigest[] = [];
  let suppressed = 0;
  for (const member of input.members) {
    const rows = rowsByCoordinator.get(member.userId);
    if (!rows) continue;
    if (rows.length === 0) {
      suppressed += 1;
      continue;
    }
    digests.push({
      recipientUserId: member.userId,
      membershipId: member.membershipId,
      email: member.email,
      data: {
        practiceName: input.practiceName,
        recipientFirstName: member.firstName?.trim() || null,
        digestDate: today,
        workQueueLink: `${appBaseUrl}/work`,
        followUps: buildSection(rows),
      },
    });
  }

  return { digests, suppressed, unassignedFollowUps };
}
