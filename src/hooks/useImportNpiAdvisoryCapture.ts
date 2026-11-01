// MINT-110 PR 2 — hands a committed import's NPI Registry advisories to the
// advisory-capture seam (src/services/advisoryCapture.ts), in the background,
// after the commit succeeded. Facts only (importNpiCaptureAdvisories builds
// them). A capture never throws into the commit and never claims anything was
// captured: the seam records nothing until the advisory store lands
// (MINT-134), and a failure is logged without values.
import { useCallback } from "react";
import type { Advisory } from "@/lib/advisories";
import {
  logAdvisoryCaptureFailure,
  recordAdvisories,
  type AdvisoryCaptureResult,
} from "@/services/advisoryCapture";

/** Send `advisories` to the seam. Resolves with the seam's own answer (today
 * always "not recorded"), or null when there was nothing to send or the
 * capture failed; never rejects. */
export async function captureImportNpiAdvisories(
  advisories: readonly Advisory[],
  record: (advisories: readonly Advisory[]) => Promise<AdvisoryCaptureResult> = recordAdvisories,
): Promise<AdvisoryCaptureResult | null> {
  if (advisories.length === 0) return null;
  try {
    return await record(advisories);
  } catch (error) {
    logAdvisoryCaptureFailure(
      error,
      advisories.map((advisory) => advisory.check),
    );
    return null;
  }
}

/** captureImportNpiAdvisories, fire and forget. */
export function useCaptureImportNpiAdvisories(): (advisories: readonly Advisory[]) => void {
  return useCallback((advisories: readonly Advisory[]) => {
    void captureImportNpiAdvisories(advisories);
  }, []);
}
