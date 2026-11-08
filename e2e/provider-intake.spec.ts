import { test, expect, type Page, type Route } from "@playwright/test";
import { safeFileName } from "@/lib/documents";
import { NO_INTAKE_ANSWERS } from "@/lib/intakeAnswers";

// Provider onboarding — the PUBLIC intake route (/intake/:token). No Supabase
// session. /api/intake/* is mocked by a small fake server: a live link, a code
// request that always answers sent, a session that opens only for code
// 123456, and her journey (consent, saved draft, version, the SSN's last 4,
// which logins are on file, her uploads, whether she submitted, and each help
// request) kept in the handler, so it outlives the page and a second page
// reads it back the way a fresh sign-in reads the database. The holding
// bucket's signed upload is mocked too, and keeps each file's size. Like the
// vaults, it keeps no full SSN or password.

interface Upload {
  id: string;
  slotKey: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  expiresOn: string | null;
}

const STORAGE = "https://example.supabase.co/storage/v1/object/upload/sign/provider-intake-uploads";

interface SavedDraft {
  answers: Record<string, unknown>;
  step: "form" | "documents";
  version: number;
  updatedAt: string;
}

function intakeApi({ loginDelayMs = 0 } = {}) {
  const practiceName = "Shelby Sports Rehab";
  const email = "anita.rao@example.test";
  const server = {
    signedIn: false,
    consented: false,
    draft: null as SavedDraft | null,
    ssnLast4: null as string | null,
    loginsOnFile: { caqh: false, pecos: false } as Record<string, boolean>,
    consents: [] as Record<string, unknown>[],
    saves: [] as Record<string, unknown>[],
    // Every request body, by route, as the browser sent it.
    sent: [] as { path: string; body: string }[],
    // Set to make the next save lose to "another window".
    otherWindowSaves: null as Record<string, unknown> | null,
    uploads: [] as Upload[],
    // Begun but not finished, by id.
    pending: new Map<string, Upload>(),
    // What reached the bucket: the size of each upload's file, and its type.
    stored: new Map<string, { size: number; type: string }>(),
    // Set to make the next file PUT fail, as a dropped connection would.
    failNextPut: false,
    submitted: false,
    // What the next Submits answer, in order; then each one lands.
    submitReplies: [] as { status: number; error: string; missing?: string[] }[],
    // Runs before a Submit answers, as another window would.
    beforeSubmit: null as (() => void) | null,
    helps: [] as Record<string, unknown>[],
    // How many help requests fail before one lands.
    helpFailures: 0,
    // How many consent signatures fail before one lands.
    consentFailures: 0,
    // The practice's pause switch: every route but signout answers 503.
    paused: false,
    // Her journey ended elsewhere (submitted, admitted or cancelled): a save
    // answers 409 intake_closed.
    closed: false,
  };
  const handler = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() as Record<string, unknown> | null;
    server.sent.push({ path, body: request.postData() ?? "" });
    const json = (status: number, data: unknown, error: string | null = null) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ data, error, meta: null }),
      });
    if (server.paused && !path.endsWith("/signout")) return json(503, null, "intake_paused");
    if (path.endsWith("/link")) {
      return body?.t === "live-token"
        ? json(200, { practiceName, email })
        : json(404, null, "invalid_link");
    }
    if (path.endsWith("/code")) return json(200, { sent: true });
    if (path.endsWith("/signout")) {
      server.signedIn = false;
      return json(200, { signedOut: true });
    }
    if (path.endsWith("/session")) {
      if (body?.code !== "123456") return json(400, null, "code_invalid");
      server.signedIn = true;
      return json(200, { signedIn: true });
    }
    if (!server.signedIn || body?.t !== "live-token") return json(401, null, "signed_out");
    if (path.endsWith("/state")) {
      return json(200, {
        practiceName,
        email,
        record: { ...NO_INTAKE_ANSWERS, firstName: "Anita", lastName: "Rao" },
        lockedFields: [],
        ssnLast4: server.ssnLast4,
        loginsOnFile: server.loginsOnFile,
        consent: { signed: server.consented, textVersion: server.consented ? 1 : null },
        draft: server.draft,
        uploads: server.uploads,
        submitted: server.submitted,
      });
    }
    if (path.endsWith("/submit")) {
      server.beforeSubmit?.();
      server.beforeSubmit = null;
      const reply = server.submitReplies.shift();
      if (reply) {
        return route.fulfill({
          status: reply.status,
          contentType: "application/json",
          body: JSON.stringify({
            data: null,
            error: reply.error,
            meta: reply.missing ? { missing: reply.missing } : null,
          }),
        });
      }
      if (body?.version !== (server.draft?.version ?? 0)) return json(409, null, "draft_conflict");
      server.submitted = true;
      return json(200, { submitted: true });
    }
    if (path.endsWith("/help")) {
      server.helps.push(body ?? {});
      if (server.helpFailures > 0) {
        server.helpFailures -= 1;
        return json(500, null, "Internal server error");
      }
      return json(200, { sent: true });
    }
    if (path.endsWith("/upload-intent")) {
      const id = crypto.randomUUID();
      const fileName = safeFileName(String(body?.fileName));
      server.pending.set(id, {
        id,
        slotKey: String(body?.slotKey),
        kind: String(body?.kind),
        fileName,
        sizeBytes: Number(body?.sizeBytes),
        expiresOn: (body?.expiresOn as string | null) ?? null,
      });
      return json(200, { uploadId: id, uploadUrl: `${STORAGE}/${id}/${fileName}?token=up` });
    }
    if (path.endsWith("/upload-finalize")) {
      const upload = server.pending.get(String(body?.uploadId));
      if (!upload) return json(404, null, "upload_not_found");
      if (server.stored.get(upload.id)?.size !== upload.sizeBytes) {
        return json(422, null, "upload_rejected");
      }
      server.pending.delete(upload.id);
      server.uploads = [...server.uploads.filter((u) => u.slotKey !== upload.slotKey), upload];
      return json(200, { upload });
    }
    if (path.endsWith("/upload-remove")) {
      server.uploads = server.uploads.filter((u) => u.id !== body?.uploadId);
      return json(200, { removed: true });
    }
    if (path.endsWith("/upload-expiry")) {
      server.uploads = server.uploads.map((u) =>
        u.id === body?.uploadId
          ? { ...u, expiresOn: (body?.expiresOn as string | null) ?? null }
          : u,
      );
      return json(200, { expiresOn: body?.expiresOn ?? null });
    }
    if (path.endsWith("/consent")) {
      if (server.consentFailures > 0) {
        server.consentFailures -= 1;
        return json(500, null, "Internal server error");
      }
      server.consents.push(body ?? {});
      server.consented = true;
      return json(200, { signed: true });
    }
    if (path.endsWith("/ssn")) {
      server.ssnLast4 = String(body?.ssn).replace(/\D/g, "").slice(-4);
      return json(200, { ssnLast4: server.ssnLast4 });
    }
    if (path.endsWith("/login")) {
      await new Promise((resolve) => setTimeout(resolve, loginDelayMs));
      server.loginsOnFile[String(body?.portal)] = true;
      return json(200, { portal: body?.portal, onFile: true });
    }
    if (path.endsWith("/draft")) {
      if (server.closed) return json(409, null, "intake_closed");
      const saved = server.draft?.version ?? 0;
      if (server.otherWindowSaves) {
        server.draft = {
          answers: { ...NO_INTAKE_ANSWERS, ...server.otherWindowSaves },
          step: "form",
          version: saved + 1,
          updatedAt: new Date().toISOString(),
        };
        server.otherWindowSaves = null;
        return json(409, null, "draft_conflict");
      }
      if (body?.version !== saved) return json(409, null, "draft_conflict");
      server.saves.push(body ?? {});
      server.draft = {
        answers: body.answers as Record<string, unknown>,
        step: body.step as SavedDraft["step"],
        version: saved + 1,
        updatedAt: new Date().toISOString(),
      };
      return json(200, { version: saved + 1 });
    }
    return json(404, null, "Not found");
  };
  // The signed upload: the browser PUTs the file straight to Storage.
  const storage = async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (server.failNextPut) {
      server.failNextPut = false;
      return route.fulfill({ status: 500, body: "{}" });
    }
    const id = new URL(request.url()).pathname.split("/").at(-2) as string;
    server.stored.set(id, {
      size: request.postDataBuffer()?.length ?? 0,
      type: request.headers()["content-type"] ?? "",
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  };
  return { handler, storage, server };
}

