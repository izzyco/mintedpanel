// MINT-110 — NPI Registry (NPPES) search and verification for staff, over the
// mock harness. /api/npi-registry/* is mocked at the browser: no request
// reaches our server's registry route, and nothing reaches NPPES.
// Announcements are counted from every live-region change (recordAnnouncements).
// No registry answer blocks or delays a save (A30): each is an advisory on the
// form's review step (A30b), and nothing is shown as found unless it matched.
//   1. Add Provider (/providers/new): a typed dashed NPI is stripped and
//      verified; a name search (plus state) lists matches; staff pick the
//      wrong Jane and add her offered license, then pick the right one by
//      keyboard: the added row goes, the untouched preset taxonomy is
//      replaced, the typed credentials are kept, and her licenses are
//      offered; adding one twice adds one row; removing it makes the offer
//      available again; the summary survives a step change; each pick and add
//      is announced once. Filled values say "From NPI Registry, <date>" (A35).
//      The Review step lists the credentials mismatch with one-click fixes;
//      the provider is created without confirming it.
//   2. Roster form (/onboarding/wizard → Add provider): a name that differs
//      and a registry outage are both warnings; a name fix is not announced;
//      a failed name search can be retried; pick A (the wrong Jane) then
//      pick B (the right one) leaves nothing of A, keeps the taxonomy staff
//      chose in between, fills the blank CO license number and adds no row;
//      a pasted label, dots or letters still fail. Save shows the review
//      step: the taxonomy mismatch is listed, "Go to Taxonomy code" goes back
//      to the field, and the provider saves without confirming it.
//   3. A check still running: the review step says "Checking the NPI
//      Registry…" and the same live region then says what the registry found
//      — in Add Provider (not found) and the roster form (a name mismatch) —
//      and never "Found" for an NPI that did not match. The save goes
//      through either way, and the roster form saves at once while the
//      check is still running.
//   4. A check the policy keeps backend only says nothing on the form or the
//      review step, and never "Found".
//   5. A confirmation sticks to what staff confirmed: a name mismatch
//      confirmed for one NPI is unconfirmed for the next, and a confirmed
//      license row keeps its confirmation when another row is removed, giving
//      none away. An NPI typed before the name says "name not checked yet".
import { test, expect, type BrowserContext, type Route } from "./fixtures/legacy-access-context";
import {
  announcements,
  recordAnnouncements,
  showNpiRegistryChecksBackendOnly,
} from "./fixtures/npiRegistry";
import type { NpiRegistryRecord } from "../src/lib/npiRegistry";

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

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

const party = (over: Record<string, unknown>) => ({
  party_type: "person",
  first_name: null,
  last_name: null,
  title: null,
  phone_office: null,
  phone_extension: null,
  phone_mobile: null,
  fax: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  country: null,
  created_by: USER_ID,
  created_at: "2026-07-09T00:00:00Z",
  ...over,
});

