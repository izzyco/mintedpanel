// Runs one scheduled job (MINT-106).
//
// There is no run ledger: each call runs the job, and the job keeps its own
// idempotency (./types.ts). A throw or a malformed result is `failed`, logged
// as allowlisted identifiers only (../safeLog.ts). The job's error text never
// reaches the log or the response.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { logServerError, type ErrorLogSite } from "../safeLog";
import { validateJobCounts } from "./counts";
import type { JobCounts, JobDefinition, JobLogger, JobOutcome } from "./types";

const LOG_EVENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

// Thrown values whose class name is the whole log line's explanation.
export class InvalidJobCountsError extends Error {
  override name = "InvalidJobCountsError";
}

export interface RunJobDeps {
  db: SupabaseClient<Database>;
  now: Date;
  /** The method and route the run's log lines name. */
  site: ErrorLogSite;
}

export interface JobRunResult {
  job: string;
  outcome: JobOutcome;
  counts: JobCounts;
  /** Set on `failed`: the correlation id of the run's log line. */
  requestId?: string;
}

/** The logger a job receives: `[jobs:<name>] <event>` lines through
 *  logServerError. An event that is not a snake_case literal is replaced, so
 *  a job cannot put data in the scope by mistake. */
export function jobLogger(jobName: string, site: ErrorLogSite): JobLogger {
  return {
    error(event, error) {
      const safeEvent = LOG_EVENT_RE.test(event) ? event : "invalid_event";
      return logServerError(`[jobs:${jobName}] ${safeEvent}`, error, site);
    },
  };
}

export async function runJob(job: JobDefinition, deps: RunJobDeps): Promise<JobRunResult> {
  const log = jobLogger(job.name, deps.site);
  const failed = (event: string, error: unknown): JobRunResult => ({
    job: job.name,
    outcome: "failed",
    counts: {},
    requestId: log.error(event, error),
  });

  let raw: unknown;
  try {
    raw = await job.run({ db: deps.db, now: new Date(deps.now.getTime()), log });
  } catch (error) {
    return failed("run_failed", error);
  }

  const counts = validateJobCounts(raw, job.countKeys);
  if (!counts) return failed("invalid_counts", new InvalidJobCountsError());
  return { job: job.name, outcome: "succeeded", counts };
}
