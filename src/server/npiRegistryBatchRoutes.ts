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
// only when nothing in the request could be checked is it a 502. No new call
// starts after NPI_REGISTRY_BATCH_START_DEADLINE_MS, so a slow registry cannot
// hold a request open past a function's time limit; NPIs not started come back
// "deferred" and their budget is refunded. Logs the failure kind only, never
// an NPI.
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
  /** NPIs never sent upstream (deferred, or skipped after a failure). */
  notStarted: number;
  failureKind: NpiRegistryFailureKind | "rejected" | null;
  failureStatus: number | undefined;
}

async function checkAll(npis: string[], deps: NppesDeps): Promise<BatchOutcome> {
  const results: NpiRegistryBatchItemResult[] = npis.map((npi) => ({
    npi,
    status: "deferred",
    record: null,
  }));
  const started = clock();
  let next = 0;
  let notStarted = npis.length;
  let outage: NpiRegistryUnavailableError | null = null;
  let rejected = false;

  const worker = async () => {
    for (;;) {
      if (outage || next >= npis.length) return;
      if (clock() - started >= NPI_REGISTRY_BATCH_START_DEADLINE_MS) return;
      const index = next;
      next += 1;
      notStarted -= 1;
      try {
        const answer = await lookupNpiRegistryCached(npis[index], deps);
        results[index] = { npi: npis[index], status: "checked", record: answer.record };
      } catch (error) {
        if (error instanceof NpiRegistryUnavailableError) {
          outage ??= error;
        } else if (error instanceof NpiRegistryQueryRejectedError) {
          // Not expected for a check-digit-valid number; this NPI only.
          rejected = true;
        } else {
          throw error;
        }
        results[index] = { npi: npis[index], status: "unavailable", record: null };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NPI_REGISTRY_BATCH_CONCURRENCY, npis.length) }, worker),
  );

  // After an outage the NPIs never asked are not checked, not deferred: asking
  // again straight away would meet the same outage.
  if (outage) {
    for (const result of results) if (result.status === "deferred") result.status = "unavailable";
  }
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

  const outcome = await checkAll(input.value, deps);
  budget.refund(ctx.userId, outcome.notStarted);
  if (outcome.failureKind) {
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
