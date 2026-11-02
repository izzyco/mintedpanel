// NPI Registry checks on the import review — MINT-110 PR 2 / MINT-119. The
// pure half: which rows are checked, the one-line notes each row shows, the
// advisories captured after commit, the estimated time left, and the progress
// words. No I/O; ImportNpiVerifier (src/lib/importNpiVerifier.ts) does the
// requests.
//
// A registry answer never blocks or delays anything (Sowmya's standing rule,
// Oct 31; A30, A39–A41): every row the dedupe would commit is committed, and
// each registry answer becomes an advisory on its row, built by the same
// review builder the provider forms use (buildNpiRegistryReview). The NPI
// Registry policy (src/lib/npiRegistryPolicy.ts) picks the rows
// (`importVerifyScope`, default new providers only) and where each check's
// advisory shows (`display`): "review_step" lists it on its row here as a
// quiet one-line note — no confirm, nothing typed — and "backend_only" shows
// nothing. After commit, the registry's answers for the committed rows go to
// the capture seam as facts only, with the run's NPI-less creates
// (importNpiRowChecks). "Found" never shows unless the registry fully matched.
// Hard rules stay hard: the 10-digit rule and the check digit (the dedupe's,
// not this module's). Results live in memory only; nothing is stored per row
// and nothing from the registry reaches the run's error report.
import {
  unresolvedConflicts,
  type CommitPlan,
  type ImportRowDisposition,
  type RunResolutions,
  type StagedImportRow,
} from "@/lib/importDedupe";
import { isValidNpi, stripNpiSeparators } from "@/lib/providerIdentity";
import { advisoriesForRecord, type Advisory } from "@/lib/advisories";
import type { NpiLookupState, NpiRegistryRecord, NpiVerificationView } from "@/lib/npiRegistry";
import { NPI_REGISTRY_BATCH_PER_MINUTE } from "@/lib/npiRegistryBatch";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  type NpiImportVerifyScope,
  type NpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";
import { buildNpiRegistryReview, shownAdvisories } from "@/lib/npiRegistryReview";

export interface ImportNpiCheckItem {
  /** Separators stripped; passes the CMS check digit. */
  npi: string;
  /** The disposition's anchor row (a folded entry's first source row). */
  line: number;
  /** What the import file gives this row. */
  firstName: string;
  lastName: string;
  credentials: string;
  taxonomyCode: string;
  /** What the import would do with the row. */
  disposition: "create" | "update" | "skip";
}

export type ImportNpiNotCheckedReason = "unavailable" | "stopped";

/** A row's check. "not_checked" carries the words staff see: for an outage,
 * npiRegistryErrorMessage of the failure, the same as the forms. */
export type ImportNpiOutcome =
  | { status: "checked"; record: NpiRegistryRecord | null }
  | { status: "not_checked"; reason: ImportNpiNotCheckedReason; message: string };

export const IMPORT_NPI_STOPPED_MESSAGE = "The checks were stopped";

/** idle: not started. running: checking. done: every row has an outcome
 * (some may be "not checked" after an outage). stopped: staff stopped it, or
 * the import was cancelled or committed first. */
export type ImportNpiPhase = "idle" | "running" | "done" | "stopped";

export interface ImportNpiSnapshot {
  phase: ImportNpiPhase;
  total: number;
  /** Rows processed: checked, or not checked because of an outage. Rows Stop
   * left are not counted, so the bar stays put. */
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
 * (their NPI and names come from the staged row). Rows the dedupe blocks are
 * never checked. The check digit is applied again here so a failing number is
 * never sent upstream. */
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
        credentials: disposition.provider.credentials ?? "",
        taxonomyCode: disposition.provider.taxonomyCode ?? "",
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
        credentials: field(row, "credentials"),
        taxonomyCode: field(row, "taxonomy_code"),
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
  /** The quiet one-line notes the row shows: each "review_step" advisory's
   * title; "Found in the NPI Registry" only for a full match with no advisory
   * at all; "Not checked" when it was not; nothing for a "backend_only"
   * answer. Never a confirm, never a block. */
  notes: NpiVerificationView[];
}

function reviewFor(
  item: ImportNpiCheckItem,
  record: NpiRegistryRecord | null,
  policy: NpiRegistryPolicy,
) {
  const state: NpiLookupState = { status: "done", record };
  return buildNpiRegistryReview({
    npi: item.npi,
    verify: true,
    state,
    typed: { firstName: item.firstName, lastName: item.lastName },
    entered: {
      credentials: item.credentials,
      taxonomyCode: item.taxonomyCode,
      // The batch answer is trimmed to what the import shows and carries no
      // registry licenses, so the license-number check does not run here.
      licenses: [],
    },
    policy,
    confirmed: new Set(),
  });
}

