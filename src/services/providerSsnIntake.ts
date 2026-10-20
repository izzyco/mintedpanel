
// 2026-10-20 — Provider-side SSN write, session-bound. Operator-side store_ssn
// continues to live in src/services/ssnVault.ts; this module is the anon write
// path used by the self-onboarding profile form.
import { supabase } from "@/integrations/supabase/externalClient";

function boundRpc() {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface ProviderSsnWriteResult {
  ok: boolean;
  state: "used" | "invalid" | "expired" | "revoked";
  mask?: string;
}

export async function submitProviderSsn(
  sessionToken: string,
  ssn: string,
): Promise<ProviderSsnWriteResult> {
  const { data, error } = await boundRpc()("submit_provider_ssn", {
    p_session_token: sessionToken,
    p_ssn: ssn,
  });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false, state: "invalid" }) as ProviderSsnWriteResult;
}
