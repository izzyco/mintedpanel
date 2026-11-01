// The import review's NPI Registry checks — MINT-110 PR 2 / MINT-119. A small
// state machine over the batch route: it sends the rows' NPIs ten at a time,
// one request in flight, and keeps every outcome in memory only.
//
// - A 429 waits out Retry-After, then sends the same batch again.
// - Any other failure (a 502, a dropped connection, an expired session) marks
//   that batch "not checked"; two in a row mark everything left "not checked"
//   and finish, rather than wait on a registry that is down.
// - stop() aborts the request in flight, schedules nothing more, and marks the
//   rows left "not checked — stopped". Cancelling or committing the import
//   calls it; so does leaving the page.
//
// Subscribe/getSnapshot fit React's useSyncExternalStore. Never a gate: the
// import can be committed at any point.
import { NPI_REGISTRY_BATCH_MAX, type NpiRegistryBatchResult } from "@/lib/npiRegistryBatch";
import { NPI_REGISTRY_UNAVAILABLE_MESSAGE, npiRegistryErrorMessage } from "@/lib/npiRegistry";
import {
  IMPORT_NPI_STOPPED_MESSAGE,
  estimateRemainingMs,
  type ImportNpiCheckItem,
  type ImportNpiNotCheckedReason,
  type ImportNpiOutcome,
  type ImportNpiPhase,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";

/** POST /api/npi-registry/verify-batch. Rejects with an error carrying
 * `status` (and `retryAfterSeconds` on a 429) when the route says no. */
export type VerifyNpiBatch = (
  npis: string[],
  signal: AbortSignal,
) => Promise<NpiRegistryBatchResult>;

/** Failed requests in a row before the rest are marked not checked. */
const MAX_FAILURES_IN_A_ROW = 2;
/** The wait after a 429 that names no Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

function readNumber(error: unknown, key: "status" | "retryAfterSeconds"): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class ImportNpiVerifier {
  private readonly npis: string[];
  private queue: string[];
  private readonly results = new Map<string, ImportNpiOutcome>();
  private phase: ImportNpiPhase = "idle";
  private startedAt: number | null = null;
  /** Time spent waiting out 429s, which the time-left pace leaves out. */
  private waitedMs = 0;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private snapshot: ImportNpiSnapshot;

  /** `known`: outcomes from a previous run over the same rows; only
   * "checked" ones are reused. */
  constructor(
    items: readonly ImportNpiCheckItem[],
    private readonly verifyBatch: VerifyNpiBatch,
    known?: ReadonlyMap<string, ImportNpiOutcome>,
  ) {
    this.npis = [...new Set(items.map((item) => item.npi))];
    for (const npi of this.npis) {
      const outcome = known?.get(npi);
      if (outcome?.status === "checked") this.results.set(npi, outcome);
    }
    this.queue = this.npis.filter((npi) => !this.results.has(npi));
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ImportNpiSnapshot => this.snapshot;

  /** Begin checking. A second call does nothing. */
  start(): void {
    if (this.phase !== "idle") return;
    this.startedAt = Date.now();
    this.phase = "running";
    // Anything unexpected (a malformed answer, a bug) ends the run as "not
    // checked" instead of leaving it running with nothing scheduled.
    void this.run().catch(() => {
      if (this.phase === "running") this.finish("unavailable", NPI_REGISTRY_UNAVAILABLE_MESSAGE);
    });
  }

  /** Abort the request in flight and schedule nothing more. Rows not yet
   * checked say "not checked — stopped". Safe to call at any time. */
  stop(): void {
    if (this.phase === "done" || this.phase === "stopped") return;
    this.controller.abort();
    this.markRemaining("stopped", IMPORT_NPI_STOPPED_MESSAGE);
    this.phase = "stopped";
    this.emit();
  }

  private buildSnapshot(): ImportNpiSnapshot {
    let checked = 0;
    let done = 0;
    for (const outcome of this.results.values()) {
      if (outcome.status === "checked") checked += 1;
      // A row Stop left unchecked was never processed: the bar stays where it
      // stopped instead of jumping to full.
      if (outcome.status === "checked" || outcome.reason !== "stopped") done += 1;
    }
    const etaMs =
      this.phase === "running" && this.startedAt !== null
        ? estimateRemainingMs({
            done,
            total: this.npis.length,
            elapsedMs: Date.now() - this.startedAt,
            waitedMs: this.waitedMs,
          })
        : null;
    return {
      phase: this.phase,
      total: this.npis.length,
      done,
      checked,
      results: new Map(this.results),
      etaMs,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private markRemaining(reason: ImportNpiNotCheckedReason, message: string): void {
    for (const npi of this.queue) {
      this.results.set(npi, { status: "not_checked", reason, message });
    }
    this.queue = [];
  }

  private finish(reason: ImportNpiNotCheckedReason | null, message = ""): void {
    if (reason) this.markRemaining(reason, message);
    this.phase = "done";
    this.emit();
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let failures = 0;
    this.emit();
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, NPI_REGISTRY_BATCH_MAX);
      let response: NpiRegistryBatchResult;
      try {
        response = await this.verifyBatch(batch, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (readNumber(error, "status") === 429) {
          const seconds = readNumber(error, "retryAfterSeconds") ?? DEFAULT_RETRY_AFTER_SECONDS;
          const waitFrom = Date.now();
          await abortableSleep(Math.max(1, seconds) * 1000, signal);
          if (signal.aborted) return;
          this.waitedMs += Date.now() - waitFrom;
          continue;
        }
        // The same words the provider forms use for a failed call.
        const message = npiRegistryErrorMessage(error);
        failures += 1;
        if (failures >= MAX_FAILURES_IN_A_ROW) {
          this.finish("unavailable", message);
          return;
        }
        this.queue = this.queue.slice(batch.length);
        for (const npi of batch) {
          this.results.set(npi, { status: "not_checked", reason: "unavailable", message });
        }
        this.emit();
        continue;
      }
      if (signal.aborted) return;
      failures = 0;
      const byNpi = new Map(response.results.map((result) => [result.npi, result]));
      for (const npi of batch) {
        const result = byNpi.get(npi);
        this.results.set(
          npi,
          result?.status === "checked"
            ? { status: "checked", record: result.record }
            : {
                status: "not_checked",
                reason: "unavailable",
                message: NPI_REGISTRY_UNAVAILABLE_MESSAGE,
              },
        );
      }
      this.queue = this.queue.slice(batch.length);
      if (this.queue.length > 0) this.emit();
    }
    this.finish(null);
  }
}

/** The life of the checks on one review screen, as useImportNpiVerification
 * drives it from an effect: begin() when the rows are known and checking is
 * enabled, end() in the effect's cleanup (the page goes away, checking is
 * disabled, or the rows change). A new set of rows reuses every NPI already
 * checked. stop() is the user's Stop (and Commit, and Cancel Import): it is
 * final for this review visit, so a later begin() — new rows, or a refetch
 * error and recovery — never starts the checks again. The session lives as
 * long as the review screen does. */
export class ImportNpiVerificationSession {
  private verifier: ImportNpiVerifier | null = null;
  private stoppedByUser = false;

  constructor(private readonly verifyBatch: VerifyNpiBatch) {}

  /** The run whose snapshot to show (the last one, even once it stopped). */
  get current(): ImportNpiVerifier | null {
    return this.verifier;
  }

  /** Whether Stop ended checking for this visit. */
  get stopped(): boolean {
    return this.stoppedByUser;
  }

  /** Stop any run, then start one over `items`, seeded with what is known —
   * unless the user stopped the checks, in which case nothing starts and the
   * stopped run (or null, if none ever ran) stays current. */
  begin(items: readonly ImportNpiCheckItem[]): ImportNpiVerifier | null {
    if (this.stoppedByUser) return this.verifier;
    const previous = this.verifier;
    previous?.stop();
    const next = new ImportNpiVerifier(items, this.verifyBatch, previous?.getSnapshot().results);
    this.verifier = next;
    next.start();
    return next;
  }

  /** Stop the current run (the effect's cleanup); its snapshot stays
   * readable, and a later begin() may start again. */
  end(): void {
    this.verifier?.stop();
  }

  /** The user's Stop: stop the current run and start none for this visit. */
  stop(): void {
    this.stoppedByUser = true;
    this.verifier?.stop();
  }
}
