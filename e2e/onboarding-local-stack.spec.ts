import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Provider onboarding end to end against a real LOCAL Supabase stack, in a
// real browser, with no mocks: the staff invite, the emailed link and code,
// consent, the form with autosave, the SSN and logins in their vaults, the
// documents in the holding bucket, Submit, the staff Onboarding card, Admit &
// assign and generation; then Cancel and a help request on two more invites.
// Every step is checked on the screen and in the database.
//
// Run it only through the runner, which starts the servers and sets the env:
//
//   bash scripts/e2e/onboarding-local-stack.sh
//
// Without E2E_LOCAL_STACK=1 every test here is skipped, so CI and the mock
// suite never run it. Each run makes its own org, staff user, group,
// location and payer under a fresh tag, so runs never collide and nothing
// needs cleaning up. Mail goes to scripts/e2e/mail-capture.mjs, which this
// spec reads for the invite link and the sign-in codes.

test.skip(
  process.env.E2E_LOCAL_STACK !== "1",
  "Runs only from scripts/e2e/onboarding-local-stack.sh",
);
test.describe.configure({ mode: "serial" });

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run scripts/e2e/onboarding-local-stack.sh.`);
  return value;
}

const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "test-results/onboarding-local-stack/screens";
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const PRACTICE = `Local Rehab ${RUN}`;
const STAFF = {
  id: randomUUID(),
  email: `staff.${RUN}@example.test`,
  password: `Pw-${randomBytes(12).toString("hex")}`,
};
// The ids come back from the fixture.
const GROUP = { id: "", name: `Local Group ${RUN}` };
const FACILITY = { id: "", name: `Charlotte Clinic ${RUN}`, city: "Charlotte" };
const PAYER = { id: "", name: `Local Payer ${RUN}` };
const OPS = "ops@example.test";
const ANITA = { first: "Anita", last: "Rao", email: `anita.${RUN}@example.test` };
const BEN = { first: "Ben", last: "Cole", email: `ben.${RUN}@example.test` };
const CARA = { first: "Cara", last: "Diaz", email: `cara.${RUN}@example.test` };
// Passes the NPI check digit.
const NPI = "1987654328";
const CAQH = { username: "anita.caqh", password: `Caqh-${randomBytes(6).toString("hex")}` };
const PECOS = { username: "ARAO77", password: `Pecos-${randomBytes(6).toString("hex")}` };

function psql(sql: string): string {
  return execFileSync(
    "psql",
    [env("LOCAL_DB_URL"), "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

function rows<T = Record<string, unknown>>(query: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(q), '[]'::json) from (${query}) q;`)) as T[];
}

