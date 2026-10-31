// NPI Registry (NPPES) reads — MINT-110. Both are reads with no side effects,
// cached for ten minutes (the server caches for ten too), never retried on
// their own: a failure is shown once and saving is never blocked on it.
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
import { lookupNpiRegistry, searchNpiRegistry } from "@/services/npiRegistry";
import {
  npiLookupStateOf,
  npiRegistrySaveBlock,
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
// Mission Control screen are a sibling of MINT-125. Until then every
// organization runs on the defaults.
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
  /** Why saving is refused under the policy, or null. */
  block: string | null;
}

/** The registry check of one NPI field: its state, its note, and whether the
 * policy refuses the save. Every caller with the same NPI shares one cached
 * lookup, so the note, the save and the record page cost one registry call. */
export function useNpiRegistryCheck(
  npi: string,
  verify: boolean,
  typed: { firstName: string; lastName: string },
  policy: NpiRegistryPolicy,
): NpiRegistryCheck {
  const checkable = npiToCheck(npi, verify);
  const lookup = useNpiRegistryLookup(checkable);
  const state = npiLookupStateOf(checkable, lookup);
  return {
    checkable,
    state,
    view: npiVerificationView(state, typed, policy),
    block: npiRegistrySaveBlock(state, typed, policy),
  };
}

/** Why a provider form must refuse to save under `policy`, or null. Reads the
 * same cached lookup the NPI field's note shows, so it adds no registry call. */
export function useNpiRegistrySaveBlock(
  npi: string,
  verify: boolean,
  typed: { firstName: string; lastName: string },
  policy: NpiRegistryPolicy,
): string | null {
  return useNpiRegistryCheck(npi, verify, typed, policy).block;
}
