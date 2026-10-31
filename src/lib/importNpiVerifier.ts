// The import review's NPI Registry scheduler — MINT-110 PR 2 / MINT-119. A
// small state machine with its I/O injected: it sends the rows' NPIs a batch
// at a time, paced to the per-user batch budget with the same token bucket
// the server enforces (so it rarely meets a 429, and the time left can be
// estimated), and keeps every outcome in memory only.
//
// - One request in flight at a time; the server runs at most two registry
//   calls per request.
// - A 429 waits out Retry-After, then sends the same batch again.
// - An outage (502, a dropped connection, any other failure) marks that batch
//   "not checked"; two in a row mark everything left "not checked" and finish,
//   rather than wait on a registry that is down. A 4xx that will not get
//   better (an expired session, a role change) does the same at once.
// - stop() aborts the request in flight, schedules nothing more, and marks the
//   rows left "not checked — stopped". Cancelling or committing the import
//   calls it; so does leaving the page.
//
// Subscribe/getSnapshot fit React's useSyncExternalStore. Never a gate: the
// import can be committed at any point.
import {
  NPI_REGISTRY_BATCH_BURST,
  NPI_REGISTRY_BATCH_MAX,
  NPI_REGISTRY_BATCH_PER_MINUTE,
  TokenBucket,
  type NpiRegistryBatchResult,
} from "@/lib/npiRegistryBatch";
import { NPI_REGISTRY_UNAVAILABLE_MESSAGE, npiRegistryErrorMessage } from "@/lib/npiRegistry";
import {
  IMPORT_NPI_RATE_LIMITED_MESSAGE,
  IMPORT_NPI_STOPPED_MESSAGE,
  estimateRemainingMs,
  type ImportNpiCheckItem,
  type ImportNpiNotCheckedReason,
  type ImportNpiOutcome,
  type ImportNpiPhase,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";

export interface ImportNpiVerifierDeps {
  /** POST /api/npi-registry/verify-batch. Rejects with an error carrying
   * `status` (and `retryAfterSeconds` on a 429) when the route says no. */
  verifyBatch: (npis: string[], signal: AbortSignal) => Promise<NpiRegistryBatchResult>;
  now?: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ImportNpiVerifierOptions {
  batchSize?: number;
  burst?: number;
  perMinute?: number;
  /** Outage batches in a row before the rest are marked not checked. */
  maxConsecutiveOutages?: number;
  /** 429s in a row before the rest are marked not checked. */
  maxConsecutiveRateLimits?: number;
  /** Extra wait whenever pacing has to wait, for clock and network skew. */
  pacingMarginMs?: number;
  /** Outcomes already known (a previous run over the same rows); only
   * "checked" outcomes are reused. */
  known?: ReadonlyMap<string, ImportNpiOutcome>;
  /** The pacing bucket. Pass one shared across runs (the hook keeps one per
   * tab) so a restart does not begin with a full burst the server has already
   * spent; by default each run has its own. */
  bucket?: TokenBucket;
}

const BUCKET_KEY = "self";
// Statuses that will not change by asking again.
const FATAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 422]);

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
  private readonly controller = new AbortController();
  private readonly bucket: TokenBucket;
  private readonly listeners = new Set<() => void>();
  private snapshot: ImportNpiSnapshot;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly batchSize: number;
  private readonly perMinute: number;
  private readonly maxOutages: number;
  private readonly maxRateLimits: number;
  private readonly marginMs: number;

  constructor(
    items: readonly ImportNpiCheckItem[],
    private readonly deps: ImportNpiVerifierDeps,
    options: ImportNpiVerifierOptions = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
    this.batchSize = Math.max(
      1,
      Math.min(NPI_REGISTRY_BATCH_MAX, options.batchSize ?? NPI_REGISTRY_BATCH_MAX),
    );
    this.perMinute = options.perMinute ?? NPI_REGISTRY_BATCH_PER_MINUTE;
    this.maxOutages = options.maxConsecutiveOutages ?? 2;
    this.maxRateLimits = options.maxConsecutiveRateLimits ?? 5;
    this.marginMs = options.pacingMarginMs ?? 300;
    this.bucket =
      options.bucket ??
      new TokenBucket(options.burst ?? NPI_REGISTRY_BATCH_BURST, this.perMinute / 60_000, this.now);
    this.npis = [...new Set(items.map((item) => item.npi))];
    for (const npi of this.npis) {
      const known = options.known?.get(npi);
      if (known?.status === "checked") this.results.set(npi, known);
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
    this.startedAt = this.now();
    if (this.queue.length === 0) {
      this.phase = "done";
      this.emit();
      return;
    }
    this.phase = "running";
    this.emit();
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
    this.markRemaining("stopped");
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
            elapsedMs: this.now() - this.startedAt,
            budgetPerMinute: this.perMinute,
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

  private markRemaining(reason: ImportNpiNotCheckedReason, message?: string): void {
    const words =
      message ??
      (reason === "stopped"
        ? IMPORT_NPI_STOPPED_MESSAGE
        : reason === "rate_limited"
          ? IMPORT_NPI_RATE_LIMITED_MESSAGE
          : NPI_REGISTRY_UNAVAILABLE_MESSAGE);
    for (const npi of this.queue) {
      if (!this.results.has(npi)) {
        this.results.set(npi, { status: "not_checked", reason, message: words });
      }
    }
    this.queue = [];
  }

  private finish(reason: ImportNpiNotCheckedReason | null, message?: string): void {
    if (reason) this.markRemaining(reason, message);
    this.phase = "done";
    this.emit();
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let outages = 0;
    let rateLimits = 0;
    // After a 429 the server said when; the client bucket is not asked again.
    let resumeAfterRetry = false;

    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.batchSize);
      if (resumeAfterRetry) {
        resumeAfterRetry = false;
        this.bucket.drain(BUCKET_KEY);
      } else {
        const waitMs = this.bucket.msUntilAvailable(BUCKET_KEY, batch.length);
        if (waitMs > 0) await this.sleep(waitMs + this.marginMs, signal);
        if (signal.aborted) return;
        this.bucket.take(BUCKET_KEY, batch.length);
      }

      let response: NpiRegistryBatchResult;
      try {
        response = await this.deps.verifyBatch(batch, signal);
        // A 200 that is not a batch answer is the registry route failing.
        if (!Array.isArray((response as Partial<NpiRegistryBatchResult> | null)?.results)) {
          throw new Error("Malformed NPI Registry batch answer");
        }
      } catch (error) {
        if (signal.aborted) return;
        const status = readNumber(error, "status");
        if (status === 429) {
          rateLimits += 1;
          if (rateLimits > this.maxRateLimits) {
            this.finish("rate_limited");
            return;
          }
          const retryAfter = readNumber(error, "retryAfterSeconds") ?? 1;
          await this.sleep(Math.max(1, retryAfter) * 1000, signal);
          if (signal.aborted) return;
          resumeAfterRetry = true;
          continue;
        }
        // The same words the provider forms use for a failed call.
        const message = npiRegistryErrorMessage(error);
        if (status !== null && FATAL_STATUSES.has(status)) {
          this.finish("unavailable", message);
          return;
        }
        // An outage: this batch is not checked.
        for (const npi of batch) {
          this.results.set(npi, { status: "not_checked", reason: "unavailable", message });
        }
        this.queue = this.queue.slice(batch.length);
        outages += 1;
        if (outages >= this.maxOutages) {
          this.finish("unavailable", message);
          return;
        }
        this.emit();
        continue;
      }
      if (signal.aborted) return;
      rateLimits = 0;

      const byNpi = new Map(response.results.map((result) => [result.npi, result]));
      const deferred: string[] = [];
      let checkedAny = false;
      for (const npi of batch) {
        const result = byNpi.get(npi);
        if (!result || result.status === "deferred") {
          deferred.push(npi);
        } else if (result.status === "checked") {
          this.results.set(npi, { status: "checked", record: result.record });
          checkedAny = true;
        } else {
          this.results.set(npi, {
            status: "not_checked",
            reason: "unavailable",
            message: NPI_REGISTRY_UNAVAILABLE_MESSAGE,
          });
        }
      }
      // Deferred NPIs cost nothing on the server; ask for them first next.
      this.bucket.refund(BUCKET_KEY, deferred.length);
      this.queue = [...deferred, ...this.queue.slice(batch.length)];
      if (checkedAny) {
        outages = 0;
      } else {
        outages += 1;
        if (outages >= this.maxOutages) {
          this.finish("unavailable");
          return;
        }
      }
      if (this.queue.length === 0) {
        this.finish(null);
        return;
      }
      this.emit();
    }
    // The queue ran out on an outage batch: the run is over either way.
    if (!signal.aborted && this.phase === "running") this.finish(null);
  }
}

/** The life of the checks on one review screen, as useImportNpiVerification
 * drives it from an effect: begin() when the rows are known and checking is
 * enabled, end() in the effect's cleanup (the page goes away, checking is
 * disabled, or the rows change). A new set of rows reuses every NPI already
 * checked, and every run paces against the same bucket. */
export class ImportNpiVerificationSession {
  private verifier: ImportNpiVerifier | null = null;

  constructor(
    private readonly deps: ImportNpiVerifierDeps,
    private readonly options: Omit<ImportNpiVerifierOptions, "known"> = {},
  ) {}

  /** The run whose snapshot to show (the last one, even once it stopped). */
  get current(): ImportNpiVerifier | null {
    return this.verifier;
  }

  /** Stop any run, then start one over `items`, seeded with what is known. */
  begin(items: readonly ImportNpiCheckItem[]): ImportNpiVerifier {
    const previous = this.verifier;
    previous?.stop();
    const next = new ImportNpiVerifier(items, this.deps, {
      ...this.options,
      known: previous?.getSnapshot().results,
    });
    this.verifier = next;
    next.start();
    return next;
  }

  /** Stop the current run; its snapshot stays readable. */
  end(): void {
    this.verifier?.stop();
  }
}
