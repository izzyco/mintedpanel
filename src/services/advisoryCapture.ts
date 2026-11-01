// Where the NPI Registry's advisories are recorded for Mission Control
// (Sowmya's standing rule, Oct 31: every noncritical check that was bypassed
// is recorded: what, who, when, why it matters, which record).
//
// The store is MINT-134's workflow advisories ledger: recordAdvisory
// (src/services/advisories.ts) sends one row per advisory through the
// record_workflow_advisory RPC, which stamps who and when from the session.
// This seam maps #564's and #566's advisory shape (src/lib/advisories.ts) to
// the ledger's registry (src/lib/advisoryChecks.ts): its check key, the
// provider, and the context the registry declares for that key. The ledger's
// context is closed, so the field, where the advisory showed and whether
// staff confirmed it stay behind, and a check the registry has no key for is
// not recorded.
//
// Never throws. A failed RPC is logged by recordAdvisory (advisory_record_failed,
// the check key and the SQLSTATE); anything else that fails here is logged as
// advisory_capture_failed with the check keys and the SQLSTATE. The front end
// stays quiet.
import type { Advisory } from "@/lib/advisories";
import type { AdvisoryContextFor, CheckKey } from "@/lib/advisoryChecks";
import { recordAdvisory } from "@/services/advisories";

/** The NPI Registry check keys #564 and #566 hand over, and the ledger's key
 * for each. Credentials, taxonomy and license differences have no key in the
 * ledger's registry, so they are not recorded. */
const LEDGER_KEYS = {
  "npi_registry.organization_number": "npi_registry.organization_number",
  "npi_registry.not_found": "npi_registry.not_found",
  "npi_registry.name_mismatch": "npi_registry.name_mismatch",
  "npi_registry.inactive": "npi_registry.inactive",
  "npi_registry.not_checked": "npi_registry.unchecked",
} as const satisfies Record<string, CheckKey>;
type LedgerKey = (typeof LEDGER_KEYS)[keyof typeof LEDGER_KEYS];

/** The provider forms that save an NPI. */
export type AdvisoryFormSurface = "add_provider" | "roster_form" | "record_edit";

/** Where the advisories came from: a provider form (source panel), or a
 * committed import row (source import). */
export type AdvisoryOrigin =
  { surface: AdvisoryFormSurface } | { surface: "import"; importRunId: string; line: number };

export interface LedgerAdvisory {
  key: LedgerKey;
  record: { table: "providers"; id: string };
  context: AdvisoryContextFor<LedgerKey>;
}

/** One advisory in the ledger's terms, or null when the ledger has no key for
 * its check or the record isn't saved. */
export function toLedgerAdvisory(
  advisory: Advisory,
  origin: AdvisoryOrigin,
): LedgerAdvisory | null {
  const key = Object.prototype.hasOwnProperty.call(LEDGER_KEYS, advisory.check)
    ? LEDGER_KEYS[advisory.check as keyof typeof LEDGER_KEYS]
    : null;
  const id = advisory.record.id;
  if (!key || advisory.record.table !== "providers" || !id) return null;
  return {
    key,
    record: { table: "providers", id },
    context:
      origin.surface === "import"
        ? { surface: "import", import_run_id: origin.importRunId, line: origin.line }
        : { surface: origin.surface },
  };
}

/** Record the advisories, one ledger row each, in order. Resolves, never
 * rejects. */
export async function recordAdvisories(
  advisories: readonly Advisory[],
  origin: AdvisoryOrigin,
): Promise<void> {
  try {
    const source = origin.surface === "import" ? "import" : "panel";
    for (const advisory of advisories) {
      const row = toLedgerAdvisory(advisory, origin);
      if (row) await recordAdvisory(row.key, row.record, row.context, source);
    }
  } catch (error) {
    logAdvisoryCaptureFailure(
      error,
      advisories.map((advisory) => advisory.check),
    );
  }
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
