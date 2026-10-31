// NPI Registry checks on the import review — MINT-110 PR 2 / MINT-119. The
// pure half: which rows are checked, each row's result (a stable kind, its
// note, its severity), the rows a "block" severity holds back, the estimated
// time left, and the progress words. No I/O; ImportNpiVerifier
// (src/lib/importNpiVerifier.ts) does the scheduling.
//
// Policy comes from the NPI Registry policy (src/lib/npiRegistryPolicy.ts),
// passed in by the caller: `importVerifyScope` picks the rows (default
// "new_providers": only rows the import would CREATE as a new provider, after
// the five-part dedupe), and `severity` grades each registry answer through
// the helpers the provider forms use (npiLookupOutcome, npiRegistrySaveBlock,
// npiVerificationView), so an import row and a form agree on the outcome, its
// words and what it does. By default every answer warns and the review is
// unchanged except for the notes; a "block" holds the row back with a plain
// reason. Hard rules stay hard: the check digit still decides what is sent,
// and "not checked" (an outage, the rate limit, Stop) is a fact that never
// blocks. Results live in memory only; nothing is stored per row.
import {
  type BlockedDisposition,
  type ImportRowDisposition,
  type StagedImportRow,
} from "@/lib/importDedupe";
import { isValidNpi, stripNpiSeparators } from "@/lib/providerIdentity";
import {
  npiLookupOutcome,
  npiRegistrySaveBlock,
  npiVerificationView,
  type NpiLookupState,
  type NpiRegistryRecord,
  type NpiVerificationView,
} from "@/lib/npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  NPI_REGISTRY_OUTCOMES,
  type NpiImportVerifyScope,
  type NpiRegistryOutcome,
  type NpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";

/** A row's stable result kind: a registry outcome the policy grades
 * (organizationNumber, notFound, nameMismatch, inactive), "found" (listed,
 * active, the name matches), "notChecked" (an outage, the rate limit or Stop;
 * never configurable, never a block) or "pending" (not checked yet). */
export type ImportNpiResultKind = "found" | NpiRegistryOutcome | "notChecked" | "pending";

/** Whether a policy can block on any registry answer. */
export function npiPolicyCanBlock(policy: NpiRegistryPolicy): boolean {
  return NPI_REGISTRY_OUTCOMES.some((outcome) => policy.severity[outcome] === "block");
}

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

/** A row's check. "not_checked" carries the words staff see: for an outage,
 * npiRegistryErrorMessage of the failure, the same as the forms. */
export type ImportNpiOutcome =
  | { status: "checked"; record: NpiRegistryRecord | null }
  | { status: "not_checked"; reason: ImportNpiNotCheckedReason; message: string };

export const IMPORT_NPI_RATE_LIMITED_MESSAGE =
  "Too many NPI Registry checks right now. Reload the review to check again";
export const IMPORT_NPI_STOPPED_MESSAGE = "The checks were stopped";

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

/** The rows to check, one per NPI. "new_providers" (the default) takes the
 * creates; "all_rows" adds the rows that update or match an existing provider
 * (their NPI and names come from the staged row). Blocked rows are never
 * checked — they already cannot import. The check digit is applied again here
 * so a failing number is never sent upstream. */
