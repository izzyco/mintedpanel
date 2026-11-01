// The coordinator follow-up digest job (MINT-108): its registry entry.
//
// Mechanism (Sowmya, Oct 30: the send hour is per org, set by Minted; Oct
// 31, A8: daily, weekly or twice a day). GET /api/jobs/followup-digest is
// called every hour, and each call sends to every org whose digest is on and
// one of whose scheduled sends is open: its local hour, in its effective time
// zone, is at or after that send's hour (the send hour, or for twice a day
// the second send hour; a weekly digest only on its weekday), unless that
// org has already had that send. "At or after" lets a missed or failed call
// catch up later; nothing goes out before the hour. See ./followupDigestRun.ts.
//
// Who calls it. Production is on Vercel's Hobby plan, which allows a cron at
// most once a day per entry and fails a deploy with a more frequent one. So:
//   * The hourly tick is a GitHub Actions schedule,
//     .github/workflows/followup-digest-tick.yml (7 minutes past each hour),
//     with the same CRON_SECRET bearer Vercel cron would send.
//   * vercel.json keeps one daily backup at 18:00 UTC, when every US zone's
//     8 am has passed (8 am in Hawaii). It only ever catches up: GitHub runs
//     schedules on the default branch only, and may delay or skip them under
//     load. It does not reach a twice-a-day second send at 2 pm in a US zone
//     (19:00 UTC or later), which relies on the hourly tick.
// crons.test.ts pins both.
//
// Two keys, on purpose:
//   * The run key (job_runs) is the UTC hour (`utcHourKey`), so each hourly
//     call is its own slot: a second call in the same hour (the Vercel backup
//     and the tick in hour 18, say) is skipped, and a failed run is retried
//     by the next call in that hour.
//   * The send slot (notification_sends, notification_org_slots) is the
//     scheduled send's: the org's local date, or `YYYY-MM-DD:2` for a
//     twice-a-day digest's second send. Each coordinator gets each scheduled
//     send at most once per org, whatever the hour, the zone, the frequency
//     or the number of calls.
//
// The work lives in ./followupDigestRun.ts and is imported when the job runs,
// so the registry, the cron route and their tests stay free of the Supabase
// client graph (the api.ts lazy-route precedent).
import type { JobDefinition } from "./types";

export const FOLLOWUP_DIGEST_JOB_NAME = "followup-digest";

/** The UTC hour of `now`, `YYYY-MM-DDTHH`: the digest's run key, one slot per
 *  hourly cron call. It matches RUN_KEY_RE as that stands, so neither the
 *  pattern nor its job_runs CHECK changes. */
export function utcHourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/** Every count the digest reports. Integers only (./counts.ts). */
export const FOLLOWUP_DIGEST_COUNT_KEYS = [
  /** Orgs whose digest is on. */
  "orgs_enabled",
  /** Of those, orgs with a scheduled send open (at or after its hour). */
  "orgs_due",
  /** Orgs before their day's first send hour, or a weekly digest on another
   *  day: nothing read. */
  "orgs_not_due",
  /** Orgs past their catch-up cut-off for the local date (FollowUpDigestRules):
   *  nothing read. Always 0 with the default (until local midnight). */
  "orgs_past_catch_up",
  /** Orgs whose catch-up cut-off is at or before their day's last send hour
   *  (that send would never go): run with the default, until local midnight,
   *  and counted. */
  "orgs_rules_fallback",
  /** Due orgs that already had their open scheduled send. */
  "orgs_already_completed",
  /** Orgs whose open scheduled send was settled on this attempt. */
  "orgs_completed",
  /** Orgs skipped because their effective send hour or time zone is unusable. */
  "orgs_skipped_send_time",
  /** Orgs skipped because their step's template fails the catalog check. */
  "orgs_skipped_template",
  /** Due orgs whose reads failed; the next hourly run tries them again. */
  "orgs_failed",
  /** Settled orgs whose completion could not be recorded; the next run
   *  re-checks them, and the send ledger keeps it from resending. */
  "orgs_completion_unrecorded",
  /** Emails the provider accepted on this attempt. */
  "digests_sent",
  /** Coordinators an earlier attempt already sent to for the scheduled send. */
  "digests_already_sent",
  /** Coordinators with nothing overdue or due today: no email. */
  "digests_suppressed",
  /** Coordinators with something due but no usable email address on their profile. */
  "recipients_skipped",
  /** Overdue or due-today follow-ups on unassigned cases: sent to no one. */
  "unassigned_follow_ups",
  /** Sends that definitely did not go out: the claim failed, or the mailer
   *  rejected it before or at SendGrid (a 4xx other than 408). A later attempt
   *  may retry them, unless the failure could not be recorded. */
  "send_failures",
  /** Sends that may have been delivered (network error, timeout, a SendGrid
   *  5xx or 408, an unexplained error): left claimed, never resent. */
  "sends_uncertain",
  /** Coordinators whose send already failed three times for the scheduled send. */
  "sends_exhausted",
  /** Coordinators another attempt claimed recently and may still be sending
   *  to: left to it, and the org's date stays open. */
  "sends_in_flight",
  /** Coordinators an earlier, finished attempt left claimed (maybe delivered,
   *  or a rejection it could not record): never resent. */
  "sends_held",
  /** Sends that went out but whose ledger row could not be finished. */
  "sends_unrecorded",
] as const;

export type FollowUpDigestCountKey = (typeof FOLLOWUP_DIGEST_COUNT_KEYS)[number];
export type FollowUpDigestCounts = Record<FollowUpDigestCountKey, number>;

export const followupDigestJob: JobDefinition = {
  name: FOLLOWUP_DIGEST_JOB_NAME,
  runKey: utcHourKey,
  countKeys: FOLLOWUP_DIGEST_COUNT_KEYS,
  async run(ctx) {
    const { runFollowUpDigest } = await import("./followupDigestRun");
    return runFollowUpDigest(ctx);
  },
};
