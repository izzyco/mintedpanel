// Staff reads and writes of provider onboarding journeys. The roster and case
// creation (who waits for Admit) read open journeys under RLS. The card's read
// and the three writes are authenticated SECURITY DEFINER RPCs (migration
// 20261107010000): each re-checks the caller's role in the journey's org and
// writes its own audit row, so this service writes none.
import { supabase } from "@/integrations/supabase/externalClient";
import { requireActiveOrg } from "@/lib/audit";
import { readCompletePages } from "@/lib/completePages";
import { isMissingProviderOnboardingsError, translateDbError } from "@/lib/dbErrors";
import { parseOnboardingRead, type PersonCheckKey } from "@/lib/onboardingCard";
import type { OpenProviderOnboarding, ProviderOnboardingRead } from "@/types";

const RPC_ERROR_COPY: Record<string, string> = {
  onboarding_not_found: "This onboarding wasn't found. Reload the page.",
  onboarding_writer_required: "Your role can view onboarding but not change it.",
  onboarding_closed: "This onboarding has already ended. Reload the page.",
  onboarding_not_submitted: "The provider hasn't submitted yet.",
  onboarding_location_ineligible:
    "That location can't be assigned. Pick an active location of one of the provider's groups.",
};

function rpcError(error: { message?: string }): unknown {
  const key = Object.keys(RPC_ERROR_COPY).find((k) => error.message?.includes(k));
  return key ? new Error(RPC_ERROR_COPY[key]) : translateDbError(error);
}

export async function listOpenProviderOnboardings(): Promise<OpenProviderOnboarding[]> {
  const orgId = requireActiveOrg();
  const query = supabase
    .from("provider_onboardings")
    .select("provider_id, created_record", { count: "exact" })
    .eq("org_id", orgId)
    .is("admitted_at", null)
    .is("cancelled_at", null)
    .order("id", { ascending: true });
  try {
    const rows = await readCompletePages(async (from, to) => await query.range(from, to), {
      label: "Open onboarding list",
    });
    return rows.map((r) => ({ providerId: r.provider_id, createdRecord: r.created_record }));
  } catch (error) {
    // Generation waits on this read, so a database without the table must
    // still generate: no table, no journey, nobody held.
    if (isMissingProviderOnboardingsError(error)) return [];
    throw error;
  }
}

export async function readProviderOnboarding(
  providerId: string,
): Promise<ProviderOnboardingRead | null> {
  const rpc = supabase.rpc.bind(supabase);
  const { data, error } = await rpc("read_provider_onboarding", { p_provider_id: providerId });
  if (error) throw rpcError(error);
  return parseOnboardingRead(data);
}

export async function recordOnboardingCheck(input: {
  onboardingId: string;
  checkKey: PersonCheckKey;
  outcome: "confirmed" | "problem";
  note: string | null;
}): Promise<void> {
  const rpc = supabase.rpc.bind(supabase);
  const { error } = await rpc("record_onboarding_check", {
    p_onboarding_id: input.onboardingId,
    p_check_key: input.checkKey,
    p_outcome: input.outcome,
    p_note: input.note,
  });
  if (error) throw rpcError(error);
}

export async function markOnboardingContacted(onboardingId: string): Promise<void> {
  const rpc = supabase.rpc.bind(supabase);
  const { error } = await rpc("mark_onboarding_contacted", { p_onboarding_id: onboardingId });
  if (error) throw rpcError(error);
}

export async function admitProviderOnboarding(
  onboardingId: string,
  facilityId: string,
): Promise<void> {
  const rpc = supabase.rpc.bind(supabase);
  const { error } = await rpc("admit_provider_onboarding", {
    p_onboarding_id: onboardingId,
    p_facility_id: facilityId,
  });
  if (error) throw rpcError(error);
}