export function selectImportNpiChecks(
  dispositions: readonly ImportRowDisposition[] | null | undefined,
  options: { scope?: NpiImportVerifyScope; rows?: readonly StagedImportRow[] | null } = {},
): ImportNpiCheckItem[] {
  if (!dispositions) return [];
  const scope = options.scope ?? DEFAULT_NPI_REGISTRY_POLICY.importVerifyScope;
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

export interface ImportNpiRowResult {
  kind: ImportNpiResultKind;
  /** "block" when the policy's severity for the outcome is block. */
  severity: "ok" | "warn" | "block";
  note: NpiVerificationView;
  /** The plain reason the review shows for a blocked row; null otherwise. */
  blockReason: string | null;
}

/** One row's result, graded like a provider form under the same policy: the
 * outcome is npiLookupOutcome, a block is npiRegistrySaveBlock, and the note
 * is npiVerificationView — except that an unblocked "not found" drops the
 * form's "You can still save" line (the import says once that a warning never
 * stops a row). A row not checked is never blocked, whatever the policy. */
export function importNpiRowResult(
  outcome: ImportNpiOutcome | undefined,
  typed: { firstName: string; lastName: string },
  phase: ImportNpiPhase,
  policy: NpiRegistryPolicy = DEFAULT_NPI_REGISTRY_POLICY,
): ImportNpiRowResult {
  if (!outcome) {
    const finished = phase === "done" || phase === "stopped";
    return {
      kind: finished ? "notChecked" : "pending",
      severity: "ok",
      note: { tone: "neutral", title: finished ? "Not checked" : "Not checked yet", detail: null },
      blockReason: null,
    };
  }
  if (outcome.status === "not_checked") {
    const stopped = outcome.reason === "stopped";
    return {
      kind: "notChecked",
      severity: stopped ? "ok" : "warn",
      note: {
        tone: stopped ? "neutral" : "warn",
        title: "Not checked",
        detail: `${outcome.message}.`,
      },
      blockReason: null,
    };
  }
  const state: NpiLookupState = { status: "done", record: outcome.record };
  const registryOutcome = npiLookupOutcome(state, typed);
  const saveBlock = npiRegistrySaveBlock(state, typed, policy);
  const view = npiVerificationView(state, typed, policy) ?? {
    tone: "neutral" as const,
    title: "Not checked",
    detail: null,
  };
  const note =
    outcome.record === null && !saveBlock
      ? { ...view, detail: "Re-check the number; deactivated NPIs are not listed." }
      : view;
  return {
    kind: registryOutcome ?? "found",
    severity: saveBlock ? "block" : registryOutcome ? "warn" : "ok",
    note,
    blockReason: saveBlock ? `${view.title}. ${saveBlock}` : null,
  };
}

/** Every checked row's result, keyed by its anchor line, plus what the review
 * needs from them: the plain reason for each row a block holds back (never a
 * skip: it writes nothing), the summary counts, and how many rows that would
 * be committed (creates and updates; never a skip) have no registry answer. */
export function summarizeImportNpiRows(
  items: readonly ImportNpiCheckItem[],
  snapshot: ImportNpiSnapshot,
  policy: NpiRegistryPolicy = DEFAULT_NPI_REGISTRY_POLICY,
): {
  byLine: Map<number, ImportNpiRowResult>;
  blockReasonByLine: Map<number, string>;
  counts: ImportNpiCounts;
  /** Rows to be committed (create / update) that were not checked. */
  unchecked: number;
} {
  const byLine = new Map<number, ImportNpiRowResult>();
  const blockReasonByLine = new Map<number, string>();
  const counts: ImportNpiCounts = { notes: 0, blocked: 0 };
  let unchecked = 0;
  for (const item of items) {
    const outcome = snapshot.results.get(item.npi);
    const committed = item.disposition !== "skip";
    if (committed && outcome?.status !== "checked") unchecked += 1;
    const result = importNpiRowResult(outcome, item, snapshot.phase, policy);
    byLine.set(item.line, result);
    if (result.blockReason && committed) {
      blockReasonByLine.set(item.line, result.blockReason);
      counts.blocked += 1;
    } else if (outcome?.status === "checked" && result.severity !== "ok") {
      counts.notes += 1;
    }
  }
  return { byLine, blockReasonByLine, counts, unchecked };
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

/** Rows done of rows total, and how many of those the registry could not
 * answer: "20 of 40 done" or "20 of 40 done, 10 not checked". The progress
 * bar's value text and the running status line; "done" never claims a row was
 * checked when it was not. */
export function importNpiProgressText(snapshot: ImportNpiSnapshot): string {
  const missing = countNotChecked(snapshot);
  const unchecked = missing.unavailable + missing.rate_limited;
  const head = `${snapshot.done} of ${snapshot.total} done`;
  return unchecked > 0 ? `${head}, ${unchecked} not checked` : head;
}

/** The visible status line under the progress bar. */
export function importNpiStatusText(snapshot: ImportNpiSnapshot, counts: ImportNpiCounts): string {
  const { phase, total } = snapshot;
  if (phase === "idle") return `${total} NPI${total === 1 ? "" : "s"} to check`;
  if (phase === "running") return importNpiProgressText(snapshot);
  if (phase === "stopped") {
    return `Stopped — ${finishedSummary(snapshot, counts)} Rows not checked say so.`;
  }
  return `Finished — ${finishedSummary(snapshot, counts)}`;
}

/** The line next to "Commit is final…", or null. Committing always stops the
 * checks; when the policy can block, rows not checked (still running, Stop,
 * an outage) go in without the check, so the warning says how many — also
 * after a failed commit, when the checks have already stopped. */
export function importNpiCommitWarning(input: {
  phase: ImportNpiPhase;
  unchecked: number;
  canBlock: boolean;
}): string | null {
  const { phase, unchecked, canBlock } = input;
  const rows = `${unchecked} row${unchecked === 1 ? "" : "s"}`;
  if (phase === "running") {
    return canBlock && unchecked > 0
      ? `NPI Registry checks are still running; committing stops them, and the ${rows} not yet checked go in without the check your NPI policy blocks on.`
      : "NPI Registry checks are still running; committing stops them.";
  }
  if (canBlock && unchecked > 0) {
    return unchecked === 1
      ? `${rows} was not checked against the NPI Registry and goes in without the check your NPI policy blocks on.`
      : `${rows} were not checked against the NPI Registry and go in without the check your NPI policy blocks on.`;
  }
  return null;
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
