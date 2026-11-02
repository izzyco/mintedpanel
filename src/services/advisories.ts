// Browser workflow advisories (MINT-134). After a save that bypassed a
// noncritical check has succeeded, the service that did the save calls
// recordAdvisory; the RPC binds the actor to auth.uid() and reads their role
// from memberships, so nothing here names a user.
//
// Fire-and-forget: call it after the save has succeeded, and don't wait on it
// before telling the user (`void recordAdvisory(...)`). It never throws or
// rejects, and the RPC is abandoned after ADVISORY_RPC_TIMEOUT_MS, so even an
// awaited call can't hold a save. The front end stays quiet. A failure (no
// active org, the RPC refused, the network, a timeout, the ledger not applied
// yet) becomes one safe log line, the event, the check key and the SQLSTATE.
import { supabase } from "@/integrations/supabase/externalClient";
import { requireActiveOrg } from "@/lib/audit";
import {
  ADVISORY_LOCAL_REFUSAL,
  ADVISORY_RECORD_FAILED,
  ADVISORY_RPC_TIMEOUT_MS,
  BROWSER_ADVISORY_SOURCES,
  advisoryRpcFields,
  checkDefinition,
  reportAdvisoryFailure,
  type AdvisoryContextFor,
  type AdvisoryRecord,
  type BrowserAdvisorySource,
  type CheckKey,
} from "@/lib/advisoryChecks";

const BROWSER_SOURCES: readonly string[] = BROWSER_ADVISORY_SOURCES;

/** Record one bypassed (or stopped) check against a record of the active org.
 *  Undeclared context keys, and values outside their key's kind, are dropped
 *  before the call. Fire-and-forget: `void recordAdvisory(...)` after the save;
 *  it resolves, never rejects, within ADVISORY_RPC_TIMEOUT_MS of the call. */
export async function recordAdvisory<K extends CheckKey>(
  key: K,
  record: AdvisoryRecord<K>,
  context: AdvisoryContextFor<K> = {},
  source: BrowserAdvisorySource = "panel",
): Promise<void> {
  try {
    const def = checkDefinition(key);
    const fields = def ? advisoryRpcFields(def, record, context) : null;
    if (!fields || !BROWSER_SOURCES.includes(source)) {
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, ADVISORY_LOCAL_REFUSAL);
      return;
    }
    const { error } = await supabase
      .rpc("record_workflow_advisory", {
        ...fields,
        p_org_id: requireActiveOrg(),
        p_source: source,
      })
      .abortSignal(AbortSignal.timeout(ADVISORY_RPC_TIMEOUT_MS));
    if (error) reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, key, error);
  }
}
