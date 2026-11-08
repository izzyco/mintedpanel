import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
import {
  admitProviderOnboarding,
  listOpenProviderOnboardings,
  markOnboardingContacted,
  readProviderOnboarding,
  recordOnboardingCheck,
} from "@/services/providerOnboardings";

const THIRTY_SECONDS = 30_000;

export function useOpenProviderOnboardings() {
  const orgId = useActiveOrgId() ?? "no-org";
  return useQuery({
    queryKey: queryKeys.openProviderOnboardings(orgId),
    queryFn: () => listOpenProviderOnboardings(),
    enabled: orgId !== "no-org",
    staleTime: THIRTY_SECONDS,
  });
}

export function useProviderOnboarding(providerId: string) {
  const orgId = useActiveOrgId() ?? "no-org";
  return useQuery({
    queryKey: queryKeys.providerOnboarding(orgId, providerId),
    queryFn: () => readProviderOnboarding(providerId),
    enabled: orgId !== "no-org" && Boolean(providerId),
    staleTime: THIRTY_SECONDS,
  });
}

/** An onboarding write refreshes every journey read and the audit log, plus
 * the keys this write also touches. */
export function useOnboardingWrite<V, R>(
  write: (vars: V) => Promise<R>,
  {
    alsoInvalidate = () => [],
    refreshOnError = false,
  }: { alsoInvalidate?: (orgId: string) => QueryKey[]; refreshOnError?: boolean } = {},
) {
  const qc = useQueryClient();
  const orgId = useActiveOrgId() ?? "no-org";
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) }),
      qc.invalidateQueries({ queryKey: ["audit-log", orgId] }),
      ...alsoInvalidate(orgId).map((queryKey) => qc.invalidateQueries({ queryKey })),
    ]);
  };
  return useMutation({
    mutationFn: write,
    onSuccess: refreshOnError ? undefined : refresh,
    // Cancel does not wait for the refetch, since its deleted path leaves the record page.
    onSettled: refreshOnError ? () => void refresh() : undefined,
  });
}

export function useRecordOnboardingCheck() {
  return useOnboardingWrite(recordOnboardingCheck);
}

export function useMarkOnboardingContacted() {
  return useOnboardingWrite(markOnboardingContacted);
}

/** Admit also writes her location assignment, so the record's facility line
 * and the roster's counts refresh. */
export function useAdmitProviderOnboarding() {
  return useOnboardingWrite(
    (vars: { onboardingId: string; facilityId: string }) =>
      admitProviderOnboarding(vars.onboardingId, vars.facilityId),
    {
      alsoInvalidate: (orgId) => [
        queryKeys.facilityAssignments(orgId),
        ["provider", orgId],
        ["providers", orgId],
      ],
    },
  );
}
