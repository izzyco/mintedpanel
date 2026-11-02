// MINT-91 U8 (Sowmya, Nov 1, 2026, Addendum 9): "required phone" is an
// advisory. Every contact form saves with its phone blank, with no warning, and
// still refuses a non-US or malformed number (A3). A stored phone the user
// didn't touch is never re-checked (A4).
//   CP-01  Add person: a blank phone saves as NULL; a non-US one is refused.
//   CP-02  Edit person: clearing the phone saves NULL; an untouched invalid
//          stored phone saves; changing it to a non-US number is refused.
//   CP-03  Create organization: a blank customer phone reaches the RPC.
//   CP-04  Capture link: a blank phone submits; an untouched invalid stored
//          phone submits; a non-US one is refused.
//   CP-05  Public /contact: a blank phone submits; a non-US one is refused.
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "./fixtures/legacy-access-context";

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const NEW_ORG = "44444444-4444-4444-8444-444444444444";
const PARTY_JANE = "66666666-6666-4666-8666-666666666666";
const PARTY_LEGACY = "77777777-7777-4777-8777-777777777777";
const PHONE_ERROR = "Enter a 10-digit US phone number";
const NON_US = "+44 20 7946 0958";

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

type Row = Record<string, unknown>;

const party = (over: Row): Row => ({
  id: PARTY_JANE,
  org_id: ORG_ID,
  party_type: "person",
  name: "",
  first_name: null,
  last_name: null,
  title: null,
  email: null,
  phone_office: null,
  phone_extension: null,
  phone_mobile: null,
  fax: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  country: "US",
  created_by: USER_ID,
  created_at: "2026-07-09T00:00:00Z",
  ...over,
});

function workspaceFixtures(): Record<string, Row[]> {
  const parties = [
    party({
      id: PARTY_JANE,
      name: "Jane Owner",
      first_name: "Jane",
      last_name: "Owner",
      email: "jane@example.test",
      phone_office: "503-555-0100",
      address_line1: "123 Main St",
      city: "Portland",
      state: "OR",
      postal_code: "97201",
    }),
    // Saved before MINT-91: a phone that isn't a US number.
    party({
      id: PARTY_LEGACY,
      name: "Lee Legacy",
      first_name: "Lee",
      last_name: "Legacy",
      email: "lee@example.test",
      phone_office: "abc-def-ghij",
      address_line1: "9 Second Ave",
      city: "Portland",
      state: "OR",
      postal_code: "97202",
    }),
  ];
  return {
    organizations: [
      {
        id: ORG_ID,
        name: "Rose City Rehab Collective",
        lifecycle_state: "active",
        created_at: "2026-07-01T00:00:00Z",
      },
    ],
    memberships: [
      {
        org_id: ORG_ID,
        role: "admin",
        organizations: {
          name: "Rose City Rehab Collective",
          lifecycle_state: "active",
          created_at: "2026-07-01T00:00:00Z",
        },
      },
    ],
    profiles: [
      {
        id: USER_ID,
        full_name: "Sowmya Seed",
        email: "sowmya.seed@example.test",
        created_at: "2026-07-09T00:00:00Z",
      },
    ],
    notes: [],
    user_table_prefs: [],
    parties,
    party_role_assignments: [
      { role_key: "owner", is_default: true, party_id: PARTY_JANE },
      { role_key: "billing_contact", is_default: true, party_id: PARTY_LEGACY },
    ],
    party_role_types: [
      { role_key: "owner", label: "Authorized contact", is_active: true },
      { role_key: "customer_escalation_contact", label: "Organization contact", is_active: true },
      { role_key: "sales_rep", label: "Sales Rep", is_active: true },
      { role_key: "billing_contact", label: "Billing Contact", is_active: true },
      { role_key: "contracting_signer", label: "Contracting Signer", is_active: true },
      { role_key: "credentialing_contact", label: "Credentialing Contact", is_active: true },
    ],
    inbound_leads: [],
    party_capture_links: [],
    audit_log: [],
  };
}

interface Write {
  method: string;
  table: string;
  url: string;
  body: Row | null;
}

