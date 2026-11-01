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
// and the org's completion record key on it, so a rerun, a changed hour or a
// changed zone cannot send a scheduled send twice. The hour is read off the
// zone's wall clock at the run's instant, so a repeated hour (DST ends) stays
// the same local date, and a skipped hour (DST starts) is caught by "at or
// after". No clock read here: `now` is passed in.
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
//     longer a member) goes to no one. The plan counts it; no row is built
//     (FollowUpDigestRules.unassignedFollowUps, "count_only", Oct 31).
//   * A coordinator with nothing due gets no email (suppressed).
//
// Business policy is configuration, never a constant: the two rules above
// that Sowmya decided are FollowUpDigestRules, resolved from the decided
// defaults, then a platform override, then an organization override, field
// by field (resolveFollowUpDigestRules); validateFollowUpDigestRules is the
// check an override must pass first. Nothing stores an override yet; the
// Mission Control setting is MINT-113, and the job reads the defaults through
// FollowUpDigestDeps.rules (src/server/jobs/followupDigestRun.ts).
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

/**
 * What happens to an overdue or due-today follow-up on an open case with no
 * current coordinator (no assignee, or one who is no longer a member).
 *   count_only  sent to no one, counted as unassigned_follow_ups (Oct 31).
 * MINT-127 adds a mode that lists them in every coordinator's Work queue; it
 * is not built here, so count_only is the only mode.
 */
export type UnassignedFollowUpMode = "count_only";

export const UNASSIGNED_FOLLOW_UP_MODES: readonly UnassignedFollowUpMode[] = ["count_only"];

/** In an override, the explicit spelling of "until local midnight" (null inherits there). */
export const CATCH_UP_UNTIL_MIDNIGHT = 24;

/** The digest's policy rules. Each field names its default. */
export interface FollowUpDigestRules {
  /** Unassigned follow-ups. Default "count_only" (Oct 31). */
  unassignedFollowUps: UnassignedFollowUpMode;
  /**
   * How late in the org's local day the day's last scheduled send still goes
   * out when it was missed. null (default, D77: as built): until local
   * midnight, so every hourly run from that send's hour through the 23:00
   * hour catches up. A whole hour H from 1 to 23: only runs whose local hour
   * is before H, so a send not made by H:00 is not made for that date. When
   * DST start skips the send's hour (midnight included, as in
   * America/Santiago), the first hour after it stands in for it, whatever
   * the cut-off. An H at or before the day's last send hour (the
   * send hour, or for twice a day the second send hour) would mean that send
   * is never due: it is invalid (catchUpRuleProblem), and the job falls back
   * to midnight and counts it. A twice-a-day first send's window always ends
   * at the second send hour.
   */
  catchUpUntilLocalHour: number | null;
}

/** The decided defaults: Sowmya's Oct 31 answers (count only; until midnight). */
export const DEFAULT_FOLLOW_UP_DIGEST_RULES: Readonly<FollowUpDigestRules> = Object.freeze({
  unassignedFollowUps: "count_only",
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

const RULE_CHECKS: { [K in keyof FollowUpDigestRules]: (value: unknown) => boolean } = {
  unassignedFollowUps: (value) =>
    typeof value === "string" && (UNASSIGNED_FOLLOW_UP_MODES as readonly string[]).includes(value),
  catchUpUntilLocalHour: isCatchUpHour,
};

/**
 * Field by field: the organization's value, else the platform's, else the
 * default. null or undefined inherits; a value of the wrong shape is skipped
 * like a missing one. A cut-off of 24 resolves to null (local midnight).
 */
export function resolveFollowUpDigestRules(
  platform?: FollowUpDigestRulesOverride | null,
  organization?: FollowUpDigestRulesOverride | null,
): FollowUpDigestRules {
  const pick = <K extends keyof FollowUpDigestRules>(key: K): FollowUpDigestRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && RULE_CHECKS[key](value)) return value as FollowUpDigestRules[K];
    }
    return DEFAULT_FOLLOW_UP_DIGEST_RULES[key];
  };
  const cutOff = pick("catchUpUntilLocalHour");
  return {
    unassignedFollowUps: pick("unassignedFollowUps"),
    catchUpUntilLocalHour: cutOff === CATCH_UP_UNTIL_MIDNIGHT ? null : cutOff,
  };
}

/** Why resolved rules cannot be applied to an org with this schedule, or null. */
export type CatchUpRuleProblem = "cut_off_not_after_send_hour";

/**
 * Pass the hour of the day's last scheduled send (lastDigestSendHour): the
 * send hour, or for twice a day the second send hour.
 */
