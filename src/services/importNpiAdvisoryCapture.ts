// MINT-110 PR 2 / MINT-134 — after a successful commit, in the background:
// the registry's answers for the committed import rows go to the capture seam
// (advisoryCapture.ts), facts only, and the run's import NPI checks
// (import.npi_missing, import.npi_unusable) go to the advisory ledger. Each
// carries the run and the row's line. Building and sending share one
// try/catch: a failure is logged without values and never reaches the commit.
import type { ImportNpiRowCheck, ImportRowAdvisories } from "@/lib/importNpiVerification";
import { logAdvisoryCaptureFailure, recordAdvisories } from "@/services/advisoryCapture";
import { recordAdvisory } from "@/services/advisories";

export interface ImportNpiCapture {
  /** The registry's advisories, per committed row. */
  registry: readonly ImportRowAdvisories[];
  /** The run's import NPI checks (importNpiRowChecks). */
  rows: readonly ImportNpiRowCheck[];
}

export async function captureImportNpiAdvisories(
  runId: string,
  build: () => ImportNpiCapture,
): Promise<void> {
  let checks: string[] = [];
  try {
    const { registry, rows } = build();
    checks = [
      ...registry.flatMap((row) => row.advisories.map((advisory) => advisory.check)),
      ...rows.map((row) => row.check),
    ];
    for (const row of registry) {
      await recordAdvisories(row.advisories, {
        surface: "import",
        importRunId: runId,
        line: row.line,
      });
    }
    for (const row of rows) {
      await recordAdvisory(
        row.check,
        row.record,
        { import_run_id: runId, line: row.line },
        "import",
      );
    }
  } catch (error) {
    logAdvisoryCaptureFailure(error, checks);
  }
}