function workspaceHandler(fixtures: Record<string, Row[]>, writes: Write[]) {
  let orgCreated = false;
  return async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.includes("/auth/v1/")) return json(SESSION);
    const table = url.pathname.split("/rest/v1/")[1] ?? "";
    if (req.method() !== "GET") {
      let body: Row | null = null;
      try {
        body = (req.postDataJSON() as Row | null) ?? null;
      } catch {
        body = null;
      }
      writes.push({ method: req.method(), table, url: req.url(), body });
    }
    if (table === "rpc/create_organization") {
      orgCreated = true;
      return json(NEW_ORG);
    }
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);
    if (table === "memberships" && orgCreated) {
      return json([
        ...fixtures.memberships,
        {
          org_id: NEW_ORG,
          role: "admin",
          organizations: {
            name: "Point Place Physical Therapy",
            lifecycle_state: "prospect",
            created_at: "2026-11-01T00:00:00Z",
          },
        },
      ]);
    }

    const parties = fixtures.parties;
    if (table === "party_role_assignments") {
      if (req.method() === "POST") return json([{ id: "a-new" }], 201);
      const select = url.searchParams.get("select") ?? "";
      if (select.trim() === "id") return json([]);
      const byId = Object.fromEntries(parties.map((p) => [p.id, p]));
      return json(
        fixtures.party_role_assignments.map((a) => ({
          role_key: a.role_key,
          is_default: a.is_default,
          parties: byId[a.party_id as string] ?? null,
        })),
      );
    }
    if (table === "parties" && req.method() === "POST") {
      const row = party({ ...(req.postDataJSON() as Row), id: `new-${parties.length + 1}` });
      parties.push(row);
      return json([row], 201);
    }
    if (table === "parties" && req.method() === "PATCH") {
      const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
      const row = parties.find((p) => p.id === id) ?? parties[0];
      Object.assign(row, req.postDataJSON() as Row);
      return json(row);
    }
    if (table === "parties" && (url.searchParams.get("select") ?? "").includes("first_name")) {
      const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
      return json(parties.find((p) => p.id === id) ?? null);
    }
    if (req.method() === "POST") return json([], 201);

    const rows = fixtures[table] ?? [];
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    if (wantsObject) {
      if (rows.length === 0) return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(rows[0]);
    }
    return json(rows);
  };
}

async function bootWorkspace(context: BrowserContext, writes: Write[]) {
  const fixtures = workspaceFixtures();
  await context.route(/\/(rest|auth)\/v1\//, workspaceHandler(fixtures, writes));
  await context.addInitScript(
    ([authKey, session, orgId]) => {
      window.localStorage.setItem(authKey as string, JSON.stringify(session));
      window.localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: orgId }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ORG_ID] as const,
  );
  return fixtures;
}

const partyPosts = (writes: Write[]) =>
  writes.filter((w) => w.table === "parties" && w.method === "POST");
const partyPatches = (writes: Write[]) =>
  writes.filter((w) => w.table === "parties" && w.method === "PATCH");

