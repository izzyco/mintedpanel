import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
import { useOnboardingWrite } from "@/hooks/useProviderOnboardings";
import {
  cancelProviderOnboarding,
  createProviderInvite,
  resendProviderInvite,
  type ProviderInviteInput,
} from "@/services/providerInvites";

export function useCreateProviderInvite() {
  const qc = useQueryClient();
  const orgId = useActiveOrgId() ?? "no-org";
  return useMutation({
    mutationFn: (input: ProviderInviteInput) => createProviderInvite(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers", orgId] });
      qc.invalidateQueries({ queryKey: ["provider", orgId] });
      qc.invalidateQueries({ queryKey: queryKeys.providerGroupAssignments(orgId) });
      qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) });
      qc.invalidateQueries({ queryKey: ["audit-log", orgId] });
    },
  });
}

export function useResendProviderInvite() {
  const qc = useQueryClient();
  const orgId = useActiveOrgId() ?? "no-org";
  return useMutation({
    mutationFn: resendProviderInvite,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) });
      qc.invalidateQueries({ queryKey: ["audit-log", orgId] });
    },
  });
}

export function useCancelProviderOnboarding() {
  return useOnboardingWrite(cancelProviderOnboarding, {
    alsoInvalidate: (orgId) => [
      ["providers", orgId],
      ["provider", orgId],
      queryKeys.providerGroupAssignments(orgId),
      queryKeys.onboardingFunnel(orgId),
    ],
    // On error too, since a 409 means she submitted after the card loaded and
    // the refetched card drops its Cancel button.
    refreshOnError: true,
  });
}
