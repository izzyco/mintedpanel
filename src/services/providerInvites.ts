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

/** "sandbox": SendGrid accepted it in sandbox mode, so nothing was delivered. */
export type InviteDelivery = "sent" | "sandbox" | "failed";

/** "added_group": the email or NPI matched a provider outside the chosen group.
 * Their record now includes that group, and no email was sent. */
export type ProviderInviteResult =
  | { outcome: "created"; providerId: string; delivery: InviteDelivery }
  | { outcome: "already_exists"; providerId: string }
  | { outcome: "added_group"; providerId: string };

export function createProviderInvite(input: ProviderInviteInput): Promise<ProviderInviteResult> {
  return authedApiFetch<ProviderInviteResult>("/api/provider-invites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `email` is where the invite went: the provider record's current address. */
export interface ResendInviteResult {
  delivery: InviteDelivery;
  email: string;
}

/** "deleted": the invite created the record and nothing else was on it, so
 * the record is gone. "closed": the record stays; what the onboarding wrote is
 * removed. A 404 has no open onboarding; a 409 already_submitted is past
 * Submit. */
export interface CancelOnboardingResult {
  outcome: "deleted" | "closed";
}

export function cancelProviderOnboarding(providerId: string): Promise<CancelOnboardingResult> {
  return authedApiFetch<CancelOnboardingResult>(
    `/api/provider-invites/${encodeURIComponent(providerId)}/cancel`,
    { method: "POST", body: "{}" },
  );
}

export function resendProviderInvite(providerId: string): Promise<ResendInviteResult> {
  return authedApiFetch<ResendInviteResult>(
    `/api/provider-invites/${encodeURIComponent(providerId)}/resend`,
    { method: "POST", body: "{}" },
  );
}
