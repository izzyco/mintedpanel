// NPI Registry (NPPES) reads — MINT-110. Both are reads with no side effects,
// cached for ten minutes (the server caches for ten too), never retried on
// their own: a failure is shown once and saving never waits for them. After a
// save, the NPI's advisories go to the capture seam (advisoryCapture), and a
// provider saved with no NPI is recorded as npi.missing (B3).
import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
import { lookupNpiRegistry, searchNpiRegistry } from "@/services/npiRegistry";
import { advisoriesForRecord } from "@/lib/advisories";
import { buildNpiRegistryReview, type NpiReviewInput } from "@/lib/npiRegistryReview";
import {
  logAdvisoryCaptureFailure,
  recordAdvisories,
  type AdvisoryFormSurface,
} from "@/services/advisoryCapture";
import { recordAdvisory } from "@/services/advisories";
import {
  npiLookupStateOf,
  npiRegistryErrorMessage,
  npiToCheck,
  npiVerificationView,
  type NpiLookupState,
  type NpiRegistryLookupResult,
  type NpiVerificationView,
  type NpiRegistryRecord,
  type NpiRegistrySearchInput,
} from "@/lib/npiRegistry";
import { resolveNpiRegistryPolicy, type NpiRegistryPolicy } from "@/lib/npiRegistryPolicy";

const TEN_MINUTES = 10 * 60 * 1000;

/** Verify one NPI. Pass null to skip (blank, malformed, or unchanged NPI). */
export function useNpiRegistryLookup(npi: string | null) {
  const orgId = useActiveOrgId() ?? "no-org";
  return useQuery({
    queryKey: queryKeys.npiRegistryLookup(orgId, npi ?? ""),
    queryFn: () => lookupNpiRegistry(npi ?? ""),
    enabled: npi !== null && orgId !== "no-org",
    staleTime: TEN_MINUTES,
    gcTime: TEN_MINUTES,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Search by name. Pass null until staff press Search. */
export function useNpiRegistrySearch(input: NpiRegistrySearchInput | null) {
  const orgId = useActiveOrgId() ?? "no-org";
  return useQuery({
    queryKey: queryKeys.npiRegistrySearch(orgId, {
      firstName: input?.firstName ?? "",
      lastName: input?.lastName ?? "",
      state: input?.state ?? "",
    }),
    queryFn: () => searchNpiRegistry(input ?? { firstName: "", lastName: "" }),
    enabled: input !== null && orgId !== "no-org",
    staleTime: TEN_MINUTES,
    gcTime: TEN_MINUTES,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Seed the lookup cache with a record staff just picked from a search, so
 * verifying the picked NPI costs no second registry call. */
export function usePrimeNpiRegistryLookup(): (record: NpiRegistryRecord) => void {
  const orgId = useActiveOrgId() ?? "no-org";
  const queryClient = useQueryClient();
  return useCallback(
    (record: NpiRegistryRecord) => {
      const result: NpiRegistryLookupResult = { record };
      queryClient.setQueryData(queryKeys.npiRegistryLookup(orgId, record.npi), result);
    },
    [orgId, queryClient],
  );
}

// No platform or organization override is stored yet: that storage and its
// Mission Control screen are MINT-128. Until then every organization runs on
// the defaults.
const RESOLVED_POLICY = resolveNpiRegistryPolicy();

/** The NPI Registry policy in force for the active organization. */
export function useNpiRegistryPolicy(): NpiRegistryPolicy {
  return RESOLVED_POLICY;
}

export interface NpiRegistryCheck {
  /** The NPI being checked, or null (blank, malformed, or not to be checked). */
  checkable: string | null;
  state: NpiLookupState;
  /** The note under the NPI field, or null when there is nothing to say. */
  view: NpiVerificationView | null;
  /** Ask the registry again (after it could not be reached). */
  retry: () => void;
}

/** The registry check of one NPI field: its state and its note. Every caller
 * with the same NPI shares one cached lookup, so the note, the review step
 * and the record page cost one registry call. A save never waits for it. */
export function useNpiRegistryCheck(
  npi: string,
  verify: boolean,
  typed: { firstName: string; lastName: string },
  policy: NpiRegistryPolicy,
): NpiRegistryCheck {
  const checkable = npiToCheck(npi, verify);
  const lookup = useNpiRegistryLookup(checkable);
  const state = npiLookupStateOf(checkable, lookup);
  const { refetch } = lookup;
  return {
    checkable,
    state,
    view: npiVerificationView(state, typed, policy),
    retry: () => void refetch(),
  };
}

/** What a saved form hands over for its NPI's advisories. */
export interface NpiAdvisoriesAfterSave {
  /** The saved provider's id. */
  recordId: string;
  /** The NPI, separators stripped; "" when the provider has none. */
  npi: string;
  /** Whether this save checks the NPI at all (see NpiReviewInput.verify):
   * a new provider, or an NPI entered, changed or cleared. */
  verify: boolean;
  /** The form that saved it. */
  surface: AdvisoryFormSurface;
  typed: NpiReviewInput["typed"];
  entered: NpiReviewInput["entered"];
  /** Advisory ids staff confirmed on the review step. */
  confirmed: ReadonlySet<string>;
  policy: NpiRegistryPolicy;
}

/** After a save: wait for the NPI's registry check (it may still be running —
 * the save never waits for it), build its advisories, and hand them, facts
 * only, to the capture seam. A save that leaves the provider with no NPI is
 * recorded as npi.missing instead (B3: a missing NPI is an advisory). It runs
 * outside the form, so it finishes after the dialog closes or the page moves
 * on. Resolves, never rejects. */
export async function recordNpiAdvisoriesAfterSave(
  client: QueryClient,
  orgId: string | null,
  input: NpiAdvisoriesAfterSave,
): Promise<void> {
  if (!orgId || !input.verify) return;
  if (!input.npi.trim()) {
    await recordAdvisory(
      "npi.missing",
      { table: "providers", id: input.recordId },
      { surface: input.surface },
    );
    return;
  }
  const checkable = npiToCheck(input.npi, input.verify);
  if (checkable === null) return;
  let state: NpiLookupState;
  try {
    const data = await client.fetchQuery({
      queryKey: queryKeys.npiRegistryLookup(orgId, checkable),
      queryFn: () => lookupNpiRegistry(checkable),
      staleTime: TEN_MINUTES,
      gcTime: TEN_MINUTES,
      retry: false,
    });
    state = { status: "done", record: data.record };
  } catch (error) {
    state = { status: "error", message: npiRegistryErrorMessage(error) };
  }
  const review = buildNpiRegistryReview({ ...input, npi: checkable, state });
  if (review.advisories.length === 0) return;
  const advisories = advisoriesForRecord(review.advisories, input.recordId);
  try {
    await recordAdvisories(advisories, { surface: input.surface });
  } catch (error) {
    logAdvisoryCaptureFailure(
      error,
      advisories.map((advisory) => advisory.check),
    );
  }
}

/** recordNpiAdvisoriesAfterSave for the active organization, fire and
 * forget: a failure is logged without values, never shown. */
export function useRecordNpiAdvisoriesAfterSave(): (input: NpiAdvisoriesAfterSave) => void {
  const client = useQueryClient();
  const orgId = useActiveOrgId();
  return useCallback(
    (input: NpiAdvisoriesAfterSave) => {
      void recordNpiAdvisoriesAfterSave(client, orgId, input).catch((error: unknown) =>
        logAdvisoryCaptureFailure(error, []),
      );
    },
    [client, orgId],
  );
}
