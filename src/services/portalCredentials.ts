// Provider portal logins (CAQH, PECOS) the provider saved during onboarding
// intake. The table has no client grant; staff read one back only through
// reveal_portal_credential, which re-checks that the caller is an admin of the
// provider's org and writes a READ audit row. The Onboarding card's Test login
// dialog is the one staff caller.
import { supabase } from "@/integrations/supabase/externalClient";
import type { IntakePortal } from "@/lib/intakeAnswers";
import type { PortalCredentialRevealResult } from "@/types";

/** Returns the login once; the caller must never persist, cache or log it. */
export async function revealPortalCredential(
  providerId: string,
  portal: IntakePortal,
  justification: string,
): Promise<PortalCredentialRevealResult> {
  const rpc = supabase.rpc.bind(supabase);
  const { data, error } = await rpc("reveal_portal_credential", {
    p_provider_id: providerId,
    p_portal: portal,
    p_justification: justification,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Record<string, unknown>;
  return { username: String(row.username ?? ""), password: String(row.password ?? "") };
}
