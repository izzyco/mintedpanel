import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "./fixtures/legacy-access-context";

// Mission Control M3 — Organizations, lifecycle, /join/$slug, the offboarded
// banner and the admin shortcuts, over a small stateful mock of PostgREST.
// The RPCs are pinned to the M3 migrations:
//   platform_create_organization(p_name, p_slug, p_owner_name, p_owner_email, p_plan_tier)
//   platform_set_org_lifecycle(p_org_id, p_stage)
//   platform_grant_membership(p_org_id)
//   platform_org_summary(p_org_id)
//   update_organization_profile(p_org_id, p_name, p_owner_name, p_owner_email, p_plan_tier)
// Covers:
//   (a) the list: section strip, rows with slug, stage, members and created
//       date, offboarded hidden until "Include offboarded", search and sort
//       go to the server
//   (b) create in one form and one click: slug prefilled from the name, an
//       inline slug refusal, then the new organization's detail page
//   (c) the detail page: counts from the summary RPC, one-click lifecycle
//       moves with no confirm dialog (Offboard, then Reopen), members and
//       pending invites, Copy join link, Grant myself admin membership ->
//       Open in workspace
//   (d) /join/$slug with a pending invite (joins, lands in that workspace)
//       and without one (needs an invitation, whom to ask, a way on)
//   (e) the offboarded banner: reads work, add affordances hidden
//   (f) the shortcuts: /organizations, /users, /settings take a platform admin
//       into Mission Control and show anyone else the not-found view
//   (g) case generation is a hard stop outside a stage that allows it

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROSE = "22222222-2222-4222-8222-222222222222";
const LONE = "33333333-3333-4333-8333-333333333333";
const OUTER = "44444444-4444-4444-8444-444444444444";
const TREE = "55555555-5555-4555-8555-555555555555";
const NEW_ORG = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;

interface Org extends Row {
  id: string;
  name: string;
  slug: string;
  lifecycle_state: string;
  plan_tier: string | null;
  created_at: string;
}

