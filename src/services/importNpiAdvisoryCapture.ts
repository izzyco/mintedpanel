// MINT-110 PR 2 — after a successful commit, the registry's answers for the
// committed import rows go to the advisory-capture seam (advisoryCapture.ts),
// facts only, in the background. Building and sending share one try/catch: a
// failure is logged without values and never reaches the commit. Nothing is
// reported as captured: the seam records nothing until the advisory store
// lands (MINT-134).
import type { Advisory } from "@/lib/advisories";
import { logAdvisoryCaptureFailure, recordAdvisories } from "@/services/advisoryCapture";

export async function captureImportNpiAdvisories(build: () => Advisory[]): Promise<void> {
  let checks: string[] = [];
  try {
    const advisories = build();
    checks = advisories.map((advisory) => advisory.check);
    if (advisories.length > 0) await recordAdvisories(advisories);
  } catch (error) {
    logAdvisoryCaptureFailure(error, checks);
  }
}