const AT_DOCUMENTS: SavedDraft = {
  answers: {
    ...NO_INTAKE_ANSWERS,
    licenses: [{ state: "NC", number: "PT-48213", expiresOn: "2027-12-31" }],
  },
  step: "documents",
  version: 2,
  updatedAt: "2026-11-06T12:00:00.000Z",
};

function pdf(name: string, bytes = 1200) {
  return { name, mimeType: "application/pdf", buffer: Buffer.alloc(bytes, "%") };
}

function slotRow(page: Page, slotLabel: string) {
  return page.getByRole("listitem").filter({ hasText: new RegExp(`^${slotLabel}`) });
}

async function expectHeld(page: Page, slotLabel: string, text: string) {
  const row = slotRow(page, slotLabel);
  await expect(row.getByRole("button", { name: `Remove ${slotLabel}` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Try uploading ${slotLabel} again` })).toHaveCount(
    0,
  );
  await expect(row).toContainText(text);
}

async function pickFile(page: Page, slotLabel: string, file: ReturnType<typeof pdf>) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: `Upload ${slotLabel}` }).click();
  await (await chooser).setFiles(file);
}

async function signIn(page: Page) {
  await page.goto("/intake/live-token");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");
}

async function consent(page: Page) {
  await page.getByLabel(/Type your full name to sign/).fill("Anita Rao");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();
}

test("a provider signs in with the emailed code, signs consent, and reaches the form", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await page.goto("/intake/live-token");

  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(page.getByText("Shelby Sports Rehab").first()).toBeVisible();
  await expect(page.getByText("anita.rao@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Send me a code" }).click();

  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const code = page.getByLabel("6-digit code");
  await code.fill("999999");
  await expect(page.getByText("That code didn't work")).toContainText("4 tries left");
  await code.fill("123456");

  await expect(page.getByRole("heading", { name: "Your consent" })).toBeVisible();
  await expect(page.getByText("We at Shelby Sports Rehab recognize")).toBeVisible();
  const sign = page.getByRole("button", { name: "Sign and continue" });
  await expect(sign).toBeDisabled();
  await page.getByLabel(/Type your full name to sign/).fill("  Anita Rao ");
  await expect(sign).toBeDisabled();
  await page.getByRole("checkbox").check();
  await sign.click();

  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(page.getByText("Signed in as anita.rao@example.test")).toBeVisible();
  expect(api.server.consents).toEqual([{ t: "live-token", typedName: "Anita Rao", version: 1 }]);
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("her SSN and logins go to the vault in their own requests", async ({ context, page }) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);

  const ssn = page.getByLabel(/^Social Security number/);
  await ssn.click();
  await page.keyboard.type("123456789");
  await page.getByLabel(/^CAQH ID/).click();
  await expect.poll(() => api.server.ssnLast4).toBe("6789");
  await expect(ssn, "the number stays in its field, hidden").toHaveAttribute("type", "password");
  await expect(ssn).toHaveValue("123-45-6789");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(ssn).toHaveAttribute("type", "text");

  await page.locator("#intake-logins-caqh-username").fill("anita.caqh");
  await page.locator("#intake-logins-caqh-password").fill("Caqh-Pass-1");
  await page.getByLabel("Mobile phone").click();
  await expect(page.getByRole("button", { name: "Change your CAQH ProView login" })).toBeVisible();
  await page.getByLabel("Mobile phone").fill("(704) 555-0100");
  await expect(page.getByRole("status")).toHaveText("Saved");

  const routesWith = (secret: string) => [
    ...new Set(api.server.sent.filter((r) => r.body.includes(secret)).map((r) => r.path)),
  ];
  expect(routesWith("123-45-6789")).toEqual(["/api/intake/ssn"]);
  expect(routesWith("123456789")).toEqual([]);
  expect(routesWith("Caqh-Pass-1")).toEqual(["/api/intake/login"]);
  expect(routesWith("anita.caqh")).toEqual(["/api/intake/login"]);
  expect(
    api.server.sent.filter((r) => r.path.endsWith("/ssn")).map((r) => JSON.parse(r.body)),
  ).toEqual([{ t: "live-token", ssn: "123-45-6789" }]);
  expect(api.server.saves.length).toBeGreaterThan(0);
});

test("a login typed last counts when she clicks Continue while it is still saving", async ({
  context,
  page,
}) => {
  const api = intakeApi({ loginDelayMs: 400 });
  api.server.consented = true;
  api.server.ssnLast4 = "6789";
  api.server.loginsOnFile.caqh = true;
  api.server.draft = {
    answers: {
      ...NO_INTAKE_ANSWERS,
      firstName: "Anita",
      lastName: "Rao",
      npi: "1234567893",
      taxonomyCode: "225100000X",
      dateOfBirth: "1990-04-01",
      caqhId: "12345678",
      mobile: "7045550100",
      homeStreet: "18 Elm St",
      homeCity: "Charlotte",
      homeState: "NC",
      homeZip: "28203",
      licenses: [{ state: "NC", number: "PT-48213", expiresOn: "2027-12-31" }],
    },
    step: "form",
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();

  await page.locator("#intake-logins-pecos-username").fill("ARAO77");
  await page.locator("#intake-logins-pecos-password").fill("Pecos-Pass-2");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  await expect(page.getByText(/things? left before you can continue/)).toHaveCount(0);
  expect(api.server.loginsOnFile.pecos).toBe(true);
});

test("her answers are saved as she types", async ({ context, page }) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await page.getByLabel("Mobile phone").fill("(704) 555-0100");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(api.server.saves).toEqual([
    {
      t: "live-token",
      answers: {
        ...NO_INTAKE_ANSWERS,
        mobile: "(704) 555-0100",
        licenses: [{ state: null, number: null, expiresOn: null }],
      },
      step: "form",
      version: 0,
    },
  ]);
});

test("Continue saves her step, so signing in again resumes on her documents", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.consented = true;
  api.server.draft = {
    answers: { ...NO_INTAKE_ANSWERS, mobile: "(704) 555-0100" },
    step: "documents",
    version: 3,
    updatedAt: new Date().toISOString(),
  };
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);

  await page.getByRole("button", { name: "Your details" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  expect(api.server.saves.at(-1)).toMatchObject({ step: "form", version: 3 });
  expect(api.server.draft?.step).toBe("form");
});

test("her documents upload as she picks them, and can be removed or replaced", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.consented = true;
  api.server.draft = AT_DOCUMENTS;
  await context.route("**/api/intake/**", api.handler);
  await context.route(`${STORAGE}/**`, api.storage);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();

  await pickFile(page, "CV", pdf("Anita Rao CV.pdf"));
  await expectHeld(page, "CV", "Anita_Rao_CV.pdf · 1 KB");
  await pickFile(page, "NC license copy", pdf("nc-license.pdf", 2400));
  await expectHeld(page, "NC license copy", "nc-license.pdf · 2 KB");

  const intents = api.server.sent.filter((r) => r.path.endsWith("/upload-intent"));
  expect(JSON.parse(intents[0].body)).toEqual({
    t: "live-token",
    slotKey: "cv",
    kind: "cv",
    fileName: "Anita Rao CV.pdf",
    sizeBytes: 1200,
    contentType: "application/pdf",
    expiresOn: null,
  });
  expect(JSON.parse(intents[1].body)).toMatchObject({
    slotKey: "license:NC",
    kind: "state_license",
  });
  expect([...api.server.stored.values()]).toEqual([
    { size: 1200, type: "application/pdf" },
    { size: 2400, type: "application/pdf" },
  ]);
  expect(
    api.server.sent.every((r) => !r.body.includes("%%%%")),
    "the file goes only to Storage, never through /api/intake",
  ).toBe(true);

  await slotRow(page, "CV").getByRole("button", { name: "Remove CV" }).click();
  await expect(page.getByRole("button", { name: "Upload CV" })).toBeVisible();
  expect(api.server.uploads.map((u) => u.slotKey)).toEqual(["license:NC"]);

  await pickFile(page, "CV", pdf("cv-2026.pdf", 3000));
  await expectHeld(page, "CV", "cv-2026.pdf · 3 KB");
  expect(api.server.uploads.map((u) => [u.slotKey, u.fileName])).toEqual([
    ["license:NC", "nc-license.pdf"],
    ["cv", "cv-2026.pdf"],
  ]);

  await page.getByRole("button", { name: "Finish later" }).click();
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
});

test("what she saved comes back when she signs in again: answers, SSN, logins, files, policy date", async ({
  context,
  page,
}) => {
  // The fake server holds what she saved before; this page starts with nothing.
  const api = intakeApi();
  api.server.consented = true;
  api.server.ssnLast4 = "6789";
  api.server.loginsOnFile = { caqh: true, pecos: false };
  api.server.draft = {
    ...AT_DOCUMENTS,
    answers: { ...AT_DOCUMENTS.answers, mobile: "(704) 555-0100" },
  };
  const upload = (slotKey: string, kind: string, fileName: string, sizeBytes: number): Upload => ({
    id: crypto.randomUUID(),
    slotKey,
    kind,
    fileName,
    sizeBytes,
    expiresOn: null,
  });
  api.server.uploads = [
    upload("cv", "cv", "Anita_Rao_CV.pdf", 1200),
    upload("license:NC", "state_license", "nc-license.pdf", 2400),
    { ...upload("coi", "coi", "policy.pdf", 1200), expiresOn: "2027-06-30" },
  ];
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  await expectHeld(page, "CV", "Anita_Rao_CV.pdf · 1 KB");
  await expectHeld(page, "NC license copy", "nc-license.pdf · 2 KB");
  await expectHeld(page, "Your own liability insurance", "policy.pdf · 1 KB");
  await expect(page.getByLabel(/Policy expires/)).toHaveValue("06/30/2027");

  await page.getByRole("button", { name: "Your details" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(page.getByLabel("Mobile phone")).toHaveValue("(704) 555-0100");
  await expect(page.getByLabel(/^Social Security number/)).toHaveValue("•••-••-6789");
  await expect(page.getByRole("button", { name: "Change your CAQH ProView login" })).toBeVisible();
  await expect(page.locator("#intake-logins-pecos-username")).toBeVisible();
});

// Signed in on her documents with a CV and her NC license copy held.
function readyToSubmit() {
  const api = intakeApi();
  api.server.consented = true;
  api.server.draft = AT_DOCUMENTS;
  const held = (slotKey: string, kind: string, fileName: string): Upload => ({
    id: crypto.randomUUID(),
    slotKey,
    kind,
    fileName,
    sizeBytes: 1200,
    expiresOn: null,
  });
  api.server.uploads = [held("cv", "cv", "cv.pdf"), held("license:NC", "state_license", "nc.pdf")];
  return api;
}

test("Submit sends her form and lands on thank you, and opening the link again stays there", async ({
  context,
  page,
}) => {
  const api = readyToSubmit();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();

  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("heading", { name: "Thank you for submitting!" })).toBeVisible();
  const submits = api.server.sent.filter((r) => r.path.endsWith("/submit"));
  expect(submits.map((r) => JSON.parse(r.body))).toEqual([{ t: "live-token", version: 2 }]);
  await expect(page.getByRole("note")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "You've already sent your form" })).toBeVisible();
});

test("a Submit the server finds incomplete reloads her files and shows what is missing", async ({
  context,
  page,
}) => {
  const api = readyToSubmit();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await expectHeld(page, "CV", "cv.pdf");

  // Another window took her CV back before this Submit arrived.
  api.server.beforeSubmit = () => {
    api.server.uploads = api.server.uploads.filter((u) => u.slotKey !== "cv");
  };
  api.server.submitReplies = [
    { status: 422, error: "intake_incomplete", missing: ["documents.cv"] },
  ];
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("1 thing left before you can submit")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload CV" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
});

test("a form answer the server finds missing opens her form showing what", async ({
  context,
  page,
}) => {
  const api = readyToSubmit();
  api.server.loginsOnFile = { caqh: true, pecos: false };
  api.server.submitReplies = [
    { status: 422, error: "intake_incomplete", missing: ["logins.pecos"] },
  ];
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);

  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "left before you can continue" }),
  ).toContainText("PECOS login");
  expect(api.server.draft?.step).toBe("form");
});

test("an NPI on another provider's record is said in plain words, and nothing is lost", async ({
  context,
  page,
}) => {
  const api = readyToSubmit();
  api.server.submitReplies = [{ status: 409, error: "npi_in_use" }];
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);

  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This NPI is on another provider's record at Shelby Sports Rehab. Check it for a typo under Your details. If it's right, use I need help and Shelby Sports Rehab will sort it out.",
  );
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("heading", { name: "Thank you for submitting!" })).toBeVisible();
});

test("a help request shows sent only once the server has it, and a failed one offers Try again", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.helpFailures = 1;
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);

  await page.getByRole("button", { name: "I need help" }).click();
  await expect(page.getByRole("heading", { name: "We couldn't send your request" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /We've let/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "We've let Shelby Sports Rehab know" }),
  ).toBeVisible();
  expect(api.server.helps).toEqual([
    { t: "live-token", reason: { kind: "help" } },
    { t: "live-token", reason: { kind: "help" } },
  ]);
  await expect(page.getByRole("note")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to your form" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
});

test("an upload that doesn't go through offers Try again, which sends the same file", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.consented = true;
  api.server.draft = AT_DOCUMENTS;
  api.server.failNextPut = true;
  await context.route("**/api/intake/**", api.handler);
  await context.route(`${STORAGE}/**`, api.storage);
  await signIn(page);

  await pickFile(page, "CV", pdf("cv.pdf"));
  const cvRow = slotRow(page, "CV");
  await expect(cvRow.getByRole("alert")).toHaveText(
    "This file didn't upload. Check your connection and try again.",
  );
  expect(api.server.uploads).toEqual([]);

  await cvRow.getByRole("button", { name: "Try uploading CV again" }).click();
  await expectHeld(page, "CV", "cv.pdf · 1 KB");
  await expect(cvRow.getByRole("alert")).toHaveCount(0);
  expect(api.server.uploads.map((u) => u.fileName)).toEqual(["cv.pdf"]);
});

test("her liability policy's expiry date saves with the file", async ({ context, page }) => {
  const api = intakeApi();
  api.server.consented = true;
  api.server.draft = AT_DOCUMENTS;
  await context.route("**/api/intake/**", api.handler);
  await context.route(`${STORAGE}/**`, api.storage);
  await signIn(page);

  await pickFile(page, "Your own liability insurance", pdf("policy.pdf"));
  await expectHeld(page, "Your own liability insurance", "policy.pdf · 1 KB");
  await page.getByLabel(/Policy expires/).fill("06/30/2027");
  await expect.poll(() => api.server.uploads[0]?.expiresOn).toBe("2027-06-30");
});

test("an edit from another window wins, and the form says it loaded the latest answers", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();

  api.server.otherWindowSaves = { mobile: "(704) 555-0188" };
  await page.getByLabel("Mobile phone").fill("(704) 555-0100");
  await expect(page.getByRole("status")).toHaveText(
    "Your form was changed in another window, so we've loaded the latest answers.",
  );
  await expect(page.getByLabel("Mobile phone")).toHaveValue("(704) 555-0188");

  await page.getByLabel("Mobile phone").fill("(704) 555-0199");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(
    api.server.saves.at(-1),
    "the next change saves on top of the version she now holds",
  ).toMatchObject({ version: 1 });
});

test("a journey that ended elsewhere closes her form on its next save, as already sent", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();

  // The practice admitted or cancelled her while she had the form open.
  api.server.closed = true;
  await page.getByLabel("Mobile phone").fill("(704) 555-0100");

  await expect(page.getByRole("heading", { name: "You've already sent your form" })).toBeVisible();
  await expect(
    page.getByText(
      "Shelby Sports Rehab has it. If something has changed, contact Shelby Sports Rehab.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toHaveCount(0);
  expect(api.server.saves).toEqual([]);
});

test("a session that ends under her shows no stale save status when she signs in again on the same page", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();

  // Her session expired on the server before the autosave reached it.
  api.server.signedIn = false;
  await page.getByLabel("Mobile phone").fill("7");
  await expect(
    page.getByRole("heading", { name: "You were signed out to keep your details safe" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("");
});

test("a message from before she signed out does not show after she signs in again", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.consentFailures = 1;
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await expect(page.getByRole("alert")).toHaveText(
    "We couldn't save your signature just now. Please try again.",
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a paused link says the form is paused instead of offering Try again", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  api.server.paused = true;
  await context.route("**/api/intake/**", api.handler);
  await page.goto("/intake/live-token");

  await expect(page.getByRole("heading", { name: "This form is paused for now" })).toBeVisible();
  await expect(page.getByText("Try again later, or contact your practice.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("a pause while her form is open replaces it with the paused notice", async ({
  context,
  page,
}) => {
  const api = intakeApi();
  await context.route("**/api/intake/**", api.handler);
  await signIn(page);
  await consent(page);
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();

  api.server.paused = true;
  await page.getByLabel("City").fill("Memphis");

  await expect(page.getByRole("heading", { name: "This form is paused for now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toHaveCount(0);
});

test("an unknown, expired or revoked link shows one invalid-link screen", async ({
  context,
  page,
}) => {
  await context.route("**/api/intake/**", intakeApi().handler);
  await page.goto("/intake/dead-token");
  await expect(
    page.getByRole("heading", { name: "This invitation is no longer valid" }),
  ).toBeVisible();
});