interface Membership extends Row {
  org_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

interface Invite extends Row {
  id: string;
  org_id: string;
  email: string;
  role: string;
  full_name: string | null;
  created_at: string;
}

interface State {
  platformAdmin: boolean;
  email: string;
  orgs: Org[];
  memberships: Membership[];
  profiles: Row[];
  invites: Invite[];
  rpc: Array<{ fn: string; args: Row }>;
  reads: URL[];
  takenSlugs: Set<string>;
}

const STAGES = [
  {
    key: "prospect",
    display_name: "Prospect",
    sort_order: 10,
    allowed_next: ["onboarding", "offboarded"],
    switcher_group: "prospects",
    writable: true,
    generation_allowed: false,
    shown_by_default: true,
  },
  {
    key: "onboarding",
    display_name: "Onboarding",
    sort_order: 20,
    allowed_next: ["active", "offboarded"],
    switcher_group: "prospects",
    writable: true,
    generation_allowed: false,
    shown_by_default: true,
  },
  {
    key: "active",
    display_name: "Active",
    sort_order: 30,
    allowed_next: ["offboarded"],
    switcher_group: "in_motion",
    writable: true,
    generation_allowed: true,
    shown_by_default: true,
  },
  {
    key: "offboarded",
    display_name: "Offboarded",
    sort_order: 40,
    allowed_next: ["active"],
    switcher_group: null,
    writable: false,
    generation_allowed: false,
    shown_by_default: false,
  },
];

function initialState(over: Partial<State> = {}): State {
  return {
    platformAdmin: true,
    email: "platform.admin@example.test",
    orgs: [
      {
        id: ROSE,
        name: "Rose City Rehab Collective",
        slug: "rose-city-rehab-collective",
        lifecycle_state: "active",
        plan_tier: "standard",
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        id: LONE,
        name: "Lone Star Rehab Group",
        slug: "lone-star-rehab-group",
        lifecycle_state: "prospect",
        plan_tier: null,
        created_at: "2026-08-15T00:00:00Z",
      },
      {
        id: OUTER,
        name: "Outer Banks Therapy Group",
        slug: "outer-banks-therapy-group",
        lifecycle_state: "inactive",
        plan_tier: null,
        created_at: "2026-02-01T00:00:00Z",
      },
      {
        id: TREE,
        name: "Tree Hill Sports Therapy",
        slug: "tree-hill-sports-therapy",
        lifecycle_state: "offboarded",
        plan_tier: "pilot",
        created_at: "2026-03-01T00:00:00Z",
      },
    ],
    memberships: [
      { org_id: ROSE, user_id: USER_ID, role: "admin", created_at: "2026-07-01T00:00:00Z" },
      {
        org_id: LONE,
        user_id: "77777777-7777-4777-8777-777777777777",
        role: "admin",
        created_at: "2026-08-15T00:00:00Z",
      },
      {
        org_id: LONE,
        user_id: "88888888-8888-4888-8888-888888888888",
        role: "specialist",
        created_at: "2026-08-20T00:00:00Z",
      },
    ],
    profiles: [
      { id: USER_ID, full_name: "Pat Platform", email: "platform.admin@example.test" },
      {
        id: "77777777-7777-4777-8777-777777777777",
        full_name: "Lena Star",
        email: "lena@lonestar.example",
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        full_name: "Sam Spec",
        email: "sam@lonestar.example",
      },
    ],
    invites: [
      {
        id: "i1",
        org_id: LONE,
        email: "new.hire@lonestar.example",
        role: "billing",
        full_name: "New Hire",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    rpc: [],
    reads: [],
    takenSlugs: new Set(),
    ...over,
  };
}

function session(email: string) {
  return {
    access_token: "fake-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 9999999999,
    refresh_token: "fake-refresh-token",
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email,
      app_metadata: { provider: "email" },
      user_metadata: { full_name: "Pat Platform" },
      created_at: "2026-07-09T00:00:00Z",
    },
  };
}

const SUMMARY = {
  owner: { name: "Lena Star", email: "lena@lonestar.example" },
  groups: [
    {
      id: "g1",
      name: "Lone Star Rehab PLLC",
      tinLast4: "6789",
      npi: "1234567893",
      active: true,
    },
  ],
  providers: {
    total: 12,
    onboarding: 3,
    pendingVerification: 2,
    active: 8,
    inCredentialing: 6,
    terminated: 1,
  },
  cases: {
    open: 7,
    byStatus: { not_started: 2, in_progress: 3, submitted: 1, in_review: 1, action_required: 0 },
  },
  members: 2,
  pendingInvites: 1,
  lastActivityAt: "2026-10-30T15:04:05.123Z",
};

function orgEmbed(org: Org) {
  return { name: org.name, lifecycle_state: org.lifecycle_state, created_at: org.created_at };
}

function filterOrgs(state: State, params: URLSearchParams): Org[] {
  let rows = [...state.orgs];
  const id = params.get("id");
  if (id?.startsWith("eq.")) rows = rows.filter((o) => o.id === id.slice(3));
  const lifecycle = params.get("lifecycle_state");
  if (lifecycle?.startsWith("not.in.(")) {
    const hidden = lifecycle.slice("not.in.(".length, -1).split(",");
    rows = rows.filter((o) => !hidden.includes(o.lifecycle_state));
  }
  const or = params.get("or");
  if (or) {
    const term = /name\.ilike\."%(.*?)%"/.exec(or)?.[1]?.toLowerCase() ?? "";
    rows = rows.filter(
      (o) => o.name.toLowerCase().includes(term) || o.slug.toLowerCase().includes(term),
    );
  }
  const order = params.get("order") ?? "";
  if (order.startsWith("created_at")) {
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (order.includes(".desc")) rows.reverse();
  return rows;
}

async function installMocks(context: BrowserContext, state: State, activeOrgId: string | null) {
  await context.route(/\/(rest|auth)\/v1\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "access-control-expose-headers": "Content-Range", ...headers },
      });
    const refuse = (message: string, code = "P0001") =>
      json({ code, message, details: null, hint: null }, 400);

    if (url.pathname.includes("/auth/v1/")) return json(session(state.email));

    if (url.pathname.includes("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/rpc/")[1] ?? "";
      const args = (req.postDataJSON() ?? {}) as Row;
      state.rpc.push({ fn, args });
      if (fn === "is_platform_admin") return json(state.platformAdmin);
      if (fn === "claim_invites") {
        const mine = state.invites.filter((i) => i.email === state.email);
        for (const invite of mine) {
          state.memberships.push({
            org_id: invite.org_id,
            user_id: USER_ID,
            role: invite.role,
            created_at: "2026-11-01T00:00:00Z",
          });
        }
        state.invites = state.invites.filter((i) => i.email !== state.email);
        return json(mine.length);
      }
      if (fn === "platform_metrics") {
        return json({
          generatedAt: "2026-11-01T12:00:00.000Z",
          organizations: { total: 4, active: 1, prospect: 1, inactive: 1 },
          users: { total: 9, platformAdmins: 1 },
          providers: { total: 30, active: 20, onboarding: 5, pendingVerification: 5 },
          cases: { total: 40, open: 25 },
          pendingInvites: 1,
        });
      }
      if (!state.platformAdmin && fn.startsWith("platform_")) {
        return refuse("platform_admin_required", "42501");
      }
      if (fn === "platform_create_organization") {
        const slug = String(args.p_slug);
        if (state.takenSlugs.has(slug) || state.orgs.some((o) => o.slug === slug)) {
          return refuse("slug_taken", "23505");
        }
        state.orgs.push({
          id: NEW_ORG,
          name: String(args.p_name),
          slug,
          lifecycle_state: "prospect",
          plan_tier: (args.p_plan_tier as string | null) ?? null,
          created_at: "2026-11-01T09:00:00Z",
        });
        // No membership: the operator opens it with Grant myself admin membership.
        return json({ orgId: NEW_ORG, slug, name: args.p_name, auditId: "a1" });
      }
      if (fn === "platform_set_org_lifecycle") {
        const org = state.orgs.find((o) => o.id === args.p_org_id);
        if (!org) return refuse("org_not_found", "P0002");
        const from = org.lifecycle_state === "inactive" ? "offboarded" : org.lifecycle_state;
        const stage = STAGES.find((s) => s.key === from);
        if (!stage?.allowed_next.includes(String(args.p_stage))) {
          return refuse("lifecycle_transition_not_allowed", "22023");
        }
        org.lifecycle_state = String(args.p_stage);
        return json({ orgId: org.id, lifecycleState: org.lifecycle_state, changed: true });
      }
      if (fn === "platform_grant_membership") {
        state.memberships.push({
          org_id: String(args.p_org_id),
          user_id: USER_ID,
          role: "admin",
          created_at: "2026-11-01T10:00:00Z",
        });
        return json({ orgId: args.p_org_id, role: "admin", changed: true });
      }
      if (fn === "platform_org_summary") {
        return json({ orgId: args.p_org_id, ...SUMMARY });
      }
      if (fn === "update_organization_profile") {
        const org = state.orgs.find((o) => o.id === args.p_org_id);
        if (org) org.name = String(args.p_name);
        return json({ orgId: args.p_org_id, changed: true });
      }
      return json([]);
    }

    const table = url.pathname.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    const params = url.searchParams;
    state.reads.push(url);
    const select = params.get("select") ?? "";
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const one = (rows: unknown[]) =>
      rows.length === 1 ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406);

