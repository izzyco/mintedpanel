import { test, expect, type Route } from "./fixtures/legacy-access-context";

// Organization-first sidebar (Option B, 2026-11-02; supersedes the E6.1
// F6.1.1 / TS-106 two-zone pins) over the mock harness, using the 11-org seed
// universe (seed-universe.md). Covers:
//   - the switcher tile at the top, above Find a provider and the nav
//   - exactly seven nav links: Main (My work, Cases + open-case count,
//     Providers, Groups, Reports) and Setup (Payer Setup, Organization
//     settings) — for BOTH admin and specialist (the TS-121 role sweep; Payer
//     Setup is visible to all roles for now)
//   - NO Admin section, no Home, no reserved Facilities slot, no retired labels
//   - branding untouched: the white layered-jack mark + wordmark (F6.1.1 AC)
//   - the org switcher tile keeps the E0.9 lifecycle-grouped menu (headings
//     only, never a per-org status label) + footer actions
//   - narrow viewport: no horizontal scroll (existing shell rules)
//   - user menu: Settings lands on Org Detail (member management's home)

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";

// The 11-org seed universe (names + lifecycle per seed-universe.md).
const UNIVERSE: Array<{ id: string; name: string; lifecycle: string }> = [
  {
    id: "00000000-0000-4000-a000-000000000001",
    name: "Outer Banks Rehab Group",
    lifecycle: "active",
  },
  { id: "00000000-0000-4000-a000-000000000002", name: "Shelby Sports Rehab", lifecycle: "active" },
  {
    id: "00000000-0000-4000-a000-000000000003",
    name: "Gemstone Family Rehab",
    lifecycle: "active",
  },
  {
    id: "00000000-0000-4000-a000-000000000004",
    name: "South Park Physical Therapy",
    lifecycle: "active",
  },
  {
    id: "00000000-0000-4000-a000-000000000005",
    name: "Dillon Sports Medicine",
    lifecycle: "active",
  },
  {
    id: "00000000-0000-4000-a000-000000000006",
    name: "Point Place Physical Therapy",
    lifecycle: "active",
  },
  {
    id: "00000000-0000-4000-a000-000000000007",
    name: "Tree Hill Sports Therapy",
    lifecycle: "prospect",
  },
  {
    id: "00000000-0000-4000-a000-000000000008",
    name: "Lowcountry Charm PT",
    lifecycle: "prospect",
  },
  {
    id: "00000000-0000-4000-a000-000000000009",
    name: "Lone Star Rehab Group",
    lifecycle: "prospect",
  },
  {
    id: "00000000-0000-4000-a000-00000000000a",
    name: "Rose City Rehab Collective",
    lifecycle: "prospect",
  },
  {
    id: "00000000-0000-4000-a000-00000000000b",
    name: "Outer Banks Therapy Group",
    lifecycle: "inactive",
  },
];
const ACTIVE_ORG = UNIVERSE[0];

const SESSION = {
  access_token: "fake-access-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 9999999999,
  refresh_token: "fake-refresh-token",
  user: {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "sowmya.seed@example.test",
    app_metadata: { provider: "email" },
    user_metadata: { full_name: "Sowmya Seed" },
    created_at: "2026-07-09T00:00:00Z",
  },
};

function makeFixtures(role: string): Record<string, unknown[]> {
  return {
    memberships: UNIVERSE.map((o) => ({
      org_id: o.id,
      role,
      organizations: {
        name: o.name,
        lifecycle_state: o.lifecycle,
        created_at: "2026-07-01T00:00:00Z",
      },
    })),
    profiles: [
      {
        id: USER_ID,
        full_name: "Sowmya Seed",
        email: "sowmya.seed@example.test",
        created_at: "2026-07-09T00:00:00Z",
      },
    ],
  };
}

function fulfillWith(fixtures: Record<string, unknown[]>) {
  return async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.includes("/auth/v1/")) return json(SESSION);
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);

    const table = url.pathname.split("/rest/v1/")[1] ?? "";
    const rows = fixtures[table] ?? [];
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    if (wantsObject) {
      if (rows.length === 0) return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(rows[0]);
    }
    return json(rows);
  };
}

