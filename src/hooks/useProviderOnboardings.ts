import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
import type { PersonCheckKey } from "@/lib/onboardingCard";
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

function useOnboardingWrite<V>(
  write: (vars: V) => Promise<void>,
  alsoInvalidate: (orgId: string) => QueryKey[] = () => [],
) {
  const qc = useQueryClient();
  const orgId = useActiveOrgId() ?? "no-org";
  return useMutation({
    mutationFn: write,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) }),
        qc.invalidateQueries({ queryKey: ["audit-log", orgId] }),
        ...alsoInvalidate(orgId).map((queryKey) => qc.invalidateQueries({ queryKey })),
      ]);
    },
  });
}

export function useRecordOnboardingCheck() {
  return useOnboardingWrite(
    (vars: {
      onboardingId: string;
      checkKey: PersonCheckKey;
      outcome: "confirmed" | "problem";
      note: string | null;
    }) => recordOnboardingCheck(vars),
  );
}

export function useMarkOnboardingContacted() {
  return useOnboardingWrite((onboardingId: string) => markOnboardingContacted(onboardingId));
}

/** Admit also writes her location assignment, so the record's facility line
 * and the roster's counts refresh. */
export function useAdmitProviderOnboarding() {
  return useOnboardingWrite(
    (vars: { onboardingId: string; facilityId: string }) =>
      admitProviderOnboarding(vars.onboardingId, vars.facilityId),
    (orgId) => [queryKeys.facilityAssignments(orgId), ["provider", orgId], ["providers", orgId]],
  );
}
