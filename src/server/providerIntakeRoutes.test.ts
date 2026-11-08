import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageApiError } from "@supabase/supabase-js";
import { EmailError } from "./email/sendgrid";
import { INTAKE_COOKIE, hashCode, hashToken } from "./intakeTokens";
import { CONSENT } from "@/lib/intakeConsent";
import { NO_INTAKE_ANSWERS } from "@/lib/intakeAnswers";
import { INTAKE_ACTION_NAMES, handleIntakeRequest } from "./providerIntakeRoutes";
import {
  CONFIG,
  PAUSED,
  PROVIDER,
  body,
  fakeDb,
  makeDeps,
  rpcArgs,
  rpcNames,
} from "./providerIntakeRoutes.testkit";

const CODE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

type StoredObject = { size?: number; mimetype?: string };

// What local Storage answers for a copy onto an object that is already
// there: a StorageApiError with status 400 and statusCode "409".
const LOCAL_ALREADY_THERE = new StorageApiError("The resource already exists", 400, "409");
// What Storage answers for a copy whose source object is gone.
const MISSING_SOURCE = { statusCode: "404", message: "Object not found" };

// The holding bucket, keyed by object path, and the vault the copies land in.
// Deletes take effect, so a test reads back what is left.
function fakeStorage(
  objects: Record<string, StoredObject> = {},
  alreadyThere: unknown = LOCAL_ALREADY_THERE,
) {
  const vault: Record<string, StoredObject> = {};
  const vaultBucket = {
    remove: vi.fn(async (paths: string[]) => {
      for (const path of paths) delete vault[path];
      return { data: [], error: null as unknown };
    }),
  };
  const bucket = {
    createSignedUploadUrl: vi.fn(async (path: string) => ({
      data: { signedUrl: `https://storage.test/upload/sign/${path}?token=up`, token: "up", path },
      error: null as unknown,
    })),
    list: vi.fn(async (prefix: string, options?: { search?: string }) => ({
      data: Object.entries(objects)
        .filter(([path]) => path.startsWith(`${prefix}/`))
        .map(([path, metadata]) => ({ name: path.slice(prefix.length + 1), metadata }))
        .filter((o) => !options?.search || o.name.startsWith(options.search)),
      error: null as unknown,
    })),
    remove: vi.fn(async (paths: string[]) => {
      for (const path of paths) delete objects[path];
      return { data: [], error: null as unknown };
    }),
    // Into the vault, as Storage answers: a missing source is a 404, a
    // destination that is already there `alreadyThere`.
    copy: vi.fn(async (from: string, to: string, _options?: { destinationBucket?: string }) => {
      if (!objects[from]) return { data: null, error: MISSING_SOURCE as unknown };
      if (vault[to]) return { data: null, error: alreadyThere };
      vault[to] = objects[from];
      return { data: { path: to }, error: null as unknown };
    }),
  };
  const from = vi.fn((name: string) => (name === "provider-documents" ? vaultBucket : bucket));
  return { storage: { from }, bucket, vaultBucket, objects, vault };
}

// provider_documents as the submit route reads it: the ids that have a row.
function documentsTable(ids: string[] = []) {
  return {
    from: vi.fn((_table: string) => ({
      select: () => ({
        eq: () => ({
          in: async (_column: string, asked: string[]) => ({
            data: asked.filter((id) => ids.includes(id)).map((id) => ({ id })),
            error: null as unknown,
          }),
        }),
      }),
    })),
  };
}