async function seedAuth(context: {
  addInitScript: (fn: (args: unknown[]) => void, args: unknown[]) => Promise<void>;
}) {
  await context.addInitScript(
    ([authKey, session, orgId]) => {
      localStorage.setItem(authKey as string, JSON.stringify(session));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: orgId }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ACTIVE_ORG.id] as const,
  );
}

const NAV_ITEMS = [
  "My work",
  "Cases",
  "Providers",
  "Groups",
  "Reports",
  "Payer Setup",
  "Organization settings",
] as const;

async function assertNavItems(page: import("@playwright/test").Page) {
  const rail = page.locator("aside").first();
  const main = rail.getByRole("navigation", { name: "Main" });
  await expect(main).toBeVisible({ timeout: 30000 });

  // The seven, with their stated destinations.
  const expectHref = async (name: string, href: string | RegExp) => {
    const link = rail.getByRole("link", { name: new RegExp(`^${name}`) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
  };
  await expectHref("My work", /^\/cases\?mine=true$/);
  await expectHref("Cases", "/cases");
  await expectHref("Providers", "/providers");
  await expectHref("Groups", "/groups");
  await expectHref("Reports", "/reporting");
  await expectHref("Payer Setup", "/admin/payer-admin");
  await expectHref("Organization settings", "/org-detail");

  // Main then Setup, in the stated order (the switcher, search and user
  // footer are buttons/menus, not nav links).
  await expect(rail.locator("nav a")).toHaveText(NAV_ITEMS.map((n) => new RegExp(`^${n}`)));

  // Order on the rail: switcher tile, then Find a provider, then the nav.
  const tileBox = await rail.getByRole("button", { name: /Switch organization/ }).boundingBox();
  const searchBox = await rail.getByRole("button", { name: "Find a provider" }).boundingBox();
  const mainBox = await main.boundingBox();
  expect(tileBox && searchBox && mainBox).toBeTruthy();
  expect(tileBox!.y).toBeLessThan(searchBox!.y);
  expect(searchBox!.y).toBeLessThan(mainBox!.y);

  // Retired entries and labels are gone — no Admin section for any role.
  for (const gone of [
    "Home",
    "My Cases",
    "Reporting Center",
    "Org Detail",
    "Mission Control",
    "Account Detail",
    "Facilities",
    "Payer Management",
    "Payer & SOP Setup",
    "Templates",
    "Portals",
    "Statuses",
    "MSO Routing",
    "Data Import",
    "Audit Log",
    "Fix-it queue",
    "Client Progress",
  ]) {
    await expect(rail.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
  }
  // No Admin SECTION exists (the "Admin" text in the user footer is the role
  // display, not a section), and the old Workspace zone label is gone.
  await expect(rail.locator("nav").getByText("Admin", { exact: true })).toHaveCount(0);
  await expect(rail.getByText("Workspace", { exact: true })).toHaveCount(0);

  // Branding (F6.1.1 AC): the shipped layered-jack mark, the PNG as a mask
  // filled from the rail ink token — white here; rail-ink only on the Mission
  // Control rail (mission-control.spec.ts).
  const logo = rail.getByRole("img", { name: "Minted Panel" });
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS("mask-image", /logo-white/);
  await expect(logo).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(rail.getByText("Minted Panel", { exact: true })).toBeVisible();
}

test.describe("admin (P1)", () => {
  test.beforeEach(async ({ context }) => {
    await context.route(/\/(rest|auth)\/v1\//, fulfillWith(makeFixtures("admin")));
    await seedAuth(context);
  });

  test("Option B: the switcher leads, then the seven items, with untouched branding", async ({
    page,
  }) => {
    await page.goto("/org-detail");
    await assertNavItems(page);

    const rail = page.locator("aside").first();
    await expect(rail.getByText("Organization", { exact: true })).toBeVisible();
    await expect(rail.getByText(ACTIVE_ORG.name)).toBeVisible();
  });

  test("org switcher groups by lifecycle with no per-org status label; footer actions work", async ({
    page,
  }) => {
    await page.goto("/org-detail");
    const rail = page.locator("aside").first();
    await rail.getByRole("button", { name: /Switch organization/ }).click({ timeout: 30000 });

    const menu = page.getByRole("menu");
    // Lifecycle group headings only (Portfolio precedent) — never a per-org
    // label. The groups come from the lifecycle stage objects (Mission Control
    // M3): In motion, Prospects; an offboarded org (here the legacy inactive
    // Outer Banks) drops out of the switcher, and the Portfolio still lists it.
    await expect(menu.getByText("In motion", { exact: true })).toBeVisible();
    await expect(menu.getByText("Prospects", { exact: true })).toBeVisible();
    await expect(menu.getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(menu.getByText("Tree Hill Sports Therapy")).toBeVisible();
    await expect(menu.getByText("Outer Banks Therapy Group")).toHaveCount(0);

    // 11 orgs > 10 → the search field renders.
    const search = menu.getByLabel("Search organizations");
    await expect(search).toBeVisible();
    await search.fill("Lone Star");
    await expect(menu.getByText("Lone Star Rehab Group")).toBeVisible();
    await expect(menu.getByText("Shelby Sports Rehab")).toHaveCount(0);
    await search.fill("");

    // Footer actions: Add organization (the wizard's one-time entry, F6.1.5)
    // + View all organizations.
    await expect(menu.getByText("Add organization")).toBeVisible();
    await expect(menu.getByText("View all organizations")).toBeVisible();
    await menu.getByText("View all organizations").click();
    await expect(page).toHaveURL(/\/reporting\/portfolio\/?$/, { timeout: 15000 });
  });

  test("switching orgs from the grouped menu updates the tile", async ({ page }) => {
    await page.goto("/org-detail");
    const rail = page.locator("aside").first();
    await rail.getByRole("button", { name: /Switch organization/ }).click({ timeout: 30000 });
    await page.getByRole("menu").getByText("Shelby Sports Rehab").click();
    await expect(rail.getByText("Shelby Sports Rehab")).toBeVisible({ timeout: 15000 });
  });

  test("user menu offers Settings (→ /account) above Sign out", async ({ page }) => {
    await page.goto("/cases");
    const rail = page.locator("aside").first();
    await rail.getByRole("button", { name: "Account menu" }).click({ timeout: 30000 });

    const menu = page.getByRole("menu");
    await expect(menu.getByText("sowmya.seed@example.test")).toBeVisible();
    const items = menu.getByRole("menuitem");
    await expect(items.filter({ hasText: "Settings" })).toBeVisible();
    await expect(items.filter({ hasText: "Sign out" })).toBeVisible();
    // Not a platform admin, so no Mission Control item.
    await expect(items.filter({ hasText: "Mission Control" })).toHaveCount(0);
    await menu.getByText("Settings").click();
    // 2026-08-16: personal settings live on /account; Organization settings
    // stays the ORG-level surface with its own nav entry.
    await expect(page).toHaveURL(/\/account\/?$/, { timeout: 15000 });
  });

  test("My work opens Cases narrowed to me; Cases clears it", async ({ page }) => {
    await page.goto("/cases");
    const rail = page.locator("aside").first();
    await rail.getByRole("link", { name: /^My work/ }).click({ timeout: 30000 });
    await expect(page).toHaveURL(/\/cases\?mine=true$/, { timeout: 15000 });
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
    await expect(rail.getByRole("link", { name: /^My work/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(rail.getByRole("link", { name: /^Cases/ })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    // My work narrows silently: the ?ids= touch banner is not shown.
    await expect(page.getByText(/you just logged a touch on/)).toHaveCount(0);

    await rail.getByRole("link", { name: /^Cases/ }).click();
    await expect(page).toHaveURL(/\/cases\/?$/, { timeout: 15000 });
    await expect(page.getByRole("heading", { level: 1, name: "Cases" })).toBeVisible();
  });

  test("TS-121: narrow viewport follows the shell rules with no horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto("/cases");
    await expect(page.locator("main h1, h1").first()).toBeVisible({ timeout: 30000 });
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("specialist (P2) — TS-121 role sweep", () => {
  test.beforeEach(async ({ context }) => {
    await context.route(/\/(rest|auth)\/v1\//, fulfillWith(makeFixtures("specialist")));
    await seedAuth(context);
  });

  test("the identical seven items render — Payer Setup visible to all roles, no admin-only section", async ({
    page,
  }) => {
    await page.goto("/cases");
    await assertNavItems(page);
  });
});
