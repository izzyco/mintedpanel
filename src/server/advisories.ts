// Server workflow advisories (MINT-134), on the service-role client.
//
//   recordServerAdvisory  /api and extension routes: after guard.ts has
//                         verified the JWT and resolved membership, the route
//                         passes its ctx; the actor is ctx.userId, and the RPC
//                         re-checks that they are a member of ctx.orgId.
//   recordJobAdvisory     scheduled jobs: no actor. One open row per (org,
//                         check, record) absorbs every repeat until resolved.
//   resolveAdvisories     a server-side re-check passed: stamps the open rows
//                         for (org, check, record).
//
// None of them throws into the workflow: a failure becomes one safe log line
// (the event, the check key and the SQLSTATE) and the call resolves. Each RPC
// is abandoned after ADVISORY_RPC_TIMEOUT_MS, so awaiting a helper adds at
// most that to a route or a job; a route may also fire and forget. The
// registry, the context filter and the log line are shared with the browser
// helper (src/lib/advisoryChecks.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  ADVISORY_LOCAL_REFUSAL,
  ADVISORY_RECORD_FAILED,
  ADVISORY_RESOLVE_FAILED,
  ADVISORY_RPC_TIMEOUT_MS,
  JOB_NAME_PATTERN,
  SERVER_ADVISORY_SOURCES,
  advisoryRpcFields,
  checkDefinition,
  reportAdvisoryFailure,
  type AdvisoryContextFor,
  type AdvisoryRecord,
  type CheckKey,
  type ServerAdvisorySource,
} from "@/lib/advisoryChecks";

type Db = SupabaseClient<Database>;

/** What a route already holds after guard.ts (AuthContext fits). */
export interface AdvisoryRouteCtx {
  db: Db;
  orgId: string;
  userId: string;
}

const SERVER_SOURCES: readonly string[] = SERVER_ADVISORY_SOURCES;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(ADVISORY_RPC_TIMEOUT_MS);
}

/** Record a check a verified user bypassed (or that stopped them) through an
 *  /api or extension route. */
export async function recordServerAdvisory<K extends CheckKey>(
  ctx: AdvisoryRouteCtx,
  source: ServerAdvisorySource,
  key: K,
  record: AdvisoryRecord<K>,
  context: AdvisoryContextFor<K> = {},
): Promise<void> {
  try {
    const def = checkDefinition(key);
    const fields = def ? advisoryRpcFields(def, record, context) : null;
    if (!fields || !SERVER_SOURCES.includes(source) || !ctx.orgId || !ctx.userId) {
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, ADVISORY_LOCAL_REFUSAL);
      return;
    }
    const { error } = await ctx.db
      .rpc("record_workflow_advisory", {
        ...fields,
        p_org_id: ctx.orgId,
        p_source: source,
        p_actor_id: ctx.userId,
      })
      .abortSignal(timeoutSignal());
    if (error) reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  }
}

/** Record a scheduled job's finding. `job` is the registered job name (the
 *  /api/jobs/<name> segment). A repeat of an open finding writes nothing. */
export async function recordJobAdvisory<K extends CheckKey>(
  db: Db,
  job: string,
  orgId: string,
  key: K,
  record: AdvisoryRecord<K>,
  context: AdvisoryContextFor<K> = {},
): Promise<void> {
  try {
    const def = checkDefinition(key);
    const fields = def ? advisoryRpcFields(def, record, context) : null;
    if (!fields || !JOB_NAME_PATTERN.test(job) || !orgId) {
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, ADVISORY_LOCAL_REFUSAL);
      return;
    }
    const { error } = await db
      .rpc("record_job_advisory", {
        ...fields,
        p_job: job,
        p_org_id: orgId,
      })
      .abortSignal(timeoutSignal());
    if (error) reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  }
}

/** Stamp the open advisories for (org, check, record) once a server-side
 *  re-check has passed. `resolvedBy` is the org member whose re-check it was,
 *  or null for a job. Returns how many were stamped, or null when it failed
 *  (they stay open, and the next re-check tries again). */
export async function resolveAdvisories<K extends CheckKey>(
  db: Db,
  orgId: string,
  key: K,
  record: AdvisoryRecord<K>,
  resolvedBy: string | null = null,
): Promise<number | null> {
  try {
    const def = checkDefinition(key);
    const fields = def ? advisoryRpcFields(def, record, {}) : null;
    if (!fields || !orgId) {
      reportAdvisoryFailure(ADVISORY_RESOLVE_FAILED, key, ADVISORY_LOCAL_REFUSAL);
      return null;
    }
    const { data, error } = await db
      .rpc("resolve_workflow_advisories", {
        p_org_id: orgId,
        p_check_key: fields.p_check_key,
        p_record_table: fields.p_record_table,
        p_record_id: fields.p_record_id,
        ...(resolvedBy ? { p_resolved_by: resolvedBy } : {}),
      })
      .abortSignal(timeoutSignal());
    if (error) {
      reportAdvisoryFailure(ADVISORY_RESOLVE_FAILED, key, error);
      return null;
    }
    return typeof data === "number" ? data : 0;
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RESOLVE_FAILED, key, error);
    return null;
  }
}
