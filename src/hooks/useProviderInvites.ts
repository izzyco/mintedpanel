import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/lib/auth-store";
import { queryKeys } from "@/hooks/queryKeys";
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
    mutationFn: (providerId: string) => resendProviderInvite(providerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) });
      qc.invalidateQueries({ queryKey: ["audit-log", orgId] });
    },
  });
}

export function useCancelProviderOnboarding() {
  const qc = useQueryClient();
  const orgId = useActiveOrgId() ?? "no-org";
  return useMutation({
    mutationFn: (providerId: string) => cancelProviderOnboarding(providerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers", orgId] });
      qc.invalidateQueries({ queryKey: ["provider", orgId] });
      qc.invalidateQueries({ queryKey: queryKeys.providerOnboardings(orgId) });
      qc.invalidateQueries({ queryKey: queryKeys.onboardingFunnel(orgId) });
      qc.invalidateQueries({ queryKey: queryKeys.providerGroupAssignments(orgId) });
      qc.invalidateQueries({ queryKey: ["audit-log", orgId] });
    },
  });
}
