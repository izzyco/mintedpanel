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