function makeFixtures(): Record<string, Record<string, unknown>[]> {
  return {
    organizations: [
      {
        id: ORG_ID,
        name: "Tree Hill Sports Therapy",
        lifecycle_state: "prospect",
        created_at: "2026-07-01T00:00:00Z",
      },
    ],
    memberships: [
      {
        org_id: ORG_ID,
        role: "admin",
        organizations: {
          name: "Tree Hill Sports Therapy",
          lifecycle_state: "prospect",
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
    party_role_assignments: [
      {
        org_id: ORG_ID,
        role_key: "owner",
        parties: party({ id: "p-owner", name: "Owner", email: "owner@example.test" }),
      },
      {
        org_id: ORG_ID,
        role_key: "customer_escalation_contact",
        parties: party({
          id: "p-contact",
          name: "Contact",
          email: "contact@example.test",
          phone_office: "704-555-0142",
          address_line1: "100 Main St",
          city: "Charlotte",
          state: "NC",
          postal_code: "28280",
          country: "US",
        }),
      },
    ],
    provider_groups: [
      {
        id: "g-th",
        org_id: ORG_ID,
        name: "Tree Hill Sports Therapy LLC",
        tin: "123456789",
        npi_type2: null,
        states: ["NC"],
        is_active: true,
        created_at: "2026-07-10T00:00:00Z",
        billing_street: "1 Main St",
        billing_city: "Charlotte",
        billing_state: "NC",
        billing_zip: "28280",
        billing_phone: "704-555-0100",
      },
    ],
    facilities: [],
    providers: [],
    state_licenses: [],
    provider_group_assignments: [],
    provider_facility_assignments: [],
    credential_cases: [],
    status_configs: [],
    notes: [],
    user_table_prefs: [],
    audit_log: [],
  };
}

interface RecordedRequest {
  method: string;
  table: string;
  body: unknown;
}

// Stateful PostgREST mock: eq/in/is filters, write-through POST and PATCH.
function makeHandler(fixtures: Record<string, Record<string, unknown>[]>) {
  const requests: RecordedRequest[] = [];
  let seq = 100;
  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.includes("/auth/v1/")) return json(SESSION);
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);

    const table = url.pathname.split("/rest/v1/")[1] ?? "";
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const matches = (row: Record<string, unknown>) => {
      for (const [key, raw] of url.searchParams.entries()) {
        if (["select", "order", "limit", "offset", "on_conflict", "or"].includes(key)) continue;
        if (!(key in row)) continue;
        if (raw.startsWith("eq.") && String(row[key]) !== raw.slice(3)) return false;
        if (raw === "is.null" && row[key] !== null) return false;
        if (raw.startsWith("in.(")) {
          const ids = raw
            .slice(4, -1)
            .split(",")
            .map((s) => s.replace(/^"|"$/g, ""));
          if (!ids.includes(String(row[key]))) return false;
        }
      }
      return true;
    };

    if (req.method() === "HEAD") {
      const n = (fixtures[table] ?? []).filter(matches).length;
      return route.fulfill({ status: 200, headers: { "content-range": `*/${n}` }, body: "" });
    }
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ method: req.method(), table, body });

    if (req.method() === "POST") {
      const rows = (Array.isArray(body) ? body : [body ?? {}]) as Record<string, unknown>[];
      const created = rows.map((row) => ({
        id: `${table}-${(seq += 1)}`,
        created_at: "2026-07-12T00:00:00Z",
        ...row,
      }));
      if (fixtures[table]) fixtures[table].push(...created);
      return json(wantsObject ? created[0] : created, 201);
    }
    if (req.method() === "PATCH") {
      const targets = (fixtures[table] ?? []).filter(matches);
      for (const target of targets) Object.assign(target, (body ?? {}) as Record<string, unknown>);
      if (wantsObject && targets.length !== 1)
        return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(wantsObject ? targets[0] : targets);
    }
    if (req.method() === "DELETE") return json([]);

    const rows = (fixtures[table] ?? []).filter(matches);
    if (wantsObject) {
      if (rows.length === 0) return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(rows[0]);
    }
    return json(rows);
  };
  return { handler, requests };
}

function seedAuth(context: BrowserContext) {
  return context.addInitScript(
    ([authKey, session, activeOrg]) => {
      localStorage.setItem(authKey as string, JSON.stringify(session));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: activeOrg }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ORG_ID] as const,
  );
}

const registryRecord = (over: Partial<NpiRegistryRecord>): NpiRegistryRecord => ({
  npi: "1234567893",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  practiceState: "CO",
  status: "active",
  enumerationDate: "2015-03-02",
  otherNames: [],
  ...over,
});

const DENVER_JANE = registryRecord({
  taxonomies: [
    {
      code: "225100000X",
      description: "Physical Therapist",
      primary: true,
      license: "PT-1001",
      licenseState: "CO",
    },
  ],
});
const BOULDER_JANE = registryRecord({
  npi: "1902833742",
  middleName: "M",
  credential: "DPT",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  practiceCity: "BOULDER",
  taxonomies: [
    {
      code: "2251X0800X",
      description: "Physical Therapist, Orthopedic",
      primary: true,
      license: "PT-4471",
      licenseState: "CO",
    },
    {
      code: "225100000X",
      description: "Physical Therapist",
      primary: false,
      license: "WY-0099",
      licenseState: "WY",
    },
  ],
  practiceAddress: {
    line1: "200 CLINIC WAY",
    line2: null,
    city: "BOULDER",
    state: "CO",
    postalCode: "803021234",
    countryCode: "US",
    phone: "303-555-0199",
  },
  mailingAddress: null,
  otherPracticeAddresses: [],
  identifiers: [{ identifier: "CO-MCD-77", type: "MEDICAID", state: "CO", issuer: null }],
  otherNames: [{ firstName: "JANE", lastName: "SMITH", middleName: null, type: "Former Name" }],
});

interface RegistryCall {
  path: string;
  body: unknown;
  authorization: string | undefined;
}

// When the mocked registry pulled its data (the server stamps every reply).
const PULLED_AT = "2026-10-31T12:00:00.000Z";
const PULLED_LABEL = "From NPI Registry, Oct 31, 2026";

