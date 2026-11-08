import {
  test,
  expect,
  type Route,
  type Page,
  type BrowserContext,
} from "./fixtures/legacy-access-context";

// Provider onboarding R1, cycle 7 (boards 6a and 6b): the staff Onboarding card
// on the provider record and the roster's Onboarding toggle and pill. The REST
// layer, the four onboarding RPCs and the cancel and resend routes are mocked;
// the RPC handlers write through into the journey so each refetch shows what
// the write did.

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_PROVIDER_ID = "55555555-5555-4555-8555-555555555555";
const JOURNEY_ID = "66666666-6666-4666-8666-666666666666";
const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const CHARLOTTE = "88888888-8888-4888-8888-888888888888";
const COLUMBIA = "99999999-9999-4999-8999-999999999999";
const SHOTS =
  "/private/tmp/claude-501/-Users-ivan-Code-mintedpanel/23a19aaf-35cf-4915-b237-3ac9913f9269/scratchpad/onboarding-e2e/cycle7";

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

function providerRow(id: string, first: string, last: string, over: Record<string, unknown> = {}) {
  return {
    id,
    org_id: ORG_ID,
    first_name: first,
    last_name: last,
    credentials: "PTA",
    npi: "1234567893",
    caqh_id: "12345678",
    caqh_last_attested_date: "2026-09-02",
    specialty: "Physical Therapy",
    taxonomy_code: "225200000X",
    dea_number: null,
    date_of_birth: "1990-04-02",
    ssn_last4: "6789",
    email: `${first.toLowerCase()}@example.test`,
    phone: "704-555-0100",
    start_date: "2026-11-10",
    home_street: null,
    home_city: null,
    home_state: null,
    home_zip: null,
    status: "onboarding",
    verification_state: "verified",
    reference_only: false,
    group_id: null,
    ...over,
  };
}

interface Journey {
  id: string;
  source: string;
  created_record: boolean;
  locked_fields: string[];
  opened_at: string;
  first_signed_in_at: string | null;
  consented_at: string | null;
  ssn_stored_at: string | null;
  submitted_at: string | null;
  admitted_at: string | null;
  admitted_by_name: string | null;
  admitted_facility_id: string | null;
  cancelled_at: string | null;
  last_help_at: string | null;
  last_contacted_at: string | null;
}

const INVITED: Journey = {
  id: JOURNEY_ID,
  source: "staff",
  created_record: true,
  locked_fields: [],
  opened_at: "2026-10-13T13:40:00Z",
  first_signed_in_at: null,
  consented_at: null,
  ssn_stored_at: null,
  submitted_at: null,
  admitted_at: null,
  admitted_by_name: null,
  admitted_facility_id: null,
  cancelled_at: null,
  last_help_at: null,
  last_contacted_at: null,
};

const SUBMITTED: Journey = {
  ...INVITED,
  first_signed_in_at: "2026-10-15T22:52:00Z",
  consented_at: "2026-10-15T22:54:00Z",
  ssn_stored_at: "2026-10-16T23:30:00Z",
  submitted_at: "2026-10-16T23:48:00Z",
};

interface Check {
  check_key: string;
  outcome: string;
  note: string | null;
  checked_by_name: string;
  checked_at: string;
}

interface MockState {
  journey: Journey | null;
  checks: Check[];
  logins: { caqh: boolean; pecos: boolean };
  heldUploads: number;
  rpcCalls: Array<{ name: string; body: Record<string, unknown> }>;
  apiCalls: string[];
  cancelOutcome: "deleted" | "closed";
}

