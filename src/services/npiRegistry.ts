// NPI Registry (NPPES) lookups — MINT-110. Sanctioned /api surface: the
// registry API has no CORS, so the browser asks our server, which calls it.
import { authedApiFetch } from "@/services/authedApi";
import type {
  NpiRegistryLookupResult,
  NpiRegistrySearchInput,
  NpiRegistrySearchResult,
} from "@/lib/npiRegistry";
import type { NpiRegistryBatchResult } from "@/lib/npiRegistryBatch";

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