// The browser half of /api/npi-registry/*: records every call and answers
// from the two fixture records. `down` makes every lookup of that NPI a 502;
// `hold(npi)` keeps its lookup running until the returned release is called.
async function mockRegistry(context: BrowserContext) {
  const calls: RegistryCall[] = [];
  const gates = new Map<string, Promise<void>>();
  const state = {
    down: new Set<string>(),
    searchDown: false,
    hold(npi: string): () => void {
      let release: () => void = () => undefined;
      gates.set(
        npi,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    },
  };
  await context.route(/\/api\/npi-registry\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.split("/").pop() ?? "";
    const body = req.postDataJSON() as Record<string, unknown>;
    calls.push({ path, body, authorization: req.headers()["authorization"] });
    const reply = (status: number, data: unknown, error: string | null = null) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ data, error, meta: null }),
      });
    if (path === "search") {
      if (state.searchDown) return reply(502, null, "NPI Registry is unavailable");
      return reply(200, {
        results: [DENVER_JANE, BOULDER_JANE],
        truncated: false,
        pulledAt: PULLED_AT,
      });
    }
    const npi = String(body.npi);
    const gate = gates.get(npi);
    if (gate) await gate;
    if (state.down.has(npi)) return reply(502, null, "NPI Registry is unavailable");
    return reply(200, {
      record: [DENVER_JANE, BOULDER_JANE].find((record) => record.npi === npi) ?? null,
      pulledAt: PULLED_AT,
    });
  });
  return { calls, state };
}

