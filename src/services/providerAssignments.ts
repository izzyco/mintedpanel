// Provider↔facility assignment service (E1.4 TE-3) — the ONE write path for
// provider_facility_assignments. The two legacy writers
// (providers.createProviderWithDetails bulk insert and
// launches.assignProviderToFacility upsert) now route through
// insertAssignmentRows here. The primary swap is atomic via the org-scoped
// SECURITY DEFINER RPC set_primary_assignment (two PostgREST calls are not
// atomic under the one-primary partial unique). Every mutation is audited;
// removals use the DELETE action (CHECK widened by 20260712150200).
import { supabase } from "@/integrations/supabase/externalClient";
import { camelizeRow } from "@/lib/case";
import { readCompletePages } from "@/lib/completePages";
import { requireActiveOrg, writeAudit } from "@/lib/audit";
import { translateDbError } from "@/lib/dbErrors";
import { CONTEXT_MAX_ARRAY, type BrowserAdvisorySource } from "@/lib/advisoryChecks";
import {
  firstAssignmentIdsToPromote,
  planFacilityAssignmentSync,
  type AssignmentDraft,
  type StoredFacilityAssignment,
} from "@/lib/assignmentScope";
import { recordAdvisory } from "@/services/advisories";
import type { FacilityAssignment } from "@/types";

/** MINT-134 — a facility assignment saved without a start date is recorded
 * as the advisory assignment.start_date_missing (Sowmya's B9; under D14 it
 * reads as billable). One row per provider, naming the facilities whose date
 * the save left blank; a set holds at most CONTEXT_MAX_ARRAY ids, so more
 * facilities take more rows. Call it as soon as the rows are written, before
 * any later step that can still fail, without waiting
 * (`void recordUndatedAssignments(...)`); it sends one row at a time and never
 * rejects (recordAdvisory never does). The front end stays quiet. */
export async function recordUndatedAssignments(
  undated: ReadonlyArray<{ providerId: string; facilityId: string }>,
  source: BrowserAdvisorySource = "panel",
): Promise<void> {
  const byProvider = new Map<string, string[]>();
  for (const { providerId, facilityId } of undated)
    byProvider.set(providerId, [...(byProvider.get(providerId) ?? []), facilityId]);
  for (const [providerId, facilityIds] of byProvider) {
    const sorted = [...new Set(facilityIds)].sort();
    for (let i = 0; i < sorted.length; i += CONTEXT_MAX_ARRAY)
      await recordAdvisory(
        "assignment.start_date_missing",
        { table: "providers", id: providerId },
        { facility_ids: sorted.slice(i, i + CONTEXT_MAX_ARRAY) },
        source,
      );
  }
}

// Scoped projection (TE-5): ids + flags + dates only — nothing PHI lives on
// this table, but keep the read shape explicit anyway.
const ASSIGNMENT_COLUMNS =
  "id, org_id, provider_id, facility_id, is_primary, start_date, created_at";

export async function listOrgAssignments(): Promise<FacilityAssignment[]> {
  const orgId = requireActiveOrg();
  const query = supabase
    .from("provider_facility_assignments")
    .select(ASSIGNMENT_COLUMNS, { count: "exact" })
    .eq("org_id", orgId)
    .order("id", { ascending: true });
  const rows = await readCompletePages(async (from, to) => await query.range(from, to), {
    label: "Facility assignment list",
  });
  return camelizeRow<FacilityAssignment[]>(rows);
}

export interface AssignmentRowInput {
  providerId: string;
  facilityId: string;
  isPrimary?: boolean;
  startDate?: string | null;
}

export interface InsertedAssignment {
  providerId: string;
  facilityId: string;
  startDate: string | null;
}

/** Shared bulk insert used by the legacy callers (provider create, CSV
 * import, batch assign). Duplicate (provider, facility) pairs are ignored,
 * matching the old launch upsert semantics. Each row's start date is the
 * caller's (blankAssignmentStartDate settles a blank one); a missing date is
 * saved as missing. Returns only the rows it inserted: an ignored duplicate
 * isn't returned (ON CONFLICT DO NOTHING ... RETURNING). */
export async function insertAssignmentRows(
  rows: AssignmentRowInput[],
): Promise<InsertedAssignment[]> {
  if (rows.length === 0) return [];
  const orgId = requireActiveOrg();
  const { data, error } = await supabase
    .from("provider_facility_assignments")
    .upsert(
      rows.map((r) => ({
        org_id: orgId,
        provider_id: r.providerId,
        facility_id: r.facilityId,
        is_primary: r.isPrimary ?? false,
        start_date: r.startDate?.trim() || null,
      })),
      { onConflict: "provider_id,facility_id", ignoreDuplicates: true },
    )
    .select("provider_id, facility_id, start_date");
  if (error) throw translateDbError(error);
  return (data ?? []).map((r) => ({
    providerId: String(r.provider_id),
    facilityId: String(r.facility_id),
    startDate: r.start_date,
  }));
}

/** After import (or any bulk insert that wrote is_primary=false), promote
 * the first assignment for any provider who still has none. No-op when
 * every listed provider already has a primary or has no assignments. */