    if (table === "lifecycle_stages") return json(STAGES);

    if (table === "organizations") {
      const rows = filterOrgs(state, params).map((o) => ({
        ...o,
        memberships: [{ count: state.memberships.filter((m) => m.org_id === o.id).length }],
      }));
      if (wantsObject) return one(rows);
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? rows.length);
      const page = rows.slice(offset, offset + limit);
      return json(page, 200, {
        "content-range":
          page.length > 0
            ? `${offset}-${offset + page.length - 1}/${rows.length}`
            : `*/${rows.length}`,
      });
    }

    if (table === "memberships") {
      const userFilter = params.get("user_id");
      const orgFilter = params.get("org_id");
      const slugFilter = params.get("organizations.slug");
      let rows = state.memberships;
      if (userFilter?.startsWith("eq."))
        rows = rows.filter((m) => m.user_id === userFilter.slice(3));
      if (orgFilter?.startsWith("eq.")) rows = rows.filter((m) => m.org_id === orgFilter.slice(3));
      if (slugFilter?.startsWith("eq.")) {
        rows = rows.filter(
          (m) => state.orgs.find((o) => o.id === m.org_id)?.slug === slugFilter.slice(3),
        );
      }
      if (select.includes("profiles(")) {
        return json(
          rows.map((m) => ({
            user_id: m.user_id,
            role: m.role,
            created_at: m.created_at,
            profiles: state.profiles.find((p) => p.id === m.user_id) ?? null,
          })),
        );
      }
      return json(
        rows.map((m) => {
          const org = state.orgs.find((o) => o.id === m.org_id) as Org;
          return {
            org_id: m.org_id,
            user_id: m.user_id,
            role: m.role,
            organizations: select.includes("slug")
              ? { name: org.name, slug: org.slug }
              : orgEmbed(org),
          };
        }),
      );
    }

    if (table === "pending_invites") {
      const orgFilter = params.get("org_id");
      return json(state.invites.filter((i) => !orgFilter || i.org_id === orgFilter.slice(3)));
    }

    if (table === "profiles") {
      const rows = state.profiles.filter((p) => p.id === USER_ID);
      return wantsObject ? one(rows) : json(rows);
    }

    return wantsObject ? json({ code: "PGRST116", message: "no rows" }, 406) : json([]);
  });

  await context.addInitScript(
    ([authKey, sess, orgId]) => {
      localStorage.setItem(authKey as string, JSON.stringify(sess));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: orgId }, version: 0 }),
      );
    },
    [AUTH_KEY, session(state.email), activeOrgId] as const,
  );
}