function one<T = Record<string, unknown>>(query: string): T {
  const found = rows<T>(query);
  expect(found, query).toHaveLength(1);
  return found[0];
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

// A credential_cases insert the way a signed-in staff member makes one (JWT
// claims set, so the onboarding backstop applies), always rolled back.
function caseInsertAsStaff(providerId: string): string {
  const claims = JSON.stringify({ sub: STAFF.id, role: "authenticated" });
  try {
    psql(`begin;
select set_config('request.jwt.claims', ${lit(claims)}, true) \\g /dev/null
insert into public.credential_cases (org_id, provider_id, group_id, payer_id, state)
  values (${lit(orgId)}, ${lit(providerId)}, ${lit(GROUP.id)}, ${lit(PAYER.id)}, 'NC');
rollback;`);
    return "ok";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

interface Mail {
  messageId: string;
  body: {
    personalizations: { to: { email: string }[] }[];
    from: { email: string; name: string };
    reply_to: { email: string; name?: string };
    subject: string;
    content: { type: string; value: string }[];
    categories: string[];
  };
}

async function mailFor(to: string, template: string): Promise<Mail[]> {
  const response = await fetch(`${env("MAIL_CAPTURE_URL")}/messages`);
  const all = (await response.json()) as Mail[];
  return all.filter(
    (m) => m.body.personalizations[0].to[0].email === to && m.body.categories[0] === template,
  );
}

function textOf(mail: Mail): string {
  return mail.body.content.find((c) => c.type === "text/plain")?.value ?? "";
}

// The `count`th mail of that template to that address, once it has arrived.
async function nthMail(to: string, template: string, count: number): Promise<Mail> {
  await expect.poll(async () => (await mailFor(to, template)).length).toBe(count);
  return (await mailFor(to, template))[count - 1];
}

function inviteLink(mail: Mail): string {
  const link = textOf(mail).match(/https?:\/\/\S+\/intake\/[A-Za-z0-9_-]+/)?.[0];
  expect(link, "the invite email carries the intake link").toBeTruthy();
  return link as string;
}

function signInCode(mail: Mail): string {
  const code = textOf(mail).match(/\b\d{6}\b/)?.[0];
  expect(code, "the code email carries a 6-digit code").toBeTruthy();
  expect(mail.body.subject).not.toContain(code as string);
  return code as string;
}

let orgId = "";

async function createFixture() {
  const response = await fetch(`${env("LOCAL_API_URL")}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env("LOCAL_SERVICE_ROLE_KEY"),
      authorization: `Bearer ${env("LOCAL_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: STAFF.id,
      email: STAFF.email,
      password: STAFF.password,
      email_confirm: true,
      user_metadata: { full_name: "Sam Staff" },
    }),
  });
  expect(response.status, "GoTrue admin created the staff user").toBe(200);

  const vars = {
    practice: PRACTICE,
    staff_id: STAFF.id,
    staff_email: STAFF.email,
    group_name: GROUP.name,
    facility_name: FACILITY.name,
    facility_city: FACILITY.city,
    payer_name: PAYER.name,
  };
  const fixture = JSON.parse(
    execFileSync(
      "psql",
      [
        env("LOCAL_DB_URL"),
        "-X",
        "-q",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        ...Object.entries(vars).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
        "-f",
        "scripts/e2e/onboarding-fixture.sql",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  ) as { org_id: string; group_id: string; facility_id: string; payer_id: string };
  orgId = fixture.org_id;
  GROUP.id = fixture.group_id;
  FACILITY.id = fixture.facility_id;
  PAYER.id = fixture.payer_id;
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    one(`select o.lifecycle_state, m.role from public.organizations o
           join public.memberships m on m.org_id = o.id
          where o.id = ${lit(orgId)} and m.user_id = ${lit(STAFF.id)}`),
  ).toEqual({ lifecycle_state: "active", role: "admin" });
}

const offStack: string[] = [];
const pageErrors: string[] = [];
const serverErrors: string[] = [];
let staffContext: BrowserContext;
let staff: Page;
let shotCount = 0;

async function shot(page: Page, name: string) {
  // Let dialogs and menus finish opening or closing; spinners run forever.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  shotCount += 1;
  await page.screenshot({
    path: join(SHOTS, `${String(shotCount).padStart(2, "0")}-${name}.png`),
    fullPage: true,
  });
}

// Nothing in this run may reach a hosted project or SendGrid.
async function newContext(browser: Browser, width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route(
    /^https?:\/\/[^/]*(supabase\.co|supabase\.in|sendgrid\.com)(:\d+)?\//,
    (r) => {
      offStack.push(new URL(r.request().url()).host);
      return r.abort();
    },
  );
  context.on("weberror", (e) => pageErrors.push(String(e.error())));
  // A 500 is a server fault even when the screen hides it, so none may happen.
  context.on("response", (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return context;
}

const providerContext = (browser: Browser) => newContext(browser, 390, 844);

function pdf(name: string, label: string) {
  const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  return { name, mimeType: "application/pdf", buffer: Buffer.from(body.padEnd(1500, " ")) };
}

function slotRow(page: Page, slotLabel: string) {
  return page.getByRole("listitem").filter({ hasText: new RegExp(`^${slotLabel}`) });
}

async function pickFile(page: Page, slotLabel: string, file: ReturnType<typeof pdf>) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: `Upload ${slotLabel}` }).click();
  await (await chooser).setFiles(file);
  await expect(
    slotRow(page, slotLabel).getByRole("button", { name: `Remove ${slotLabel}` }),
  ).toBeVisible();
}

async function invite(person: { first: string; last: string; email: string }) {
  await staff.goto("/providers");
  await staff.getByRole("button", { name: "Invite provider" }).click();
  const dialog = staff.getByRole("dialog", { name: "Invite a provider" });
  await dialog.getByLabel("First name").fill(person.first);
  await dialog.getByLabel("Last name").fill(person.last);
  await dialog.getByLabel("Email").fill(person.email);
  await dialog.getByRole("combobox", { name: "Group" }).click();
  await staff.getByRole("option", { name: GROUP.name }).click();
  return dialog;
}

async function sendInvite(dialog: ReturnType<Page["getByRole"]>, email: string) {
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(staff.getByText(`Invite sent to ${email}`)).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

function providerIdFor(email: string): string {
  return one<{ id: string }>(
    `select id from public.providers where org_id = ${lit(orgId)} and email = ${lit(email)}`,
  ).id;
}

async function requestCode(page: Page, email: string, count: number): Promise<string> {
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  return signInCode(await nthMail(email, "intake_code", count));
}

async function signConsent(page: Page, typedName: string) {
  await expect(page.getByRole("heading", { name: "Your consent" })).toBeVisible();
  await page.getByLabel(/Type your full name to sign/).fill(typedName);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  await createFixture();
  staffContext = await newContext(browser, 1440, 900);
  staff = await staffContext.newPage();
});

// Checked after each step, so a failure names the step that caused it.
test.afterEach(() => {
  expect(offStack.splice(0), "no request left this machine").toEqual([]);
  expect(pageErrors.splice(0), "no uncaught error on any page").toEqual([]);
  expect(serverErrors.splice(0), "no server error answered any request").toEqual([]);
});

test.afterAll(async () => {
  await staffContext?.close();
});

let anitaId = "";
let anitaJourney = "";
let anitaLink = "";
let provider: Page;

test("1. staff signs in and invites a new provider; the invite email carries her link", async () => {
  await staff.goto("/login");
  await staff.getByLabel("Email").fill(STAFF.email);
  await staff.getByLabel("Password").fill(STAFF.password);
  await staff.getByRole("button", { name: "Sign in" }).click();
  await expect(staff).not.toHaveURL(/\/login/);

  const dialog = await invite(ANITA);
  await shot(staff, "staff-invite-dialog");
  await sendInvite(dialog, ANITA.email);

  anitaId = providerIdFor(ANITA.email);
  const journey = one<{ id: string; created_record: boolean; delivery: string }>(
    `select po.id, po.created_record, i.delivery
       from public.provider_onboardings po
       join public.provider_intake_invites i on i.onboarding_id = po.id and i.revoked_at is null
      where po.provider_id = ${lit(anitaId)}`,
  );
  expect(journey).toMatchObject({ created_record: true, delivery: "sent" });
  anitaJourney = journey.id;

  const mail = await nthMail(ANITA.email, "provider_invitation", 1);
  expect(mail.body.subject).toContain(PRACTICE);
  expect(mail.body.from).toEqual({
    email: "no-reply@example.test",
    name: `${PRACTICE} via Minted Panel`,
  });
  expect(mail.body.reply_to.email).toBe(STAFF.email);
  anitaLink = inviteLink(mail);
  expect(new URL(anitaLink).origin).toBe(env("APP_ORIGIN"));
});

test("2. she signs in with the emailed code, signs consent, and fills the form; it lands in the vaults", async ({
  browser,
}) => {
  const context = await providerContext(browser);
  provider = await context.newPage();
  await provider.goto(anitaLink);
  await expect(provider.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(provider.getByText(ANITA.email)).toBeVisible();
  await shot(provider, "provider-confirm");

  const code = await requestCode(provider, ANITA.email, 1);
  const codeBox = provider.getByLabel("6-digit code");
  await codeBox.fill(code === "000000" ? "111111" : "000000");
  await expect(provider.getByText("That code didn't work")).toContainText("4 tries left");
  await shot(provider, "provider-wrong-code");
  await codeBox.fill(code);
  await expect(provider.getByRole("heading", { name: "Your consent" })).toBeVisible();
  await shot(provider, "provider-consent");
  await signConsent(provider, "Anita Rao");

  await expect(provider.getByLabel("First name")).toHaveValue("Anita");
  await provider.locator("#intake-identity-npi").fill(NPI);
  await provider.getByRole("combobox", { name: "Specialty" }).click();
  await provider.getByLabel("Search specialties").fill("Physical Therapist");
  await provider.getByRole("option").filter({ hasText: "225100000X" }).click();
  await provider.locator("#intake-identity-dateOfBirth").fill("04/01/1990");
  await provider.locator("#intake-identity-caqhId").fill("12345678");
  await provider.locator("#intake-identity-ssn").click();
  await provider.keyboard.type("123456789");
  await provider.getByLabel("Mobile phone").click();
  await expect
    .poll(() => rows(`select ssn_last4 from public.providers where id = ${lit(anitaId)}`), {
      message: "leaving the field sent the SSN to the vault",
    })
    .toEqual([{ ssn_last4: "6789" }]);
  await provider.getByLabel("Mobile phone").fill("(704) 555-0100");
  await provider.getByLabel("Street address").fill("18 Elm St");
  await provider.getByLabel("City").fill("Charlotte");
  await provider.locator("#intake-address-state").selectOption("NC");
  await provider.getByLabel("ZIP code").fill("28203");
  await provider.locator("#intake-licenses-0-state").selectOption("NC");
  await provider.locator("#intake-licenses-0-number").fill("PT-48213");
  await provider.locator("#intake-licenses-0-expiresOn").fill("12/31/2027");
  await provider.locator("#intake-logins-caqh-username").fill(CAQH.username);
  await provider.locator("#intake-logins-caqh-password").fill(CAQH.password);
  await provider.locator("#intake-logins-pecos-username").click();
  await expect(
    provider.getByRole("button", { name: "Change your CAQH ProView login" }),
  ).toBeVisible();
  await provider.locator("#intake-logins-pecos-username").fill(PECOS.username);
  await provider.locator("#intake-logins-pecos-password").fill(PECOS.password);
  await provider.getByLabel("Mobile phone").click();
  await expect(provider.getByRole("button", { name: "Change your PECOS login" })).toBeVisible();
  await expect(provider.getByRole("status")).toHaveText("Saved");
  await shot(provider, "provider-form-filled");

  const journey = one<{ consented: boolean; signed_in: boolean; ssn_stored: boolean }>(
    `select consented_at is not null as consented, first_signed_in_at is not null as signed_in,
            ssn_stored_at is not null as ssn_stored
       from public.provider_onboardings where id = ${lit(anitaJourney)}`,
  );
  expect(journey).toEqual({ consented: true, signed_in: true, ssn_stored: true });
  expect(
    rows(`select typed_name, text_version from public.provider_intake_consents
           where onboarding_id = ${lit(anitaJourney)}`),
  ).toEqual([{ typed_name: "Anita Rao", text_version: 1 }]);

  await expect
    .poll(
      () =>
        rows(`select answers->>'npi' as npi, answers->>'caqhId' as caqh, answers->>'homeZip' as zip
                from public.provider_intake_drafts where onboarding_id = ${lit(anitaJourney)}`),
      { message: "the draft holds her latest answers" },
    )
    .toEqual([{ npi: NPI, caqh: "12345678", zip: "28203" }]);
  const draftText = one<{ answers: string }>(
    `select answers::text as answers from public.provider_intake_drafts
      where onboarding_id = ${lit(anitaJourney)}`,
  ).answers;
  for (const secret of ["123456789", "123-45-6789", CAQH.password, PECOS.password, CAQH.username]) {
    expect(draftText, "no secret in the draft").not.toContain(secret);
  }

  expect(
    one(`select p.ssn_last4,
                position(convert_to('123456789', 'UTF8') in v.ssn_ciphertext) = 0 as sealed
           from public.providers p join public.provider_ssn_vault v on v.provider_id = p.id
          where p.id = ${lit(anitaId)}`),
  ).toEqual({ ssn_last4: "6789", sealed: true });
  expect(
    rows(`select portal, username, onboarding_id::text as journey,
                 position(convert_to(case portal when 'caqh' then ${lit(CAQH.password)}
                                              else ${lit(PECOS.password)} end, 'UTF8')
                          in password_ciphertext) = 0 as sealed
            from public.provider_portal_credentials
           where provider_id = ${lit(anitaId)} order by portal`),
  ).toEqual([
    { portal: "caqh", username: CAQH.username, journey: anitaJourney, sealed: true },
    { portal: "pecos", username: PECOS.username, journey: anitaJourney, sealed: true },
  ]);
});

test("3. Finish later, then a new code: her answers, SSN and logins come back from the server", async () => {
  await provider.getByRole("button", { name: "Finish later" }).click();
  await expect(provider.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await shot(provider, "provider-signed-out");
  const context = provider.context();
  await provider.close();

  // A fresh page holds nothing in memory: only the server has her answers.
  provider = await context.newPage();
  await provider.goto(anitaLink);
  const code = await requestCode(provider, ANITA.email, 2);
  await provider.getByLabel("6-digit code").fill(code);
  await expect(provider.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(provider.locator("#intake-identity-npi")).toHaveValue(NPI);
  await expect(provider.locator("#intake-identity-dateOfBirth")).toHaveValue("04/01/1990");
  await expect(provider.locator("#intake-identity-caqhId")).toHaveValue("12345678");
  await expect(provider.getByLabel("Mobile phone")).toHaveValue("(704) 555-0100");
  await expect(provider.getByLabel("Street address")).toHaveValue("18 Elm St");
  await expect(provider.locator("#intake-licenses-0-number")).toHaveValue("PT-48213");
  await expect(provider.locator("#intake-licenses-0-expiresOn")).toHaveValue("12/31/2027");
  await expect(provider.locator("#intake-identity-ssn")).toHaveValue("•••-••-6789");
  await expect(
    provider.getByRole("button", { name: "Change your CAQH ProView login" }),
  ).toBeVisible();
  await expect(provider.getByRole("button", { name: "Change your PECOS login" })).toBeVisible();
  await shot(provider, "provider-form-restored");
});

test("4. she uploads her documents, takes one back, and submits; it all lands on her record", async () => {
  await provider.getByRole("button", { name: "Continue" }).click();
  await expect(provider.getByRole("heading", { name: "Your documents" })).toBeVisible();

  await pickFile(provider, "CV", pdf("Anita Rao CV.pdf", "first cv"));
  await pickFile(provider, "NC license copy", pdf("nc-license.pdf", "license"));
  await slotRow(provider, "CV").getByRole("button", { name: "Remove CV" }).click();
  await expect(provider.getByRole("button", { name: "Upload CV" })).toBeVisible();
  await pickFile(provider, "CV", pdf("cv-2026.pdf", "second cv"));
  await expect(slotRow(provider, "CV")).toContainText("cv-2026.pdf");
  await shot(provider, "provider-documents");

  const holding = `org/${orgId}/onboarding/${anitaJourney}/`;
  expect(
    rows(`select slot_key, file_name, removed_at is not null as removed
            from public.provider_intake_uploads
           where onboarding_id = ${lit(anitaJourney)} and finalized_at is not null
           order by created_at`),
  ).toEqual([
    { slot_key: "cv", file_name: "Anita_Rao_CV.pdf", removed: true },
    { slot_key: "license:NC", file_name: "nc-license.pdf", removed: false },
    { slot_key: "cv", file_name: "cv-2026.pdf", removed: false },
  ]);
  expect(
    one(`select count(*)::int as held from storage.objects
          where bucket_id = 'provider-intake-uploads' and name like ${lit(`${holding}%`)}`),
  ).toEqual({ held: 2 });

  await provider.getByRole("button", { name: "Submit" }).click();
  await expect(provider.getByRole("heading", { name: "Thank you for submitting!" })).toBeVisible();
  await shot(provider, "provider-thank-you");
  await provider.reload();
  await expect(
    provider.getByRole("heading", { name: "You've already sent your form" }),
  ).toBeVisible();
  await shot(provider, "provider-thank-you-reload");

  expect(
    one(`select first_name, last_name, npi, taxonomy_code, date_of_birth::text as dob, caqh_id,
                regexp_replace(phone, '\\D', '', 'g') as phone, home_street, home_city,
                home_state, home_zip, email, ssn_last4
           from public.providers where id = ${lit(anitaId)}`),
  ).toEqual({
    first_name: "Anita",
    last_name: "Rao",
    npi: NPI,
    taxonomy_code: "225100000X",
    dob: "1990-04-01",
    caqh_id: "12345678",
    phone: "7045550100",
    home_street: "18 Elm St",
    home_city: "Charlotte",
    home_state: "NC",
    home_zip: "28203",
    email: ANITA.email,
    ssn_last4: "6789",
  });
  expect(
    rows(`select state, license_number, expiration_date::text as expires
            from public.state_licenses where provider_id = ${lit(anitaId)}`),
  ).toEqual([{ state: "NC", license_number: "PT-48213", expires: "2027-12-31" }]);

  const documents = rows<{
    doc_type: string;
    file_name: string;
    expires: string | null;
    file_path: string;
  }>(
    `select doc_type, file_name, expiration_date::text as expires, file_path
       from public.provider_documents where provider_id = ${lit(anitaId)} order by doc_type`,
  );
  expect(documents.map(({ file_path: _, ...d }) => d)).toEqual([
    { doc_type: "cv", file_name: "cv-2026.pdf", expires: null },
    { doc_type: "state_license", file_name: "nc-license.pdf", expires: "2027-12-31" },
  ]);
  for (const d of documents) {
    expect(d.file_path.startsWith(`org/${orgId}/provider/${anitaId}/`)).toBe(true);
  }
  expect(
    one(`select count(*)::int as stored from storage.objects
          where bucket_id = 'provider-documents'
            and name in (${documents.map((d) => lit(d.file_path)).join(", ")})`),
  ).toEqual({ stored: 2 });
  expect(
    one(`select count(*)::int as held from storage.objects
          where bucket_id = 'provider-intake-uploads' and name like ${lit(`${holding}%`)}`),
  ).toEqual({ held: 0 });
  expect(
    one(`select submitted_at is not null as submitted, submitted_email_delivery
           from public.provider_onboardings where id = ${lit(anitaJourney)}`),
  ).toEqual({ submitted: true, submitted_email_delivery: "sent" });

  const confirmation = await nthMail(ANITA.email, "intake_submitted", 1);
  expect(textOf(confirmation)).not.toContain(NPI);
  const alerts = await mailFor(OPS, "onboarding_ops_alert");
  expect(alerts.filter((m) => textOf(m).includes(`/providers/${anitaId}`))).toHaveLength(1);
  // The reload above read her state again; nothing was sent twice.
  expect(await mailFor(ANITA.email, "intake_submitted")).toHaveLength(1);
  await provider.context().close();
});

test("5. before Admit, generation holds her with the onboarding reason, and so does the database", async () => {
  await staff.goto("/generation");
  const held = staff.getByRole("listitem").filter({ hasText: "Anita Rao" });
  await expect(held).toContainText(
    `${GROUP.name} · ${PAYER.name} NC — Onboarding not finished. Admit & assign on the provider's page first`,
  );
  await expect(held.getByRole("link", { name: "Open provider" })).toBeVisible();
  await expect(staff.getByRole("checkbox", { name: new RegExp(`^Include Anita Rao`) })).toHaveCount(
    0,
  );
  await shot(staff, "staff-generation-held");
  expect(caseInsertAsStaff(anitaId)).toContain("onboarding_not_admitted");
});

test("6. staff review the submitted card, test a login, and Admit & assign; generation then counts her", async () => {
  await staff.goto(`/providers/${anitaId}`);
  const card = staff.locator("section#onboarding");
  await expect(card.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  await expect(card.getByText("Stage: Submitted")).toBeAttached();
  await expect(card.getByRole("heading", { name: /Verification/ })).toBeVisible();
  await expect(card.getByText("Created by this invitation")).toBeVisible();
  await shot(staff, "staff-onboarding-submitted");

  await card.getByRole("button", { name: "Test CAQH login" }).click();
  const testDialog = staff.getByRole("dialog", { name: "Test the CAQH login" });
  await testDialog.getByLabel("Reason").fill("Checking before Admit");
  await testDialog.getByRole("button", { name: "Show login" }).click();
  await expect(testDialog.getByText(CAQH.username)).toBeVisible();
  await expect(testDialog.getByText(CAQH.password)).toBeVisible();
  await testDialog.getByRole("button", { name: "It works" }).click();
  await expect(testDialog).toHaveCount(0);

  await card.getByRole("button", { name: "Admit & assign" }).click();
  const admit = staff.getByRole("dialog", { name: "Admit Anita and assign a location" });
  await admit.getByRole("combobox", { name: "Location" }).click();
  await staff.getByRole("option", { name: `${FACILITY.name} · ${FACILITY.city}, NC` }).click();
  await shot(staff, "staff-admit-dialog");
  await admit.getByRole("button", { name: "Admit & assign" }).click();
  await expect(
    staff.getByText(`Anita was admitted and assigned to ${FACILITY.name}.`),
  ).toBeVisible();
  await expect(card).toContainText(/Admitted .* by Sam Staff · .* · Ready for credentialing/);
  await expect(card.getByRole("button")).toHaveCount(0);
  await shot(staff, "staff-admitted");

  expect(
    one(`select admitted_at is not null as admitted, admitted_facility_id::text as facility,
                admitted_by::text as by
           from public.provider_onboardings where id = ${lit(anitaJourney)}`),
  ).toEqual({ admitted: true, facility: FACILITY.id, by: STAFF.id });
  expect(
    rows(`select facility_id::text as facility, is_primary from public.provider_facility_assignments
           where provider_id = ${lit(anitaId)}`),
  ).toEqual([{ facility: FACILITY.id, is_primary: true }]);
  expect(
    rows(`select count(*)::int as live from public.provider_intake_invites
           where onboarding_id = ${lit(anitaJourney)} and revoked_at is null`),
  ).toEqual([{ live: 0 }]);
  expect(
    rows(`select check_key, outcome from public.provider_onboarding_checks
           where onboarding_id = ${lit(anitaJourney)}`),
  ).toEqual([{ check_key: "caqh_login", outcome: "confirmed" }]);

  expect(caseInsertAsStaff(anitaId)).toBe("ok");

  await staff.goto("/generation");
  await expect(
    staff.getByRole("checkbox", { name: `Include Anita Rao — ${PAYER.name} NC` }),
  ).toBeChecked();
  await expect(
    staff.getByRole("listitem").filter({ hasText: "Onboarding not finished" }),
  ).toHaveCount(0);
  await shot(staff, "staff-generation-candidate");
  await staff.getByRole("button", { name: "Confirm & create 1 case" }).click();
  await staff.waitForURL(/\/cases\?.*run=/);
  expect(
    rows(`select group_id::text as "group", payer_id::text as payer, state
            from public.credential_cases where provider_id = ${lit(anitaId)}`),
  ).toEqual([{ group: GROUP.id, payer: PAYER.id, state: "NC" }]);

  await staff.goto(`/providers/${anitaId}`);
  await expect(card).toContainText("In credentialing");
});

test("7. Cancel on a second invite removes the record, and her link goes dead", async ({
  browser,
}) => {
  await sendInvite(await invite(BEN), BEN.email);
  const benId = providerIdFor(BEN.email);
  const link = inviteLink(await nthMail(BEN.email, "provider_invitation", 1));

  await staff.goto(`/providers/${benId}`);
  const card = staff.locator("section#onboarding");
  await expect(card.getByText("Stage: Invited")).toBeAttached();
  await card.getByRole("button", { name: "Cancel invitation" }).click();
  const dialog = staff.getByRole("dialog", { name: "Cancel Ben's invitation?" });
  await expect(
    dialog.getByText(/created Ben's record, so the record is removed too/),
  ).toBeVisible();
  await shot(staff, "staff-cancel-dialog");
  await dialog.getByRole("button", { name: "Cancel invitation" }).click();
  await expect(staff.getByText("Invitation cancelled. Ben's record was removed.")).toBeVisible();
  await expect(staff).toHaveURL(/\/providers$/);

  expect(rows(`select id from public.providers where id = ${lit(benId)}`)).toEqual([]);
  expect(
    rows(`select id from public.provider_onboardings where provider_id = ${lit(benId)}`),
  ).toEqual([]);
  await staff.goto(`/providers/${benId}`);
  await expect(staff.getByText("Provider not found.")).toBeVisible();

  const context = await providerContext(browser);
  const page = await context.newPage();
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "This invitation is no longer valid" }),
  ).toBeVisible();
  await shot(page, "provider-invalid-link");
  await context.close();
});

test("8. I need help on a third invite writes a provider note staff can read, and alerts ops", async ({
  browser,
}) => {
  await sendInvite(await invite(CARA), CARA.email);
  const caraId = providerIdFor(CARA.email);
  const link = inviteLink(await nthMail(CARA.email, "provider_invitation", 1));

  const context = await providerContext(browser);
  const page = await context.newPage();
  await page.goto(link);
  const code = await requestCode(page, CARA.email, 1);
  await page.getByLabel("6-digit code").fill(code);
  await signConsent(page, "Cara Diaz");
  await page.getByRole("button", { name: "I need help" }).click();
  await expect(page.getByRole("heading", { name: `We've let ${PRACTICE} know` })).toBeVisible();
  await shot(page, "provider-help-sent");
  await context.close();

  const note = one<{ content: string; author: string | null }>(
    `select content, author_id::text as author from public.notes
      where entity_type = 'provider' and entity_id = ${lit(caraId)}`,
  );
  expect(note.author).toBeNull();
  expect(
    one(`select last_help_at is not null as asked from public.provider_onboardings
          where provider_id = ${lit(caraId)}`),
  ).toEqual({ asked: true });
  await expect
    .poll(
      async () =>
        (await mailFor(OPS, "onboarding_ops_alert")).filter((m) =>
          textOf(m).includes(`/providers/${caraId}`),
        ).length,
    )
    .toBe(1);

  await staff.goto(`/providers/${caraId}#notes`);
  await expect(staff.getByText(note.content)).toBeVisible();
  await expect(staff.getByText("Provider (onboarding form)")).toBeVisible();
  await shot(staff, "staff-help-note");
});