/** One row's result, from the same review builder as the provider forms. */
export function importNpiRowResult(
  outcome: ImportNpiOutcome | undefined,
  item: ImportNpiCheckItem,
  phase: ImportNpiPhase,
  policy: NpiRegistryPolicy = DEFAULT_NPI_REGISTRY_POLICY,
): ImportNpiRowResult {
  if (!outcome) {
    const finished = phase === "done" || phase === "stopped";
    return {
      notes: [
        { tone: "neutral", title: finished ? "Not checked" : "Not checked yet", detail: null },
      ],
    };
  }
  if (outcome.status === "not_checked") {
    return {
      notes: [
        {
          tone: outcome.reason === "stopped" ? "neutral" : "warn",
          title: "Not checked",
          detail: `${outcome.message}.`,
        },
      ],
    };
  }
  const review = reviewFor(item, outcome.record, policy);
  const shown = shownAdvisories(review);
  // Every registry answer about the NPI is an advisory, so no advisory and an
  // "ok" line is a full match.
  const fullMatch = review.advisories.length === 0 && review.line?.tone === "ok";
  return {
    notes:
      shown.length > 0
        ? shown.map((advisory) => ({ tone: "warn" as const, title: advisory.title, detail: null }))
        : fullMatch
          ? [{ tone: "ok", title: "Found in the NPI Registry", detail: null }]
          : [],
  };
}

/** Rows by what their check found, for the summary line. */
export interface ImportNpiCounts {
  /** Checked rows that list at least one advisory. */
  notes: number;
}

/** The anchor lines of the dispositions a commit would write right now: every
 * create, and every update whose conflicts are all resolved (an update with
 * one unresolved is held back by the commit plan itself). */
export function importCommittedLines(
  dispositions: readonly ImportRowDisposition[] | null | undefined,
  resolutions: RunResolutions,
): Set<number> {
  const lines = new Set<number>();
  for (const disposition of dispositions ?? []) {
    if (disposition.kind === "create") lines.add(disposition.line);
    else if (
      disposition.kind === "update" &&
      unresolvedConflicts(disposition, resolutions).length === 0
    ) {
      lines.add(disposition.line);
    }
  }
  return lines;
}

/** Every row's result, keyed by its anchor line, plus the summary count and
 * how many rows the commit would write without a registry answer: those in
 * `committedLines` (importCommittedLines). */
export function summarizeImportNpiRows(
  items: readonly ImportNpiCheckItem[],
  snapshot: ImportNpiSnapshot,
  policy: NpiRegistryPolicy,
  committedLines: ReadonlySet<number>,
): {
  byLine: Map<number, ImportNpiRowResult>;
  counts: ImportNpiCounts;
  /** Rows the commit would write that were not checked. */
  unchecked: number;
} {
  const byLine = new Map<number, ImportNpiRowResult>();
  const counts: ImportNpiCounts = { notes: 0 };
  let unchecked = 0;
  for (const item of items) {
    const outcome = snapshot.results.get(item.npi);
    if (committedLines.has(item.line) && outcome?.status !== "checked") unchecked += 1;
    const result = importNpiRowResult(outcome, item, snapshot.phase, policy);
    byLine.set(item.line, result);
    if (outcome?.status === "checked" && result.notes.some((note) => note.tone === "warn")) {
      counts.notes += 1;
    }
  }
  return { byLine, counts, unchecked };
}

/** Which provider each committed row became: an update names its provider;
 * creates come back from commit_import_run in plan order, so they are paired
 * by position — and only when the counts agree, so no advisory is ever
 * attributed to the wrong provider. */
export function importCommitProviderIds(
  plan: Pick<CommitPlan, "creates" | "updates">,
  result: { createdProviderIds: readonly string[] },
): Map<number, string> {
  const byLine = new Map<number, string>();
  if (result.createdProviderIds.length === plan.creates.length) {
    plan.creates.forEach((create, index) =>
      byLine.set(create.line, result.createdProviderIds[index]),
    );
  }
  for (const update of plan.updates) byLine.set(update.line, update.provider_id);
  return byLine;
}

/** One committed row's registry advisories, by its anchor line. */
export interface ImportRowAdvisories {
  line: number;
  advisories: Advisory[];
}

/** The advisories captured after commit: for each committed row (a create or
 * an update; a skip writes nothing) whose provider is known and whose NPI the
 * registry answered, every advisory that answer produced — shown on the row
 * or kept for Mission Control. A row nobody checked adds nothing. Facts only
 * (A35, A41): the check key and the provider; no value, no name, no registry
 * data. */
export function importNpiCaptureAdvisories(input: {
  items: readonly ImportNpiCheckItem[];
  snapshot: ImportNpiSnapshot;
  policy: NpiRegistryPolicy;
  providerIdByLine: ReadonlyMap<number, string>;
}): ImportRowAdvisories[] {
  const captured: ImportRowAdvisories[] = [];
  for (const item of input.items) {
    const providerId = input.providerIdByLine.get(item.line);
    const outcome = input.snapshot.results.get(item.npi);
    if (item.disposition === "skip" || !providerId || outcome?.status !== "checked") continue;
    const review = reviewFor(item, outcome.record, input.policy);
    if (review.advisories.length === 0) continue;
    captured.push({
      line: item.line,
      advisories: advisoriesForRecord(review.advisories, providerId),
    });
  }
  return captured;
}

