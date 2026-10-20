
// 2026-10-20 — Portal credential service. Two paths: operator-side (authenticated,
// admin+specialist) and provider-side (auth-less, session-bound — TODO wire).
// Browser-facing write/reveal calls go through the operator-side RPCs.
import { supabase } from "@/integrations/supabase/externalClient";
import type { PortalCredentialReveal, PortalId } from "@/types";

function boundRpc() {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface PortalCredentialWriteResult {
  ok: boolean;
  portal: PortalId;
}

export async function storePortalCredential(
  providerId: string,
  portal: PortalId,
  username: string,
  password: string,
): Promise<PortalCredentialWriteResult> {
  const { data, error } = await boundRpc()("store_portal_credential", {
    p_provider_id: providerId,
    p_portal: portal,
    p_username: username,
    p_password: password,
  });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false, portal }) as PortalCredentialWriteResult;
}

export async function revealPortalCredential(
  providerId: string,
  portal: PortalId,
  justification: string,
): Promise<PortalCredentialReveal> {
  const { data, error } = await boundRpc()("reveal_portal_credential", {
    p_provider_id: providerId,
    p_portal: portal,
    p_justification: justification,
  });
  if (error) throw new Error(error.message);
  return data as PortalCredentialReveal;
}