test("MINT-110: Add Provider verifies a typed NPI; a keyboard pick fills blank fields, keeps typed ones and offers other licenses", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler, requests } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  const registry = await mockRegistry(context);
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/providers/new");
  await expect(page.getByRole("heading", { name: "Add provider" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByLabel("First name", { exact: true }).fill("Jane");
  await page.getByLabel("Last name", { exact: true }).fill("Doe");
  // Typed by staff: a pick must keep it.
  await page.getByLabel("Credentials", { exact: true }).fill("PT");
  await page.getByRole("button", { name: "Next" }).click();

  // A pasted dashed NPI keeps all ten digits and is verified once.
  const npi = page.getByLabel("NPI", { exact: true });
  await npi.fill("123-456-7893");
  await expect(npi).toHaveValue("1234567893");
  await expect(page.getByText("Found in the NPI Registry", { exact: true })).toBeVisible();
  // The input is described by the note, and the result is announced once.
  await expect(npi).toHaveAccessibleDescription(
    /Found in the NPI Registry.*JANE DOE, PT · Physical Therapist · DENVER, CO/,
  );
  await expect.poll(() => announcements(page, "Found in the NPI Registry. JANE DOE, PT")).toBe(1);
  expect(registry.calls).toEqual([
    { path: "lookup", body: { npi: "1234567893" }, authorization: "Bearer fake-access-token" },
  ]);

  // A field staff typed must survive a pick.
  const attested = page.getByLabel("CAQH last attested date");
  await attested.fill("2026-07-01");

  // Search by the form's name plus a state; only what staff typed is sent.
  await page.getByLabel("NPI Registry search state").click();
  await page.getByRole("option", { name: "CO", exact: true }).click();
  await page.getByRole("button", { name: "Search NPI Registry" }).click();
  await expect(
    page.getByText("2 matches in the NPI Registry. Pick one to fill the NPI and any blank fields."),
  ).toBeVisible();
  expect(registry.calls.at(-1)).toMatchObject({
    path: "search",
    body: { firstName: "Jane", lastName: "Doe", state: "CO" },
  });

  // Pick A: the Denver Jane. Its CO license is offered, and staff add it.
  const matches = page.getByRole("list", { name: "NPI Registry matches" });
  await matches.getByRole("button", { name: /^JANE DOE, PT NPI 1234567893/ }).click();
  const summary = page.getByRole("region", { name: "From the NPI Registry" });
  await summary.getByRole("button", { name: "Add license row for CO PT-1001" }).click();
  await expect(summary.getByRole("button", { name: "On the form for CO PT-1001" })).toBeFocused();
  await expect
    .poll(() => announcements(page, "Added a CO license row with number PT-1001."))
    .toBe(1);

  // Pick B by keyboard: focus the list, arrow to the second match, Enter.
  await page.getByRole("button", { name: "Search NPI Registry" }).click();
  await matches.getByRole("button").first().focus();
  await page.keyboard.press("ArrowDown");
  // The button's name starts with its visible text (WCAG 2.5.3).
  const boulder = matches.getByRole("button", { name: /^JANE M DOE, DPT NPI 1902833742/ });
  await expect(boulder).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(npi).toHaveValue("1902833742");
  await expect(attested).toHaveValue("2026-07-01");
  await expect(matches).toHaveCount(0);
  // Focus stays on the search, not on the summary.
  await expect(page.getByRole("button", { name: "Search NPI Registry" })).toBeFocused();
  await expect(npi).toHaveAccessibleDescription(
    /Found in the NPI Registry.*JANE M DOE, DPT · Physical Therapist, Orthopedic · BOULDER, CO/,
  );
  // The picked records seed the check: no further lookup call.
  expect(registry.calls.filter((call) => call.path === "lookup")).toHaveLength(1);

  // Filled: the preset taxonomy nobody chose. Cleared: the row staff added
  // from A's offer and left alone. Kept: the typed credentials. B's licenses
  // are offered, not added. Announced once, with the check the pick caused.
  const filledText = "Filled from the NPI Registry: NPI, Taxonomy code.";
  const clearedText = "Cleared from the previous pick: CO license row.";
  const keptText = "Kept yours: Credentials — registry has DPT.";
  const offersText = "The registry lists 2 licenses that are not on the form.";
  await expect
    .poll(() =>
      announcements(
        page,
        `${filledText} ${clearedText} ${keptText} ${offersText} Add them below if they apply. ` +
          "Found in the NPI Registry. JANE M DOE, DPT",
      ),
    )
    .toBe(1);
  await expect(summary.getByText(filledText, { exact: true })).toBeVisible();
  await expect(summary.getByText(clearedText, { exact: true })).toBeVisible();
  await expect(summary.getByText(keptText, { exact: true })).toBeVisible();
  await expect(summary).toContainText(
    "Practice address200 CLINIC WAY, BOULDER, CO 80302-1234 · 303-555-0199",
  );
  await expect(summary).toContainText("Other identifiersMEDICAID CO-MCD-77 (CO)");
  await expect(summary).toContainText("Other namesJANE SMITH (Former Name)");
  await expect(page.getByRole("combobox", { name: "Taxonomy code" })).toContainText("2251X0800X");
  // A35: the taxonomy the pick filled says where it came from, and when; the
  // credentials staff typed do not.
  await expect(page.getByText(PULLED_LABEL, { exact: true })).toHaveCount(1);

  // Staff add B's CO license; focus stays on the button, the add is announced.
  await summary.getByRole("button", { name: "Add license row for CO PT-4471" }).click();
  const coOnForm = summary.getByRole("button", { name: "On the form for CO PT-4471" });
  await expect(coOnForm).toBeFocused();
  await expect
    .poll(() => announcements(page, "Added a CO license row with number PT-4471."))
    .toBe(1);
  // Adding it again (Enter on the focused aria-disabled button) adds nothing
  // and says so.
  await page.keyboard.press("Enter");
  await expect
    .poll(() => announcements(page, "A CO license row with number PT-4471 is already on the form."))
    .toBe(1);
  await expect(
    summary.getByRole("button", { name: "Add license row for WY WY-0099" }),
  ).toBeVisible();

  // Removing the row on the Licenses step makes the offer available again;
  // the summary outlives the step change and is not announced again.
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Remove license" }).click();
  await expect(page.getByRole("button", { name: "Remove license" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(summary.getByText(filledText, { exact: true })).toBeVisible();
  expect(await announcements(page, filledText)).toBe(1);
  await summary.getByRole("button", { name: "Add license row for CO PT-4471" }).click();
  await expect
    .poll(() => announcements(page, "Added a CO license row with number PT-4471."))
    .toBe(2);

  // The added license row says where its number came from (A35).
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(PULLED_LABEL, { exact: true })).toHaveCount(1);
  for (let step = 0; step < 2; step += 1) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await expect(page.getByText("CO · PT-4471", { exact: false })).toBeVisible();
  await expect(page.getByText("CO · PT-1001", { exact: false })).toHaveCount(0);
  await expect(page.getByText("WY · WY-0099", { exact: false })).toHaveCount(0);

  // A30b: the Review step says what the registry found, lists what differs
  // with one-click fixes, and marks the filled values; nothing to type.
  const check = page.getByRole("region", { name: "NPI Registry check" });
  await expect(check.getByRole("status")).toContainText("Found in the NPI Registry");
  const toReview = check.getByRole("list", { name: "To review" });
  await expect(toReview.getByRole("listitem")).toHaveCount(1);
  await expect(toReview).toContainText("Credentials PT — the registry has DPT");
  await expect(toReview.getByRole("button", { name: "Go to Credentials" })).toBeVisible();
  await expect(toReview.getByRole("button", { name: "Use DPT" })).toBeVisible();
  const confirm = toReview.getByRole("button", { name: "Confirm" });
  await confirm.click();
  await expect(toReview.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Confirming is a toggle; the save does not need it.
  await toReview.getByRole("button", { name: "Confirmed" }).click();
  await expect(toReview.getByRole("button", { name: "Confirm" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(check).toContainText(
    `${PULLED_LABEL}: Taxonomy code 2251X0800X; CO license PT-4471. Submitting confirms them.`,
  );
  await expect(check.locator("input, textarea")).toHaveCount(0);
  // The mismatch stays unconfirmed, and the provider is still created.
  await page.getByRole("button", { name: "Create provider" }).click();
  await expect(page.getByRole("heading", { name: "Provider Info" })).toBeVisible({
    timeout: 30000,
  });
  const creates = requests.filter((r) => r.method === "POST" && r.table === "providers");
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({
    first_name: "Jane",
    last_name: "Doe",
    credentials: "PT",
    npi: "1902833742",
    taxonomy_code: "2251X0800X",
    caqh_last_attested_date: "2026-07-01",
  });
  const licenses = requests.filter((r) => r.method === "POST" && r.table === "state_licenses");
  expect(licenses).toHaveLength(1);
  expect(licenses[0].body).toEqual([
    expect.objectContaining({ state: "CO", license_number: "PT-4471", expiration_date: null }),
  ]);
});

test("MINT-110: roster form saves through a mismatch and an outage; pick A then pick B leaves nothing of A", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  const registry = await mockRegistry(context);
  registry.state.down.add("1902833742");
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/onboarding/wizard");
  const card = page.locator("#wizard-providers");
  await card.getByRole("button", { name: "Add provider" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  await dialog.locator("#prov-first").fill("Jane");
  await dialog.locator("#prov-last").fill("Roe");

  // Only the ten digits: a pasted label, dots or letters fail (Sowmya, Oct
  // 31), and are never looked up. The error is linked to the input.
  const npi = dialog.locator("#prov-npi");
  for (const junk of ["NPI: 1234567893", "123.456.7893", "12a4567893"]) {
    await npi.fill(junk);
    await dialog.getByRole("button", { name: "Save provider" }).click();
    await expect(dialog).toContainText("NPI must be 10 digits");
  }
  expect(fixtures.providers).toHaveLength(0);
  await expect(npi).toHaveAttribute("aria-invalid", "true");
  await expect(npi).toHaveAccessibleDescription(/NPI must be 10 digits/);

  // A spaced NPI is checked; the registry's name differs — a warning only.
  await npi.fill("123 456 7893");
  await expect(
    dialog.getByText("Found in the NPI Registry, but the name differs", { exact: true }),
  ).toBeVisible();
  await expect(npi).toHaveAccessibleDescription(
    /but the name differs.*The registry lists JANE DOE/,
  );
  await expect.poll(() => announcements(page, "but the name differs")).toBe(1);

  // Fixing the name updates the note but is not announced.
  await dialog.locator("#prov-last").fill("Doe");
  await expect(dialog.getByText("Found in the NPI Registry", { exact: true })).toBeVisible();
  expect(await announcements(page, "but the name differs")).toBe(1);
  expect(await announcements(page, "Found in the NPI Registry.")).toBe(0);

  // The registry is down for the next number — still a warning only.
  await npi.fill("190-283-3742");
  // (The format error from the junk above stays linked until the next save.)
  await expect(npi).toHaveAccessibleDescription(/^NPI Registry is unavailable/);
  expect(registry.calls.map((call) => call.body)).toEqual([
    { npi: "1234567893" },
    { npi: "1902833742" },
  ]);

  // A failed name search says so; pressing Search again retries it.
  registry.state.searchDown = true;
  const search = dialog.getByRole("button", { name: "Search NPI Registry" });
  await search.click();
  await expect(
    dialog.getByText("NPI Registry is unavailable. You can still type the NPI."),
  ).toBeVisible();
  registry.state.searchDown = false;
  await search.click();
  const matches = dialog.getByRole("list", { name: "NPI Registry matches" });
  await expect(matches).toBeVisible();
  expect(registry.calls.filter((call) => call.path === "search")).toHaveLength(2);

  // Staff chose the license state; its number is blank, so a pick fills it.
  await dialog.locator("#lic-0-state").click();
  await page.getByRole("option", { name: "CO", exact: true }).click();

  // Pick A: the Denver Jane, by mistake.
  await matches.getByRole("button", { name: /^JANE DOE, PT NPI 1234567893/ }).click();
  const filledA =
    "Filled from the NPI Registry: NPI, Credentials, Taxonomy code, CO license number.";
  await expect.poll(() => announcements(page, filledA)).toBe(1);
  await expect(dialog.locator("#prov-credentials")).toHaveValue("PT");
  await expect(dialog.locator("#prov-taxonomy")).toContainText("225100000X");
  await expect(dialog.locator("#lic-0-number")).toHaveValue("PT-1001");

  // Staff choose the taxonomy themselves: theirs from now on.
  await dialog.locator("#prov-taxonomy").click();
  await page.getByRole("option", { name: /^225200000X/ }).click();

  // Pick B: the right Jane. A's untouched data is replaced, never "kept".
  await search.click();
  await matches.getByRole("button", { name: /^JANE M DOE, DPT NPI 1902833742/ }).click();
  const filledB = "Filled from the NPI Registry: NPI, Credentials, CO license number.";
  const keptB =
    "Kept yours: Taxonomy code — registry has 2251X0800X (Physical Therapist, Orthopedic).";
  const offerB = "The registry lists 1 license that is not on the form.";
  await expect.poll(() => announcements(page, `${filledB} ${keptB} ${offerB}`)).toBe(1);
  expect(await announcements(page, filledA)).toBe(1);
  expect(await announcements(page, "Kept yours: Credentials")).toBe(0);
  const summary = dialog.getByRole("region", { name: "From the NPI Registry" });
  await expect(summary.getByText(filledB, { exact: true })).toBeVisible();
  await expect(summary.getByText(keptB, { exact: true })).toBeVisible();
  await expect(
    summary.getByRole("button", { name: "Add license row for WY WY-0099" }),
  ).toBeVisible();
  await expect(dialog.locator("#prov-credentials")).toHaveValue("DPT");
  await expect(dialog.locator("#prov-taxonomy")).toContainText("225200000X");
  await expect(dialog.locator("#lic-0-number")).toHaveValue("PT-4471");
  // A35: credentials and the license number the pick filled are marked; the
  // taxonomy staff chose is not.
  await expect(dialog.getByText(PULLED_LABEL, { exact: true })).toHaveCount(2);
  // No row was added for WY.
  await expect(dialog.locator("#lic-1-state")).toHaveCount(0);
  // The picks seeded the check, the outage NPI's too: no lookup call.
  expect(registry.calls.filter((call) => call.path === "lookup")).toHaveLength(2);

  // Save shows the review step (a new provider), and saves nothing yet.
  const save = dialog.getByRole("button", { name: "Save provider" });
  await save.click();
  const review = dialog.getByRole("region", { name: "Review before saving" });
  await expect(review).toContainText("Jane Doe");
  await expect(review).toContainText("1902833742");
  const check = dialog.getByRole("region", { name: "NPI Registry check" });
  await expect(check.getByRole("status")).toContainText("Found in the NPI Registry");
  const toReview = check.getByRole("list", { name: "To review" });
  await expect(toReview).toContainText(
    "Taxonomy code 225200000X — the registry has 2251X0800X (Physical Therapist, Orthopedic)",
  );
  await expect(check).toContainText(
    `${PULLED_LABEL}: Credentials DPT; CO license PT-4471. Submitting confirms them.`,
  );
  expect(fixtures.providers).toHaveLength(0);
  // One click goes back to the field.
  await toReview.getByRole("button", { name: "Go to Taxonomy code" }).click();
  await expect(dialog.locator("#prov-taxonomy")).toBeFocused();
  // Staff keep their taxonomy and save without confirming the mismatch.
  await save.click();
  await expect(toReview).toBeVisible();
  await save.click();
  await expect(card).toContainText("Jane Doe", { timeout: 15000 });
  expect(fixtures.providers).toHaveLength(1);
  expect(fixtures.providers[0]).toMatchObject({
    first_name: "Jane",
    last_name: "Doe",
    credentials: "DPT",
    npi: "1902833742",
    taxonomy_code: "225200000X",
  });
  expect(fixtures.state_licenses).toHaveLength(1);
  expect(fixtures.state_licenses[0]).toMatchObject({
    state: "CO",
    license_number: "PT-4471",
    expiration_date: null,
  });
});

test("MINT-110: Add Provider's Review step says Checking…, then Not found in place, and the provider is created", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler, requests } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  const registry = await mockRegistry(context);
  const release = registry.state.hold("1234567810");
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/providers/new");
  await expect(page.getByRole("heading", { name: "Add provider" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByLabel("First name", { exact: true }).fill("Jane");
  await page.getByLabel("Last name", { exact: true }).fill("Doe");
  await page.getByRole("button", { name: "Next" }).click();
  // A check-digit-valid NPI the registry does not list; its check is slow.
  const npi = page.getByLabel("NPI", { exact: true });
  await npi.fill("1234567810");
  await expect(npi).toHaveAccessibleDescription("Checking the NPI Registry…");
  // Next never waits for the check.
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  const check = page.getByRole("region", { name: "NPI Registry check" });
  const status = check.getByRole("status");
  await expect(status).toHaveText("Checking the NPI Registry…");
  await expect(check.getByRole("list", { name: "To review" })).toHaveCount(0);

  // The registry answers: the same live region says so, in place.
  release();
  await expect(status).toContainText("Not found in the NPI Registry");
  await expect(status).not.toContainText("Checking");
  const toReview = check.getByRole("list", { name: "To review" });
  await expect(toReview).toContainText("Not found in the NPI Registry");
  await expect(toReview.getByRole("button", { name: "Go to NPI" })).toBeVisible();
  // Never shown as found.
  await expect(page.getByText("Found in the NPI Registry", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Create provider" }).click();
  await expect(page.getByRole("heading", { name: "Provider Info" })).toBeVisible({
    timeout: 30000,
  });
  const creates = requests.filter((r) => r.method === "POST" && r.table === "providers");
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({ npi: "1234567810" });
});

test("MINT-110: the roster form's review step updates a running check in place, and saves through a name mismatch", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  const registry = await mockRegistry(context);
  const release = registry.state.hold("1234567893");
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/onboarding/wizard");
  const card = page.locator("#wizard-providers");
  await card.getByRole("button", { name: "Add provider" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  await dialog.locator("#prov-first").fill("Jane");
  await dialog.locator("#prov-last").fill("Roe");
  await dialog.locator("#prov-npi").fill("1234567893");

  const save = dialog.getByRole("button", { name: "Save provider" });
  await save.click();
  const check = dialog.getByRole("region", { name: "NPI Registry check" });
  const status = check.getByRole("status");
  await expect(status).toHaveText("Checking the NPI Registry…");

  release();
  await expect(status).toContainText("Found in the NPI Registry, but the name differs");
  const toReview = check.getByRole("list", { name: "To review" });
  await expect(toReview).toContainText("Found in the NPI Registry, but the name differs");
  await expect(toReview.getByRole("button", { name: "Go to name" })).toBeVisible();
  // A mismatch is never shown as a plain match.
  await expect(dialog.getByText("Found in the NPI Registry", { exact: true })).toHaveCount(0);
  await expect.poll(() => announcements(page, "Checking the NPI Registry…")).toBeGreaterThan(0);
  await expect.poll(() => announcements(page, "but the name differs")).toBeGreaterThan(0);

  await save.click();
  await expect(card).toContainText("Jane Roe", { timeout: 15000 });
  expect(fixtures.providers).toHaveLength(1);
  expect(fixtures.providers[0]).toMatchObject({ last_name: "Roe", npi: "1234567893" });
});

test("MINT-110: a check kept backend only says nothing on the form, and the roster form saves at once while a check runs", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const policy = await showNpiRegistryChecksBackendOnly(context, ["nameMismatch"]);
  const fixtures = makeFixtures();
  const { handler } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  const registry = await mockRegistry(context);
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/onboarding/wizard");
  const card = page.locator("#wizard-providers");
  await card.getByRole("button", { name: "Add provider" }).click({ timeout: 30000 });
  expect(policy.patched()).toBe(true);
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  await dialog.locator("#prov-first").fill("Jane");
  await dialog.locator("#prov-last").fill("Roe");
  await dialog.locator("#prov-npi").fill("1234567893");
  await expect.poll(() => registry.calls.length).toBe(1);

  // The name differs, but the policy keeps that for Mission Control: the form
  // says nothing — and never "Found".
  const save = dialog.getByRole("button", { name: "Save provider" });
  await save.click();
  await expect(dialog.getByRole("region", { name: "Review before saving" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "NPI Registry check" })).toHaveCount(0);
  await expect(dialog.getByText(/name differs|Found in the NPI Registry/)).toHaveCount(0);
  await save.click();
  await expect(card).toContainText("Jane Roe", { timeout: 15000 });

  // A check that has not answered yet never delays the save.
  const release = registry.state.hold("1902833742");
  await card.getByRole("button", { name: "Add provider" }).click();
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  await dialog.locator("#prov-first").fill("Mary");
  await dialog.locator("#prov-last").fill("Major");
  await dialog.locator("#prov-npi").fill("1902833742");
  await save.click();
  const status = dialog.getByRole("region", { name: "NPI Registry check" }).getByRole("status");
  await expect(status).toHaveText("Checking the NPI Registry…");
  await save.click();
  await expect(card).toContainText("Mary Major", { timeout: 15000 });
  expect(fixtures.providers).toHaveLength(2);
  release();
});

test("MINT-110: a name mismatch confirmed for one NPI is not confirmed for the next", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  await mockRegistry(context);
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/onboarding/wizard");
  const card = page.locator("#wizard-providers");
  await card.getByRole("button", { name: "Add provider" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  // The NPI first: listed, but nothing is compared until both names are in.
  const npi = dialog.locator("#prov-npi");
  await npi.fill("1234567893");
  await expect(npi).toHaveAccessibleDescription(/In the NPI Registry; name not checked yet/);
  await expect(dialog.getByText("Found in the NPI Registry", { exact: true })).toHaveCount(0);
  await dialog.locator("#prov-first").fill("Jane");
  await expect(npi).toHaveAccessibleDescription(/name not checked yet/);
  await dialog.locator("#prov-last").fill("Roe");
  await expect(npi).toHaveAccessibleDescription(/but the name differs/);

  // Confirm the mismatch for NPI X (the Denver Jane Doe).
  const save = dialog.getByRole("button", { name: "Save provider" });
  await save.click();
  const toReview = dialog
    .getByRole("region", { name: "NPI Registry check" })
    .getByRole("list", { name: "To review" });
  await expect(toReview).toContainText("JANE DOE");
  await toReview.getByRole("button", { name: "Confirm" }).click();
  await expect(toReview.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Back to the form; NPI Y (the Boulder Jane M Doe) also differs from Roe.
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await npi.fill("1902833742");
  await save.click();
  await expect(toReview).toContainText("JANE M DOE");
  // Y's mismatch is a new advisory: not confirmed.
  await expect(toReview.getByRole("button", { name: "Confirm" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(toReview.getByRole("button", { name: "Confirmed" })).toHaveCount(0);

  // Back to X: the same mismatch staff confirmed is still confirmed.
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await npi.fill("1234567893");
  await save.click();
  await expect(toReview).toContainText("JANE DOE");
  await expect(toReview.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await save.click();
  await expect(card).toContainText("Jane Roe", { timeout: 15000 });
  expect(fixtures.providers).toHaveLength(1);
});

test("MINT-110: a confirmed license row keeps its confirmation when another row is removed, and gives none away", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = makeFixtures();
  const { handler } = makeHandler(fixtures);
  await context.route(/\/(rest|auth)\/v1\//, handler);
  await mockRegistry(context);
  await recordAnnouncements(context);
  await seedAuth(context);

  await page.goto("/onboarding/wizard");
  const card = page.locator("#wizard-providers");
  await card.getByRole("button", { name: "Add provider" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Assign Tree Hill Sports Therapy LLC").click();
  await dialog.locator("#prov-first").fill("Jane");
  await dialog.locator("#prov-last").fill("Doe");
  // The Boulder Jane: the registry lists CO PT-4471 and WY WY-0099.
  await dialog.locator("#prov-npi").fill("1902833742");

  // Two rows whose numbers differ from the registry's: CO, then WY.
  const addLicense = dialog.getByRole("button", { name: "Add license" });
  if ((await dialog.locator("#lic-0-state").count()) === 0) await addLicense.click();
  await dialog.locator("#lic-0-state").click();
  await page.getByRole("option", { name: "CO", exact: true }).click();
  await dialog.locator("#lic-0-number").fill("PT-1");
  await addLicense.click();
  await dialog.locator("#lic-1-state").click();
  await page.getByRole("option", { name: "WY", exact: true }).click();
  await dialog.locator("#lic-1-number").fill("WY-9");

  const save = dialog.getByRole("button", { name: "Save provider" });
  await save.click();
  const toReview = dialog
    .getByRole("region", { name: "NPI Registry check" })
    .getByRole("list", { name: "To review" });
  const co = toReview.getByRole("listitem").filter({ hasText: "CO license PT-1" });
  const wy = toReview.getByRole("listitem").filter({ hasText: "WY license WY-9" });
  await expect(co).toBeVisible();
  await expect(wy).toBeVisible();
  // Confirm row 1's WY difference.
  await wy.getByRole("button", { name: "Confirm" }).click();
  await expect(wy.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(co.getByRole("button", { name: "Confirm" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // Remove row 0 (CO). The WY row keeps its confirmation.
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await dialog.getByRole("button", { name: "Remove license 1" }).click();
  await expect(dialog.locator("#lic-0-number")).toHaveValue("WY-9");
  await save.click();
  await expect(toReview.getByRole("listitem")).toHaveCount(1);
  await expect(wy.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // A new CO row, now after WY, was never confirmed.
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await addLicense.click();
  await dialog.locator("#lic-1-state").click();
  await page.getByRole("option", { name: "CO", exact: true }).click();
  await dialog.locator("#lic-1-number").fill("PT-1");
  await save.click();
  await expect(toReview.getByRole("listitem")).toHaveCount(2);
  await expect(co.getByRole("button", { name: "Confirm" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(wy.getByRole("button", { name: "Confirmed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The registry's one WY number is offered to use.
  await expect(wy.getByRole("button", { name: "Use WY-0099" })).toBeVisible();

  await save.click();
  await expect(card).toContainText("Jane Doe", { timeout: 15000 });
  expect(fixtures.providers).toHaveLength(1);
});
