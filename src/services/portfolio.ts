// Portfolio data source (redesign E0.0, enabler TE-2).
//
// CROSS-ORG by design: unlike every other service this deliberately does NOT
// call requireActiveOrg() — the Portfolio is the cross-org home and renders
// without an active org (features F0.0.2 / F0.0.5). It returns exactly the
// caller's MEMBER orgs, and the query says so itself: an inner embed on the
// caller's own memberships row. RLS alone no longer means "my orgs" — a
// platform admin (Mission Control) may read every organizations row through
// its own permissive SELECT policy — so the membership scope is explicit
// rather than inferred from the policy. The pure bucketing (prospects /
// in-motion, inactive excluded) lives in src/lib/portfolio.ts.
import { supabase } from "@/integrations/supabase/externalClient";
import { currentUserId } from "@/lib/audit";
import { readCompletePages } from "@/lib/completePages";
import type { LifecycleState, PortfolioOrg } from "@/types";

// The stored lifecycle stage key, as is (Mission Control M3: the stages are
// configuration rows; readers go through normalizeLifecycle()). Anything that
// is not a non-blank string reads as the column default.
function toLifecycleState(value: unknown): LifecycleState {
  return typeof value === "string" && value.trim() ? value.trim() : "active";
}

interface PortfolioOrgRow {
  id: string;
  name: string;
  lifecycle_state: string;
  created_at: string;
}

// Explicit projection: the `memberships` embed only scopes the read and never
// reaches the Portfolio row.
function toPortfolioOrg(row: PortfolioOrgRow): PortfolioOrg {
  return {
    id: row.id,
    name: row.name,
    lifecycleState: toLifecycleState(row.lifecycle_state),
    createdAt: row.created_at,
  };
}

export async function listPortfolioOrgs(): Promise<PortfolioOrg[]> {
  const userId = currentUserId();
  // No session, no member orgs (what RLS alone gave a signed-out caller).
  if (!userId) return [];
  const query = supabase
    .from("organizations")
    .select("id, name, lifecycle_state, created_at, memberships!inner(user_id)", {
      count: "exact",
    })
    .eq("memberships.user_id", userId)
    .order("name")
    .order("id", { ascending: true });
  const rows = await readCompletePages(async (from, to) => await query.range(from, to), {
    label: "Organization list",
  });
  return rows.map(toPortfolioOrg);
}
