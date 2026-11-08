// The onboarding file cleanup job: GET /api/jobs/onboarding-file-cleanup,
// called once a day by the Vercel cron in vercel.json.
//
// Provider onboarding leaves Storage files no step reads again: a signed
// upload URL still works for a while after Cancel or Remove, a best-effort
// delete can fail, an upload can be abandoned, and a Submit can stop between
// its vault copies and its RPC. onboarding_orphan_files
// (supabase/migrations/20261107040000_onboarding_orphan_files.sql) names
// them, and this job deletes them through Storage:
//   * provider-intake-uploads files of a removed or missing upload, or of a
//     journey that is submitted, admitted, cancelled or gone;
//   * provider-documents files under an upload's vault folder that no
//     document row has, once that upload's journey has ended;
//   * provider-documents files under a provider id no provider row has.
// Only files older than ORPHAN_MIN_AGE_MS, longer than any signed upload URL
// lives, so a file on its way is never taken. Any other path is refused
// before anything is deleted.
//
// At most ORPHAN_BATCH files a run; the next run takes the rest. A file
// named once stays an orphan, and Storage answers a delete of a file that is
// already gone with nothing deleted, so a repeated or overlapping run
// converges. The run reports counts only; a failed delete is one log line
// with identifiers only.
import type { JobContext, JobCounts, JobDefinition } from "./types";

const ONBOARDING_FILE_CLEANUP_JOB_NAME = "onboarding-file-cleanup";

/** Signed upload URLs live two hours. */
const ORPHAN_MIN_AGE_MS = 3 * 60 * 60 * 1000;
const ORPHAN_BATCH = 500;
const REMOVE_BATCH = 100;

const ONBOARDING_FILE_CLEANUP_COUNT_KEYS = [
  /** Files onboarding_orphan_files named this run. */
  "files_found",
  /** Deleted from provider-intake-uploads, as Storage reported. */
  "holding_removed",
  /** Deleted from provider-documents, as Storage reported. */
  "vault_removed",
  /** Named, but in a delete call that failed; the next run tries again. */
  "remove_failed",
] as const;
type OnboardingFileCleanupCounts = Record<
  (typeof ONBOARDING_FILE_CLEANUP_COUNT_KEYS)[number],
  number
>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The only shapes the job deletes, by bucket, and the count each feeds.
const ORPHAN_KINDS = [
  {
    bucket: "provider-intake-uploads",
    path: new RegExp(`^org/${UUID}/onboarding/${UUID}/${UUID}/[^/]+$`),
    count: "holding_removed",
  },
  {
    bucket: "provider-documents",
    path: new RegExp(`^org/${UUID}/provider/${UUID}/${UUID}/.+$`),
    count: "vault_removed",
  },
] as const;

function orphanPaths(data: unknown): Map<(typeof ORPHAN_KINDS)[number], string[]> {
  if (!Array.isArray(data)) throw new Error("onboarding_orphan_files returned no list");
  const byKind = new Map(ORPHAN_KINDS.map((kind) => [kind, [] as string[]]));
  for (const entry of data as unknown[]) {
    const { bucket, path } = (entry ?? {}) as { bucket?: unknown; path?: unknown };
    const kind = ORPHAN_KINDS.find((k) => k.bucket === bucket);
    if (!kind || typeof path !== "string" || !kind.path.test(path)) {
      throw new Error("onboarding_orphan_files named a file outside onboarding");
    }
    byKind.get(kind)?.push(path);
  }
  return byKind;
}

export async function runOnboardingFileCleanup(ctx: JobContext): Promise<JobCounts> {
  const { data, error } = await ctx.db.rpc("onboarding_orphan_files", {
    p_cutoff: new Date(ctx.now.getTime() - ORPHAN_MIN_AGE_MS).toISOString(),
    p_limit: ORPHAN_BATCH,
  });
  if (error) throw error;
  const byKind = orphanPaths(data);

  const counts = Object.fromEntries(
    ONBOARDING_FILE_CLEANUP_COUNT_KEYS.map((key) => [key, 0]),
  ) as OnboardingFileCleanupCounts;
  for (const [kind, paths] of byKind) {
    counts.files_found += paths.length;
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const batch = paths.slice(i, i + REMOVE_BATCH);
      const { data: removed, error: removeError } = await ctx.db.storage
        .from(kind.bucket)
        .remove(batch);
      if (removeError) {
        counts.remove_failed += batch.length;
        ctx.log.error("remove_failed", removeError);
        continue;
      }
      counts[kind.count] += removed?.length ?? 0;
    }
  }
  return counts;
}

export const onboardingFileCleanupJob: JobDefinition = {
  name: ONBOARDING_FILE_CLEANUP_JOB_NAME,
  countKeys: ONBOARDING_FILE_CLEANUP_COUNT_KEYS,
  run: runOnboardingFileCleanup,
};
