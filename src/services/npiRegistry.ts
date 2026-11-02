// NPI Registry (NPPES) lookups — MINT-110. Sanctioned /api surface: the
// registry API has no CORS, so the browser asks our server, which calls it.
import { ApiRequestError, authedApiFetch } from "@/services/authedApi";
import type {
  NpiRegistryLookupResult,
  NpiRegistrySearchInput,
  NpiRegistrySearchResult,
} from "@/lib/npiRegistry";
import type { NpiRegistryBatchResult } from "@/lib/npiRegistryBatch";
import type { NpiRegistryPullInput, NpiRegistryPullResult } from "@/lib/npiRegistryPulls";

/** Individuals (NPI-1) matching a first and last name, optionally in a state. */
export function searchNpiRegistry(input: NpiRegistrySearchInput): Promise<NpiRegistrySearchResult> {
  return authedApiFetch<NpiRegistrySearchResult>("/api/npi-registry/search", {
    method: "POST",
    body: JSON.stringify({
      firstName: input.firstName,
      lastName: input.lastName,
      state: input.state || null,
    }),
  });
}

/** The registry record for one NPI, or `record: null` when it has none. */
export function lookupNpiRegistry(npi: string): Promise<NpiRegistryLookupResult> {
  return authedApiFetch<NpiRegistryLookupResult>("/api/npi-registry/lookup", {
    method: "POST",
    body: JSON.stringify({ npi }),
  });
}

/** MINT-110 PR 2: check up to NPI_REGISTRY_BATCH_MAX NPIs at once (the import
 * review). Only the NPIs are sent. A failure throws ApiRequestError, whose
 * `status` and `retryAfterSeconds` tell a rate limit (429) from an outage. */
export function verifyNpiRegistryBatch(
  npis: string[],
  signal?: AbortSignal,
): Promise<NpiRegistryBatchResult> {
  return authedApiFetch<NpiRegistryBatchResult>("/api/npi-registry/verify-batch", {
    method: "POST",
    body: JSON.stringify({ npis }),
    signal,
  });
}

/** MINT-110 PR 3: store the registry answer a save used as the provider's
 * source data. Only the provider, its NPI, what the save took from the pick
 * and whether it was confirmed are sent; the server fetches the reply. */
export function recordNpiRegistryPull(input: NpiRegistryPullInput): Promise<NpiRegistryPullResult> {
  return authedApiFetch<NpiRegistryPullResult>("/api/npi-registry/pulls", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** What a failed pull logs: the event, how many of how many failed, and the
 * last HTTP status. Never an NPI, a provider or a value. */
export function npiRegistryPullFailureLog(
  failed: number,
  of: number,
  error: unknown,
): { event: "npi_registry_pull_failed"; failed: number; of: number; status: number | null } {
  return {
    event: "npi_registry_pull_failed",
    failed,
    of,
    status: error instanceof ApiRequestError ? error.status : null,
  };
}

/** After a save (or an import commit): record each pull, one request at a
 * time, in the background. Resolves, never rejects: a failure is logged
 * without values and never reaches the save. */
export async function recordNpiRegistryPulls(
  inputs: readonly NpiRegistryPullInput[],
): Promise<void> {
  let failed = 0;
  let lastError: unknown = null;
  for (const input of inputs) {
    try {
      await recordNpiRegistryPull(input);
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  }
  if (failed > 0) {
    const entry = npiRegistryPullFailureLog(failed, inputs.length, lastError);
    console.warn(entry.event, entry);
  }
}
