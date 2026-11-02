// MINT-135: the extension routes' task.completed_out_of_order recorder. Server
// only: completeTaskForFill and recordSubmissionTouch are also bundled for the
// browser, so they never import it. Their service ctx carries onTaskCompleted,
// and extensionRoutes.ts sets that to this recorder. The rule itself is
// countEarlierOpenCaseTasks (src/services/taskOrderAdvisory.ts), shared with
// the browser's updateTaskStatus.
import { ADVISORY_RECORD_FAILED, reportAdvisoryFailure } from "@/lib/advisoryChecks";
import { countEarlierOpenCaseTasks, type CompletedTaskRef } from "@/services/taskOrderAdvisory";
import { recordServerAdvisory, type AdvisoryRouteCtx } from "./advisories";

/** Call it, without awaiting, only after the save that moved an open task to
 * completed. It never throws or rejects. */
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
