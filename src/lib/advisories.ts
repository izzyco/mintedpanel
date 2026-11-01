// Advisories — Sowmya's standing rule (Oct 31, 2026): only security, access
// control, tenant isolation, privacy, financial, legal and factual accuracy
// block. Every other check is advisory: the action proceeds, the event is
// recorded for Mission Control (what was bypassed, who, when, why it matters,
// which record), and the form stays quiet unless the user must act.
//
// This is the typed shape a check hands to the capture. It carries facts
// only — a check key, the record, where it showed, whether staff confirmed it
// — never a value, a name or any registry data (A35: registry values stay out
// of the append-only advisory ledger). The form's own view of an advisory may
// show values; it is reduced to this shape before capture
// (toCapturedAdvisory).
//
// The advisory store does not exist yet (the foundational capture PR is being
// designed); until it lands, src/services/advisoryCapture.ts is the one seam,
// and it records nothing. Who and when are the capture's to stamp (the
// session and the server clock), and org_id comes from the session too.
//
// Pure: no runtime imports.

/** Where an advisory showed. "review_step": on the form's review step, where
 * staff fix it (jump to the field), choose the registry's value, or confirm
 * it — one click, no reason to type. "backend_only": for Mission Control
 * only. This is the capture's severity_at_time. */
export type AdvisoryDisplay = "review_step" | "backend_only";

/** The record an advisory concerns (record_table, record_id). `id` is null
 * until the record is saved. */
export interface AdvisoryRecordRef {
  table: "providers";
  id: string | null;
  /** The field the check looked at, e.g. "npi" or "licenses.0.number". */
  field: string;
}

export interface Advisory {
  /** check_key: "<area>.<check>", e.g. "npi_registry.not_found". */
  check: string;
  record: AdvisoryRecordRef;
  display: AdvisoryDisplay;
  /** One sentence for Mission Control: why it matters. No values. */
  whyItMatters: string;
  /** Facts only: never a value, a name or registry data. */
  context: AdvisoryContext;
}

/** Facts about the advisory. `importRunId` and `line` (MINT-110 PR 2) say
 * which roster import and source row it came from, when it came from one. */
export interface AdvisoryContext {
  confirmed: boolean;
  importRunId?: string;
  line?: number;
}

/** An advisory reduced to the captured shape: whatever else a form's view
 * carries (titles, the registry's values) stays behind. */
export function toCapturedAdvisory(advisory: Advisory): Advisory {
  return {
    check: advisory.check,
    record: {
      table: advisory.record.table,
      id: advisory.record.id,
      field: advisory.record.field,
    },
    display: advisory.display,
    whyItMatters: advisory.whyItMatters,
    context: {
      confirmed: advisory.context.confirmed,
      ...(advisory.context.importRunId !== undefined
        ? { importRunId: advisory.context.importRunId }
        : {}),
      ...(advisory.context.line !== undefined ? { line: advisory.context.line } : {}),
    },
  };
}

/** The advisories, captured shape, for the saved record. */
export function advisoriesForRecord(advisories: readonly Advisory[], id: string): Advisory[] {
  return advisories.map((advisory) => {
    const captured = toCapturedAdvisory(advisory);
    return { ...captured, record: { ...captured.record, id } };
  });
}
