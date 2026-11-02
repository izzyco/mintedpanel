// SEAM — where advisories will be recorded for Mission Control (Sowmya's
// standing rule, Oct 31: every noncritical check that was bypassed is
// recorded: what, who, when, why it matters, which record).
//
// The advisory store and its API come from the foundational capture PR, which
// is being designed. Until it lands this records NOTHING, and says so in its
// result: callers get { recorded: false } and must not report the advisories
// as captured. When the API is known, replace this body — not the callers.
// Who and when are the capture's to stamp, not the caller's.
import type { Advisory } from "@/lib/advisories";

export interface AdvisoryCaptureResult {
  recorded: false;
  reason: "advisory_store_not_built";
}

export async function recordAdvisories(
  advisories: readonly Advisory[],
): Promise<AdvisoryCaptureResult> {
  void advisories;
  return { recorded: false, reason: "advisory_store_not_built" };
}

/** What a failed capture logs: the event, the check keys, and the database
 * SQLSTATE when there is one. Never the message or anything else from the
 * error, which can quote values. */
export function advisoryCaptureFailureLog(
  error: unknown,
  checks: readonly string[],
): { event: "advisory_capture_failed"; checks: string[]; sqlstate: string | null } {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return {
    event: "advisory_capture_failed",
    checks: [...new Set(checks)],
    sqlstate: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null,
  };
}

/** A capture runs after the save, in the background: its failure is logged,
 * safely, and never reaches the form. */
export function logAdvisoryCaptureFailure(error: unknown, checks: readonly string[]): void {
  const entry = advisoryCaptureFailureLog(error, checks);
  console.warn(entry.event, entry);
}