test.use({ platformAdminRpc: "passthrough", locale: "en-US", timezoneId: "UTC" });

function rpcArgs(state: State, fn: string) {
  return state.rpc.filter((call) => call.fn === fn).map((call) => call.args);
}

async function expectNotFound(page: Page) {
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible({
    timeout: 30000,
  });
}

test("(a) the list shows every organization but offboarded ones, with search and sort on the server", async ({
  context,
  page,
}) => {
  const state = initialState();
  await installMocks(context, state, ROSE);

  await page.goto("/mission-control/organizations");
  const sections = page.getByRole("navigation", { name: "Mission Control sections" });
  await expect(sections).toBeVisible({ timeout: 30000 });
  await expect(sections.getByRole("link", { name: "Organizations" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1, name: "Organizations" })).toBeVisible();

  const table = page.locator("table");
  const lone = table.getByRole("row", { name: /Lone Star Rehab Group/ });
  await expect(lone).toContainText("lone-star-rehab-group");
  await expect(lone).toContainText("Prospect");
  await expect(lone).toContainText("2");
  await expect(lone).toContainText("Aug 15, 2026");
  await expect(table.getByRole("row", { name: /Rose City Rehab Collective/ })).toContainText(
    "Active",
  );
  // Offboarded (and the legacy inactive) are hidden by default, on the server.
  await expect(table.getByText("Tree Hill Sports Therapy")).toHaveCount(0);
  await expect(table.getByText("Outer Banks Therapy Group")).toHaveCount(0);
  const firstList = state.reads.find(
    (u) => u.pathname.endsWith("/organizations") && u.searchParams.has("offset"),
  );
  expect(firstList?.searchParams.get("lifecycle_state")).toBe("not.in.(inactive,offboarded)");
  await expect(page.getByText("2 organizations")).toBeVisible();

  // One click includes them; the legacy inactive reads as Offboarded.
  await page.getByLabel("Include offboarded").click();
  await expect(table.getByRole("row", { name: /Tree Hill Sports Therapy/ })).toContainText(
    "Offboarded",
  );
  await expect(table.getByRole("row", { name: /Outer Banks Therapy Group/ })).toContainText(
    "Offboarded",
  );
  await expect(page.getByText("4 organizations")).toBeVisible();

  // Search over name and slug.
  await page.getByLabel("Search organizations").fill("tree");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText("Tree Hill Sports Therapy")).toBeVisible();
  const searched = state.reads.filter((u) => u.searchParams.get("or")).at(-1);
  expect(searched?.searchParams.get("or")).toBe('(name.ilike."%tree%",slug.ilike."%tree%")');

  // Sort: newest first.
  await page.getByLabel("Search organizations").fill("");
  await page.getByLabel("Sort organizations").click();
  await page.getByRole("option", { name: "Newest first" }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Lone Star Rehab Group");
  const sorted = state.reads
    .filter((u) => u.searchParams.get("order")?.startsWith("created_at"))
    .at(-1);
  expect(sorted?.searchParams.get("order")).toBe("created_at.desc,id.asc");
});

