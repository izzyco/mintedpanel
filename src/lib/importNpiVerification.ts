// NPI Registry checks on the import review — MINT-110 PR 2 / MINT-119. The
// pure half: which rows are checked, each row's result (a stable kind, its
// note, its severity), the rows a "block" severity holds back, the estimated
// time left, and the progress words. No I/O; ImportNpiVerifier
// (src/lib/importNpiVerifier.ts) does the scheduling.
//
// Policy is injected, never hard-wired: `scope` picks the rows (default
// "new_providers": only rows the import would CREATE as a new provider, after
// the five-part dedupe) and `severityFor(kind)` says whether each registry
// outcome warns or blocks (default: every outcome warns, so nothing changes
// on the review screen except the notes). These are the parameters the
// resolved NPI Registry policy (src/lib/npiRegistryPolicy.ts, MINT-110 PR 1)
// will supply. Hard rules stay hard: the check digit still decides what is
// sent, and "not checked" (an outage, the rate limit, Stop) is a fact that
// never blocks. Results live in memory only; nothing is stored per row.
import {
  type ImportRowDisposition,
  type StagedImportRow,
  type BlockedDisposition,
} from "@/lib/importDedupe";
import { isValidNpi, stripNpiSeparators } from "@/lib/providerIdentity";
import {
  compareNpiRegistryName,
  npiVerificationView,
  type NpiRegistryRecord,
  type NpiVerificationView,
} from "@/lib/npiRegistry";

/** Which rows an import checks. The decided default is "new_providers". */
export type ImportNpiVerifyScope = "new_providers" | "all_rows";
export const DEFAULT_IMPORT_NPI_SCOPE: ImportNpiVerifyScope = "new_providers";

/** The registry outcomes a policy can grade. */
export type NpiRegistryOutcomeKind =
  "organizationNumber" | "notFound" | "nameMismatch" | "inactive";
export type NpiRegistrySeverity = "warn" | "block";
export type NpiRegistrySeverityFor = (kind: NpiRegistryOutcomeKind) => NpiRegistrySeverity;
/** The decided default: every outcome is a warning. */
export const DEFAULT_NPI_SEVERITY_FOR: NpiRegistrySeverityFor = () => "warn";

export const NPI_REGISTRY_OUTCOME_KINDS: readonly NpiRegistryOutcomeKind[] = [
  "organizationNumber",
  "notFound",
  "nameMismatch",
  "inactive",
];

/** Whether a policy blocks on any outcome. */
export function npiPolicyCanBlock(severityFor: NpiRegistrySeverityFor): boolean {
  return NPI_REGISTRY_OUTCOME_KINDS.some((kind) => severityFor(kind) === "block");
}

/** A row's stable result kind. "found": in the registry, active, name matches.
 * "notChecked": an outage, the rate limit or Stop — never configurable, never
 * a block. "pending": not checked yet. */
export type ImportNpiResultKind = "found" | NpiRegistryOutcomeKind | "notChecked" | "pending";

export interface ImportNpiCheckItem {
  /** Separators stripped; passes the CMS check digit. */
  npi: string;
  /** The disposition's anchor row (a folded entry's first source row). */
  line: number;
  /** The names the import file gives this row. */
  firstName: string;
  lastName: string;
  /** What the import would do with the row. */
  disposition: "create" | "update" | "skip";
}

export type ImportNpiNotCheckedReason = "unavailable" | "rate_limited" | "stopped";

export type ImportNpiOutcome =
  | { status: "checked"; record: NpiRegistryRecord | null }
  | { status: "not_checked"; reason: ImportNpiNotCheckedReason };

/** idle: not started. running: checking. done: every row has an outcome
 * (some may be "not checked" after an outage). stopped: staff stopped it, or
 * the import was cancelled or committed first. */
export type ImportNpiPhase = "idle" | "running" | "done" | "stopped";

export interface ImportNpiSnapshot {
  phase: ImportNpiPhase;
  total: number;
  /** Rows processed: checked, or not checked because of an outage or the
   * rate limit. Rows Stop left are not counted, so the bar stays put. */
  done: number;
  /** Rows the registry answered for. */
  checked: number;
  results: ReadonlyMap<string, ImportNpiOutcome>;
  /** Estimated ms left, or null when it can't be shown reliably. */
  etaMs: number | null;
}

