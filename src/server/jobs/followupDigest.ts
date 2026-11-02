// The coordinator follow-up digest job (MINT-108): its registry entry.
//
// Mechanism (Sowmya, Oct 30: the send hour is per org, set by Minted; Oct
// 31, A8: daily, weekly or twice a day). GET /api/jobs/followup-digest is
// called every hour, and each call sends to every org whose digest is on and
// set up (G2: Minted sets its schedule; there is no default) and one of whose
// scheduled sends is open: its local hour, in the org's zone, is at or after
// that send's hour (the send hour, or for twice a day the second send hour; a
// weekly digest only on its weekday). "At or after" lets a missed or failed
// call catch up later; nothing goes out before the hour. See
// ./followupDigestRun.ts.
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
// There is no run ledger (MINT-106): every call runs the job. What a send is
// once-only for is its slot in notification_sends: the scheduled send's, the
// org's local date or `YYYY-MM-DD:2` for a twice-a-day second send. Each
// coordinator gets each scheduled send at most once per org, whatever the
// hour, the zone, the frequency or the number of calls (the tick and the
// Vercel backup may even overlap).
//
// The work lives in ./followupDigestRun.ts and is imported when the job runs,
// so the registry, the cron route and their tests stay free of the Supabase
// client graph (the api.ts lazy-route precedent).
import type { JobDefinition } from "./types";

export const FOLLOWUP_DIGEST_JOB_NAME = "followup-digest";

/** Every count the digest reports. Integers only (./counts.ts). Each skip
 *  and failure is also logged, one line each. */
export const FOLLOWUP_DIGEST_COUNT_KEYS = [
  /** Orgs whose digest is on, set up, and has a scheduled send open. */
  "orgs_due",
  /** Due orgs whose reads failed; the next hourly run tries them again. */
  "orgs_failed",
  /** Due orgs whose step fails the template check (U6): their coordinators
   *  are skipped, with no fallback digest. */
  "orgs_skipped_template",
  /** Emails the provider accepted in this run. */
  "digests_sent",
  /** Coordinators with nothing overdue or due today: no email (A16). */
  "digests_suppressed",
  /** Overdue or due-today follow-ups on unassigned cases: sent to no one. */
  "unassigned_follow_ups",
  /** Sends that did not go out for sure: the claim failed, the provider
   *  definitely rejected it (marked failed; a later run retries it), or it
   *  may have been delivered (left claimed, never resent). */
  "send_failures",
] as const;

export type FollowUpDigestCountKey = (typeof FOLLOWUP_DIGEST_COUNT_KEYS)[number];
export type FollowUpDigestCounts = Record<FollowUpDigestCountKey, number>;

export const followupDigestJob: JobDefinition = {
  name: FOLLOWUP_DIGEST_JOB_NAME,
  countKeys: FOLLOWUP_DIGEST_COUNT_KEYS,
  async run(ctx) {
    const { runFollowUpDigest } = await import("./followupDigestRun");
    return runFollowUpDigest(ctx);
  },
};
