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

/** Build the advisories, then send them. A builder that throws is logged
 * (without values) and nothing is sent; never rejects, so nothing a capture
 * does can reach the commit's own feedback. */
export async function captureImportNpiAdvisoriesFrom(
  build: () => readonly Advisory[],
  record?: (advisories: readonly Advisory[]) => Promise<AdvisoryCaptureResult>,
): Promise<AdvisoryCaptureResult | null> {
  let advisories: readonly Advisory[];
  try {
    advisories = build();
  } catch (error) {
    logAdvisoryCaptureFailure(error, []);
    return null;
  }
  return captureImportNpiAdvisories(advisories, record);
}

/** captureImportNpiAdvisoriesFrom, fire and forget. */
export function useCaptureImportNpiAdvisories(): (build: () => readonly Advisory[]) => void {
  return useCallback((build: () => readonly Advisory[]) => {
    void captureImportNpiAdvisoriesFrom(build);
  }, []);
}
