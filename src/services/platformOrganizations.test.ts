import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { supabase } from "@/integrations/supabase/externalClient";
import {
  OrgRpcError,
  createPlatformOrganization,
  listPlatformOrganizations,
  orgSearchFilter,
  parsePlatformOrgSummary,
  setOrgLifecycle,
} from "./platformOrganizations";

const ORG_ID = "22222222-2222-4222-8222-222222222222";

interface Captured {
  table?: string;
  select?: string;
  selectOpts?: unknown;
  or: string[];
  not: Array<[string, string, string]>;
  orders: Array<[string, unknown]>;
  ranges: Array<[number, number]>;
}

function fakeList(page: { data: unknown[]; count: number }): Captured {
  const cap: Captured = { or: [], not: [], orders: [], ranges: [] };
  const builder = {
    select(cols: string, opts?: unknown) {
      cap.select = cols;
      cap.selectOpts = opts;
      return builder;
    },
    or(filter: string) {
      cap.or.push(filter);
      return builder;
    },
    not(column: string, op: string, value: string) {
      cap.not.push([column, op, value]);
      return builder;
    },
    order(column: string, opts?: unknown) {
      cap.orders.push([column, opts]);
      return builder;
    },
    range(from: number, to: number) {
      cap.ranges.push([from, to]);
      return Promise.resolve({ data: page.data, error: null, count: page.count });
    },
  };
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    cap.table = table;
    return builder;
  }) as never);
  return cap;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("orgSearchFilter", () => {
  it("searches name and slug with a quoted value", () => {
    expect(orgSearchFilter("  rose ")).toBe('name.ilike."%rose%",slug.ilike."%rose%"');
  });

  it("keeps commas and parentheses literal and escapes quotes", () => {
    expect(orgSearchFilter('Rehab, "LLC" (KS)')).toBe(
      'name.ilike."%Rehab, \\"LLC\\" (KS)%",slug.ilike."%Rehab, \\"LLC\\" (KS)%"',
    );
  });

  it("is null for a blank search", () => {
    expect(orgSearchFilter("   ")).toBeNull();
  });
});

describe("listPlatformOrganizations", () => {
  it("pages, sorts and hides the stages not shown by default", async () => {
    const cap = fakeList({
      data: [
        {
          id: ORG_ID,
          name: "Rose City Rehab",
          slug: "rose-city-rehab",
          lifecycle_state: "onboarding",
          plan_tier: "pilot",
          created_at: "2026-10-01T00:00:00Z",
          memberships: [{ count: 3 }],
        },
      ],
      count: 51,
    });

    const page = await listPlatformOrganizations(
      { search: "rose", sort: "-created", page: 3, pageSize: 25, includeHidden: false },
      ["inactive", "offboarded"],
    );

    expect(cap.table).toBe("organizations");
    expect(cap.select).toBe(
      "id, name, slug, lifecycle_state, plan_tier, created_at, memberships(count)",
    );
    expect(cap.selectOpts).toEqual({ count: "exact" });
    expect(cap.or).toEqual(['name.ilike."%rose%",slug.ilike."%rose%"']);
    expect(cap.not).toEqual([["lifecycle_state", "in", "(inactive,offboarded)"]]);
    expect(cap.orders).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: true }],
    ]);
    expect(cap.ranges).toEqual([[50, 74]]);
    expect(page).toEqual({
      total: 51,
      rows: [
        {
          id: ORG_ID,
          name: "Rose City Rehab",
          slug: "rose-city-rehab",
          lifecycleState: "onboarding",
          planTier: "pilot",
          memberCount: 3,
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
  });

  it("includes every stage on request and searches nothing when blank", async () => {
    const cap = fakeList({ data: [], count: 0 });
    await listPlatformOrganizations(
      { search: "", sort: "name", page: 1, pageSize: 25, includeHidden: true },
      ["inactive", "offboarded"],
    );
    expect(cap.or).toEqual([]);
    expect(cap.not).toEqual([]);
    expect(cap.orders[0]).toEqual(["name", { ascending: true }]);
    expect(cap.ranges).toEqual([[0, 24]]);
  });
});

describe("parsePlatformOrgSummary", () => {
  it("keeps a full document", () => {
    const doc = {
      orgId: ORG_ID,
      owner: { name: "Pat Owner", email: "pat@example.test" },
      groups: [
        { id: "g1", name: "Group One", tinLast4: "6789", npi: "1234567893", active: true },
        { id: "g2", name: "Group Two", tinLast4: null, npi: null, active: false },
      ],
      providers: {
        total: 9,
        onboarding: 2,
        pendingVerification: 1,
        active: 6,
        inCredentialing: 5,
        terminated: 1,
      },
      cases: {
        open: 4,
        byStatus: {
          not_started: 1,
          in_progress: 1,
          submitted: 1,
          in_review: 1,
          action_required: 0,
        },
      },
      members: 3,
      pendingInvites: 2,
      lastActivityAt: "2026-10-30T15:04:05.123Z",
    };
    expect(parsePlatformOrgSummary(doc, ORG_ID)).toEqual(doc);
  });

  it("fills missing counts with 0 and drops malformed groups", () => {
    expect(
      parsePlatformOrgSummary(
        { owner: null, groups: [{ id: "g", name: "" }, "x"], providers: { total: "9" } },
        ORG_ID,
      ),
    ).toEqual({
      orgId: ORG_ID,
      owner: null,
      groups: [],
      providers: {
        total: 0,
        onboarding: 0,
        pendingVerification: 0,
        active: 0,
        inCredentialing: 0,
        terminated: 0,
      },
      cases: {
        open: 0,
        byStatus: {
          not_started: 0,
          in_progress: 0,
          submitted: 0,
          in_review: 0,
          action_required: 0,
        },
      },
      members: 0,
      pendingInvites: 0,
      lastActivityAt: null,
    });
  });
});

describe("organization RPCs", () => {
  it("creates through platform_create_organization with trimmed fields", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { orgId: ORG_ID, slug: "rose-city" },
      error: null,
    } as never);
    const result = await createPlatformOrganization({
      name: " Rose City ",
      slug: " rose-city ",
      ownerName: " Pat Owner ",
      ownerEmail: " pat@example.test ",
      planTier: null,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("platform_create_organization", {
      p_name: "Rose City",
      p_slug: "rose-city",
      p_owner_name: "Pat Owner",
      p_owner_email: "pat@example.test",
      p_plan_tier: null,
    });
    expect(result).toEqual({ orgId: ORG_ID, slug: "rose-city" });
  });

  it("turns a database refusal into an OrgRpcError with its code", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "lifecycle_transition_not_allowed" },
    } as never);
    const failure = setOrgLifecycle(ORG_ID, "prospect");
    await expect(failure).rejects.toBeInstanceOf(OrgRpcError);
    await expect(failure).rejects.toMatchObject({
      code: "lifecycle_transition_not_allowed",
      message: "That stage change isn't allowed from the current stage",
    });
  });
});
