// Scheduled jobs (MINT-106): the contract a job implements.
//
// Vercel cron calls GET /api/jobs/<name> (./route.ts), which runs the job
// (./runner.ts) and answers with its integer counts. There is no run ledger:
// every call runs the job, so a second call, a retry or two overlapping calls
// each run it again. A job whose work has side effects (one email per
// recipient, say) keeps its own idempotency: it records each side effect
// under a unique key and skips the ones already done.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** Integer tallies a run reports, e.g. `{ orgs: 3, sent: 2, failed: 1 }`.
 *  Keys are snake_case (`JOB_COUNT_KEY_RE`), values non-negative safe
 *  integers (./counts.ts). Never row data. */
export type JobCounts = Readonly<Record<string, number>>;

/** What one call to /api/jobs/<name> did. */
export type JobOutcome = "succeeded" | "failed";

export interface JobLogger {
  /** Logs one allowlisted line through safeLog's `logServerError` and returns
   *  its correlation id. `event` is a snake_case code literal such as
   *  `"org_send_failed"`; anything else is logged as `invalid_event`. The
   *  error is reduced to its SQLSTATE, constraint and class, never its text. */
  error(event: string, error: unknown): string;
}

export interface JobContext {
  /** The service-role client. It bypasses RLS, so a job that reads tenant
   *  rows scopes every query by org itself. */
  db: SupabaseClient<Database>;
  /** The request time, and the job's only clock. */
  now: Date;
  log: JobLogger;
}

export interface JobDefinition {
  /** The /api/jobs/<name> path segment, matching `JOB_NAME_RE`. */
  name: string;
  /** Every count key the job may report, e.g. `["orgs", "sent", "failed"]`.
   *  A run that reports any other key fails as `invalid_counts`, so a name or
   *  a date cannot ride in as a key. A run may report a subset. */
  countKeys: readonly string[];
  run: (ctx: JobContext) => Promise<JobCounts>;
}

/** Every job the cron route can run, by name. */
export type JobRegistry = ReadonlyMap<string, JobDefinition>;
