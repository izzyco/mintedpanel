// POST /api/npi-registry/verify-batch — MINT-110 PR 2: check the NPIs of the
// providers a roster import would create, a few at a time, while the import
// review screen is open.
//
//   POST /api/npi-registry/verify-batch  { npis: string[] }   1–10 NPIs
//     → { results: [{ npi, status: "checked" | "unavailable" | "deferred",
//                     record: NpiRegistryRecord | null }] }
//
// Same wall as /search and /lookup: the full org guard (authenticate()), then
// writer-only. Same order: role, then validation, then budget, so a forbidden
// or malformed request never spends the budget and never reaches the registry.
// Each NPI is answered like /lookup (same validation, the same shared cache and
// key, the same narrowed public record); only the NPI goes upstream. Nothing is
// stored and no audit row is written: the registry is public data.
//
// Budget: its own per-user token bucket (src/lib/npiRegistryBatch.ts), so an
// import never eats the interactive 30 a minute. Over budget → 429 with
// Retry-After. In memory per instance, best effort (TECH-DEBT TD-55/TD-56).
//
// Errors are per NPI. A registry failure marks that NPI "unavailable" and stops
// new calls in this request (an outage costs at most two timeouts, not ten);
// only when nothing in the request could be checked is it a 502. NPIs never
// sent come back "deferred" with their budget refunded, so the browser can ask
// again: after an outage, past NPI_REGISTRY_BATCH_START_DEADLINE_MS (a slow
// registry cannot hold a request open past a function's time limit), or once
// the caller has gone (the request's abort signal also cancels calls in
// flight). An unexpected error stops every worker before it is rethrown, and
// the budget is refunded either way. The answer carries a trimmed record
// (trimNpiRecordForImport): no addresses, phones or identifiers. Logs the
// failure kind only, never an NPI.
import { fail, ok } from "./envelope";
import { isWriter, type AuthContext } from "./guard";
import {
  NpiRegistryQueryRejectedError,
  NpiRegistryUnavailableError,
  type NpiRegistryFailureKind,
  type NppesDeps,
} from "./npiRegistry";
import { lookupNpiRegistryCached } from "./npiRegistryRoutes";
import { NPI_REGISTRY_UNAVAILABLE_MESSAGE } from "@/lib/npiRegistry";
import {
  NPI_REGISTRY_BATCH_BURST,
  NPI_REGISTRY_BATCH_PER_MINUTE,
  NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE,
  TokenBucket,
  trimNpiRecordForImport,
  validateNpiRegistryBatch,
  type NpiRegistryBatchItemResult,
  type NpiRegistryBatchResult,
} from "@/lib/npiRegistryBatch";

/** Registry calls in flight per request. */
export const NPI_REGISTRY_BATCH_CONCURRENCY = 2;
/** No registry call starts this long after the request began. With the 5 s
 * per-call timeout a request ends within about 9 s. */
export const NPI_REGISTRY_BATCH_START_DEADLINE_MS = 4_000;

const refillPerMs = NPI_REGISTRY_BATCH_PER_MINUTE / 60_000;
let clock: () => number = Date.now;
let budget = new TokenBucket(NPI_REGISTRY_BATCH_BURST, refillPerMs, clock);

/** Tests only: a fresh batch budget, optionally on a fake clock. The shared
 * lookup cache is reset by resetNpiRegistryLimits. */
export function resetNpiRegistryBatchBudget(now: () => number = Date.now): void {
  clock = now;
  budget = new TokenBucket(NPI_REGISTRY_BATCH_BURST, refillPerMs, now);
}

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

interface BatchOutcome {
  results: NpiRegistryBatchItemResult[];
  /** NPIs never sent upstream (all "deferred"). */
  notStarted: number;
  failureKind: NpiRegistryFailureKind | "rejected" | null;
  failureStatus: number | undefined;
}