test("(b) creating an organization takes one form and one click, and the slug rule holds inline", async ({
  context,
  page,
}) => {
  const state = initialState({ takenSlugs: new Set(["kansas-fitness-physio"]) });
  await installMocks(context, state, ROSE);

  await page.goto("/mission-control/organizations");
  await page.getByRole("button", { name: "New organization" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "New organization" });
  await dialog.getByLabel("Organization name").fill("Kansas Fitness Physio");
  // The slug follows the name until edited.
  await expect(dialog.getByLabel("Slug")).toHaveValue("kansas-fitness-physio");
  await expect(dialog.getByText("Join link /join/kansas-fitness-physio")).toBeVisible();
  await dialog.getByLabel("Owner name").fill("Kara Owner");
  await dialog.getByLabel("Owner email").fill("kara@kfp.example");
  await dialog.getByRole("button", { name: "Create organization" }).click();

  // The slug is taken: refused inline, nothing else lost.
  await expect(dialog.getByText("That slug is already used by another organization")).toBeVisible();
  await expect(dialog.getByLabel("Owner name")).toHaveValue("Kara Owner");

  await dialog.getByLabel("Slug").fill("kansas-fitness-physio-ks");
  await dialog.getByLabel("Plan tier (optional)").click();
  await page.getByRole("option", { name: "Pilot" }).click();
  await dialog.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(new RegExp(`/mission-control/organizations/${NEW_ORG}$`), {
    timeout: 15000,
  });
  await expect(
    page.getByRole("heading", { level: 2, name: "Kansas Fitness Physio" }),
  ).toBeVisible();
  await expect(page.getByText("/join/kansas-fitness-physio-ks")).toBeVisible();
  expect(rpcArgs(state, "platform_create_organization")).toEqual([
    {
      p_name: "Kansas Fitness Physio",
      p_slug: "kansas-fitness-physio",
      p_owner_name: "Kara Owner",
      p_owner_email: "kara@kfp.example",
      p_plan_tier: null,
    },
    {
      p_name: "Kansas Fitness Physio",
      p_slug: "kansas-fitness-physio-ks",
      p_owner_name: "Kara Owner",
      p_owner_email: "kara@kfp.example",
      p_plan_tier: "pilot",
    },
  ]);
  // New organizations start as prospects, and the creator is not a member
  // (Sowmya, Nov 2): Grant myself admin membership is the one click that opens it.
  const lifecycle = page.getByRole("region", { name: "Lifecycle" });
  await expect(lifecycle).toContainText("Prospect");
  expect(state.memberships.some((m) => m.org_id === NEW_ORG)).toBe(false);
  await expect(page.getByRole("button", { name: "Open in workspace" })).toHaveCount(0);
  await page.getByRole("button", { name: "Grant myself admin membership" }).click();
  await expect(page.getByRole("button", { name: "Open in workspace" })).toBeVisible();
  expect(rpcArgs(state, "platform_grant_membership")).toEqual([{ p_org_id: NEW_ORG }]);
});