export function catchUpRuleProblem(
  rules: Pick<FollowUpDigestRules, "catchUpUntilLocalHour">,
  lastSendHour: number | null,
): CatchUpRuleProblem | null {
  const cutOff = rules.catchUpUntilLocalHour;
  if (cutOff == null || cutOff >= CATCH_UP_UNTIL_MIDNIGHT || lastSendHour == null) return null;
  return cutOff <= lastSendHour ? "cut_off_not_after_send_hour" : null;
}

/**
 * Plain-language problems with an override (or resolved rules); empty when it
 * can go live. null leaves a rule to the layer below. Pass the org's
 * effective schedule (its send hour, and for twice a day its frequency and
 * second send hour) to also check that the cut-off leaves every scheduled
 * send a due hour.
 */
export function validateFollowUpDigestRules(
  rules: unknown,
  context: Partial<DigestSchedule> = {},
): string[] {
  if (rules == null || typeof rules !== "object" || Array.isArray(rules)) {
    return ["The follow-up digest rules must be a set of named values."];
  }
  const record = rules as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in RULE_CHECKS)) errors.push(`"${key}" is not a follow-up digest rule.`);
  }
  const mode = record.unassignedFollowUps;
  if (mode != null && !RULE_CHECKS.unassignedFollowUps(mode)) {
    errors.push('Unassigned follow-ups can only be counted for now ("count_only").');
  }
  const cutOff = record.catchUpUntilLocalHour;
  if (cutOff != null && !isCatchUpHour(cutOff)) {
    errors.push(
      "The catch-up cut-off must be a whole hour from 1 to 23, or 24 (or none) for local midnight.",
    );
  } else if (isCatchUpHour(cutOff)) {
    const last = lastDigestSendHour(context);
    if (catchUpRuleProblem({ catchUpUntilLocalHour: cutOff }, last)) {
      errors.push(
        last === context.sendHour
          ? `The catch-up cut-off (${cutOff}:00) must be after the send hour (${last}:00), or the digest never goes out.`
          : `The catch-up cut-off (${cutOff}:00) must be after the second send hour (${last}:00), or the second digest never goes out.`,
      );
    }
  }
  return errors;
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
  /** Resolved rules (resolveFollowUpDigestRules); default DEFAULT_FOLLOW_UP_DIGEST_RULES. */
  rules?: Pick<FollowUpDigestRules, "unassignedFollowUps">;
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

/**
 * The hour of the day's last scheduled send: the second send hour for twice
 * a day, else the send hour. The catch-up cut-off must be after it
 * (catchUpRuleProblem). Null when the org's digest is not set up.
 */
export function lastDigestSendHour(schedule: Partial<DigestSchedule>): number | null {
  const set = digestScheduleOf(schedule);
  if (!set) return null;
  const hours = sendHours(set);
  return hours[hours.length - 1];
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
  /** That send's hour: its first due hour, where once-per-send logging happens. */
  sendHour: number;
  /** That send's key for the claims and the completion row (digestSlotKey). */
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
      sendHour: hours[index],
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
  const hour = hours[index];
  const cutOff = rules.catchUpUntilLocalHour;
  let beforeCutOff = cutOff == null || local.hour < cutOff;
  if (!beforeCutOff && local.hour > hour) {
    // DST start can skip the send's hour (2 am on Mar 14 2027 in Chicago).
    // The first hour after it then stands in for it, so a cut-off just after
    // that hour still leaves that one attempt. Where DST start skips
    // midnight itself (America/Santiago on Sep 6 2026: 23:59 on the 5th, then
    // 1 am on the 6th), the hour before this one is on the previous date:
    // this is the local day's first hour, and every hour before it was
    // skipped, so it counts as "the hour before was before the send hour". On
    // any other day the hour before this one is on this date and at or after
    // the send's hour.
    try {
      const hourBefore = zonedDateHour(new Date(now.getTime() - 3_600_000), sendTimeZone);
      if (hourBefore.date !== local.date || hourBefore.hour < hour) beforeCutOff = true;
    } catch {
      // The zone formatted a moment ago; leave the cut-off as it is.
    }
  }
  return at(beforeCutOff ? "due" : "past_catch_up", index);
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
  const rules = input.rules ?? DEFAULT_FOLLOW_UP_DIGEST_RULES;
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
      // A fact, counted whatever the mode. The mode decides routing only:
      // count_only (the one mode until MINT-127) sends it to no one.
      unassignedFollowUps += 1;
      switch (rules.unassignedFollowUps) {
        case "count_only":
          break;
      }
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
