// MINT-135: task.completed_out_of_order for a task a save has just moved to
// completed. One rule for every path, the same as complete_sop_task_step's
// and record_typed_enrollment_submission's: an earlier task is one of the same
// case with a lower sort_order that is not completed and is not a removed
// payer form. The browser's updateTaskStatus and the extension's direct
// completions (completeTaskForFill, recordSubmissionTouch) share it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ADVISORY_RECORD_FAILED, reportAdvisoryFailure } from "@/lib/advisoryChecks";
import { isPayerFormRemoved } from "@/lib/payerForms";
import { recordServerAdvisory, type AdvisoryRouteCtx } from "@/server/advisories";

export interface CompletedTaskRef {
  id: string;
  caseId: string | null;
  sortOrder: number | null;
}

/** How many earlier tasks of the task's case are still open. 0 for a task
 * without a case or a sort order. Throws if the read fails. */
export async function countEarlierOpenCaseTasks(
  db: SupabaseClient<Database>,
  orgId: string,
  task: CompletedTaskRef,
): Promise<number> {
  const sortOrder = task.sortOrder;
  if (!task.caseId || typeof sortOrder !== "number") return 0;
  const { data, error } = await db
    .from("tasks")
    .select("status, sort_order, sop_content")
    .eq("org_id", orgId)
    .eq("case_id", task.caseId);
  if (error) throw error;
  return (data ?? []).filter(
    (row) =>
      typeof row.sort_order === "number" &&
      row.sort_order < sortOrder &&
      row.status !== "completed" &&
      !isPayerFormRemoved(row.sop_content),
  ).length;
}

/** The extension routes' recorder: call it, without awaiting, only after the
 * save that moved an open task to completed. It never throws or rejects. */
export async function recordServerCompletedOutOfOrder(
  ctx: AdvisoryRouteCtx,
  task: CompletedTaskRef,
): Promise<void> {
  try {
    const earlierOpenCount = await countEarlierOpenCaseTasks(ctx.db, ctx.orgId, task);
    if (earlierOpenCount === 0) return;
    await recordServerAdvisory(
      ctx,
      "extension",
      "task.completed_out_of_order",
      { table: "tasks", id: task.id },
      { earlier_open_count: earlierOpenCount },
    );
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "task.completed_out_of_order", error);
  }
}