function baseTables(role: string): Record<string, unknown[]> {
  return {
    organizations: [
      {
        id: ORG_ID,
        name: "Shelby Sports Rehab",
        lifecycle_state: "active",
        created_at: "2026-07-01T00:00:00Z",
      },
    ],
    memberships: [
      {
        org_id: ORG_ID,
        role,
        organizations: {
          name: "Shelby Sports Rehab",
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
    providers: [providerRow(PROVIDER_ID, "Lena", "Ortiz")],
    provider_groups: [
      { id: GROUP_ID, org_id: ORG_ID, name: "Shelby Sports Rehab", is_active: true },
    ],
    provider_group_assignments: [
      {
        id: "pga-1",
        org_id: ORG_ID,
        provider_id: PROVIDER_ID,
        group_id: GROUP_ID,
        is_primary: true,
        start_date: null,
        end_date: null,
        created_at: "2026-10-13T13:40:00Z",
      },
    ],
    facilities: [
      {
        id: CHARLOTTE,
        org_id: ORG_ID,
        group_id: GROUP_ID,
        name: "Charlotte",
        city: "Charlotte",
        state: "NC",
        is_active: true,
      },
      {
        id: COLUMBIA,
        org_id: ORG_ID,
        group_id: GROUP_ID,
        name: "Columbia",
        city: "Columbia",
        state: "SC",
        is_active: true,
      },
    ],
    state_licenses: [
      {
        id: "lic-nc",
        org_id: ORG_ID,
        provider_id: PROVIDER_ID,
        state: "NC",
        license_number: "PTA1234",
        license_type: "full",
        expiration_date: "2027-06-30",
        status: "active",
        verified_status: "unverified",
      },
    ],
    provider_documents: [
      {
        id: "doc-cv",
        org_id: ORG_ID,
        provider_id: PROVIDER_ID,
        doc_type: "cv",
        file_name: "cv.pdf",
        file_path: "x",
        created_at: "2026-10-16T23:48:00Z",
        document_family_id: "doc-cv",
        version_number: 1,
        supersedes_document_id: null,
      },
      {
        id: "doc-lic",
        org_id: ORG_ID,
        provider_id: PROVIDER_ID,
        doc_type: "state_license",
        file_name: "nc.pdf",
        file_path: "y",
        expiration_date: "2027-06-30",
        created_at: "2026-10-16T23:48:00Z",
        document_family_id: "doc-lic",
        version_number: 1,
        supersedes_document_id: null,
      },
    ],
    notes: [],
    user_table_prefs: [],
  };
}

function readPayload(state: MockState) {
  if (!state.journey) return null;
  return {
    journey: state.journey,
    invite: {
      email: "lena@example.test",
      last_sent_at: "2026-10-13T13:40:00Z",
      delivery: "sent",
      sends: 1,
    },
    checks: state.checks,
    logins_on_file: state.logins,
    ssn_on_file: state.journey.ssn_stored_at !== null,
    held_uploads: state.heldUploads,
    has_case: false,
    npi_in_use: false,
  };
}

function eqFilter(url: URL, column: string): string | null {
  const v = url.searchParams.get(column);
  return v && v.startsWith("eq.") ? v.slice(3) : null;
}

async function mount(
  context: BrowserContext,
  options: { role?: string; journey: Journey | null; tables?: Record<string, unknown[]> },
): Promise<MockState> {
  const tables = { ...baseTables(options.role ?? "admin"), ...(options.tables ?? {}) };
  const state: MockState = {
    journey: options.journey ? { ...options.journey } : null,
    checks: [],
    logins: { caqh: true, pecos: true },
    heldUploads: 0,
    rpcCalls: [],
    apiCalls: [],
    cancelOutcome: "deleted",
  };

  await context.route(/\/(rest|auth)\/v1\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/auth/v1/")) return json(SESSION);

    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (rpcMatch) {
      const name = rpcMatch[1];
      const body = (req.postData() ? JSON.parse(req.postData() as string) : {}) as Record<
        string,
        unknown
      >;
      state.rpcCalls.push({ name, body });
      const now = new Date().toISOString();
      switch (name) {
        case "read_provider_onboarding":
          return json(body.p_provider_id === PROVIDER_ID ? readPayload(state) : null);
        case "record_onboarding_check": {
          const row = {
            check_key: String(body.p_check_key),
            outcome: String(body.p_outcome),
            note: (body.p_note as string | null) ?? null,
            checked_by_name: "Sowmya Seed",
            checked_at: now,
          };
          state.checks = [...state.checks.filter((c) => c.check_key !== row.check_key), row];
          return json(row);
        }
        case "mark_onboarding_contacted":
          if (state.journey) state.journey.last_contacted_at = now;
          return json({ last_contacted_at: now });
        case "admit_provider_onboarding":
          if (state.journey) {
            state.journey.admitted_at = now;
            state.journey.admitted_by_name = "Sowmya Seed";
            state.journey.admitted_facility_id = String(body.p_facility_id);
          }
          tables.provider_facility_assignments = [
            {
              id: "pfa-1",
              org_id: ORG_ID,
              provider_id: PROVIDER_ID,
              facility_id: String(body.p_facility_id),
              is_primary: true,
              start_date: "2026-11-10",
              created_at: now,
            },
          ];
          return json({ admitted_at: now, assignment_created: true, made_primary: true });
        case "reveal_portal_credential":
          return json({ username: "lena.caqh", password: "Pass-Word-1" });
        case "get_sop_field_tokens":
          return json([]);
        default:
          return json([]);
      }
    }

    const table = url.pathname.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    if (table === "provider_onboardings") {
      const open = state.journey && !state.journey.admitted_at && !state.journey.cancelled_at;
      const rows = [
        ...(open
          ? [
              {
                id: JOURNEY_ID,
                provider_id: PROVIDER_ID,
                opened_at: INVITED.opened_at,
                submitted_at: state.journey?.submitted_at ?? null,
              },
            ]
          : []),
        ...((tables.provider_onboardings as unknown[]) ?? []),
      ];
      return json(rows);
    }
    let rows = tables[table] ?? [];
    const id = eqFilter(url, "id");
    if (id) rows = rows.filter((r) => (r as { id?: string }).id === id);
    const providerId = eqFilter(url, "provider_id");
    if (providerId && table !== "provider_group_assignments") {
      rows = rows.filter((r) => (r as { provider_id?: string }).provider_id === providerId);
    }
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    if (wantsObject) {
      if (rows.length === 0) return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(rows[0]);
    }
    if (req.method() === "POST" || req.method() === "PATCH") return json(null, 201);
    return json(rows);
  });

  await context.route("**/api/provider-invites/**", async (route) => {
    const url = new URL(route.request().url());
    state.apiCalls.push(`${route.request().method()} ${url.pathname}`);
    const ok = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data, error: null, meta: {} }),
      });
    if (url.pathname.endsWith("/cancel")) {
      if (state.journey) state.journey.cancelled_at = new Date().toISOString();
      if (state.cancelOutcome === "deleted") tables.providers = [];
      return ok({ outcome: state.cancelOutcome });
    }
    if (url.pathname.endsWith("/resend"))
      return ok({ delivery: "sent", email: "lena@example.test" });
    return route.fulfill({ status: 404, body: "{}" });
  });

  await context.addInitScript(
    ([authKey, session, orgId]) => {
      localStorage.setItem(authKey as string, JSON.stringify(session));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: orgId }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ORG_ID] as const,
  );
  return state;
}