// The injected fetch, also cancelled when the caller goes away.
function withCallerSignal(deps: NppesDeps, signal: AbortSignal | undefined): NppesDeps {
  if (!signal) return deps;
  const upstream = deps.fetch ?? fetch;
  return {
    ...deps,
    fetch: (input, init) =>
      upstream(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
  };
}

async function checkAll(
  npis: string[],
  deps: NppesDeps,
  signal: AbortSignal | undefined,
  onSettled: (notStarted: number) => void,
): Promise<BatchOutcome> {
  const results: NpiRegistryBatchItemResult[] = npis.map((npi) => ({
    npi,
    status: "deferred",
    record: null,
  }));
  const started = clock();
  const upstreamDeps = withCallerSignal(deps, signal);
  let next = 0;
  let notStarted = npis.length;
  let outage: NpiRegistryUnavailableError | null = null;
  let rejected = false;
  // Set by the first unexpected error, so no worker starts another call.
  let unexpected: { error: unknown } | null = null;

  const worker = async () => {
    for (;;) {
      if (outage || unexpected || signal?.aborted || next >= npis.length) return;
      if (clock() - started >= NPI_REGISTRY_BATCH_START_DEADLINE_MS) return;
      const index = next;
      next += 1;
      notStarted -= 1;
      try {
        const answer = await lookupNpiRegistryCached(npis[index], upstreamDeps);
        results[index] = {
          npi: npis[index],
          status: "checked",
          record: answer.record ? trimNpiRecordForImport(answer.record) : null,
        };
      } catch (error) {
        if (error instanceof NpiRegistryUnavailableError) {
          outage ??= error;
        } else if (error instanceof NpiRegistryQueryRejectedError) {
          // Not expected for a check-digit-valid number; this NPI only.
          rejected = true;
        } else {
          unexpected ??= { error };
          return;
        }
        results[index] = { npi: npis[index], status: "unavailable", record: null };
      }
    }
  };
  try {
    await Promise.allSettled(
      Array.from({ length: Math.min(NPI_REGISTRY_BATCH_CONCURRENCY, npis.length) }, worker),
    );
  } finally {
    onSettled(notStarted);
  }
  const failed = unexpected as { error: unknown } | null;
  if (failed) throw failed.error;
  const failure = outage as NpiRegistryUnavailableError | null;
  return {
    results,
    notStarted,
    failureKind: failure ? failure.kind : rejected ? "rejected" : null,
    failureStatus: failure?.status,
  };
}

export async function handleNpiRegistryVerifyBatch(
  body: unknown,
  ctx: AuthContext,
  deps: NppesDeps = {},
  signal?: AbortSignal,
): Promise<Response> {
  if (!isWriter(ctx)) {
    return privateResponse(
      fail(403, "Only admins and specialists can check NPIs in the NPI Registry"),
    );
  }
  const input = validateNpiRegistryBatch(body);
  if (!input.ok) return privateResponse(fail(422, input.error));
  const decision = budget.take(ctx.userId, input.value.length);
  if (!decision.allowed) {
    const response = privateResponse(fail(429, NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE));
    response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    return response;
  }

  // NPIs never sent cost nothing, whether the request finished or failed.
  const outcome = await checkAll(input.value, deps, signal, (notStarted) =>
    budget.refund(ctx.userId, notStarted),
  );
  if (outcome.failureKind && !signal?.aborted) {
    const unchecked = outcome.results.filter((result) => result.status === "unavailable").length;
    // The failure kind, upstream status and a count — never an NPI.
    console.warn(
      `[npi-registry] verify-batch: ${unchecked} of ${outcome.results.length} not checked (${outcome.failureKind}${outcome.failureStatus ? ` ${outcome.failureStatus}` : ""})`,
    );
  }
  const statuses = new Set(outcome.results.map((result) => result.status));
  if (!statuses.has("checked") && statuses.has("unavailable")) {
    return privateResponse(fail(502, NPI_REGISTRY_UNAVAILABLE_MESSAGE));
  }
  const result: NpiRegistryBatchResult = { results: outcome.results };
  return privateResponse(ok(result));
}
