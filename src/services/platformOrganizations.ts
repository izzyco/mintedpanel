// Mission Control › Organizations (M3). Platform-admin reads and writes over
// every organization. Not org-scoped (no requireActiveOrg()): a platform admin
// works across organizations and may belong to none.
//
// Reads are browser → PostgREST under RLS: organizations, memberships,
// profiles and pending_invites each carry an additive platform-admin SELECT
// policy (migration 20261030180000). Nothing else is widened: groups,
// providers and cases reach this surface only as counts, through the
// platform_org_summary() RPC. Writes are SECURITY DEFINER RPCs that check
// is_platform_admin() themselves and write one admin_audit_log row each.
import { supabase } from "@/integrations/supabase/externalClient";
import { orgErrorMessage } from "@/lib/orgProfile";
import type {
  AppRole,
  PlatformOrgInvite,
  PlatformOrgListPage,
  PlatformOrgListQuery,
  PlatformOrgListRow,
  PlatformOrgMember,
  PlatformOrgSummary,
} from "@/types";

/** An organization RPC refusal: `code` is the database's message (slug_taken,
 * org_offboarded, ...), `message` the sentence the UI shows. */
export class OrgRpcError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(orgErrorMessage(code));
    this.name = "OrgRpcError";
    this.code = code;
  }
}

type RpcResult = { data: unknown; error: { message: string } | null };

// supabase.rpc must be called bound — an extracted method throws at call time.
async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    params: Record<string, unknown>,
  ) => Promise<RpcResult>;
  const { data, error } = await rpc(name, args);
  if (error) throw new OrgRpcError(error.message);
  return data;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const ROLES: readonly AppRole[] = ["admin", "specialist", "billing"];
function role(value: unknown): AppRole {
  return ROLES.includes(value as AppRole) ? (value as AppRole) : "billing";
}

const ORG_COLUMNS = "id, name, slug, lifecycle_state, plan_tier, created_at";

interface OrgRow {
  id: string;
  name: string;
  slug: string | null;
  lifecycle_state: string | null;
  plan_tier: string | null;
  created_at: string;
  memberships?: Array<{ count?: number }> | null;
}

function toListRow(row: OrgRow): PlatformOrgListRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? "",
    lifecycleState: row.lifecycle_state ?? "active",
    planTier: row.plan_tier,
    memberCount: count(row.memberships?.[0]?.count),
    createdAt: row.created_at,
  };
}

/** A search term as a quoted PostgREST value: commas and parentheses stay
 * literal, and a quote or backslash in the term is escaped. */
export function orgSearchFilter(search: string): string | null {
  const term = search.trim();
  if (!term) return null;
  const quoted = `"%${term.replace(/[\\"]/g, (ch) => `\\${ch}`)}%"`;
  return `name.ilike.${quoted},slug.ilike.${quoted}`;
}

/**
 * One page of organizations: search over name and slug, sort by name or
 * created date, and the stored lifecycle values to leave out (the stages not
 * shown by default, with their legacy aliases) unless includeHidden.
 */
export async function listPlatformOrganizations(
  query: PlatformOrgListQuery,
  hiddenValues: readonly string[],
): Promise<PlatformOrgListPage> {
  const from = Math.max(0, (query.page - 1) * query.pageSize);
  let request = supabase
    .from("organizations")
    .select(`${ORG_COLUMNS}, memberships(count)`, { count: "exact" });
  const filter = orgSearchFilter(query.search);
  if (filter) request = request.or(filter);
  if (!query.includeHidden && hiddenValues.length > 0) {
    request = request.not("lifecycle_state", "in", `(${hiddenValues.join(",")})`);
  }
  const column = query.sort.endsWith("name") ? "name" : "created_at";
  const ascending = !query.sort.startsWith("-");
  const {
    data,
    error,
    count: total,
  } = await request
    .order(column, { ascending })
    .order("id", { ascending: true })
    .range(from, from + query.pageSize - 1);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as unknown as OrgRow[]).map(toListRow);
  return { rows, total: total ?? rows.length };
}

export async function getPlatformOrganization(orgId: string): Promise<PlatformOrgListRow | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select(`${ORG_COLUMNS}, memberships(count)`)
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toListRow(data as unknown as OrgRow) : null;
}

const OPEN_STATUSES = [
  "not_started",
  "in_progress",
  "submitted",
  "in_review",
  "action_required",
] as const;

/** Validate the platform_org_summary() document. A missing or malformed count
 * reads as 0, so a partial document still renders. */