/** An import NPI check the advisory ledger records at commit:
 * import.npi_missing on the provider a blank-NPI create became (B3: a blank
 * NPI imports). A row held back for a malformed or check-digit-failing NPI
 * did not proceed (a hard block), so it is no bypassed check and records
 * nothing. */
export interface ImportNpiRowCheck {
  check: "import.npi_missing";
  record: { table: "providers"; id: string };
  line: number;
}

/** The run's import NPI checks at commit: every create with no NPI whose
 * provider is known (importCommitProviderIds), by its anchor line. */
export function importNpiRowChecks(input: {
  plan: Pick<CommitPlan, "creates">;
  providerIdByLine: ReadonlyMap<number, string>;
}): ImportNpiRowCheck[] {
  const checks: ImportNpiRowCheck[] = [];
  for (const create of input.plan.creates) {
    const providerId = input.providerIdByLine.get(create.line);
    if (providerId && !create.provider.npi?.trim()) {
      checks.push({
        check: "import.npi_missing",
        record: { table: "providers", id: providerId },
        line: create.line,
      });
    }
  }
  return checks;
}

/** No estimate until this many rows are done (two requests): a rate from a
 * handful of rows swings too much to show. */
export const ETA_MIN_DONE = 20;

/** Time left for this run's own rows (rows a previous run already checked
 * cost no time and are not counted). Two limits, and the later wins:
 * - the registry's pace: this run's rows over the time their requests took;
 * - the budget: NPI_REGISTRY_BATCH_PER_MINUTE NPIs per minute-long window, so
 *   the last row cannot go before the window it falls in opens. Windows are
 *   counted from `windowOpensInMs` (when the current window opened, negative,
 *   or the next one opens, from a 429's Retry-After), and `sentInWindow` NPIs
 *   of this run already went in it.
 * Until the first 429 the window is taken to open with the run, so a window an
 * earlier run already opened isn't known yet; the estimate corrects on that 429.
 * Null while the estimate would not be reliable — fewer than ETA_MIN_DONE of
 * this run's rows done, or nothing left. */
export function estimateRemainingMs(input: {
  done: number;
  activeMs: number;
  remaining: number;
  windowOpensInMs: number;
  sentInWindow: number;
}): number | null {
  const { done, activeMs, remaining, windowOpensInMs, sentInWindow } = input;
  if (remaining <= 0 || done < ETA_MIN_DONE || activeMs <= 0) return null;
  const msPerRow = activeMs / done;
  // The last row's place in the windows, counted from the current one's start.
  const lastRow = sentInWindow + remaining - 1;
  const lastWindowOpensIn =
    windowOpensInMs + Math.floor(lastRow / NPI_REGISTRY_BATCH_PER_MINUTE) * 60_000;
  const rowsInLastWindow = Math.min(remaining, (lastRow % NPI_REGISTRY_BATCH_PER_MINUTE) + 1);
  return Math.ceil(
    Math.max(remaining * msPerRow, Math.max(0, lastWindowOpensIn) + rowsInLastWindow * msPerRow),
  );
}

/** "A few seconds left", "About 40 seconds left", "About 2 minutes left". */
export function formatTimeRemaining(ms: number): string {
  if (ms < 10_000) return "A few seconds left";
  if (ms < 50_000) return `About ${Math.ceil(ms / 10_000) * 10} seconds left`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

function countNotChecked(snapshot: ImportNpiSnapshot): Record<ImportNpiNotCheckedReason, number> {
  const counts: Record<ImportNpiNotCheckedReason, number> = { unavailable: 0, stopped: 0 };
  for (const outcome of snapshot.results.values()) {
    if (outcome.status === "not_checked") counts[outcome.reason] += 1;
  }
  return counts;
}

// "40 of 100 checked, 3 with notes." plus why rows went unchecked.
function finishedSummary(snapshot: ImportNpiSnapshot, counts: ImportNpiCounts): string {
  const notes = `${counts.notes} with ${counts.notes === 1 ? "a note" : "notes"}`;
  const head = `${snapshot.checked} of ${snapshot.total} checked, ${notes}.`;
  if (snapshot.phase === "stopped") return head;
  const missing = countNotChecked(snapshot);
  const unchecked = missing.unavailable + missing.stopped;
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
  const unchecked = countNotChecked(snapshot).unavailable;
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

/** The line next to "Commit is final…", or null. Commit never waits for the
 * checks (A39): committing stops any still running, and every row that will
 * be committed without a registry answer goes in marked "not checked" — the
 * line says how many. */
export function importNpiCommitWarning(input: {
  phase: ImportNpiPhase;
  unchecked: number;
}): string | null {
  const { phase, unchecked } = input;
  const rows = `${unchecked} row${unchecked === 1 ? "" : "s"}`;
  const goIn = unchecked === 1 ? "goes in" : "go in";
  if (phase === "running") {
    return unchecked > 0
      ? `NPI Registry checks are still running; committing stops them, and ${rows} ${goIn} not checked.`
      : "NPI Registry checks are still running; committing stops them.";
  }
  if (unchecked > 0) return `${rows} ${goIn} not checked against the NPI Registry.`;
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