test("CP-01: Add person saves a blank phone as NULL and refuses a non-US one", async ({
  context,
  page,
}) => {
  const writes: Write[] = [];
  await bootWorkspace(context, writes);
  await page.goto("/org-detail");
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible({ timeout: 30000 });

  await page.getByRole("button", { name: /Add person/ }).click();
  const dialog = page.getByRole("dialog");
  // The Phone label carries no required marker.
  await expect(dialog.locator('label[for="new-party-phone"]')).toHaveText("Phone");
  await expect(dialog.locator("#new-party-phone")).not.toHaveAttribute("aria-required", "true");
  await dialog.locator("#new-party-first-name").fill("Dana");
  await dialog.locator("#new-party-last-name").fill("Reyes");
  await dialog.locator("#new-party-email").fill("dana@example.test");
  await dialog.locator("#new-party-line1").fill("500 NW Everett St");
  await dialog.locator("#new-party-city").fill("Portland");
  await dialog.locator("#new-party-zip").fill("97209");
  await dialog.locator("#new-party-state").click();
  await page.getByRole("option", { name: "OR", exact: true }).click();
  await dialog.getByRole("combobox").last().click();
  await page.getByRole("option", { name: /Billing Contact/ }).click();

  // A non-US number is refused at the field, and nothing is written.
  await dialog.locator("#new-party-phone").fill(NON_US);
  await dialog.getByRole("button", { name: /^Add person$/ }).click();
  await expect(dialog.getByText(PHONE_ERROR)).toBeVisible();
  expect(partyPosts(writes)).toHaveLength(0);

  // Blank: saves, quietly, with the phone stored as NULL.
  await dialog.locator("#new-party-phone").fill("");
  await dialog.getByRole("button", { name: /^Add person$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Phone is required")).toHaveCount(0);
  expect(partyPosts(writes)).toHaveLength(1);
  expect(partyPosts(writes)[0].body).toMatchObject({
    first_name: "Dana",
    last_name: "Reyes",
    phone_office: null,
  });
});

test("CP-02: Edit person clears the phone to NULL, keeps an untouched legacy phone, refuses a non-US one", async ({
  context,
  page,
}) => {
  const writes: Write[] = [];
  await bootWorkspace(context, writes);
  await page.goto("/org-detail");
  await expect(page.getByText("Lee Legacy").first()).toBeVisible({ timeout: 30000 });

  // A4: Lee's stored phone isn't a US number, but nobody touched it, so an
  // unrelated edit saves and the phone is sent back unchanged.
  const lee = page.locator("div.rounded-md.border", { hasText: "Lee Legacy" }).last();
  await lee.getByRole("button", { name: "Edit" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator(`#edit-${PARTY_LEGACY}-title`).fill("Office Manager");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(partyPatches(writes)).toHaveLength(1);
  expect(partyPatches(writes)[0].body).toMatchObject({
    title: "Office Manager",
    phone_office: "abc-def-ghij",
  });

  // Changing it to a non-US number is refused, and nothing is written.
  await lee.getByRole("button", { name: "Edit" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator(`#edit-${PARTY_LEGACY}-phone`).fill(NON_US);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText(PHONE_ERROR)).toBeVisible();
  expect(partyPatches(writes)).toHaveLength(1);

  // Clearing it saves, and the phone is stored as NULL, not "".
  await dialog.locator(`#edit-${PARTY_LEGACY}-phone`).fill("");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(partyPatches(writes)).toHaveLength(2);
  expect(partyPatches(writes)[1].body).toMatchObject({ phone_office: null });
  await expect(page.getByText("Phone is required")).toHaveCount(0);
});

test("CP-03: Create organization sends a blank customer phone to the RPC and lands in the wizard", async ({
  context,
  page,
}) => {
  const writes: Write[] = [];
  await bootWorkspace(context, writes);
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "New organization" })).toBeVisible({
    timeout: 30000,
  });

  const form = page.getByLabel("Organization intake");
  await expect(form.locator('label[for="customer-phone"]')).toHaveText("Phone");
  const inputs = form.locator("input");
  await inputs.nth(0).fill("Point Place Physical Therapy");
  await inputs.nth(1).fill("Owner Point Place");
  await inputs.nth(2).fill("owner.point-place@example.test");
  await form.locator("#customer-first-name").fill("Kitty");
  await form.locator("#customer-last-name").fill("Forman");
  await form.locator("#customer-email").fill("contact.point-place@example.test");
  await form.locator("#customer-line1").fill("416 Marie Dr");
  await form.locator("#customer-city").fill("Point Place");
  await form.locator("#customer-state").click();
  await page.getByRole("option", { name: "WI", exact: true }).click();
  await form.locator("#customer-zip").fill("53511");

  const rpcCalls = () => writes.filter((w) => w.table === "rpc/create_organization");

  // A non-US customer phone is refused before the RPC.
  await form.locator("#customer-phone").fill(NON_US);
  await form.getByRole("button", { name: "Create organization" }).click();
  await expect(form.getByText(PHONE_ERROR)).toBeVisible();
  expect(rpcCalls()).toHaveLength(0);

  // Blank: the RPC is called with the phone blank, and the org is created.
  await form.locator("#customer-phone").fill("");
  await form.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/onboarding\/wizard\/?$/, { timeout: 15000 });
  expect(rpcCalls()).toHaveLength(1);
  const customer = rpcCalls()[0].body?.p_customer as Row;
  expect(customer).toMatchObject({ first_name: "Kitty", last_name: "Forman" });
  expect(String(customer.phone_office ?? "").trim()).toBe("");
});

// ---------------------------------------------------------------------------
// Public pages (no session).
// ---------------------------------------------------------------------------

function captureView(phone: string | null) {
  return {
    state: "active",
    org_name: "Rose City Rehab Collective",
    recipient_name: "Candace Devereaux",
    recipient_email: "contact.rose-city@example.test",
    expires_at: "2026-11-12T17:00:00Z",
    required_fields: [],
    current: {
      name: "Candace Devereaux",
      email: "contact.rose-city@example.test",
      phone_office: phone,
      phone_mobile: null,
      address_line1: "3550 N Mississippi Ave",
      address_line2: null,
      city: "Portland",
      state: null,
      postal_code: "97227",
      country: "US",
    },
  };
}

async function openCapture(page: Page, token: string) {
  await page.goto(`/capture/${token}`);
  await expect(page.getByRole("heading", { name: "Confirm your details" })).toBeVisible({
    timeout: 30000,
  });
  await page.locator("#capture-state").click();
  await page.getByRole("option", { name: "OR", exact: true }).click();
}

async function routeCapture(context: BrowserContext, view: unknown, submits: Row[]) {
  await context.route(/\/(rest|auth)\/v1\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.endsWith("/rpc/validate_capture_token")) return json(view);
    if (url.pathname.endsWith("/rpc/submit_capture")) {
      submits.push(route.request().postDataJSON() as Row);
      return json({ ok: true, state: "used" });
    }
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);
    if (url.pathname.includes("/auth/v1/")) return json({});
    return json([]);
  });
}