export function parsePlatformOrgSummary(value: unknown, orgId: string): PlatformOrgSummary {
  const doc = asRecord(value);
  const owner = asRecord(doc.owner);
  const providers = asRecord(doc.providers);
  const cases = asRecord(doc.cases);
  const byStatus = asRecord(cases.byStatus);
  const groups = Array.isArray(doc.groups) ? doc.groups : [];
  return {
    orgId: text(doc.orgId) ?? orgId,
    owner: text(owner.name) ? { name: owner.name as string, email: text(owner.email) } : null,
    groups: groups.flatMap((raw) => {
      const group = asRecord(raw);
      const id = text(group.id);
      const name = text(group.name);
      if (!id || !name) return [];
      return [
        {
          id,
          name,
          tinLast4: text(group.tinLast4),
          npi: text(group.npi),
          active: group.active !== false,
        },
      ];
    }),
    providers: {
      total: count(providers.total),
      onboarding: count(providers.onboarding),
      pendingVerification: count(providers.pendingVerification),
      active: count(providers.active),
      inCredentialing: count(providers.inCredentialing),
      terminated: count(providers.terminated),
    },
    cases: {
      open: count(cases.open),
      byStatus: Object.fromEntries(
        OPEN_STATUSES.map((status) => [status, count(byStatus[status])]),
      ) as PlatformOrgSummary["cases"]["byStatus"],
    },
    members: count(doc.members),
    pendingInvites: count(doc.pendingInvites),
    lastActivityAt:
      typeof doc.lastActivityAt === "string" && !Number.isNaN(Date.parse(doc.lastActivityAt))
        ? doc.lastActivityAt
        : null,
  };
}

export async function getPlatformOrgSummary(orgId: string): Promise<PlatformOrgSummary> {
  return parsePlatformOrgSummary(await callRpc("platform_org_summary", { p_org_id: orgId }), orgId);
}

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
  profiles: { full_name: string | null; email: string | null } | null;
}

export async function listPlatformOrgMembers(orgId: string): Promise<PlatformOrgMember[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id, role, created_at, profiles(full_name, email)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as MemberRow[]).map((row) => ({
    userId: row.user_id,
    role: role(row.role),
    fullName: text(row.profiles?.full_name),
    email: text(row.profiles?.email),
    joinedAt: row.created_at,
  }));
}

interface InviteRow {
  id: string;
  email: string;
  role: string;
  full_name: string | null;
  created_at: string;
}

export async function listPlatformOrgInvites(orgId: string): Promise<PlatformOrgInvite[]> {
  const { data, error } = await supabase
    .from("pending_invites")
    .select("id, email, role, full_name, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as InviteRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    role: role(row.role),
    fullName: text(row.full_name),
    createdAt: row.created_at,
  }));
}

export interface CreatePlatformOrganizationInput {
  name: string;
  slug: string;
  ownerName: string;
  ownerEmail: string;
  planTier: string | null;
}

export async function createPlatformOrganization(
  input: CreatePlatformOrganizationInput,
): Promise<{ orgId: string; slug: string }> {
  const doc = asRecord(
    await callRpc("platform_create_organization", {
      p_name: input.name.trim(),
      p_slug: input.slug.trim(),
      p_owner_name: input.ownerName.trim(),
      p_owner_email: input.ownerEmail.trim(),
      p_plan_tier: input.planTier,
    }),
  );
  const orgId = text(doc.orgId);
  if (!orgId) throw new Error("The organization was created but its id did not come back");
  return { orgId, slug: text(doc.slug) ?? input.slug.trim() };
}

export async function setOrgLifecycle(orgId: string, stage: string): Promise<void> {
  await callRpc("platform_set_org_lifecycle", { p_org_id: orgId, p_stage: stage });
}

export async function grantSelfAdminMembership(orgId: string): Promise<void> {
  await callRpc("platform_grant_membership", { p_org_id: orgId });
}

export interface OrganizationProfileInput {
  name: string;
  ownerName: string;
  ownerEmail: string;
  planTier: string | null;
}

export async function updateOrganizationProfile(
  orgId: string,
  input: OrganizationProfileInput,
): Promise<void> {
  await callRpc("update_organization_profile", {
    p_org_id: orgId,
    p_name: input.name.trim(),
    p_owner_name: input.ownerName.trim(),
    p_owner_email: input.ownerEmail.trim(),
    p_plan_tier: input.planTier,
  });
}
