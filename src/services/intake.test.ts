// How each /api/intake answer reads back to the form: a typed result for the
// states it acts on, or a thrown error whose message is the server's code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT } from "@/lib/intakeConsent";
import { isIntakePaused } from "@/lib/intakeFlow";
import {
  openIntakeSession,
  readIntakeLink,
  readIntakeState,
  removeIntakeDocument,
  requestIntakeCode,
  requestIntakeHelp,
  saveIntakeDraft,
  saveIntakeLogin,
  saveIntakeSsn,
  setIntakeDocumentExpiry,
  signIntakeConsent,
  signOutIntake,
  submitIntake,
  uploadIntakeDocument,
} from "./intake";

const TOKEN = "live-token";
const UPLOAD_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const ANSWERS = {
  firstName: "Anita",
  lastName: "Rao",
  npi: null,
  taxonomyCode: null,
  dateOfBirth: null,
  caqhId: null,
  mobile: "7045550100",
  homeStreet: null,
  homeCity: null,
  homeState: null,
  homeZip: null,
  licenses: [],
};
const UPLOAD = {
  id: UPLOAD_ID,
  slotKey: "cv",
  kind: "cv",
  fileName: "cv.pdf",
  sizeBytes: 1200,
  expiresOn: null,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function envelope(
  status: number,
  body: { data?: unknown; error?: string | null; meta?: unknown } = {},
): Response {
  return new Response(JSON.stringify({ data: null, error: null, meta: null, ...body }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function answers(status: number, body: { data?: unknown; error?: string; meta?: unknown } = {}) {
  fetchMock.mockResolvedValueOnce(envelope(status, body));
}

/** What the server saw: the action and the JSON body of the request at `index`. */
function sent(index = 0): { action: string; method: string | undefined; body: unknown } {
  const [url, init] = fetchMock.mock.calls[index];
  return {
    action: String(url).replace("/api/intake/", ""),
    method: init?.method,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  };
}

interface Family {
  name: string;
  call: () => Promise<unknown>;
  action: string;
  body: unknown;
  ok: { data: unknown; result: unknown };
}

// Every action that acts on her journey, with the request it sends and what
// its 200 reads as.
const FAMILIES: Family[] = [
  {
    name: "saveIntakeDraft",
    call: () => saveIntakeDraft(TOKEN, ANSWERS, "form", 2),
    action: "draft",
    body: { t: TOKEN, answers: ANSWERS, step: "form", version: 2 },
    ok: { data: { version: 3 }, result: { kind: "saved", version: 3 } },
  },
  {
    name: "signIntakeConsent",
    call: () => signIntakeConsent(TOKEN, "Anita Rao"),
    action: "consent",
    body: { t: TOKEN, typedName: "Anita Rao", version: CONSENT.version },
    ok: { data: { signed: true }, result: { kind: "signed" } },
  },
  {
    name: "saveIntakeSsn",
    call: () => saveIntakeSsn(TOKEN, "123-45-6789"),
    action: "ssn",
    body: { t: TOKEN, ssn: "123-45-6789" },
    ok: { data: { ssnLast4: "6789" }, result: { kind: "stored", ssnLast4: "6789" } },
  },
  {
    name: "saveIntakeLogin",
    call: () => saveIntakeLogin(TOKEN, "caqh", "anita.caqh", "Caqh-Pass-1"),
    action: "login",
    body: { t: TOKEN, portal: "caqh", username: "anita.caqh", password: "Caqh-Pass-1" },
    ok: { data: { portal: "caqh", onFile: true }, result: { kind: "stored" } },
  },
  {
    name: "removeIntakeDocument",
    call: () => removeIntakeDocument(TOKEN, UPLOAD_ID),
    action: "upload-remove",
    body: { t: TOKEN, uploadId: UPLOAD_ID },
    ok: { data: { removed: true }, result: { kind: "removed" } },
  },
  {
    name: "setIntakeDocumentExpiry",
    call: () => setIntakeDocumentExpiry(TOKEN, UPLOAD_ID, "2027-06-30"),
    action: "upload-expiry",
    body: { t: TOKEN, uploadId: UPLOAD_ID, expiresOn: "2027-06-30" },
    ok: { data: { expiresOn: "2027-06-30" }, result: { kind: "saved" } },
  },
  {
    name: "submitIntake",
    call: () => submitIntake(TOKEN, 2),
    action: "submit",
    body: { t: TOKEN, version: 2 },
    ok: { data: { submitted: true }, result: { kind: "submitted" } },
  },
  {
    name: "requestIntakeHelp",
    call: () => requestIntakeHelp(TOKEN, { kind: "help" }),
    action: "help",
    body: { t: TOKEN, reason: { kind: "help" } },
    ok: { data: { sent: true }, result: { kind: "sent" } },
  },
];

it("every journey action posts its body under her link and reads a 200 as done", async () => {
  for (const [index, { name, call, action, body, ok }] of FAMILIES.entries()) {
    answers(200, { data: ok.data });
    await expect(call(), name).resolves.toEqual(ok.result);
    expect(sent(index), name).toEqual({ action, method: "POST", body });
  }
  expect(fetchMock).toHaveBeenCalledTimes(FAMILIES.length);
});

// Every journey action ends in the same answers when it isn't done, so one
// action stands for all of them.
describe("a journey action that isn't done", () => {
  const save = () => saveIntakeDraft(TOKEN, ANSWERS, "form", 2);

  it("reads a 401 as her session having ended", async () => {
    answers(401, { error: "signed_out" });
    await expect(save()).resolves.toEqual({ kind: "session_ended" });
  });

  it("reads a 409 intake_closed as the journey having ended", async () => {
    answers(409, { error: "intake_closed" });
    await expect(save()).resolves.toEqual({ kind: "closed" });
  });

  it("throws the paused code so the page can swap in the paused notice", async () => {
    answers(503, { error: "intake_paused" });
    await expect(save()).rejects.toSatisfy(isIntakePaused);
  });

  it("throws any other failure with the server's code as the message", async () => {
    answers(500, { error: "Internal server error" });
    await expect(save()).rejects.toThrow("Internal server error");
  });
});

describe("the answers only some actions give", () => {
  it("readIntakeLink: the practice and address, an invalid link as null, and the paused code", async () => {
    answers(200, { data: { practiceName: "Shelby", email: "anita.rao@example.test" } });
    await expect(readIntakeLink(TOKEN)).resolves.toEqual({
      practiceName: "Shelby",
      email: "anita.rao@example.test",
    });
    expect(sent()).toEqual({ action: "link", method: "POST", body: { t: TOKEN } });
    answers(404, { error: "invalid_link" });
    await expect(readIntakeLink(TOKEN)).resolves.toBeNull();
    answers(503, { error: "intake_paused" });
    await expect(readIntakeLink(TOKEN)).rejects.toSatisfy(isIntakePaused);
  });

  it("requestIntakeCode: asks under her link, and throws the paused code", async () => {
    answers(200, { data: { sent: true } });
    await expect(requestIntakeCode(TOKEN)).resolves.toBeUndefined();
    expect(sent()).toEqual({ action: "code", method: "POST", body: { t: TOKEN } });
    answers(503, { error: "intake_paused" });
    await expect(requestIntakeCode(TOKEN)).rejects.toSatisfy(isIntakePaused);
  });

  it("openIntakeSession: a 400 is a wrong code, a 200 signed in, and the paused code throws", async () => {
    answers(400, { error: "code_invalid" });
    await expect(openIntakeSession(TOKEN, "999999")).resolves.toBe(false);
    expect(sent()).toEqual({
      action: "session",
      method: "POST",
      body: { t: TOKEN, code: "999999" },
    });
    answers(200, { data: { signedIn: true } });
    await expect(openIntakeSession(TOKEN, "123456")).resolves.toBe(true);
    answers(503, { error: "intake_paused" });
    await expect(openIntakeSession(TOKEN, "123456")).rejects.toSatisfy(isIntakePaused);
  });

  it("readIntakeState: her state, no session as null, and the paused code", async () => {
    const state = { practiceName: "Shelby", submitted: false };
    answers(200, { data: state });
    await expect(readIntakeState(TOKEN)).resolves.toEqual(state);
    expect(sent()).toEqual({ action: "state", method: "POST", body: { t: TOKEN } });
    answers(401, { error: "signed_out" });
    await expect(readIntakeState(TOKEN)).resolves.toBeNull();
    answers(503, { error: "intake_paused" });
    await expect(readIntakeState(TOKEN)).rejects.toSatisfy(isIntakePaused);
  });

  it("saveIntakeDraft: another window saved first", async () => {
    answers(409, { error: "draft_conflict" });
    await expect(saveIntakeDraft(TOKEN, ANSWERS, "form", 2)).resolves.toEqual({ kind: "conflict" });
  });

  it("saveIntakeSsn: an SSN already on file is locked", async () => {
    answers(409, { error: "field_locked" });
    await expect(saveIntakeSsn(TOKEN, "123-45-6789")).resolves.toEqual({ kind: "locked" });
  });

  it("removeIntakeDocument: a file already gone counts as removed", async () => {
    answers(404, { error: "upload_not_found" });
    await expect(removeIntakeDocument(TOKEN, UPLOAD_ID)).resolves.toEqual({ kind: "removed" });
  });

  it("submitIntake: incomplete names what is missing, with or without the list", async () => {
    answers(422, {
      error: "intake_incomplete",
      meta: { missing: ["identity.ssn", "documents.cv"] },
    });
    await expect(submitIntake(TOKEN, 2)).resolves.toEqual({
      kind: "incomplete",
      missing: ["identity.ssn", "documents.cv"],
    });
    answers(422, { error: "intake_incomplete" });
    await expect(submitIntake(TOKEN, 2)).resolves.toEqual({ kind: "incomplete", missing: [] });
  });

  it("submitIntake: an NPI on another record, and a newer draft", async () => {
    answers(409, { error: "npi_in_use" });
    await expect(submitIntake(TOKEN, 2)).resolves.toEqual({ kind: "npi_in_use" });
    answers(409, { error: "draft_conflict" });
    await expect(submitIntake(TOKEN, 2)).resolves.toEqual({ kind: "conflict" });
  });
});

describe("uploadIntakeDocument", () => {
  const file = new File([new Uint8Array(1200).fill(37)], "cv.pdf", { type: "application/pdf" });
  const slot = { key: "cv", kind: "cv" };
  const uploadUrl = "https://storage.test/upload/sign/cv.pdf?token=up";

  it("records the intent, puts the file straight to Storage, then finalizes", async () => {
    answers(200, { data: { uploadId: UPLOAD_ID, uploadUrl } });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    answers(200, { data: { upload: UPLOAD } });

    await expect(uploadIntakeDocument(TOKEN, slot, file)).resolves.toEqual({
      kind: "uploaded",
      upload: UPLOAD,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent(0)).toEqual({
      action: "upload-intent",
      method: "POST",
      body: {
        t: TOKEN,
        slotKey: "cv",
        kind: "cv",
        fileName: "cv.pdf",
        sizeBytes: 1200,
        contentType: "application/pdf",
        expiresOn: null,
      },
    });
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(String(putUrl)).toBe(uploadUrl);
    expect(putInit?.method).toBe("PUT");
    expect(putInit?.body).toBe(file);
    expect(sent(2)).toEqual({
      action: "upload-finalize",
      method: "POST",
      body: { t: TOKEN, uploadId: UPLOAD_ID },
    });
  });

  it("stops at the intent when she is signed out", async () => {
    answers(401, { error: "signed_out" });
    await expect(uploadIntakeDocument(TOKEN, slot, file)).resolves.toEqual({
      kind: "session_ended",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a file Storage refuses never finalizes", async () => {
    answers(200, { data: { uploadId: UPLOAD_ID, uploadUrl } });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(uploadIntakeDocument(TOKEN, slot, file)).rejects.toThrow("Upload failed (500)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("signOutIntake", () => {
  it("posts signout with no link token", async () => {
    answers(200, { data: { signedOut: true } });
    await expect(signOutIntake()).resolves.toBeUndefined();
    expect(sent()).toEqual({ action: "signout", method: "POST", body: {} });
  });
});