function field(row: StagedImportRow | undefined, key: string): string {
  const value = row?.mapped?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The rows to check, one per NPI. "new_providers" takes the creates;
 * "all_rows" adds the rows that update or match an existing provider (their
 * NPI and names come from the staged row). Blocked rows are never checked —
 * they already cannot import. The check digit is applied again here so a
 * failing number is never sent upstream. */
export function selectImportNpiChecks(
  dispositions: readonly ImportRowDisposition[] | null | undefined,
  options: { scope?: ImportNpiVerifyScope; rows?: readonly StagedImportRow[] | null } = {},
): ImportNpiCheckItem[] {
  if (!dispositions) return [];
  const scope = options.scope ?? DEFAULT_IMPORT_NPI_SCOPE;
  const rowsByLine = new Map((options.rows ?? []).map((row) => [row.line, row]));
  const seen = new Set<string>();
  const items: ImportNpiCheckItem[] = [];
  for (const disposition of dispositions) {
    let candidate: ImportNpiCheckItem | null = null;
    if (disposition.kind === "create") {
      candidate = {
        npi: stripNpiSeparators(disposition.npi),
        line: disposition.line,
        firstName: disposition.provider.firstName,
        lastName: disposition.provider.lastName,
        disposition: "create",
      };
    } else if (
      scope === "all_rows" &&
      (disposition.kind === "update" || disposition.kind === "skip")
    ) {
      const row = rowsByLine.get(disposition.line);
      candidate = {
        npi: stripNpiSeparators(field(row, "npi")),
        line: disposition.line,
        firstName: field(row, "provider_first_name"),
        lastName: field(row, "provider_last_name"),
        disposition: disposition.kind,
      };
    }
    if (!candidate || !isValidNpi(candidate.npi) || seen.has(candidate.npi)) continue;
    seen.add(candidate.npi);
    items.push(candidate);
  }
  return items;
}

/** A key that changes only when the set of rows to check does. */
export function importNpiChecksKey(items: readonly ImportNpiCheckItem[]): string {
  return items
    .map((item) => `${item.npi}|${item.firstName}|${item.lastName}`)
    .sort()
    .join("\n");
}

/** Every graded outcome that applies to a registry answer, most serious first
 * (the order the provider forms check in). An organization number is only
 * that; an individual's NPI can be both inactive and under another name. */
export function registryOutcomeKinds(
  record: NpiRegistryRecord | null,
  typed: { firstName: string; lastName: string },
): NpiRegistryOutcomeKind[] {
  if (!record) return ["notFound"];
  if (record.enumerationType === "NPI-2") return ["organizationNumber"];
  const kinds: NpiRegistryOutcomeKind[] = [];
  if (record.status !== "active") kinds.push("inactive");
  if (compareNpiRegistryName(typed, record) === "mismatch") kinds.push("nameMismatch");
  return kinds;
}

const BLOCK_REASONS: Record<NpiRegistryOutcomeKind, string> = {
  organizationNumber: "the NPI belongs to an organization in the NPI Registry",
  notFound: "the NPI is not in the NPI Registry",
  nameMismatch: "the name differs from the NPI Registry",
  inactive: "the NPI Registry lists this NPI as inactive",
};

const NOT_CHECKED_TITLES: Record<ImportNpiNotCheckedReason, string> = {
  unavailable: "Not checked — NPI Registry is unavailable",
  rate_limited: "Not checked — too many NPI Registry checks",
  stopped: "Not checked — the checks were stopped",
};

export interface ImportNpiRowResult {
  kind: ImportNpiResultKind;
  /** Every graded outcome that applies (empty unless the registry answered). */
  outcomes: NpiRegistryOutcomeKind[];
  /** "block" when any applicable outcome's severity is block. */
  severity: "ok" | "warn" | "block";
  note: NpiVerificationView;
  /** The plain reason the review shows for a blocked row; null otherwise. */
  blockReason: string | null;
}

/** One row's result. Checked rows read exactly as the provider forms do
 * (npiVerificationView), except that "not found" drops the form's "You can
 * still save" line; the import says once that a warning never stops a row. */
export function importNpiRowResult(
  outcome: ImportNpiOutcome | undefined,
  typed: { firstName: string; lastName: string },
  phase: ImportNpiPhase,
  severityFor: NpiRegistrySeverityFor = DEFAULT_NPI_SEVERITY_FOR,
): ImportNpiRowResult {
  if (!outcome) {
    const finished = phase === "done" || phase === "stopped";
    return {
      kind: finished ? "notChecked" : "pending",
      outcomes: [],
      severity: "ok",
      note: { tone: "neutral", title: finished ? "Not checked" : "Not checked yet", detail: null },
      blockReason: null,
    };
  }
  if (outcome.status === "not_checked") {
    return {
      kind: "notChecked",
      outcomes: [],
      severity: outcome.reason === "stopped" ? "ok" : "warn",
      note: {
        tone: outcome.reason === "stopped" ? "neutral" : "warn",
        title: NOT_CHECKED_TITLES[outcome.reason],
        detail: null,
      },
      blockReason: null,
    };
  }
  const outcomes = registryOutcomeKinds(outcome.record, typed);
  const view = npiVerificationView({ status: "done", record: outcome.record }, typed) ?? {
    tone: "neutral" as const,
    title: "Not checked",
    detail: null,
  };
  const note =
    outcome.record === null
      ? { ...view, detail: "Re-check the number; deactivated NPIs are not listed." }
      : view;
  const blocking = outcomes.find((kind) => severityFor(kind) === "block") ?? null;
  return {
    kind: outcomes[0] ?? "found",
    outcomes,
    severity: blocking ? "block" : outcomes.length > 0 ? "warn" : "ok",
    note,
    blockReason: blocking
      ? `Not imported — ${BLOCK_REASONS[blocking]}. Correct the row and re-import.`
      : null,
  };
}

/** The dispositions the review shows and commits once registry blocks apply:
 * a create or update whose row is blocked becomes one blocked entry per source
 * line (so the counts still reconcile with the staged rows), excluded from the
 * commit and listed with its reason in Blocked rows and the error report. A
 * skip writes nothing, so it stays a skip. With no blocks (the default policy)
 * the same array comes back. */
export function applyImportNpiBlocks(
  dispositions: ImportRowDisposition[],
  blockReasonByLine: ReadonlyMap<number, string>,
): ImportRowDisposition[] {
  if (blockReasonByLine.size === 0) return dispositions;
  return dispositions.flatMap((disposition): ImportRowDisposition[] => {
    if (disposition.kind !== "create" && disposition.kind !== "update") return [disposition];
    const reason = blockReasonByLine.get(disposition.line);
    if (!reason) return [disposition];
    return disposition.lines.map((line): BlockedDisposition => ({
      kind: "blocked",
      line,
      column: "npi",
      displayName: disposition.displayName,
      reason,
    }));
  });
}

/** No estimate until this many rows are done (two batches): the first ones
 * ride the burst, and a rate from a handful of rows swings too much to show. */
export const ETA_MIN_DONE = 20;

/** Time left from the rows done so far: the observed rate, capped by the
 * budget (the rate can never be faster than the budget once the burst is
 * spent, so a fast start never promises too much). Null while the estimate
 * would not be reliable — fewer than ETA_MIN_DONE rows done, or nothing left. */
export function estimateRemainingMs(input: {
  done: number;
  total: number;
  elapsedMs: number;
  budgetPerMinute: number;
}): number | null {
  const remaining = input.total - input.done;
  if (remaining <= 0 || input.done < ETA_MIN_DONE || input.elapsedMs <= 0) {
    return null;
  }
  const observedPerMs = input.done / input.elapsedMs;
  const budgetPerMs = input.budgetPerMinute / 60_000;
  const perMs = Math.min(observedPerMs, budgetPerMs);
  return perMs > 0 ? Math.ceil(remaining / perMs) : null;
}

/** "A few seconds left", "About 40 seconds left", "About 2 minutes left". */
export function formatTimeRemaining(ms: number): string {
  if (ms < 10_000) return "A few seconds left";
  if (ms < 50_000) return `About ${Math.ceil(ms / 10_000) * 10} seconds left`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

/** Rows by what their check found, for the summary line. */
export interface ImportNpiCounts {
  /** Checked rows with a warning. */
  notes: number;
  /** Rows a "block" severity holds back. */
  blocked: number;
}

function countNotChecked(snapshot: ImportNpiSnapshot): Record<ImportNpiNotCheckedReason, number> {
  const counts: Record<ImportNpiNotCheckedReason, number> = {
    unavailable: 0,
    rate_limited: 0,
    stopped: 0,
  };
  for (const outcome of snapshot.results.values()) {
    if (outcome.status === "not_checked") counts[outcome.reason] += 1;
  }
  return counts;
}

// "40 of 100 checked, 3 with notes." plus blocks and why rows went unchecked.
function finishedSummary(snapshot: ImportNpiSnapshot, counts: ImportNpiCounts): string {
  const notes = `${counts.notes} with ${counts.notes === 1 ? "a note" : "notes"}`;
  const blocked = counts.blocked > 0 ? `, ${counts.blocked} blocked` : "";
  const head = `${snapshot.checked} of ${snapshot.total} checked, ${notes}${blocked}.`;
  if (snapshot.phase === "stopped") return head;
  const missing = countNotChecked(snapshot);
  const unchecked = missing.unavailable + missing.rate_limited + missing.stopped;
  if (unchecked === 0) return head;
  return missing.unavailable > 0
    ? `${head} ${unchecked} not checked — the NPI Registry is unavailable.`
    : `${head} ${unchecked} not checked.`;
}

/** The visible status line under the progress bar. */
export function importNpiStatusText(snapshot: ImportNpiSnapshot, counts: ImportNpiCounts): string {
  const { phase, total, done } = snapshot;
  if (phase === "idle") return `${total} NPI${total === 1 ? "" : "s"} to check`;
  if (phase === "running") return `${done} of ${total} checked`;
  if (phase === "stopped") {
    return `Stopped — ${finishedSummary(snapshot, counts)} Rows not checked say so.`;
  }
  return `Finished — ${finishedSummary(snapshot, counts)}`;
}

/** What the polite live region says. It changes at the start, at each quarter
 * and at the end — never once per row. */
export function importNpiAnnouncement(
  snapshot: ImportNpiSnapshot,
  counts: ImportNpiCounts,
): string {
  const { phase, total, done } = snapshot;
  if (phase === "idle" || total === 0) return "";
  if (phase === "running") {
    const quarter = Math.min(3, Math.floor((done / total) * 4));
    return quarter === 0
      ? `Checking ${total} NPI${total === 1 ? "" : "s"} in the NPI Registry.`
      : `NPI Registry checks ${quarter * 25}% done.`;
  }
  return `NPI Registry checks ${phase === "stopped" ? "stopped" : "finished"}: ${finishedSummary(snapshot, counts)}`;
}