test("(b) a duplicate name is allowed: the notice links the other organization before and after Save", async ({
  context,
  page,
}) => {
  const state = initialState();
  await installMocks(context, state, ROSE);

  await page.goto("/mission-control/organizations");
  await page.getByRole("button", { name: "New organization" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "New organization" });
  await dialog.getByLabel("Organization name").fill("rose city  rehab collective");
  // Shown as soon as the name matches, with a link to the other organization.
  const notice = dialog.getByRole("note");
  await expect(notice).toContainText("Another organization has this name");
  await expect(notice).toContainText("You can still create this one.");
  await expect(notice.getByRole("link", { name: "Rose City Rehab Collective" })).toHaveAttribute(
    "href",
    `/mission-control/organizations/${ROSE}`,
  );
  await dialog.getByLabel("Slug").fill("rose-city-west");
  await dialog.getByLabel("Owner name").fill("Wes Owner");
  await dialog.getByLabel("Owner email").fill("wes@rosewest.example");
  // No confirm dialog: one click creates it.
  await dialog.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(new RegExp(`/mission-control/organizations/${NEW_ORG}$`), {
    timeout: 15000,
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(
    state.orgs.filter(
      (o) => o.name.replace(/\s+/g, "").toLowerCase() === "rosecityrehabcollective",
    ),
  ).toHaveLength(2);
  expect(rpcArgs(state, "platform_create_organization")).toHaveLength(1);
  // After Save, the new organization's page still says so and links the other.
  const after = page.getByRole("note").filter({ hasText: "Another organization has this name" });
  await expect(after.getByRole("link", { name: "Rose City Rehab Collective" })).toHaveAttribute(
    "href",
    `/mission-control/organizations/${ROSE}`,
  );
});

test("(c) the detail page: counts, one-click lifecycle moves, members, invites, join link, self-grant", async ({
  context,
  page,
}) => {
  const state = initialState();
  await installMocks(context, state, ROSE);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto(`/mission-control/organizations/${LONE}`);
  await expect(page.getByRole("heading", { level: 2, name: "Lone Star Rehab Group" })).toBeVisible({
    timeout: 30000,
  });

  // Counts and non-PHI identifiers from platform_org_summary().
  await expect(page.getByRole("region", { name: "Groups" })).toContainText("Lone Star Rehab PLLC");
  await expect(page.getByRole("region", { name: "Groups" })).toContainText("•••••6789");
  await expect(page.getByRole("region", { name: "Groups" })).toContainText("1234567893");
  await expect(page.getByRole("region", { name: "Providers" })).toContainText("12");
  await expect(page.getByRole("region", { name: "Open cases" })).toContainText("7");
  await expect(page.getByRole("region", { name: "Profile" })).toContainText(
    "Lena Star · lena@lonestar.example",
  );
  expect(rpcArgs(state, "platform_org_summary")).toContainEqual({ p_org_id: LONE });

  // Lifecycle: the configured next stages, one click each, no confirm dialog.
  const lifecycle = page.getByRole("region", { name: "Lifecycle" });
  await expect(lifecycle.getByRole("button", { name: "Move to Onboarding" })).toBeVisible();
  await lifecycle.getByRole("button", { name: "Offboard" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(lifecycle).toContainText("Offboarded");
  await expect(lifecycle).toContainText("Changes are off");
  await expect(
    page.getByRole("region", { name: "Profile" }).getByRole("button", { name: "Edit" }),
  ).toHaveCount(0);
  await lifecycle.getByRole("button", { name: "Reopen" }).click();
  await expect(lifecycle).toContainText("Active");
  expect(rpcArgs(state, "platform_set_org_lifecycle")).toEqual([
    { p_org_id: LONE, p_stage: "offboarded" },
    { p_org_id: LONE, p_stage: "active" },
  ]);

  // Members and pending invites (the M1 read policies).
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByRole("row", { name: /Lena Star/ })).toContainText("Admin");
  await expect(page.getByRole("row", { name: /Sam Spec/ })).toContainText("Specialist");
  await page.getByRole("tab", { name: "Pending invites" }).click();
  await expect(page.getByRole("row", { name: /new.hire@lonestar.example/ })).toContainText(
    "Billing",
  );
  // No empty Settings tab ships.
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveCount(0);

  // Copy join link.
  await page.getByRole("button", { name: "Copy join link" }).click();
  await expect(page.getByText("Join link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/join\/lone-star-rehab-group$/);

  // Grant myself admin membership, then open the workspace.
  await page.getByRole("button", { name: "Grant myself admin membership" }).click();
  await expect(page.getByRole("button", { name: "Open in workspace" })).toBeVisible();
  expect(rpcArgs(state, "platform_grant_membership")).toEqual([{ p_org_id: LONE }]);
  await page.getByRole("button", { name: "Open in workspace" }).click();
  await expect(page).toHaveURL(/\/org-detail$/, { timeout: 15000 });
});

test("(d) /join/$slug claims a pending invite and lands in that workspace", async ({
  context,
  page,
}) => {
  const state = initialState({ platformAdmin: false, email: "new.hire@lonestar.example" });
  await installMocks(context, state, ROSE);

  await page.goto("/join/lone-star-rehab-group");
  await expect(page).toHaveURL(/\/cases$/, { timeout: 30000 });
  await expect(page.getByText("You're in Lone Star Rehab Group")).toBeVisible();
  expect(state.rpc.map((call) => call.fn)).toContain("claim_invites");
  expect(state.memberships.some((m) => m.org_id === LONE && m.user_id === USER_ID)).toBe(true);
  await expect(page.locator("aside").first()).toContainText("Lone Star Rehab Group");
});

test("(d) /join/$slug without an invite says so, names whom to ask, and offers a way on", async ({
  context,
  page,
}) => {
  const state = initialState({ platformAdmin: false, email: "someone@elsewhere.example" });
  await installMocks(context, state, ROSE);

  await page.goto("/join/lone-star-rehab-group");
  await expect(page.getByRole("heading", { name: "This link needs an invitation" })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("someone@elsewhere.example")).toBeVisible();
  await expect(page.getByText(/administrator or your Minted contact/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);
  await page.getByRole("link", { name: "Go to my workspace" }).click();
  await expect(page).toHaveURL(/\/cases$/, { timeout: 15000 });
});

test("(e) an offboarded organization shows the banner, reads work, add affordances are hidden", async ({
  context,
  page,
}) => {
  const state = initialState({ platformAdmin: false });
  state.orgs.find((o) => o.id === ROSE)!.lifecycle_state = "offboarded";
  await installMocks(context, state, ROSE);

  await page.goto("/providers");
  await expect(page.getByRole("status").filter({ hasText: "is offboarded" })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("Rose City Rehab Collective is offboarded.")).toBeVisible();
  await expect(page.getByText(/You can still read everything/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export roster" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New Provider" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite provider" })).toHaveCount(0);
});

test("(e) an active organization shows no banner and keeps its add affordances", async ({
  context,
  page,
}) => {
  const state = initialState({ platformAdmin: false });
  await installMocks(context, state, ROSE);

  await page.goto("/providers");
  await expect(page.getByRole("link", { name: "New Provider" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/is offboarded/)).toHaveCount(0);
});

for (const stage of ["prospect", "onboarding"]) {
  test(`(g) case generation is a hard stop for a ${stage} organization: the reason, no grid`, async ({
    context,
    page,
  }) => {
    const state = initialState({ platformAdmin: false });
    state.orgs.find((o) => o.id === ROSE)!.lifecycle_state = stage;
    await installMocks(context, state, ROSE);

    await page.goto("/generation");
    await expect(page.getByRole("heading", { name: "Generate cases" })).toBeVisible({
      timeout: 30000,
    });
    const reason = page.getByRole("alert").filter({ hasText: "Case generation is off" });
    await expect(reason).toContainText(
      `Case generation is off while Rose City Rehab Collective is ${stage === "prospect" ? "Prospect" : "Onboarding"}`,
    );
    await expect(reason).toContainText("Ask your Minted contact");
    // No way through: the grid is not rendered at all.
    await expect(page.getByText("Nothing to review here yet")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "By provider" })).toHaveCount(0);
  });
}

test("(g) an active organization generates as before", async ({ context, page }) => {
  const state = initialState({ platformAdmin: false });
  await installMocks(context, state, ROSE);

  await page.goto("/generation");
  await expect(page.getByRole("heading", { name: "Generate cases" })).toBeVisible({
    timeout: 30000,
  });
  // The grid renders (with this empty fixture, its own empty state).
  await expect(page.getByText("Nothing to review here yet")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Case generation is off")).toHaveCount(0);
});

test("(f) /organizations, /users and /settings take a platform admin into Mission Control", async ({
  context,
  page,
}) => {
  const state = initialState();
  await installMocks(context, state, ROSE);

  await page.goto("/organizations");
  await expect(page).toHaveURL(/\/mission-control\/organizations\/?$/, { timeout: 30000 });
  await page.goto("/users");
  await expect(page).toHaveURL(/\/mission-control\/?$/, { timeout: 30000 });
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/mission-control\/?$/, { timeout: 30000 });
});

test("(f) for anyone else the shortcuts are the not-found view, URL unchanged", async ({
  context,
  page,
}) => {
  const state = initialState({ platformAdmin: false });
  await installMocks(context, state, ROSE);

  for (const path of ["/organizations", "/users", "/settings"]) {
    await page.goto(path);
    await expectNotFound(page);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.getByText(/mission control/i)).toHaveCount(0);
  }
});