export async function ensureFirstFacilityPrimary(providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  const orgId = requireActiveOrg();
  const { data, error } = await supabase
    .from("provider_facility_assignments")
    .select("id, provider_id, is_primary, created_at")
    .eq("org_id", orgId)
    .in("provider_id", providerIds);
  if (error) throw translateDbError(error);
  const promoteIds = firstAssignmentIdsToPromote(
    (data ?? []).map((r) => ({
      id: String(r.id),
      providerId: String(r.provider_id),
      isPrimary: Boolean(r.is_primary),
      createdAt: String(r.created_at ?? ""),
    })),
  );
  if (promoteIds.length === 0) return;
  const { error: updateError } = await supabase
    .from("provider_facility_assignments")
    .update({ is_primary: true })
    .eq("org_id", orgId)
    .in("id", promoteIds);
  if (updateError) throw translateDbError(updateError);
}

async function listProviderAssignmentRows(
  orgId: string,
  providerId: string,
): Promise<Array<StoredFacilityAssignment & { orgId: string }>> {
  const { data, error } = await supabase
    .from("provider_facility_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider_id", providerId);
  if (error) throw error;
  return camelizeRow<Array<StoredFacilityAssignment & { orgId: string }>>(data ?? []);
}

// Full-set sync for one provider (the E1.4 editor save): validates the
// invariants (exactly one primary when non-empty — so removing the primary
// forces a re-pick; a blank start date saves as missing), then executes
// updates → deletes → inserts(as non-primary) → atomic RPC swap.
export async function setAssignments(providerId: string, drafts: AssignmentDraft[]): Promise<void> {
  const orgId = requireActiveOrg();
  const stored = await listProviderAssignmentRows(orgId, providerId);
  const plan = planFacilityAssignmentSync(drafts, stored);
  // The facilities this save leaves undated, as each write lands: a dated row
  // cleared, or a new row without a date. A row that was already undated is
  // not this save's. They are recorded once the row writes are done, before
  // the primary swap and the audit row, and also when a later write fails.
  const storedById = new Map(stored.map((r) => [r.id, r]));
  const undatedFacilityIds: string[] = [];
  try {
    for (const upd of plan.updates) {
      const { error } = await supabase
        .from("provider_facility_assignments")
        .update({ start_date: upd.startDate.trim() || null })
        .eq("id", upd.id)
        .eq("org_id", orgId)
        .eq("provider_id", providerId);
      if (error) throw translateDbError(error);
      const before = storedById.get(upd.id);
      if (!upd.startDate.trim() && before?.startDate?.trim())
        undatedFacilityIds.push(before.facilityId);
    }

    if (plan.deleteIds.length > 0) {
      const { error } = await supabase
        .from("provider_facility_assignments")
        .delete()
        .eq("org_id", orgId)
        .eq("provider_id", providerId)
        .in("id", plan.deleteIds);
      if (error) throw translateDbError(error);
      await writeAudit({
        actionType: "DELETE",
        entityType: "provider_facility_assignment",
        entityId: providerId,
        before: { removed: stored.filter((r) => plan.deleteIds.includes(r.id)) },
        description: `Removed ${plan.deleteIds.length} facility assignment(s)`,
      });
    }

    if (plan.inserts.length > 0) {
      // Always inserted non-primary; the RPC promotes atomically below.
      const { error } = await supabase.from("provider_facility_assignments").insert(
        plan.inserts.map((d) => ({
          org_id: orgId,
          provider_id: providerId,
          facility_id: d.facilityId,
          is_primary: false,
          start_date: d.startDate.trim() || null,
        })),
      );
      if (error) throw translateDbError(error);
      for (const d of plan.inserts) if (!d.startDate.trim()) undatedFacilityIds.push(d.facilityId);
    }
  } finally {
    void recordUndatedAssignments(
      undatedFacilityIds.map((facilityId) => ({ providerId, facilityId })),
    );
  }

  if (plan.primaryFacilityId && !plan.primaryAlreadySet) {
    const after = await listProviderAssignmentRows(orgId, providerId);
    const target = after.find((r) => r.facilityId === plan.primaryFacilityId);
    if (!target) throw new Error("Primary assignment not found after save");
    const rpc = supabase.rpc.bind(supabase);
    const { error } = await rpc("set_primary_assignment", {
      p_provider_id: providerId,
      p_assignment_id: target.id,
    });
    if (error) throw translateDbError(error);
  }

  await writeAudit({
    actionType: "UPDATE",
    entityType: "provider_facility_assignment",
    entityId: providerId,
    before: { assignments: stored },
    after: { assignments: drafts },
    description: "Updated facility assignments",
  });
}

/** One-click primary swap from the section list (F1.4.3) — atomic via RPC. */
export async function setPrimaryAssignment(
  providerId: string,
  assignmentId: string,
): Promise<void> {
  requireActiveOrg();
  const rpc = supabase.rpc.bind(supabase);
  const { error } = await rpc("set_primary_assignment", {
    p_provider_id: providerId,
    p_assignment_id: assignmentId,
  });
  if (error) throw translateDbError(error);
  await writeAudit({
    actionType: "UPDATE",
    entityType: "provider_facility_assignment",
    entityId: assignmentId,
    after: { providerId, assignmentId, isPrimary: true },
    description: "Changed primary practice location",
  });
}
