// /join/<slug> (Mission Control M3): which of the caller's own memberships, if
// any, is the organization with this slug. The read is the caller's own
// memberships row with an inner embed on the organization's slug, so it
// answers only for an organization the caller already belongs to; it never
// reveals whether a slug exists. Joining itself is the existing path: the
// caller's pending invites become memberships in claim_invites(), which the
// auth store runs on every membership load.
import { supabase } from "@/integrations/supabase/externalClient";
import { currentUserId } from "@/lib/audit";

export interface JoinedOrganization {
  orgId: string;
  orgName: string;
}

export async function findMyOrganizationBySlug(slug: string): Promise<JoinedOrganization | null> {
  const userId = currentUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("memberships")
    .select("org_id, organizations!inner(name, slug)")
    .eq("user_id", userId)
    .eq("organizations.slug", slug)
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as
    { org_id: string; organizations: { name: string | null } | null } | undefined;
  if (!row) return null;
  return { orgId: row.org_id, orgName: row.organizations?.name ?? "the organization" };
}
