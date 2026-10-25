// Staff provider invites (slice 1). Sanctioned /api surface: the invite email
// is sent by the server, so this can't run over browser RLS.
import { authedApiFetch } from "@/services/authedApi";

export interface ProviderInviteInput {
  firstName: string;
  lastName: string;
  email: string;
  groupId: string;
  npi?: string;
  startDate?: string;
}

export type ProviderInviteResult =
  | { outcome: "created"; providerId: string; emailSent: boolean }
  | { outcome: "already_exists"; providerId: string };

export function createProviderInvite(input: ProviderInviteInput): Promise<ProviderInviteResult> {
  return authedApiFetch<ProviderInviteResult>("/api/provider-invites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function resendProviderInvite(providerId: string): Promise<{ emailSent: boolean }> {
  return authedApiFetch<{ emailSent: boolean }>(
    `/api/provider-invites/${encodeURIComponent(providerId)}/resend`,
    { method: "POST", body: "{}" },
  );
}