async function openRecord(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/providers/${PROVIDER_ID}`);
  await expect(page.getByRole("heading", { name: /Lena Ortiz/ })).toBeVisible({ timeout: 30000 });
}

const card = (page: Page) => page.locator("section#onboarding");

test.describe("staff Onboarding card (board 6b)", () => {
  test("invited: tracker, waiting on her, Resend and Cancel; Admit waits; Readiness hidden", async ({
    context,
    page,
  }) => {
    const state = await mount(context, { journey: INVITED });
    state.logins = { caqh: false, pecos: false };
    await openRecord(page);

    await expect(card(page).getByRole("heading", { name: "Onboarding" })).toBeVisible();
    await expect(card(page).getByText("Stage: Invited")).toBeAttached();
    await expect(card(page).getByText("Lena · invited, hasn't signed in yet")).toBeVisible();
    await expect(card(page).getByText("Oct 13, 2026 · lena@example.test")).toBeVisible();
    await expect(card(page).getByText("Created by this invitation")).toBeVisible();
    await expect(card(page).getByText("Nothing saved yet")).toBeVisible();
    await expect(card(page).getByRole("heading", { name: /Verification/ })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Admit & assign" })).toBeDisabled();
    await expect(card(page).getByText("Admit & assign opens once Lena submits.")).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Mark contacted" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/card-invited.png`, fullPage: false });

    await card(page).getByRole("button", { name: "Resend invitation" }).click();
    await expect(page.getByText("Invitation sent to lena@example.test")).toBeVisible();
    expect(state.apiCalls).toContain(`POST /api/provider-invites/${PROVIDER_ID}/resend`);

    await page.getByRole("tab", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { name: "Readiness" })).toHaveCount(0);
  });

  test("a help request waits on the practice until Mark contacted", async ({ context, page }) => {
    const state = await mount(context, {
      journey: {
        ...INVITED,
        first_signed_in_at: "2026-10-15T22:52:00Z",
        last_help_at: "2026-10-17T15:00:00Z",
      },
    });
    state.heldUploads = 2;
    await openRecord(page);

    await expect(
      card(page).getByText("The practice · Lena asked for help Oct 17, 2026"),
    ).toBeVisible();
    await expect(card(page).getByText("2 files uploaded")).toBeVisible();
    await card(page).getByRole("button", { name: "Mark contacted" }).click();
    await expect(page.getByText("Marked Lena contacted")).toBeVisible();
    expect(state.rpcCalls.find((c) => c.name === "mark_onboarding_contacted")?.body).toEqual({
      p_onboarding_id: JOURNEY_ID,
    });
    await expect(card(page).getByText("Lena · signed in, not submitted")).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Mark contacted" })).toHaveCount(0);
  });

  test("Cancel states what goes, then says the record was removed", async ({ context, page }) => {
    const state = await mount(context, { journey: INVITED });
    await openRecord(page);

    await card(page).getByRole("button", { name: "Cancel invitation" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel Lena's invitation?" });
    await expect(
      dialog.getByText(/the answers, the uploaded files, and the SSN and logins/),
    ).toBeVisible();
    await expect(
      dialog.getByText(/created Lena's record, so the record is removed too/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel invitation" }).click();

    await expect(page.getByText("Invitation cancelled. Lena's record was removed.")).toBeVisible();
    await expect(page).toHaveURL(/\/providers\/?$/);
    expect(state.apiCalls).toContain(`POST /api/provider-invites/${PROVIDER_ID}/cancel`);
  });

  test("Cancel of a kept record says it was kept", async ({ context, page }) => {
    const state = await mount(context, { journey: { ...INVITED, created_record: false } });
    state.cancelOutcome = "closed";
    await openRecord(page);

    await card(page).getByRole("button", { name: "Cancel invitation" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel Lena's invitation?" });
    await expect(dialog.getByText("Lena's record stays.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel invitation" }).click();
    await expect(
      page.getByText(
        "Invitation cancelled. Lena's record was kept; what Lena entered was removed.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/providers/${PROVIDER_ID}`));
    await expect(card(page)).toHaveCount(0);
  });

  test("submitted: the Verification block, person checks and Test login", async ({
    context,
    page,
  }) => {
    const state = await mount(context, { journey: SUBMITTED });
    await openRecord(page);

    await expect(
      card(page).getByText("Minted · submitted Oct 16, 2026, ready for review"),
    ).toBeVisible();
    const verification = card(page).getByRole("heading", { name: /Verification/ });
    await expect(verification).toContainText("6 of 10 confirmed · 4 pending");
    await expect(card(page).getByRole("button", { name: "Cancel invitation" })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Resend invitation" })).toHaveCount(0);
    const ncRow = card(page).getByRole("row", { name: /NC license verified/ });
    await expect(ncRow.getByText("Not verified yet")).toBeVisible();
    await expect(ncRow.getByRole("link", { name: "Open Licenses" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/card-submitted.png`, fullPage: true });

    const attestation = card(page).getByRole("row", { name: /CAQH attested within 120 days/ });
    await attestation.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("CAQH attested within 120 days: confirmed")).toBeVisible();
    expect(state.rpcCalls.find((c) => c.name === "record_onboarding_check")?.body).toEqual({
      p_onboarding_id: JOURNEY_ID,
      p_check_key: "caqh_attestation",
      p_outcome: "confirmed",
      p_note: null,
    });
    await expect(verification).toContainText("7 of 10 confirmed · 3 pending");

    await card(page)
      .getByRole("row", { name: /PECOS login works/ })
      .getByRole("button", { name: "Mark problem" })
      .click();
    const problem = page.getByRole("dialog", { name: "Mark a problem" });
    await problem.getByLabel("What's wrong (optional)").fill("Account locked");
    await problem.getByRole("button", { name: "Mark problem" }).click();
    await expect(
      card(page)
        .getByRole("row", { name: /PECOS login works/ })
        .getByText("Account locked"),
    ).toBeVisible();
    await expect(verification).toContainText("7 of 10 confirmed · 1 problem · 2 pending");

    await card(page).getByRole("button", { name: "Test CAQH login" }).click();
    const test = page.getByRole("dialog", { name: "Test the CAQH login" });
    const show = test.getByRole("button", { name: "Show login" });
    await expect(show).toBeDisabled();
    await test.getByLabel("Reason").fill("Testing before Admit");
    await show.click();
    await expect(test.getByText("lena.caqh")).toBeVisible();
    await expect(test.getByText("Pass-Word-1")).toBeVisible();
    expect(state.rpcCalls.find((c) => c.name === "reveal_portal_credential")?.body).toEqual({
      p_provider_id: PROVIDER_ID,
      p_portal: "caqh",
      p_justification: "Testing before Admit",
    });
    await test.getByRole("button", { name: "It works" }).click();
    await expect(test).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Pass-Word-1");
    expect(
      state.rpcCalls.filter((c) => c.name === "record_onboarding_check").at(-1)?.body,
    ).toMatchObject({
      p_check_key: "caqh_login",
      p_outcome: "confirmed",
    });
  });

  test("Admit & assign warns outside her license states, then collapses the card", async ({
    context,
    page,
  }) => {
    const state = await mount(context, { journey: SUBMITTED });
    await openRecord(page);

    await card(page).getByRole("button", { name: "Admit & assign" }).click();
    const dialog = page.getByRole("dialog", { name: "Admit Lena and assign a location" });
    await dialog.getByRole("combobox", { name: "Location" }).click();
    await page.getByRole("option", { name: "Columbia · Columbia, SC" }).click();
    await expect(
      dialog.getByText("This location is in SC. Lena's licenses are in NC."),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Not confirmed yet: CAQH attested within 120 days, NC license verified/),
    ).toBeVisible();
    const admit = dialog.getByRole("button", { name: "Admit & assign" });
    await expect(admit).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/admit-dialog.png` });
    await dialog.getByRole("checkbox", { name: "Assign this location anyway" }).check();
    await expect(admit).toBeEnabled();
    await admit.click();

    await expect(page.getByText("Lena was admitted and assigned to Columbia.")).toBeVisible();
    expect(state.rpcCalls.find((c) => c.name === "admit_provider_onboarding")?.body).toEqual({
      p_onboarding_id: JOURNEY_ID,
      p_facility_id: COLUMBIA,
    });
    await expect(card(page)).toContainText(
      /Admitted \w{3} \d{1,2}, \d{4} by Sowmya Seed · Columbia · Ready for credentialing/,
    );
    await expect(card(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByText("No facility assigned")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/card-collapsed.png` });

    await page.getByRole("tab", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { name: "Readiness" })).toBeVisible();
  });

  test("an in-state location needs no confirmation", async ({ context, page }) => {
    await mount(context, { journey: SUBMITTED });
    await openRecord(page);
    await card(page).getByRole("button", { name: "Admit & assign" }).click();
    const dialog = page.getByRole("dialog", { name: "Admit Lena and assign a location" });
    await dialog.getByRole("combobox", { name: "Location" }).click();
    await page.getByRole("option", { name: "Charlotte · Charlotte, NC" }).click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Admit & assign" })).toBeEnabled();
  });

  test("billing reads the card with no actions", async ({ context, page }) => {
    await mount(context, { role: "billing", journey: SUBMITTED });
    await openRecord(page);
    await expect(card(page).getByRole("heading", { name: /Verification/ })).toBeVisible();
    await expect(card(page).getByRole("button")).toHaveCount(0);
  });

  test("no journey: no card, Readiness shown", async ({ context, page }) => {
    await mount(context, { journey: null });
    await openRecord(page);
    await expect(card(page)).toHaveCount(0);
    await page.getByRole("tab", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { name: "Readiness" })).toBeVisible();
  });
});

test.describe("roster Onboarding toggle and pill (board 6a)", () => {
  test("counts open journeys, pills them, and filters to them", async ({ context, page }) => {
    await mount(context, {
      journey: INVITED,
      tables: {
        providers: [
          providerRow(PROVIDER_ID, "Lena", "Ortiz"),
          providerRow(OTHER_PROVIDER_ID, "Marcus", "Bell", { npi: "1245319599" }),
          providerRow(THIRD_PROVIDER_ID, "Owen", "Park", { npi: "1689051734", status: "active" }),
        ],
        provider_onboardings: [
          {
            id: "j-2",
            provider_id: OTHER_PROVIDER_ID,
            opened_at: "2026-10-20T10:00:00Z",
            submitted_at: null,
          },
        ],
      },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/providers");
    await expect(page.getByRole("link", { name: /Park, Owen/ })).toBeVisible({ timeout: 30000 });

    const toggle = page.getByRole("button", { name: "Onboarding 2" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Onboarding not complete")).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/roster-toggle-off.png` });
    await toggle.click();
    await expect(page.getByRole("button", { name: "Showing onboarding only 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("link", { name: /Park, Owen/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Ortiz, Lena/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Bell, Marcus/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/roster-toggle.png` });

    await page
      .getByRole("row", { name: /Ortiz, Lena/ })
      .getByRole("link", { name: /Onboarding not complete/ })
      .click();
    await expect(page.locator("section#onboarding")).toBeVisible({ timeout: 30000 });
  });
});