test("CP-04: the capture link submits a blank phone and refuses a non-US one", async ({
  context,
  page,
}) => {
  const submits: Row[] = [];
  await routeCapture(context, captureView(null), submits);
  await openCapture(page, "cp04-token");

  await page.locator("#capture-phone").fill(NON_US);
  await page.getByRole("button", { name: "Submit details" }).click();
  await expect(page.getByText(PHONE_ERROR)).toBeVisible();
  expect(submits).toHaveLength(0);

  await page.locator("#capture-phone").fill("");
  await page.getByRole("button", { name: "Submit details" }).click();
  await expect(page.getByText("Thank you — you're all set")).toBeVisible();
  expect(submits).toHaveLength(1);
  expect((submits[0].p_payload as Row).phone_office).toBe("");
});

test("CP-04: the capture link never re-checks an untouched stored phone (A4)", async ({
  context,
  page,
}) => {
  const submits: Row[] = [];
  await routeCapture(context, captureView("abc-def-ghij"), submits);
  await openCapture(page, "cp04-legacy-token");
  await expect(page.locator("#capture-phone")).toHaveValue("abc-def-ghij");

  await page.getByRole("button", { name: "Submit details" }).click();
  await expect(page.getByText("Thank you — you're all set")).toBeVisible();
  expect((submits[0].p_payload as Row).phone_office).toBe("abc-def-ghij");
});

test("CP-05: the public contact form submits a blank phone and refuses a non-US one", async ({
  context,
  page,
}) => {
  const leads: Row[] = [];
  await context.route(/\/(rest|auth)\/v1\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.endsWith("/rpc/submit_inbound_lead")) {
      leads.push(route.request().postDataJSON() as Row);
      return json({ ok: true });
    }
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);
    if (url.pathname.includes("/auth/v1/")) return json({});
    return json([]);
  });
  await page.goto("/contact");
  await expect(
    page.getByRole("heading", { name: "Tell us where credentialing needs support." }),
  ).toBeVisible({ timeout: 30000 });

  await expect(page.locator('label[for="lead-phone"]')).toHaveText("Phone");
  await page.locator("#lead-org").fill("Dillon Sports Medicine");
  await page.locator("#lead-name").fill("Coach Eric Taylor");
  await page.locator("#lead-email").fill("coach@dillon.example.test");

  await page.locator("#lead-phone").fill(NON_US);
  await page.getByRole("button", { name: "Send details" }).click();
  await expect(page.getByText(PHONE_ERROR)).toBeVisible();
  expect(leads).toHaveLength(0);

  await page.locator("#lead-phone").fill("");
  await page.getByRole("button", { name: "Send details" }).click();
  await expect(page.getByText("Thanks for reaching out")).toBeVisible();
  expect(leads).toHaveLength(1);
  expect((leads[0].p_payload as Row).contact_phone).toBe("");
});