function withStorage(db: ReturnType<typeof fakeDb>, storage: ReturnType<typeof fakeStorage>) {
  return Object.assign(db, { storage: storage.storage });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function intake(path: string, init: { json?: unknown; headers?: Record<string, string> } = {}) {
  const { json, headers = {} } = init;
  const request = new Request(`https://x.test/api/intake/${path}`, {
    method: json === undefined ? "GET" : "POST",
    headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { request, readBody: async () => json };
}

async function call(
  path: string,
  db: ReturnType<typeof fakeDb>,
  init: { json?: unknown; headers?: Record<string, string> } = {},
  deps = makeDeps().deps,
) {
  const { request, readBody } = intake(path, init);
  return handleIntakeRequest(request, readBody, deps, db as never);
}

const SIGNED_IN = { cookie: `${INTAKE_COOKIE}=sess` };

// What ran after the pause check: [] for a request refused before anything was
// read or stored.
function rpcsAfterPause(db: ReturnType<typeof fakeDb>): string[] {
  return rpcNames(db).filter((name) => name !== "intake_link_paused");
}

const STATE_ROW = {
  practice_name: "Shelby",
  email: "a@b.test",
  record: {
    ...NO_INTAKE_ANSWERS,
    firstName: "Anita",
    npi: "1730195835",
    licenses: [{ state: "NC", number: "PT-1", expiresOn: "2027-12-31" }],
  },
  locked_fields: ["npi", "date_of_birth"],
  ssn_last4: "6789",
  logins_on_file: { caqh: true, pecos: false },
  consented: true,
  consent_text_version: 1,
  // Stored with the locked keys already dropped.
  draft: {
    answers: { mobile: "7045550100", licenses: [] },
    step: "documents",
    version: 4,
    updated_at: "2026-11-05T12:00:00+00:00",
  },
  uploads: [
    {
      id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      slot_key: "coi",
      doc_type: "coi",
      file_name: "policy.pdf",
      size_bytes: 52000,
      expires_on: "2027-06-30",
    },
  ],
  submitted: false,
};

const DRAFT = { t: "tok", answers: { mobile: "7045550100" }, step: "form", version: 0 };
// A number the SSA could issue, as the form sends it.
const SSN = "123-45-6789";
const LOGIN = { t: "tok", portal: "caqh", username: " anita.caqh ", password: " Pass word 1 " };
const UPLOAD_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const UPLOAD_PATH = `org/org-1/onboarding/journey-1/${UPLOAD_ID}/Anita_Rao_CV.pdf`;
const OLD_PATH = "org/org-1/onboarding/journey-1/old/cv.pdf";
const UPLOAD = {
  t: "tok",
  slotKey: "cv",
  kind: "cv",
  fileName: "Anita Rao CV.pdf",
  sizeBytes: 52000,
  contentType: "application/pdf",
};
const FOUND = {
  result: "found",
  upload: {
    id: UPLOAD_ID,
    slot_key: "cv",
    doc_type: "cv",
    file_name: "Anita_Rao_CV.pdf",
    size_bytes: 52000,
    expires_on: null,
  },
  object_path: UPLOAD_PATH,
  content_type: "application/pdf",
  finalized: false,
};

const ORG = "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d";
const JOURNEY_ID = "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b";
const CV_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const LICENSE_ID = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
const HELD_CV = `org/${ORG}/onboarding/${JOURNEY_ID}/${CV_ID}/cv.pdf`;
const HELD_LICENSE = `org/${ORG}/onboarding/${JOURNEY_ID}/${LICENSE_ID}/nc.pdf`;
const REPLACED_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const HELD_REPLACED = `org/${ORG}/onboarding/${JOURNEY_ID}/${REPLACED_ID}/old.pdf`;
const VAULT_CV = `org/${ORG}/provider/${PROVIDER}/${CV_ID}/1/cv.pdf`;
const VAULT_LICENSE = `org/${ORG}/provider/${PROVIDER}/${LICENSE_ID}/1/nc.pdf`;
const VAULT_REPLACED = `org/${ORG}/provider/${PROVIDER}/${REPLACED_ID}/1/old.pdf`;
const HELD: Record<string, StoredObject> = {
  [HELD_CV]: { size: 100, mimetype: "application/pdf" },
  [HELD_LICENSE]: { size: 100, mimetype: "application/pdf" },
};
// Everything Submit needs: her record and the vaults cover every field, and
// a CV and her NC license copy are held.
const READY_ROW = {
  ...STATE_ROW,
  org_id: ORG,
  provider_id: PROVIDER,
  record: {
    firstName: "Anita",
    lastName: "Rao",
    npi: "1730195835",
    taxonomyCode: "225100000X",
    dateOfBirth: "1990-04-02",
    caqhId: "12345678",
    mobile: "7045550100",
    homeStreet: "1 Main St",
    homeCity: "Charlotte",
    homeState: "NC",
    homeZip: "28202",
    licenses: [{ state: "NC", number: "PT-1", expiresOn: "2027-12-31" }],
  },
  locked_fields: [],
  logins_on_file: { caqh: true, pecos: true },
  draft: {
    answers: { mobile: "7045550111", licenses: [{ state: "NC" }] },
    step: "documents",
    version: 4,
    updated_at: "2026-11-06T12:00:00+00:00",
  },
  uploads: [
    {
      id: CV_ID,
      slot_key: "cv",
      doc_type: "cv",
      file_name: "cv.pdf",
      size_bytes: 100,
      expires_on: null,
    },
    {
      id: LICENSE_ID,
      slot_key: "license:NC",
      doc_type: "state_license",
      file_name: "nc.pdf",
      size_bytes: 100,
      expires_on: null,
    },
  ],
  held_object_paths: [HELD_CV, HELD_LICENSE, HELD_REPLACED],
};
const SUBMITTED = {
  result: "submitted",
  onboarding_id: JOURNEY_ID,
  provider_id: PROVIDER,
  practice_name: "Shelby",
  first_name: "Anita",
  email: "anita.rao@example.test",
};
const SUBMIT = { t: "tok", version: 4 };

// `submit` answers submit_provider_intake (an Error is thrown, as a lost
// connection is); `documentIds` are the upload ids that have a
// provider_documents row.
function submitDb(
  storage: ReturnType<typeof fakeStorage>,
  submit: unknown = SUBMITTED,
  documentIds: string[] = [],
) {
  const db = fakeDb(null, {
    read_intake_state: { data: READY_ROW, error: null },
    submit_provider_intake: submit instanceof Error ? submit : { data: submit, error: null },
  });
  return withStorage(Object.assign(db, documentsTable(documentIds)), storage);
}

describe("/api/intake/*", () => {
  it("refuses a POST that isn't application/json", async () => {
    const db = fakeDb();
    const { request } = intake("code", {
      json: { t: "x" },
      headers: { "content-type": "text/plain" },
    });
    const res = await handleIntakeRequest(
      request,
      async () => ({ t: "x" }),
      makeDeps().deps,
      db as never,
    );
    expect(res.status).toBe(415);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("link: a live token returns the practice and invited email; anything else one 404", async () => {
    const live = await call("link", fakeDb({ practice_name: "Shelby", email: "a@b.test" }), {
      json: { t: "tok" },
    });
    expect((await body(live)).data).toEqual({ practiceName: "Shelby", email: "a@b.test" });
    expect(live.headers.get("cache-control")).toContain("no-store");

    const dead = await call("link", fakeDb(null), { json: { t: "tok" } });
    const missing = await call("link", fakeDb(null), { json: {} });
    expect(dead.status).toBe(404);
    expect(await dead.text()).toBe(await missing.text());
  });

  it("code: always answers sent, and emails the code only when the database says so", async () => {
    const { deps, send } = makeDeps();
    const db = fakeDb({ send: true, code_id: CODE_ID, email: "a@b.test", practice_name: "Shelby" });
    const res = await call("code", db, { json: { t: "tok" } }, deps);
    expect((await body(res)).data).toEqual({ sent: true });

    const args = rpcArgs(db, "issue_intake_code");
    const code = send.mock.calls[0][0].data.code;
    expect(code).toMatch(/^\d{6}$/);
    expect(args).toEqual({
      p_token_hash: hashToken("tok"),
      p_code_hash: hashCode(hashToken("tok"), code),
    });

    const quiet = makeDeps();
    const refused = await call("code", fakeDb({ send: false }), { json: { t: "tok" } }, quiet.deps);
    expect(await refused.text()).toBe(
      await (await call("code", db, { json: { t: "tok" } })).text(),
    );
    expect(quiet.send).not.toHaveBeenCalled();
  });

  it("code: records what happened to the code email on the code, and a failed record still answers sent", async () => {
    for (const delivery of ["sent", "sandbox", "failed"] as const) {
      const send =
        delivery === "failed"
          ? vi.fn().mockRejectedValue(new EmailError("provider_rejected", "x", 400))
          : vi.fn().mockResolvedValue({ status: 202, sandbox: delivery === "sandbox" });
      const db = fakeDb({ send: true, code_id: CODE_ID, email: "a@b.test", practice_name: "S" });
      const res = await call("code", db, { json: { t: "tok" } }, makeDeps({ send }).deps);
      expect((await body(res)).data).toEqual({ sent: true });
      expect(rpcArgs(db, "record_intake_email_delivery")).toEqual({
        p_kind: "code",
        p_id: CODE_ID,
        p_delivery: delivery,
      });
    }

    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = fakeDb(
      { send: true, code_id: CODE_ID, email: "a@b.test", practice_name: "S" },
      {
        record_intake_email_delivery: { data: null, error: { code: "42501", message: "a@b.test" } },
      },
    );
    const res = await call("code", broken, { json: { t: "tok" } });
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ sent: true });
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0].map(String).join(" ")).not.toContain("a@b.test");
  });

  it("answers every action but signout with one 503 intake_paused while paused, before anything else", async () => {
    const texts = new Set<string>();
    for (const action of INTAKE_ACTION_NAMES.filter((name) => name !== "signout")) {
      const { deps, send } = makeDeps();
      const db = fakeDb({ send: true, code_id: CODE_ID, email: "a@b.test" }, PAUSED);
      const res = await call(
        action,
        db,
        { json: { t: "tok", code: "012345" }, headers: { cookie: `${INTAKE_COOKIE}=sess` } },
        deps,
      );
      expect(res.status).toBe(503);
      expect((await body(res.clone())).error).toBe("intake_paused");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
      expect(send).not.toHaveBeenCalled();
      texts.add(await res.text());
    }
    expect(texts.size).toBe(1);
  });

  it("link, code and session: an offboarded org's link is paused before a code is issued or emailed", async () => {
    const frozen = hashToken("frozen-link");
    function frozenDb() {
      const db = fakeDb({
        send: true,
        code_id: CODE_ID,
        email: "a@b.test",
        practice_name: "Shelby",
      });
      const answer = db.rpc.getMockImplementation();
      db.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) =>
        name === "intake_link_paused"
          ? { data: args?.p_token_hash === frozen, error: null }
          : (answer as NonNullable<typeof answer>)(name, args),
      );
      return db;
    }
    for (const action of ["link", "code", "session"]) {
      const { deps, send } = makeDeps();
      const db = frozenDb();
      const res = await call(action, db, { json: { t: "frozen-link", code: "012345" } }, deps);
      expect(res.status, action).toBe(503);
      expect((await body(res)).error).toBe("intake_paused");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
      expect(send).not.toHaveBeenCalled();
    }
    // Another org's live link is not held up by it.
    const { deps, send } = makeDeps();
    const live = await call("code", frozenDb(), { json: { t: "live-link" } }, deps);
    expect(live.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it("code: a missing email env is a 500 before any database call, never a quiet sent", async () => {
    const db = fakeDb({ send: true, email: "a@b.test", practice_name: "Shelby" });
    const unconfigured = makeDeps({ config: { ...CONFIG, emailReady: false, fromEmail: null } });
    const res = await call("code", db, { json: { t: "tok" } }, unconfigured.deps);
    expect(res.status).toBe(500);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(unconfigured.send).not.toHaveBeenCalled();

    // The code email needs no link origin, so APP_BASE_URL alone doesn't block it.
    const noBaseUrl = makeDeps({ config: { ...CONFIG, appBaseUrl: null } });
    const sent = await call("code", db, { json: { t: "tok" } }, noBaseUrl.deps);
    expect(sent.status).toBe(200);
    expect(noBaseUrl.send).toHaveBeenCalledOnce();
  });

  it("session: a right code sets the HttpOnly cookie; a wrong one gets one generic 400", async () => {
    const good = await call("session", fakeDb("ok"), { json: { t: "tok", code: "012345" } });
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(
      new RegExp(`^${INTAKE_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict`),
    );
    expect(await good.text()).not.toContain(cookie.split(";")[0].split("=")[1]);

    const bad = await call("session", fakeDb("invalid"), { json: { t: "tok", code: "999999" } });
    const malformed = await call("session", fakeDb(), { json: { t: "tok", code: "12ab" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe(await malformed.text());
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("state: needs the cookie and the link, and reads only under this link", async () => {
    expect((await call("state", fakeDb(), { json: { t: "tok" } })).status).toBe(401);
    const noLink = await call("state", fakeDb(), { json: {}, headers: SIGNED_IN });
    expect(noLink.status).toBe(401);

    const db = fakeDb(STATE_ROW);
    const res = await call("state", db, { json: { t: "tok" }, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(db.rpc).toHaveBeenCalledWith("read_intake_state", {
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
    });
    expect((await body(res)).data).toEqual({
      practiceName: "Shelby",
      email: "a@b.test",
      record: STATE_ROW.record,
      lockedFields: ["npi", "dateOfBirth"],
      ssnLast4: "6789",
      loginsOnFile: { caqh: true, pecos: false },
      consent: { signed: true, textVersion: 1 },
      draft: {
        answers: { ...NO_INTAKE_ANSWERS, mobile: "7045550100" },
        step: "documents",
        version: 4,
        updatedAt: "2026-11-05T12:00:00+00:00",
      },
      uploads: [
        {
          id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
          slotKey: "coi",
          kind: "coi",
          fileName: "policy.pdf",
          sizeBytes: 52000,
          expiresOn: "2027-06-30",
        },
      ],
      submitted: false,
    });

    // A session from another invite, an expired one or a revoked one: one 401.
    const otherLink = await call("state", fakeDb(null), {
      json: { t: "someone-elses-link" },
      headers: SIGNED_IN,
    });
    expect(otherLink.status).toBe(401);
    expect((await body(otherLink)).error).toBe("signed_out");
  });

  it("state: no draft yet reads as a null draft", async () => {
    const res = await call("state", fakeDb({ ...STATE_ROW, draft: null }), {
      json: { t: "tok" },
      headers: SIGNED_IN,
    });
    expect((await body(res)).data?.draft).toBeNull();
  });

  it("state: never answers an internal field: no org or provider id, path, hash, username or password", async () => {
    const leaky = {
      ...READY_ROW,
      session_hash: hashToken("sess"),
      token_hash: hashToken("tok"),
      logins_on_file: { caqh: true, pecos: false, username: "anita.caqh", password: "Pass-1" },
      uploads: READY_ROW.uploads.map((u) => ({
        ...u,
        object_path: HELD_CV,
        onboarding_id: JOURNEY_ID,
      })),
    };
    const res = await call("state", fakeDb(leaky), { json: { t: "tok" }, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const internal of [
      "org_id",
      "provider_id",
      "onboarding_id",
      "held_object_paths",
      "object_path",
      "_hash",
      "username",
      "password",
      ORG,
      PROVIDER,
      JOURNEY_ID,
      "org/",
      hashToken("sess"),
      hashToken("tok"),
      "anita.caqh",
      "Pass-1",
    ]) {
      expect(text, internal).not.toContain(internal);
    }
  });

  it("every session action answers no cookie or a dead session signed_out and an ended journey intake_closed, storing and sending nothing", async () => {
    const accepted: Record<string, Record<string, unknown>> = {
      draft: DRAFT,
      consent: { t: "tok", typedName: "Anita Rao", version: CONSENT.version },
      ssn: { t: "tok", ssn: SSN },
      login: LOGIN,
      "upload-intent": UPLOAD,
      "upload-finalize": { t: "tok", uploadId: UPLOAD_ID },
      "upload-remove": { t: "tok", uploadId: UPLOAD_ID },
      "upload-expiry": { t: "tok", uploadId: UPLOAD_ID, expiresOn: null },
      submit: SUBMIT,
      help: { t: "tok", reason: { kind: "help" } },
    };
    const sessionless = ["link", "code", "session", "state", "signout"];
    expect(Object.keys(accepted).sort()).toEqual(
      INTAKE_ACTION_NAMES.filter((name) => !sessionless.includes(name)).sort(),
    );
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const answers = [
      ["no cookie", null, {}, 401, "signed_out", 0],
      ["dead session", null, SIGNED_IN, 401, "signed_out", 1],
      ["closed", { result: "closed" }, SIGNED_IN, 409, "intake_closed", 1],
    ] as const;
    for (const [action, json] of Object.entries(accepted)) {
      for (const [when, reply, headers, status, error, ran] of answers) {
        // read_intake_state answers an ended journey with no row, so Submit's
        // intake_closed comes from submit_provider_intake (the take-back test).
        if (action === "submit" && when === "closed") continue;
        const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000 }, ...HELD });
        const db = withStorage(fakeDb(reply), storage);
        const res = await call(action, db, { json, headers }, deps);
        expect(res.status, `${action}, ${when}`).toBe(status);
        expect((await body(res)).error, `${action}, ${when}`).toBe(error);
        expect(rpcsAfterPause(db), `${action}, ${when}`).toHaveLength(ran);
        expect(storage.storage.from, `${action}, ${when}`).not.toHaveBeenCalled();
      }
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("draft: saves her parsed answers under this link with the version she read", async () => {
    const db = fakeDb({ result: "saved", version: 5 });
    const res = await call("draft", db, {
      json: {
        t: "tok",
        answers: { mobile: " 7045550100 ", ssn: "123456789", orgId: "x" },
        step: "documents",
        version: 4,
      },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({ version: 5 });
    expect(rpcArgs(db, "save_intake_draft")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_answers: { ...NO_INTAKE_ANSWERS, mobile: "7045550100" },
      p_step: "documents",
      p_expected_version: 4,
    });
  });

  it("draft: a stale version is a 409 draft_conflict", async () => {
    const res = await call("draft", fakeDb({ result: "conflict", version: 7 }), {
      json: DRAFT,
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("draft_conflict");
  });

  it("draft: refuses a body that isn't a draft before saving anything", async () => {
    for (const json of [
      { ...DRAFT, answers: { firstName: 42 } },
      { ...DRAFT, answers: "x" },
      { ...DRAFT, step: "review" },
      { ...DRAFT, version: -1 },
      { ...DRAFT, version: 1.5 },
      { ...DRAFT, version: "1" },
    ]) {
      const db = fakeDb({ result: "saved", version: 1 });
      const res = await call("draft", db, { json, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(json)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
    }
    // A body over the bound reaches the handler as null (api.ts's reader).
    const db = fakeDb({ result: "saved", version: 1 });
    const oversize = await handleIntakeRequest(
      intake("draft", { json: DRAFT, headers: SIGNED_IN }).request,
      async () => null,
      makeDeps().deps,
      db as never,
    );
    expect(oversize.status).toBe(400);
    expect(rpcsAfterPause(db)).toEqual([]);
  });

  it("consent: signs with her trimmed name and the current text version", async () => {
    const db = fakeDb({ result: "signed" });
    const res = await call("consent", db, {
      json: { t: "tok", typedName: "  Anita Rao ", version: CONSENT.version },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({ signed: true });
    expect(rpcArgs(db, "sign_intake_consent")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_typed_name: "Anita Rao",
      p_text_version: CONSENT.version,
    });
  });

  it("consent: refuses another text version and a blank or overlong name before signing", async () => {
    for (const json of [
      { t: "tok", typedName: "Anita Rao", version: CONSENT.version + 1 },
      { t: "tok", typedName: "Anita Rao" },
      { t: "tok", typedName: "   ", version: CONSENT.version },
      { t: "tok", typedName: "x".repeat(201), version: CONSENT.version },
    ]) {
      const db = fakeDb({ result: "signed" });
      const res = await call("consent", db, { json, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
    }
  });

  it("ssn: stores the 9 digits under this link and answers only the last 4", async () => {
    const db = fakeDb({ result: "stored", ssn_last4: "6789" });
    const res = await call("ssn", db, { json: { t: "tok", ssn: ` ${SSN} ` }, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res.clone())).data).toEqual({ ssnLast4: "6789" });
    expect(await res.text()).not.toContain("12345");
    expect(rpcArgs(db, "store_intake_ssn")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_ssn: "123456789",
    });
  });

  it("ssn: refuses a number nobody could be issued with one 422, before storing anything", async () => {
    for (const ssn of [
      "123-45-678",
      "000-12-3456",
      "123-00-4567",
      "1234567a9",
      "078-05-1120",
      123456789,
    ]) {
      const db = fakeDb({ result: "stored", ssn_last4: "6789" });
      const res = await call("ssn", db, { json: { t: "tok", ssn }, headers: SIGNED_IN });
      expect(res.status, String(ssn)).toBe(422);
      expect((await body(res)).error).toBe("ssn_invalid");
      expect(rpcsAfterPause(db)).toEqual([]);
    }
  });

  it("ssn: a locked SSN is a 409 field_locked", async () => {
    const locked = await call("ssn", fakeDb({ result: "locked" }), {
      json: { t: "tok", ssn: SSN },
      headers: SIGNED_IN,
    });
    expect(locked.status).toBe(409);
    expect((await body(locked)).error).toBe("field_locked");
  });

  it("login: stores the trimmed username and the password exactly as typed", async () => {
    const db = fakeDb({ result: "stored" });
    const res = await call("login", db, { json: LOGIN, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.clone().text();
    expect((await body(res)).data).toEqual({ portal: "caqh", onFile: true });
    expect(text).not.toContain("anita.caqh");
    expect(text).not.toContain("Pass word");
    expect(rpcArgs(db, "store_intake_portal_login")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_portal: "caqh",
      p_username: "anita.caqh",
      p_password: " Pass word 1 ",
    });
  });

  it("login: refuses another portal, a blank or long username or password, before storing", async () => {
    for (const json of [
      { ...LOGIN, portal: "medicare" },
      { ...LOGIN, portal: undefined },
      { ...LOGIN, username: "   " },
      { ...LOGIN, username: "u".repeat(101) },
      { ...LOGIN, password: "" },
      { ...LOGIN, password: "p".repeat(201) },
      { ...LOGIN, password: 12345 },
    ]) {
      const db = fakeDb({ result: "stored" });
      const res = await call("login", db, { json, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(json).slice(0, 60)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
    }
    const longest = fakeDb({ result: "stored" });
    const res = await call("login", longest, {
      json: { ...LOGIN, portal: "pecos", username: "u".repeat(100), password: "p".repeat(200) },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(200);
  });

  it("refuses a state-changing request from another site before touching the database", async () => {
    for (const action of INTAKE_ACTION_NAMES.filter(
      (name) => name !== "link" && name !== "state",
    )) {
      const db = fakeDb({ result: "saved", version: 1 });
      const res = await call(action, db, {
        json: {
          ...DRAFT,
          ...LOGIN,
          code: "012345",
          typedName: "A R",
          version: CONSENT.version,
          ssn: SSN,
        },
        headers: { ...SIGNED_IN, origin: "https://evil.example" },
      });
      expect(res.status, action).toBe(403);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(db.rpc).not.toHaveBeenCalled();
    }
    for (const origin of ["null", "not a url"]) {
      const res = await call("draft", fakeDb(), { json: DRAFT, headers: { ...SIGNED_IN, origin } });
      expect(res.status, origin).toBe(403);
    }
  });

  it("accepts a state-changing request from its own site, or with no Origin at all", async () => {
    const same = await call("draft", fakeDb({ result: "saved", version: 1 }), {
      json: DRAFT,
      headers: { ...SIGNED_IN, origin: "https://x.test" },
    });
    expect(same.status).toBe(200);
    // Behind the hosting proxy the request URL can read as http.
    const proxied = await call("draft", fakeDb({ result: "saved", version: 1 }), {
      json: DRAFT,
      headers: { ...SIGNED_IN, origin: "http://x.test" },
    });
    expect(proxied.status).toBe(200);
    const none = await call("draft", fakeDb({ result: "saved", version: 1 }), {
      json: DRAFT,
      headers: SIGNED_IN,
    });
    expect(none.status).toBe(200);
  });

  it("upload-intent: begins under this link with the storage-safe name, then signs that path", async () => {
    const storage = fakeStorage();
    const db = withStorage(
      fakeDb({
        result: "started",
        upload_id: UPLOAD_ID,
        object_path: UPLOAD_PATH,
        replaced_object_path: null,
      }),
      storage,
    );
    const res = await call("upload-intent", db, { json: UPLOAD, headers: SIGNED_IN });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.clone().text();
    expect((await body(res)).data).toEqual({
      uploadId: UPLOAD_ID,
      uploadUrl: `https://storage.test/upload/sign/${UPLOAD_PATH}?token=up`,
    });
    expect(text).not.toContain("Anita Rao");
    expect(rpcArgs(db, "begin_intake_upload")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_slot_key: "cv",
      p_doc_type: "cv",
      p_file_name: "Anita_Rao_CV.pdf",
      p_size_bytes: 52000,
      p_content_type: "application/pdf",
      p_expires_on: null,
    });
    expect(storage.storage.from).toHaveBeenCalledWith("provider-intake-uploads");
    expect(storage.bucket.createSignedUploadUrl).toHaveBeenCalledWith(UPLOAD_PATH);
    expect(storage.bucket.remove).not.toHaveBeenCalled();
  });

  it("upload-intent: a license slot holds a state license, and a COI may bring its date", async () => {
    const started = { result: "started", upload_id: UPLOAD_ID, object_path: UPLOAD_PATH };
    const license = withStorage(fakeDb(started), fakeStorage());
    const nc = await call("upload-intent", license, {
      json: { ...UPLOAD, slotKey: "license:NC", kind: "state_license", contentType: "image/jpeg" },
      headers: SIGNED_IN,
    });
    expect(nc.status).toBe(200);
    expect(rpcArgs(license, "begin_intake_upload")).toMatchObject({
      p_slot_key: "license:NC",
      p_doc_type: "state_license",
      p_file_name: "Anita_Rao_CV.pdf",
      p_content_type: "image/jpeg",
    });

    const coi = withStorage(fakeDb(started), fakeStorage());
    const dated = await call("upload-intent", coi, {
      json: { ...UPLOAD, slotKey: "coi", kind: "coi", expiresOn: "2027-06-30" },
      headers: SIGNED_IN,
    });
    expect(dated.status).toBe(200);
    expect(rpcArgs(coi, "begin_intake_upload")).toMatchObject({ p_expires_on: "2027-06-30" });
  });

  it("upload-intent: replacing a slot's file deletes the old object and signs the new one", async () => {
    const storage = fakeStorage({ [OLD_PATH]: { size: 10, mimetype: "application/pdf" } });
    const db = withStorage(
      fakeDb({
        result: "started",
        upload_id: UPLOAD_ID,
        object_path: UPLOAD_PATH,
        replaced_object_path: OLD_PATH,
      }),
      storage,
    );
    const res = await call("upload-intent", db, { json: UPLOAD, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(storage.objects).toEqual({});
    expect(storage.bucket.createSignedUploadUrl).toHaveBeenCalledWith(UPLOAD_PATH);
  });

  it("upload-intent: a failed delete of the replaced object still signs the new upload", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage({ [OLD_PATH]: { size: 10 } });
    storage.bucket.remove.mockResolvedValueOnce({
      data: [],
      error: { name: "StorageUnknownError", message: OLD_PATH },
    });
    const db = withStorage(
      fakeDb({
        result: "started",
        upload_id: UPLOAD_ID,
        object_path: UPLOAD_PATH,
        replaced_object_path: OLD_PATH,
      }),
      storage,
    );
    const res = await call("upload-intent", db, { json: UPLOAD, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(storage.bucket.createSignedUploadUrl).toHaveBeenCalledWith(UPLOAD_PATH);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(OLD_PATH);
  });

  it("upload-intent: refuses a slot, kind, type, size or date that can't be held, before the RPC", async () => {
    for (const json of [
      { ...UPLOAD, slotKey: "dea", kind: "dea" },
      { ...UPLOAD, slotKey: "license:nc", kind: "state_license" },
      { ...UPLOAD, kind: "diploma" },
      { ...UPLOAD, slotKey: "license:NC", kind: "cv" },
      { ...UPLOAD, contentType: "text/plain" },
      { ...UPLOAD, sizeBytes: 10 * 1024 * 1024 + 1 },
      { ...UPLOAD, sizeBytes: 0 },
      { ...UPLOAD, sizeBytes: 1.5 },
      { ...UPLOAD, sizeBytes: "52000" },
      { ...UPLOAD, fileName: 42 },
      { ...UPLOAD, expiresOn: "2027-06-30" },
      { ...UPLOAD, slotKey: "coi", kind: "coi", expiresOn: "06/30/2027" },
    ]) {
      const storage = fakeStorage();
      const db = withStorage(fakeDb({ result: "started" }), storage);
      const res = await call("upload-intent", db, { json, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(json)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
      expect(storage.storage.from).not.toHaveBeenCalled();
    }
  });

  it("upload-finalize: an object with the declared size and type finishes, with the size Storage reported", async () => {
    const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000, mimetype: "application/pdf" } });
    const db = withStorage(
      fakeDb(null, {
        read_intake_upload: { data: FOUND, error: null },
        finish_intake_upload: { data: { result: "finalized" }, error: null },
      }),
      storage,
    );
    const res = await call("upload-finalize", db, {
      json: { t: "tok", uploadId: UPLOAD_ID },
      headers: SIGNED_IN,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({
      upload: {
        id: UPLOAD_ID,
        slotKey: "cv",
        kind: "cv",
        fileName: "Anita_Rao_CV.pdf",
        sizeBytes: 52000,
        expiresOn: null,
      },
    });
    const keys = { p_session_hash: hashToken("sess"), p_token_hash: hashToken("tok") };
    expect(rpcArgs(db, "read_intake_upload")).toEqual({ ...keys, p_upload_id: UPLOAD_ID });
    expect(rpcArgs(db, "finish_intake_upload")).toEqual({
      ...keys,
      p_upload_id: UPLOAD_ID,
      p_size_bytes: 52000,
    });
    expect(storage.objects).toHaveProperty([UPLOAD_PATH]);
  });

  it("upload-finalize: a missing, resized, retyped or oversized object is deleted and the upload removed", async () => {
    for (const stored of [
      undefined,
      { size: 51999, mimetype: "application/pdf" },
      { mimetype: "application/pdf" },
      { size: 52000, mimetype: "image/png" },
      { size: 11 * 1024 * 1024, mimetype: "application/pdf" },
    ]) {
      const storage = fakeStorage(stored ? { [UPLOAD_PATH]: stored } : {});
      const db = withStorage(
        fakeDb(null, {
          read_intake_upload: { data: FOUND, error: null },
          remove_intake_upload: {
            data: { result: "removed", object_path: UPLOAD_PATH },
            error: null,
          },
        }),
        storage,
      );
      const res = await call("upload-finalize", db, {
        json: { t: "tok", uploadId: UPLOAD_ID },
        headers: SIGNED_IN,
      });
      expect(res.status, JSON.stringify(stored)).toBe(422);
      expect((await body(res)).error).toBe("upload_rejected");
      expect(storage.objects).toEqual({});
      expect(rpcNames(db)).toContain("remove_intake_upload");
      expect(rpcNames(db)).not.toContain("finish_intake_upload");
    }
  });

  it("upload-finalize: an upload that isn't hers is not found, and Storage is never asked", async () => {
    const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000, mimetype: "application/pdf" } });
    const db = withStorage(
      fakeDb(null, { read_intake_upload: { data: { result: "not_found" }, error: null } }),
      storage,
    );
    const notHers = await call("upload-finalize", db, {
      json: { t: "tok", uploadId: UPLOAD_ID },
      headers: SIGNED_IN,
    });
    expect(notHers.status).toBe(404);
    expect((await body(notHers)).error).toBe("upload_not_found");
    expect(storage.storage.from).not.toHaveBeenCalled();
    expect(rpcsAfterPause(db)).toEqual(["read_intake_upload"]);
    const badId = withStorage(fakeDb(), fakeStorage());
    const res = await call("upload-finalize", badId, {
      json: { t: "tok", uploadId: "../other" },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(404);
    expect(rpcsAfterPause(badId)).toEqual([]);
  });

  it("upload-remove: removes the upload, then deletes the object at the path the RPC returned", async () => {
    const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000 }, [OLD_PATH]: { size: 10 } });
    const db = withStorage(fakeDb({ result: "removed", object_path: UPLOAD_PATH }), storage);
    const res = await call("upload-remove", db, {
      json: { t: "tok", uploadId: UPLOAD_ID },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({ removed: true });
    expect(rpcArgs(db, "remove_intake_upload")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_upload_id: UPLOAD_ID,
    });
    expect(Object.keys(storage.objects)).toEqual([OLD_PATH]);
  });

  it("upload-remove: a failed delete is a server fault, so she can try again", async () => {
    const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000 } });
    const deleteError = { name: "StorageUnknownError", message: "x" };
    storage.bucket.remove.mockResolvedValueOnce({ data: [], error: deleteError });
    const db = withStorage(fakeDb({ result: "removed", object_path: UPLOAD_PATH }), storage);
    await expect(
      call("upload-remove", db, { json: { t: "tok", uploadId: UPLOAD_ID }, headers: SIGNED_IN }),
    ).rejects.toBe(deleteError);
  });

  it("upload-remove: an upload that isn't hers deletes nothing", async () => {
    const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000 } });
    const res = await call("upload-remove", withStorage(fakeDb({ result: "not_found" }), storage), {
      json: { t: "tok", uploadId: UPLOAD_ID },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("upload_not_found");
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("upload-expiry: saves or clears a COI's date under this link", async () => {
    for (const expiresOn of ["2027-06-30", null]) {
      const db = fakeDb({ result: "saved" });
      const res = await call("upload-expiry", db, {
        json: { t: "tok", uploadId: UPLOAD_ID, expiresOn },
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect((await body(res)).data).toEqual({ expiresOn });
      expect(rpcArgs(db, "set_intake_upload_expiry")).toEqual({
        p_session_hash: hashToken("sess"),
        p_token_hash: hashToken("tok"),
        p_upload_id: UPLOAD_ID,
        p_expires_on: expiresOn,
      });
    }
  });

  it("upload-expiry: refuses a date that isn't one, or an upload that takes none", async () => {
    for (const expiresOn of ["06/30/2027", "2027-02-30", 20270630]) {
      const db = fakeDb({ result: "saved" });
      const res = await call("upload-expiry", db, {
        json: { t: "tok", uploadId: UPLOAD_ID, expiresOn },
        headers: SIGNED_IN,
      });
      expect(res.status, String(expiresOn)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
    }
    const notDated = await call("upload-expiry", fakeDb({ result: "not_dated" }), {
      json: { t: "tok", uploadId: UPLOAD_ID, expiresOn: "2027-06-30" },
      headers: SIGNED_IN,
    });
    expect(notDated.status).toBe(422);
    const notHers = await call("upload-expiry", fakeDb({ result: "not_found" }), {
      json: { t: "tok", uploadId: UPLOAD_ID, expiresOn: null },
      headers: SIGNED_IN,
    });
    expect(notHers.status).toBe(404);
  });

  it("submit: something still missing is a 422 naming it, before any file is copied or written", async () => {
    const storage = fakeStorage({ ...HELD });
    const row = { ...READY_ROW, ssn_last4: null, uploads: [READY_ROW.uploads[1]] };
    const db = withStorage(
      fakeDb(null, { read_intake_state: { data: row, error: null } }),
      storage,
    );
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const sent = await body(res);
    expect(sent.error).toBe("intake_incomplete");
    expect(sent.meta?.missing).toEqual(["identity.ssn", "documents.cv"]);
    expect(storage.bucket.copy).not.toHaveBeenCalled();
    expect(rpcsAfterPause(db)).toEqual(["read_intake_state"]);
  });

  it("submit: a draft newer than the one she sent is a 409, before any file is copied", async () => {
    const storage = fakeStorage({ ...HELD });
    const db = withStorage(
      fakeDb(null, { read_intake_state: { data: READY_ROW, error: null } }),
      storage,
    );
    const res = await call("submit", db, { json: { ...SUBMIT, version: 3 }, headers: SIGNED_IN });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("draft_conflict");
    expect(storage.bucket.copy).not.toHaveBeenCalled();
    expect(rpcNames(db)).not.toContain("submit_provider_intake");
  });

  it("submit: copies each held file to its vault path, then submits once with those paths", async () => {
    const storage = fakeStorage({ ...HELD });
    const db = submitDb(storage);
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({ submitted: true });

    expect(storage.storage.from).toHaveBeenCalledWith("provider-intake-uploads");
    expect(storage.bucket.copy.mock.calls).toEqual([
      [HELD_CV, VAULT_CV, { destinationBucket: "provider-documents" }],
      [HELD_LICENSE, VAULT_LICENSE, { destinationBucket: "provider-documents" }],
    ]);
    expect(Object.keys(storage.vault)).toEqual([VAULT_CV, VAULT_LICENSE]);
    expect(rpcArgs(db, "submit_provider_intake")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_expected_version: 4,
      p_documents: [
        { upload_id: CV_ID, file_path: VAULT_CV },
        { upload_id: LICENSE_ID, file_path: VAULT_LICENSE },
      ],
    });
    // Every held file goes once Submit has them, the ones she replaced too.
    expect(storage.bucket.remove).toHaveBeenCalledWith([HELD_CV, HELD_LICENSE, HELD_REPLACED]);
    expect(storage.objects).toEqual({});
  });

  it("submit: any other copy failure is a server fault, and nothing is submitted", async () => {
    // Her CV is not in the holding bucket, so its copy fails with Storage's 404.
    const storage = fakeStorage({ [HELD_LICENSE]: HELD[HELD_LICENSE] });
    const db = submitDb(storage);
    await expect(call("submit", db, { json: SUBMIT, headers: SIGNED_IN })).rejects.toBe(
      MISSING_SOURCE,
    );
    expect(rpcNames(db)).not.toContain("submit_provider_intake");
    expect(storage.bucket.remove).not.toHaveBeenCalled();
  });

  it("submit: emails her and the ops inbox once, and keeps what happened to her email", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const db = submitDb(fakeStorage({ ...HELD }));
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN }, deps);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "anita.rao@example.test",
      template: "intake_submitted",
      data: { practiceName: "Shelby", firstName: "Anita" },
      practiceName: "Shelby",
    });
    expect(send.mock.calls[1][0]).toMatchObject({
      to: "ops@minted.example",
      template: "onboarding_ops_alert",
    });
    // The practice and a link: never her name or anything she entered.
    expect(send.mock.calls[1][0].data).toEqual({
      practiceName: "Shelby",
      kind: "submitted",
      link: `https://staging.example.test/providers/${PROVIDER}`,
    });
    expect(rpcArgs(db, "record_intake_email_delivery")).toEqual({
      p_kind: "submitted",
      p_id: JOURNEY_ID,
      p_delivery: "sent",
    });
  });

  it("submit: no ops alert without ONBOARDING_OPS_EMAIL", async () => {
    const { deps, send } = makeDeps();
    const res = await call(
      "submit",
      submitDb(fakeStorage({ ...HELD })),
      { json: SUBMIT, headers: SIGNED_IN },
      deps,
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].template).toBe("intake_submitted");
  });

  it("submit: a failed email never fails Submit, and is kept as failed", async () => {
    const { deps } = makeDeps({
      send: vi.fn().mockRejectedValue(new EmailError("provider_rejected", "x", 400)),
      config: { ...CONFIG, opsEmail: "ops@minted.example" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = submitDb(fakeStorage({ ...HELD }));
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN }, deps);
    expect(res.status).toBe(200);
    expect(rpcArgs(db, "record_intake_email_delivery").p_delivery).toBe("failed");
  });

  it("submit: a retry after a lost response answers submitted and sends nothing again", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const storage = fakeStorage({ ...HELD });
    // The first try's Submit landed: the state says so, so nothing is checked
    // or copied, and the RPC answers already_submitted.
    const row = { ...READY_ROW, ssn_last4: null, submitted: true };
    const db = withStorage(
      fakeDb(null, {
        read_intake_state: { data: row, error: null },
        submit_provider_intake: { data: { result: "already_submitted" }, error: null },
      }),
      storage,
    );
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN }, deps);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ submitted: true });
    expect(storage.bucket.copy).not.toHaveBeenCalled();
    expect(rpcArgs(db, "submit_provider_intake").p_documents).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(rpcNames(db)).not.toContain("record_intake_email_delivery");
    expect(storage.bucket.remove).toHaveBeenCalledWith([HELD_CV, HELD_LICENSE, HELD_REPLACED]);

    // Two tabs: this one read the state before the other's Submit landed.
    const race = submitDb(fakeStorage({ ...HELD }), { result: "already_submitted" });
    const again = await call("submit", race, { json: SUBMIT, headers: SIGNED_IN }, deps);
    expect(again.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("submit: an NPI on another provider's record is a 409 she can act on, with nothing sent", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const storage = fakeStorage({ ...HELD });
    const db = submitDb(storage, { result: "npi_in_use" });
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN }, deps);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("npi_in_use");
    expect(send).not.toHaveBeenCalled();
    expect(storage.bucket.remove).not.toHaveBeenCalled();
  });

  it("submit: a version that isn't a whole number is a 422", async () => {
    for (const version of [undefined, -1, 1.5, "4"]) {
      const res = await call("submit", fakeDb(READY_ROW), {
        json: { t: "tok", version },
        headers: SIGNED_IN,
      });
      expect(res.status, String(version)).toBe(422);
    }
  });

  it("submit: a held file that can't be deleted still answers 200, and the log names no path", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage({ ...HELD });
    storage.bucket.remove.mockResolvedValueOnce({
      data: [],
      error: { name: "StorageUnknownError", message: HELD_CV },
    });
    const res = await call("submit", submitDb(storage), { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(HELD_CV);
  });

  it("submit: a Submit that doesn't commit takes back the vault copies it made or found", async () => {
    for (const [reply, status, error] of [
      [{ result: "conflict", version: 5 }, 409, "draft_conflict"],
      [{ result: "npi_in_use" }, 409, "npi_in_use"],
      [{ result: "closed" }, 409, "intake_closed"],
      [null, 401, "signed_out"],
    ] as const) {
      const storage = fakeStorage({ ...HELD });
      // Left by an earlier Submit that failed after its copies.
      storage.vault[VAULT_CV] = { size: 100 };
      const res = await call("submit", submitDb(storage, reply), {
        json: SUBMIT,
        headers: SIGNED_IN,
      });
      expect(res.status, error).toBe(status);
      expect((await body(res)).error).toBe(error);
      expect(storage.vault, error).toEqual({});
      // Her held files wait for her next Submit.
      expect(Object.keys(storage.objects), error).toEqual([HELD_CV, HELD_LICENSE]);
    }
  });

  it("submit: a Submit that throws takes back its copies, except one a committed row points at", async () => {
    // The RPC's answer was lost, and it had committed: the CV has its row.
    const storage = fakeStorage({ ...HELD });
    const db = submitDb(storage, new Error("socket hang up"), [CV_ID]);
    await expect(call("submit", db, { json: SUBMIT, headers: SIGNED_IN })).rejects.toThrow(
      "socket hang up",
    );
    expect(Object.keys(storage.vault)).toEqual([VAULT_CV]);

    // A copy that fails partway (the license is not held) takes back the one before it.
    const partway = fakeStorage({ [HELD_CV]: HELD[HELD_CV] });
    await expect(
      call("submit", submitDb(partway), { json: SUBMIT, headers: SIGNED_IN }),
    ).rejects.toBe(MISSING_SOURCE);
    expect(partway.vault).toEqual({});
  });

  it("submit: already_submitted never takes a copy back, because the Submit that landed holds them", async () => {
    const storage = fakeStorage({ ...HELD });
    const db = submitDb(storage, { result: "already_submitted" }, [CV_ID, LICENSE_ID]);
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(Object.keys(storage.vault)).toEqual([VAULT_CV, VAULT_LICENSE]);
    expect(storage.vaultBucket.remove).not.toHaveBeenCalled();
  });

  it("submit: a take-back that fails still answers the same error, and the log names no path", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage({ ...HELD });
    storage.vaultBucket.remove.mockResolvedValueOnce({
      data: [],
      error: { name: "StorageUnknownError", message: VAULT_CV },
    });
    const res = await call("submit", submitDb(storage, { result: "npi_in_use" }), {
      json: SUBMIT,
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("npi_in_use");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(VAULT_CV);
  });

  it("submit: a Submit that commits deletes the vault copies of her uploads that did not go in", async () => {
    // A failed Submit copied a file she then replaced: it has no document row.
    const storage = fakeStorage({ ...HELD });
    storage.vault[VAULT_REPLACED] = { size: 100 };
    const res = await call("submit", submitDb(storage), { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(Object.keys(storage.vault)).toEqual([VAULT_CV, VAULT_LICENSE]);
  });

  it("submit: a copy Storage says is already there counts, however it says so", async () => {
    for (const alreadyThere of [
      LOCAL_ALREADY_THERE,
      { statusCode: 409, message: "Conflict" },
      { status: 409 },
      { status: "409" },
      { statusCode: "400", error: "Duplicate", message: "The resource already exists" },
      { message: "The Resource Already Exists" },
      { error: "duplicate" },
    ]) {
      const storage = fakeStorage({ ...HELD }, alreadyThere);
      storage.vault[VAULT_CV] = { size: 100 };
      const db = submitDb(storage);
      const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(alreadyThere)).toBe(200);
      expect(rpcArgs(db, "submit_provider_intake").p_documents).toHaveLength(2);
    }
    for (const otherError of [
      { statusCode: "404", message: "Object not found" },
      { status: 400, statusCode: "400", message: "Invalid key" },
      new Error("fetch failed"),
    ]) {
      const storage = fakeStorage({ ...HELD }, otherError);
      storage.vault[VAULT_CV] = { size: 100 };
      const db = submitDb(storage);
      await expect(call("submit", db, { json: SUBMIT, headers: SIGNED_IN })).rejects.toBe(
        otherError,
      );
      expect(rpcNames(db)).not.toContain("submit_provider_intake");
    }
  });

  it("help: asks under this link, then alerts the ops inbox with the record link only", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const db = fakeDb({ result: "requested", provider_id: PROVIDER, practice_name: "Shelby" });
    const res = await call(
      "help",
      db,
      { json: { t: "tok", reason: { kind: "help" } }, headers: SIGNED_IN },
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await body(res)).data).toEqual({ sent: true });
    expect(rpcArgs(db, "request_intake_help")).toEqual({
      p_session_hash: hashToken("sess"),
      p_token_hash: hashToken("tok"),
      p_kind: "help",
      p_field: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "ops@minted.example",
      template: "onboarding_ops_alert",
    });
    expect(send.mock.calls[0][0].data).toEqual({
      practiceName: "Shelby",
      kind: "help",
      link: `https://staging.example.test/providers/${PROVIDER}`,
    });
  });

  it("help: a fix names the field as the database does", async () => {
    for (const [field, column] of [
      ["npi", "npi"],
      ["dateOfBirth", "date_of_birth"],
      ["ssn", "ssn"],
    ]) {
      const db = fakeDb({ result: "requested", provider_id: PROVIDER, practice_name: "Shelby" });
      await call("help", db, {
        json: { t: "tok", reason: { kind: "fix", field } },
        headers: SIGNED_IN,
      });
      expect(rpcArgs(db, "request_intake_help")).toMatchObject({ p_kind: "fix", p_field: column });
    }
  });

  it("help: a second ask within a minute answers sent, with no second alert", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const res = await call(
      "help",
      fakeDb({ result: "recent" }),
      { json: { t: "tok", reason: { kind: "help" } }, headers: SIGNED_IN },
      deps,
    );
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("help: refuses a reason that isn't one, before asking the database", async () => {
    for (const reason of [
      undefined,
      { kind: "other" },
      { kind: "fix" },
      { kind: "fix", field: "email" },
    ]) {
      const db = fakeDb({ result: "requested" });
      const res = await call("help", db, { json: { t: "tok", reason }, headers: SIGNED_IN });
      expect(res.status, JSON.stringify(reason)).toBe(422);
      expect(rpcsAfterPause(db)).toEqual([]);
    }
  });

  it("signout: still revokes the session and clears the cookie while intake is paused", async () => {
    const db = fakeDb(null, PAUSED);
    const res = await call("signout", db, {
      json: {},
      headers: { cookie: `${INTAKE_COOKIE}=sess` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ signedOut: true });
    expect(db.rpc).toHaveBeenCalledWith("revoke_intake_session", {
      p_session_hash: hashToken("sess"),
    });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
