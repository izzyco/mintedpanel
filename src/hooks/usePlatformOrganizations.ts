// Mission Control › Organizations (M3) hooks. Every query runs only for a
// known platform admin; the database authorizes each read and write itself.
// Writes invalidate the "platform" prefix (list, detail, Home tiles) and
// reload the caller's memberships, because creating an organization and
// granting yourself admin membership both add one to the switcher.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/queryKeys";
import { useLifecycleStages } from "@/hooks/useLifecycleStages";
import { useAuthStore } from "@/lib/auth-store";
import { lifecycleValuesHiddenByDefault } from "@/lib/lifecycle";
import { usePlatformAdmin } from "@/lib/permissions";
import {
  createPlatformOrganization,
  getPlatformOrgSummary,
  getPlatformOrganization,
  grantSelfAdminMembership,
  listPlatformOrgInvites,
  listPlatformOrgMembers,
  listPlatformOrgNames,
  listPlatformOrganizations,
  setOrgLifecycle,
  updateOrganizationProfile,
  type CreatePlatformOrganizationInput,
  type OrganizationProfileInput,
} from "@/services/platformOrganizations";
import type { PlatformOrgListQuery } from "@/types";

const THIRTY_SECONDS = 30 * 1000;

export function usePlatformOrgList(query: PlatformOrgListQuery) {
  const isPlatformAdmin = usePlatformAdmin();
  const stages = useLifecycleStages();
  const hidden = lifecycleValuesHiddenByDefault(stages);
  return useQuery({
    queryKey: queryKeys.platformOrgs({ ...query, hidden }),
    queryFn: () => listPlatformOrganizations(query, hidden),
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
    placeholderData: keepPreviousData,
  });
}

/** Every organization's id and name (the same-name notice). */
export function usePlatformOrgNames() {
  const isPlatformAdmin = usePlatformAdmin();
  return useQuery({
    queryKey: queryKeys.platformOrgNames(),
    queryFn: listPlatformOrgNames,
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
  });
}

export function usePlatformOrg(orgId: string) {
  const isPlatformAdmin = usePlatformAdmin();
  return useQuery({
    queryKey: queryKeys.platformOrg(orgId),
    queryFn: () => getPlatformOrganization(orgId),
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
  });
}

export function usePlatformOrgSummary(orgId: string) {
  const isPlatformAdmin = usePlatformAdmin();
  return useQuery({
    queryKey: queryKeys.platformOrgSummary(orgId),
    queryFn: () => getPlatformOrgSummary(orgId),
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
  });
}

export function usePlatformOrgMembers(orgId: string) {
  const isPlatformAdmin = usePlatformAdmin();
  return useQuery({
    queryKey: queryKeys.platformOrgMembers(orgId),
    queryFn: () => listPlatformOrgMembers(orgId),
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
  });
}

export function usePlatformOrgInvites(orgId: string) {
  const isPlatformAdmin = usePlatformAdmin();
  return useQuery({
    queryKey: queryKeys.platformOrgInvites(orgId),
    queryFn: () => listPlatformOrgInvites(orgId),
    enabled: isPlatformAdmin === true,
    staleTime: THIRTY_SECONDS,
  });
}

function usePlatformWrite<TVariables, TResult>(
  write: (variables: TVariables) => Promise<TResult>,
  options: { reloadMemberships?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: async () => {
      if (options.reloadMemberships) {
        await useAuthStore
          .getState()
          .loadMemberships()
          .catch(() => undefined);
      }
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    },
  });
}

export function useCreatePlatformOrganization() {
  return usePlatformWrite(
    (input: CreatePlatformOrganizationInput) => createPlatformOrganization(input),
    { reloadMemberships: true },
  );
}

export function useSetOrgLifecycle(orgId: string) {
  return usePlatformWrite((stage: string) => setOrgLifecycle(orgId, stage), {
    reloadMemberships: true,
  });
}

export function useGrantSelfAdminMembership(orgId: string) {
  return usePlatformWrite(() => grantSelfAdminMembership(orgId), { reloadMemberships: true });
}

export function useUpdateOrganizationProfile(orgId: string) {
  return usePlatformWrite(
    (input: OrganizationProfileInput) => updateOrganizationProfile(orgId, input),
    { reloadMemberships: true },
  );
}
