import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageApiError } from "@supabase/supabase-js";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext } from "./guard";
import { EmailError } from "./email/sendgrid";
import { INTAKE_COOKIE, hashCode, hashToken } from "./intakeTokens";
import { CONSENT } from "@/lib/intakeConsent";
import { SSN_NOT_ISSUED_MESSAGE } from "@/lib/providerIdentity";
import {
  resolveAppBaseUrl,
  handleCancelProviderOnboarding,
  handleCreateProviderInvite,
  handleIntakeRequest,
  handleResendProviderInvite,
  type IntakeConfig,
  type IntakeDeps,
} from "./providerIntakeRoutes";

const GROUP = "0b6a3a52-3c9f-4f3e-9a51-6a1d2f6e7c11";
const PROVIDER = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const INVITE_ID = "9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a";
const CODE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOW = new Date("2026-10-25T12:00:00Z");

const CONFIG: IntakeConfig = {
  appBaseUrl: "https://staging.example.test",
  fromEmail: "no-reply@mintedpanel.com",
  emailReady: true,
  secureCookie: true,
  opsEmail: null,
};

function makeDeps(overrides: Partial<IntakeDeps> = {}) {
  const send = vi.fn().mockResolvedValue({ status: 202, sandbox: false });
  const deps: IntakeDeps = { config: CONFIG, send, now: () => NOW, ...overrides };
  return { deps, send: deps.send as ReturnType<typeof vi.fn> };
}

interface RpcReply {
  data: unknown;
  error: unknown;
}

// `result` answers the route's own RPC. The off switch reads "not paused" and
// the delivery record succeeds unless a test passes its own reply (an Error
// is thrown, like a dropped connection).
function fakeDb(result: unknown = null, replies: Record<string, RpcReply | Error> = {}) {
  const defaults: Record<string, RpcReply> = {
    intake_paused: { data: false, error: null },
    intake_link_paused: { data: false, error: null },
    record_intake_email_delivery: { data: true, error: null },
  };
  return {
    rpc: vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<RpcReply> => {
      const reply = replies[name] ?? defaults[name] ?? { data: result, error: null };
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

const PAUSED = {
  intake_paused: { data: true, error: null },
  intake_link_paused: { data: true, error: null },
};

type StoredObject = { size?: number; mimetype?: string };

// What local Storage answered (Nov 7, captured from the local stack) for a
// copy onto an object that is already there: a StorageApiError with status
// 400 and statusCode "409".
const LOCAL_ALREADY_THERE = new StorageApiError("The resource already exists", 400, "409");

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
      if (!objects[from]) {
        return { data: null, error: { statusCode: "404", message: "Object not found" } as unknown };
      }
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

function rpcNames(db: ReturnType<typeof fakeDb>): string[] {
  return db.rpc.mock.calls.map(([name]) => name);
}

function rpcArgs(db: ReturnType<typeof fakeDb>, name: string): Record<string, unknown> {
  const call = db.rpc.mock.calls.find(([called]) => called === name);
  if (!call) throw new Error(`${name} was not called`);
  return call[1] ?? {};
}

function ctx(db: ReturnType<typeof fakeDb>, role: AuthContext["role"] = "admin"): AuthContext {
  return {
    userId: "u1",
    orgId: "org-1",
    role,
    userName: "Jordan Seed",
    email: "jordan@minted.example",
    userMetadata: null,
    db: db as unknown as AuthContext["db"],
    writeAudit: vi.fn(),
  };
}

const INVITE = {
  firstName: "Anita",
  lastName: "Rao",
  email: "anita.rao@example.test",
  groupId: GROUP,
};

async function body(res: Response): Promise<ApiEnvelope<Record<string, unknown>>> {
  return (await res.json()) as ApiEnvelope<Record<string, unknown>>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/provider-invites", () => {
  it("creates the invite in one RPC, then emails a link built from APP_BASE_URL", async () => {
    const db = fakeDb({
      result: "created",
      provider_id: PROVIDER,
      invite_id: INVITE_ID,
      practice_name: "Shelby Sports Rehab",
    });
    const { deps, send } = makeDeps();
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);

    expect(res.status).toBe(201);
    expect((await body(res)).data).toEqual({
      outcome: "created",
      providerId: PROVIDER,
      delivery: "sent",
    });
    const args = rpcArgs(db, "create_provider_intake_invite");
    expect(args).toMatchObject({
      p_org_id: "org-1",
      p_actor_id: "u1",
      p_actor_name: "Jordan Seed",
    });
    expect(args.p_expires_at).toBe("2026-11-24T12:00:00.000Z");
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const mail = send.mock.calls[0][0];
    expect(mail).toMatchObject({
      to: "anita.rao@example.test",
      template: "provider_invitation",
      practiceName: "Shelby Sports Rehab",
      replyTo: { email: "jordan@minted.example", name: "Jordan Seed" },
    });
    const token = mail.data.link.replace("https://staging.example.test/intake/", "");
    expect(hashToken(token)).toBe(args.p_token_hash);
  });

  it("writes nothing when email is not configured", async () => {
    const db = fakeDb();
    const { deps } = makeDeps({ config: { ...CONFIG, appBaseUrl: null } });
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);
    expect(res.status).toBe(500);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("is a 403 for billing", async () => {
    const db = fakeDb();
    expect(
      (await handleCreateProviderInvite(INVITE, ctx(db, "billing"), makeDeps().deps)).status,
    ).toBe(403);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("rejects bad input with 422 before calling the database", async () => {
    const db = fakeDb();
    const res = await handleCreateProviderInvite(
      { ...INVITE, email: "nope" },
      ctx(db),
      makeDeps().deps,
    );
    expect(res.status).toBe(422);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("returns the existing provider for a duplicate, without sending", async () => {
    const db = fakeDb({ result: "duplicate", provider_id: PROVIDER });
    const { deps, send } = makeDeps();
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ outcome: "already_exists", providerId: PROVIDER });
    expect(send).not.toHaveBeenCalled();
  });

  it("says added_group when her existing record joined the group, and emails nobody", async () => {
    const db = fakeDb({ result: "added_group", provider_id: PROVIDER });
    const { deps, send } = makeDeps();
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ outcome: "added_group", providerId: PROVIDER });
    expect(send).not.toHaveBeenCalled();
    expect(rpcNames(db)).not.toContain("record_intake_email_delivery");
  });

  it("is a 409 when the email or NPI matches more than one provider, and emails nobody", async () => {
    const db = fakeDb({ result: "conflict" });
    const { deps, send } = makeDeps();
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);
    expect(res.status).toBe(409);
    expect((await body(res)).data).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("records what happened to the invite email on the invite", async () => {
    const outcomes = [
      ["sent", vi.fn().mockResolvedValue({ status: 202, sandbox: false })],
      ["sandbox", vi.fn().mockResolvedValue({ status: 200, sandbox: true })],
      ["failed", vi.fn().mockRejectedValue(new EmailError("network", "x"))],
    ] as const;
    for (const [delivery, send] of outcomes) {
      const db = fakeDb({ result: "created", provider_id: PROVIDER, invite_id: INVITE_ID });
      await handleCreateProviderInvite(INVITE, ctx(db), makeDeps({ send }).deps);
      expect(rpcArgs(db, "record_intake_email_delivery")).toEqual({
        p_kind: "invite",
        p_id: INVITE_ID,
        p_delivery: delivery,
      });
    }
  });

  it("still answers 201 when the delivery can't be recorded, and logs no address", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const reply of [
      { data: null, error: { code: "PGRST202", message: "anita.rao@example.test" } },
      new Error("socket hang up anita.rao@example.test"),
    ]) {
      const db = fakeDb(
        { result: "created", provider_id: PROVIDER, invite_id: INVITE_ID },
        { record_intake_email_delivery: reply },
      );
      const res = await handleCreateProviderInvite(INVITE, ctx(db), makeDeps().deps);
      expect(res.status).toBe(201);
      expect((await body(res)).data).toMatchObject({ outcome: "created", delivery: "sent" });
    }
    expect(errors).toHaveBeenCalledTimes(2);
    for (const call of errors.mock.calls) {
      expect(call.map(String).join(" ")).not.toContain("anita.rao@example.test");
    }
  });

  it("answers 503 intake_paused while intake is paused, before any write or email", async () => {
    const db = fakeDb({ result: "created", provider_id: PROVIDER, invite_id: INVITE_ID }, PAUSED);
    const { deps, send } = makeDeps();
    const res = await handleCreateProviderInvite(INVITE, ctx(db), deps);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("intake_paused");
    expect(rpcNames(db)).toEqual(["intake_paused"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("is a 404 for a group outside the caller's org", async () => {
    const db = fakeDb({ result: "group_not_found" });
    expect((await handleCreateProviderInvite(INVITE, ctx(db), makeDeps().deps)).status).toBe(404);
  });

  it("reports a failed send as delivery failed, because the invite is already saved", async () => {
    const db = fakeDb({ result: "created", provider_id: PROVIDER, practice_name: "Shelby" });
    const send = vi.fn().mockRejectedValue(new EmailError("provider_rejected", "x", 400));
    const res = await handleCreateProviderInvite(INVITE, ctx(db), makeDeps({ send }).deps);
    expect(res.status).toBe(201);
    expect((await body(res)).data).toMatchObject({ delivery: "failed" });
  });

  it("says sandbox when SendGrid accepted the mail in sandbox mode, so nobody thinks it arrived", async () => {
    const db = fakeDb({ result: "created", provider_id: PROVIDER, practice_name: "Shelby" });
    const send = vi.fn().mockResolvedValue({ status: 200, sandbox: true });
    const res = await handleCreateProviderInvite(INVITE, ctx(db), makeDeps({ send }).deps);
    expect((await body(res)).data).toMatchObject({ delivery: "sandbox" });
  });

  it("falls back to the caller's email for the audit actor name", async () => {
    const db = fakeDb({ result: "created", provider_id: PROVIDER, practice_name: "Shelby" });
    await handleCreateProviderInvite(INVITE, { ...ctx(db), userName: null }, makeDeps().deps);
    expect(rpcArgs(db, "create_provider_intake_invite").p_actor_name).toBe("jordan@minted.example");
  });

  it("falls back to the from address for reply-to when the caller has no email", async () => {
    const db = fakeDb({ result: "created", provider_id: PROVIDER, practice_name: "Shelby" });
    const { deps, send } = makeDeps();
    await handleCreateProviderInvite(INVITE, { ...ctx(db), email: null }, deps);
    expect(send.mock.calls[0][0].replyTo.email).toBe("no-reply@mintedpanel.com");
  });
});

describe("POST /api/provider-invites/:id/resend", () => {
  it("maps not_found to 404 and cooldown to 429, sending nothing", async () => {
    for (const [result, status] of [
      ["not_found", 404],
      ["cooldown", 429],
    ] as const) {
      const { deps, send } = makeDeps();
      const res = await handleResendProviderInvite(PROVIDER, ctx(fakeDb({ result })), deps);
      expect(res.status).toBe(status);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("emails the new link to the address the RPC chose, and tells staff which one", async () => {
    const db = fakeDb({
      result: "resent",
      invite_id: INVITE_ID,
      email: "anita.rao@example.test",
      first_name: "Anita",
      practice_name: "Shelby",
    });
    const { deps, send } = makeDeps();
    const res = await handleResendProviderInvite(PROVIDER, ctx(db), deps);
    expect(res.status).toBe(200);
    // The record's current email, not what staff typed, so the toast must say.
    expect((await body(res)).data).toEqual({ delivery: "sent", email: "anita.rao@example.test" });
    expect(send.mock.calls[0][0]).toMatchObject({ to: "anita.rao@example.test" });
    const token = send.mock.calls[0][0].data.link.split("/intake/")[1];
    expect(hashToken(token)).toBe(rpcArgs(db, "resend_provider_intake_invite").p_token_hash);
    expect(rpcArgs(db, "record_intake_email_delivery")).toEqual({
      p_kind: "invite",
      p_id: INVITE_ID,
      p_delivery: "sent",
    });
  });

  it("answers 503 intake_paused while intake is paused, before any write or email", async () => {
    const db = fakeDb({ result: "resent", invite_id: INVITE_ID, email: "a@b.test" }, PAUSED);
    const { deps, send } = makeDeps();
    const res = await handleResendProviderInvite(PROVIDER, ctx(db), deps);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("intake_paused");
    expect(rpcNames(db)).toEqual(["intake_paused"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("is a 404 for a malformed provider id, without a database call", async () => {
    const db = fakeDb();
    expect((await handleResendProviderInvite("x", ctx(db), makeDeps().deps)).status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

const JOURNEY = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const CANCEL_UPLOAD = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
const HOLDING = `org/org-1/onboarding/${JOURNEY}/`;
const VAULT = `org/org-1/provider/${PROVIDER}/`;

// Buckets of object paths. list answers one folder level, as Storage does: a
// file has an id, a subfolder comes back with id null.
function folderStorage(buckets: Record<string, string[]>, fail: { list?: boolean } = {}) {
  const stored: Record<string, Set<string>> = Object.fromEntries(
    Object.entries(buckets).map(([name, paths]) => [name, new Set(paths)]),
  );
  const removeError = vi.fn((_bucket: string): unknown => null);
  const from = vi.fn((bucket: string) => ({
    list: vi.fn(async (folder: string, options: { limit?: number; offset?: number } = {}) => {
      if (fail.list) return { data: null, error: { statusCode: "500", message: "down" } };
      const children = new Map<string, boolean>();
      for (const path of stored[bucket] ?? []) {
        if (!path.startsWith(`${folder}/`)) continue;
        const [name, ...rest] = path.slice(folder.length + 1).split("/");
        children.set(name, children.get(name) || rest.length > 0);
      }
      const entries = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({ name, id: isFolder ? null : `id-${name}` }));
      const offset = options.offset ?? 0;
      return { data: entries.slice(offset, offset + (options.limit ?? 100)), error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      const error = removeError(bucket);
      if (!error) for (const path of paths) stored[bucket]?.delete(path);
      return { data: error ? null : [], error };
    }),
  }));
  return { storage: { from }, stored, removeError };
}

function cancelDb(
  result: unknown,
  storage = folderStorage({}),
  replies: Record<string, RpcReply> = {},
) {
  return Object.assign(fakeDb(result, replies), { storage: storage.storage });
}

const left = (storage: ReturnType<typeof folderStorage>, bucket: string) =>
  [...(storage.stored[bucket] ?? [])].sort();

describe("POST /api/provider-invites/:id/cancel", () => {
  const otherJourney = `org/org-1/onboarding/0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d/${CANCEL_UPLOAD}/cv.pdf`;
  const otherProvider = `org/org-1/provider/0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d/${CANCEL_UPLOAD}/1/cv.pdf`;

  it("deletes a record the journey created, then every file under the prefixes it names", async () => {
    const storage = folderStorage({
      "provider-intake-uploads": [
        `${HOLDING}${CANCEL_UPLOAD}/cv.pdf`,
        `${HOLDING}u2/coi.pdf`,
        otherJourney,
      ],
      "provider-documents": [`${VAULT}${CANCEL_UPLOAD}/1/cv.pdf`, otherProvider],
    });
    const db = cancelDb(
      {
        result: "deleted",
        storage: [
          { bucket: "provider-intake-uploads", prefix: HOLDING },
          { bucket: "provider-documents", prefix: VAULT },
        ],
      },
      storage,
    );
    const context = ctx(db, "specialist");
    const res = await handleCancelProviderOnboarding(PROVIDER, context);

    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ outcome: "deleted" });
    expect(rpcArgs(db, "cancel_provider_onboarding")).toEqual({
      p_org_id: "org-1",
      p_actor_id: "u1",
      p_actor_name: "Jordan Seed",
      p_provider_id: PROVIDER,
    });
    expect(left(storage, "provider-intake-uploads")).toEqual([otherJourney]);
    expect(left(storage, "provider-documents")).toEqual([otherProvider]);
    expect(context.writeAudit).not.toHaveBeenCalled();
  });

  it("closes the journey and deletes only the files it held, keeping her record's documents", async () => {
    const kept = `${VAULT}9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f/1/license.pdf`;
    const storage = folderStorage({
      "provider-intake-uploads": [`${HOLDING}${CANCEL_UPLOAD}/cv.pdf`],
      "provider-documents": [`${VAULT}${CANCEL_UPLOAD}/1/cv.pdf`, kept],
    });
    const db = cancelDb(
      {
        result: "closed",
        storage: [
          { bucket: "provider-intake-uploads", prefix: HOLDING },
          { bucket: "provider-documents", prefix: `${VAULT}${CANCEL_UPLOAD}/` },
        ],
      },
      storage,
    );
    const res = await handleCancelProviderOnboarding(PROVIDER, ctx(db));

    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ outcome: "closed" });
    expect(left(storage, "provider-intake-uploads")).toEqual([]);
    expect(left(storage, "provider-documents")).toEqual([kept]);
  });

  it("deletes past the first page of a folder", async () => {
    const many = Array.from(
      { length: 250 },
      (_, i) => `${HOLDING}u${String(i).padStart(3, "0")}/f.pdf`,
    );
    const storage = folderStorage({ "provider-intake-uploads": many });
    const db = cancelDb(
      { result: "closed", storage: [{ bucket: "provider-intake-uploads", prefix: HOLDING }] },
      storage,
    );
    expect((await handleCancelProviderOnboarding(PROVIDER, ctx(db))).status).toBe(200);
    expect(left(storage, "provider-intake-uploads")).toEqual([]);
  });

  it("is a 404 for another org's provider, with no file touched", async () => {
    const storage = folderStorage({
      "provider-intake-uploads": [`${HOLDING}${CANCEL_UPLOAD}/cv.pdf`],
    });
    const db = cancelDb({ result: "not_found" }, storage);
    const res = await handleCancelProviderOnboarding(PROVIDER, ctx(db));
    expect(res.status).toBe(404);
    expect((await body(res)).data).toBeNull();
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("is a 409 already_submitted after Submit, with no file touched", async () => {
    const storage = folderStorage({});
    const res = await handleCancelProviderOnboarding(
      PROVIDER,
      ctx(cancelDb({ result: "already_submitted" }, storage)),
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("already_submitted");
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("still answers 200 when Storage fails, logging no id or path", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const fail of [{ list: true }, {}]) {
      const storage = folderStorage(
        { "provider-intake-uploads": [`${HOLDING}${CANCEL_UPLOAD}/cv.pdf`] },
        fail,
      );
      storage.removeError.mockReturnValue({ statusCode: "500", message: HOLDING });
      const db = cancelDb(
        { result: "closed", storage: [{ bucket: "provider-intake-uploads", prefix: HOLDING }] },
        storage,
      );
      const res = await handleCancelProviderOnboarding(PROVIDER, ctx(db));
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual({ outcome: "closed" });
    }
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.flat().map(String).join(" ")).not.toMatch(
      new RegExp(`${JOURNEY}|${PROVIDER}|org-1|cv\\.pdf`),
    );
  });

  it("works while intake is paused: it only takes access away", async () => {
    const db = cancelDb({ result: "closed", storage: [] }, folderStorage({}), PAUSED);
    expect((await handleCancelProviderOnboarding(PROVIDER, ctx(db))).status).toBe(200);
  });

  it("is a 403 for a billing member and a 404 for a malformed id, with no database call", async () => {
    const db = cancelDb({ result: "deleted", storage: [] });
    expect((await handleCancelProviderOnboarding(PROVIDER, ctx(db, "billing"))).status).toBe(403);
    expect((await handleCancelProviderOnboarding("x", ctx(db))).status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
  });
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

const NO_ANSWERS = {
  firstName: null,
  lastName: null,
  npi: null,
  taxonomyCode: null,
  dateOfBirth: null,
  caqhId: null,
  mobile: null,
  homeStreet: null,
  homeCity: null,
  homeState: null,
  homeZip: null,
  licenses: [],
};

const STATE_ROW = {
  practice_name: "Shelby",
  email: "a@b.test",
  record: {
    ...NO_ANSWERS,
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
  first_time: true,
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
    for (const action of [
      "link",
      "code",
      "session",
      "state",
      "draft",
      "consent",
      "ssn",
      "login",
      "submit",
      "help",
    ]) {
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
        answers: { ...NO_ANSWERS, mobile: "7045550100" },
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

  it("the old me action is gone", async () => {
    const res = await call("me", fakeDb(), { json: { t: "tok" }, headers: SIGNED_IN });
    expect(res.status).toBe(404);
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
      p_answers: { ...NO_ANSWERS, mobile: "7045550100" },
      p_step: "documents",
      p_expected_version: 4,
    });
  });

  it("draft: a dead session or another link is signed_out, and nothing is saved without a cookie", async () => {
    const noCookie = fakeDb();
    const res = await call("draft", noCookie, { json: DRAFT });
    expect(res.status).toBe(401);
    expect(rpcNames(noCookie)).toEqual(["intake_link_paused"]);

    const dead = await call("draft", fakeDb(null), { json: DRAFT, headers: SIGNED_IN });
    expect(dead.status).toBe(401);
    expect((await body(dead)).error).toBe("signed_out");
  });

  it("draft: a stale version is a 409 that names the saved version", async () => {
    const res = await call("draft", fakeDb({ result: "conflict", version: 7 }), {
      json: DRAFT,
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(409);
    const envelope = await body(res);
    expect(envelope.error).toBe("draft_conflict");
    expect(envelope.meta?.draft_version).toBe(7);
  });

  it("draft: a submitted, admitted or cancelled journey is a 409 intake_closed", async () => {
    const res = await call("draft", fakeDb({ result: "closed" }), {
      json: DRAFT,
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("intake_closed");
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
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
    expect(rpcNames(db)).toEqual(["intake_link_paused"]);
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
    }
  });

  it("consent: a dead session is signed_out and a closed journey is intake_closed", async () => {
    const json = { t: "tok", typedName: "Anita Rao", version: CONSENT.version };
    const dead = await call("consent", fakeDb(null), { json, headers: SIGNED_IN });
    expect(dead.status).toBe(401);
    const closed = await call("consent", fakeDb({ result: "closed" }), {
      json,
      headers: SIGNED_IN,
    });
    expect(closed.status).toBe(409);
    expect((await body(closed)).error).toBe("intake_closed");
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
      const envelope = await body(res);
      expect(envelope.error).toBe("ssn_invalid");
      expect(envelope.meta?.message).toBe(SSN_NOT_ISSUED_MESSAGE);
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
    }
  });

  it("ssn: a locked SSN, a closed journey and a dead session each get their own answer", async () => {
    const json = { t: "tok", ssn: SSN };
    const locked = await call("ssn", fakeDb({ result: "locked" }), { json, headers: SIGNED_IN });
    expect(locked.status).toBe(409);
    expect((await body(locked)).error).toBe("field_locked");

    const closed = await call("ssn", fakeDb({ result: "closed" }), { json, headers: SIGNED_IN });
    expect(closed.status).toBe(409);
    expect((await body(closed)).error).toBe("intake_closed");

    const dead = await call("ssn", fakeDb(null), { json, headers: SIGNED_IN });
    expect(dead.status).toBe(401);
    expect((await body(dead)).error).toBe("signed_out");

    const noCookie = fakeDb({ result: "stored", ssn_last4: "6789" });
    expect((await call("ssn", noCookie, { json })).status).toBe(401);
    expect(rpcNames(noCookie)).toEqual(["intake_link_paused"]);
  });

  it("ssn: a vault that can't encrypt (no key) is a server fault, never a 4xx", async () => {
    const db = fakeDb(null, {
      store_intake_ssn: {
        data: null,
        error: { code: "P0001", message: "SSN vault key is not configured" },
      },
    });
    await expect(
      call("ssn", db, { json: { t: "tok", ssn: SSN }, headers: SIGNED_IN }),
    ).rejects.toEqual({ code: "P0001", message: "SSN vault key is not configured" });
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
    }
    const longest = fakeDb({ result: "stored" });
    const res = await call("login", longest, {
      json: { ...LOGIN, portal: "pecos", username: "u".repeat(100), password: "p".repeat(200) },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(200);
  });

  it("login: a closed journey is intake_closed and a dead session is signed_out", async () => {
    const closed = await call("login", fakeDb({ result: "closed" }), {
      json: LOGIN,
      headers: SIGNED_IN,
    });
    expect(closed.status).toBe(409);
    expect((await body(closed)).error).toBe("intake_closed");
    const dead = await call("login", fakeDb(null), { json: LOGIN, headers: SIGNED_IN });
    expect(dead.status).toBe(401);
  });

  it("refuses a state-changing request from another site before touching the database", async () => {
    for (const action of [
      "code",
      "session",
      "draft",
      "consent",
      "ssn",
      "login",
      "signout",
      "upload-intent",
      "upload-finalize",
      "upload-remove",
      "upload-expiry",
      "submit",
      "help",
    ]) {
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

  it("upload-intent: replacing a slot's file deletes the old object before signing the new one", async () => {
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
    expect(storage.bucket.remove.mock.invocationCallOrder[0]).toBeLessThan(
      storage.bucket.createSignedUploadUrl.mock.invocationCallOrder[0],
    );
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
      expect(storage.storage.from).not.toHaveBeenCalled();
    }
    const big = await call("upload-intent", withStorage(fakeDb(), fakeStorage()), {
      json: { ...UPLOAD, sizeBytes: 10 * 1024 * 1024 + 1 },
      headers: SIGNED_IN,
    });
    expect((await body(big)).meta?.message).toMatch(/over 10 MB/);
  });

  it("upload-intent: a dead session is signed_out and a closed journey intake_closed, nothing signed", async () => {
    for (const [reply, status, error] of [
      [null, 401, "signed_out"],
      [{ result: "closed" }, 409, "intake_closed"],
    ] as const) {
      const storage = fakeStorage();
      const res = await call("upload-intent", withStorage(fakeDb(reply), storage), {
        json: UPLOAD,
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(status);
      expect((await body(res)).error).toBe(error);
      expect(storage.storage.from).not.toHaveBeenCalled();
    }
    const noCookie = withStorage(fakeDb({ result: "started" }), fakeStorage());
    expect((await call("upload-intent", noCookie, { json: UPLOAD })).status).toBe(401);
    expect(rpcNames(noCookie)).toEqual(["intake_link_paused"]);
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
    for (const [reply, status, error] of [
      [null, 401, "signed_out"],
      [{ result: "not_found" }, 404, "upload_not_found"],
      [{ result: "closed" }, 409, "intake_closed"],
    ] as const) {
      const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000, mimetype: "application/pdf" } });
      const db = withStorage(
        fakeDb(null, { read_intake_upload: { data: reply, error: null } }),
        storage,
      );
      const res = await call("upload-finalize", db, {
        json: { t: "tok", uploadId: UPLOAD_ID },
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(status);
      expect((await body(res)).error).toBe(error);
      expect(storage.storage.from).not.toHaveBeenCalled();
      expect(rpcNames(db)).not.toContain("finish_intake_upload");
    }
    const badId = withStorage(fakeDb(), fakeStorage());
    const res = await call("upload-finalize", badId, {
      json: { t: "tok", uploadId: "../other" },
      headers: SIGNED_IN,
    });
    expect(res.status).toBe(404);
    expect(rpcNames(badId)).toEqual(["intake_link_paused"]);
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
    storage.bucket.remove.mockResolvedValueOnce({
      data: [],
      error: { name: "StorageUnknownError", message: "x" },
    });
    const db = withStorage(fakeDb({ result: "removed", object_path: UPLOAD_PATH }), storage);
    await expect(
      call("upload-remove", db, { json: { t: "tok", uploadId: UPLOAD_ID }, headers: SIGNED_IN }),
    ).rejects.toBeTruthy();
  });

  it("upload-remove: not hers, closed or signed out deletes nothing", async () => {
    for (const [reply, status] of [
      [null, 401],
      [{ result: "not_found" }, 404],
      [{ result: "closed" }, 409],
    ] as const) {
      const storage = fakeStorage({ [UPLOAD_PATH]: { size: 52000 } });
      const res = await call("upload-remove", withStorage(fakeDb(reply), storage), {
        json: { t: "tok", uploadId: UPLOAD_ID },
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(status);
      expect(storage.storage.from).not.toHaveBeenCalled();
    }
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
    }
    const notDated = await call("upload-expiry", fakeDb({ result: "not_dated" }), {
      json: { t: "tok", uploadId: UPLOAD_ID, expiresOn: "2027-06-30" },
      headers: SIGNED_IN,
    });
    expect(notDated.status).toBe(422);
    for (const [reply, status] of [
      [null, 401],
      [{ result: "not_found" }, 404],
      [{ result: "closed" }, 409],
    ] as const) {
      const res = await call("upload-expiry", fakeDb(reply), {
        json: { t: "tok", uploadId: UPLOAD_ID, expiresOn: null },
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(status);
    }
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
    expect(rpcNames(db)).toEqual(["intake_link_paused", "read_intake_state"]);
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
    const submitAt = db.rpc.mock.calls.findIndex(([name]) => name === "submit_provider_intake");
    const lastCopy = Math.max(...storage.bucket.copy.mock.invocationCallOrder);
    expect(lastCopy).toBeLessThan(db.rpc.mock.invocationCallOrder[submitAt]);
    // Every held file goes once Submit has them, the ones she replaced too.
    expect(storage.bucket.remove).toHaveBeenCalledWith([HELD_CV, HELD_LICENSE, HELD_REPLACED]);
    expect(storage.objects).toEqual({});
  });

  it("submit: a file already in the vault counts as copied, so a retried Submit converges", async () => {
    const storage = fakeStorage({ ...HELD });
    storage.vault[VAULT_CV] = { size: 100 };
    const db = submitDb(storage);
    const res = await call("submit", db, { json: SUBMIT, headers: SIGNED_IN });
    expect(res.status).toBe(200);
    expect(storage.bucket.copy).toHaveBeenCalledTimes(2);
    expect(rpcNames(db)).toContain("submit_provider_intake");
  });

  it("submit: any other copy failure is a server fault, and nothing is submitted", async () => {
    const storage = fakeStorage({ [HELD_LICENSE]: HELD[HELD_LICENSE] });
    const db = submitDb(storage);
    await expect(call("submit", db, { json: SUBMIT, headers: SIGNED_IN })).rejects.toThrow();
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

  it("submit: a conflict, a closed journey and a dead session each get their own answer", async () => {
    for (const [reply, status, error] of [
      [{ result: "conflict", version: 5 }, 409, "draft_conflict"],
      [{ result: "closed" }, 409, "intake_closed"],
      [null, 401, "signed_out"],
    ] as const) {
      const res = await call("submit", submitDb(fakeStorage({ ...HELD }), reply), {
        json: SUBMIT,
        headers: SIGNED_IN,
      });
      expect(res.status).toBe(status);
      expect((await body(res)).error).toBe(error);
    }
    const otherLink = await call("submit", fakeDb(null), { json: SUBMIT, headers: SIGNED_IN });
    expect(otherLink.status).toBe(401);
    const noCookie = await call("submit", fakeDb(READY_ROW), { json: SUBMIT });
    expect(noCookie.status).toBe(401);
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

    // A copy that fails partway takes back the one before it.
    const partway = fakeStorage({ [HELD_CV]: HELD[HELD_CV] });
    await expect(
      call("submit", submitDb(partway), { json: SUBMIT, headers: SIGNED_IN }),
    ).rejects.toBeDefined();
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
      await expect(call("submit", db, { json: SUBMIT, headers: SIGNED_IN })).rejects.toBeDefined();
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

  it("help: no ops address sends nothing, and a failed alert still answers sent", async () => {
    const quiet = makeDeps();
    const db = fakeDb({ result: "requested", provider_id: PROVIDER, practice_name: "Shelby" });
    const json = { t: "tok", reason: { kind: "help" } };
    expect((await call("help", db, { json, headers: SIGNED_IN }, quiet.deps)).status).toBe(200);
    expect(quiet.send).not.toHaveBeenCalled();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = makeDeps({
      send: vi.fn().mockRejectedValue(new EmailError("network", "x")),
      config: { ...CONFIG, opsEmail: "ops@minted.example" },
    });
    expect((await call("help", db, { json, headers: SIGNED_IN }, failing.deps)).status).toBe(200);
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
      expect(rpcNames(db)).toEqual(["intake_link_paused"]);
    }
  });

  it("help: a dead session is signed_out and a closed journey intake_closed, nothing sent", async () => {
    const { deps, send } = makeDeps({ config: { ...CONFIG, opsEmail: "ops@minted.example" } });
    const json = { t: "tok", reason: { kind: "help" } };
    const dead = await call("help", fakeDb(null), { json, headers: SIGNED_IN }, deps);
    expect(dead.status).toBe(401);
    const closed = await call(
      "help",
      fakeDb({ result: "closed" }),
      { json, headers: SIGNED_IN },
      deps,
    );
    expect(closed.status).toBe(409);
    expect((await body(closed)).error).toBe("intake_closed");
    expect(send).not.toHaveBeenCalled();
  });

  it("signout: revokes the session and clears the cookie", async () => {
    const db = fakeDb();
    const res = await call("signout", db, {
      json: {},
      headers: { cookie: `${INTAKE_COOKIE}=sess` },
    });
    expect(db.rpc).toHaveBeenCalledWith("revoke_intake_session", {
      p_session_hash: hashToken("sess"),
    });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
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

describe("resolveAppBaseUrl", () => {
  it("accepts a bare https origin and normalizes a trailing slash", () => {
    expect(resolveAppBaseUrl("https://staging.mintedpanel.com/", false)).toBe(
      "https://staging.mintedpanel.com",
    );
  });

  it("treats anything else as missing, so a typo fails closed instead of mailing a bad link", () => {
    for (const raw of [
      undefined,
      "",
      "http://staging.mintedpanel.com",
      "staging.mintedpanel.com",
      "https://staging.mintedpanel.com/intake",
      "https://x.test/?a=1",
    ]) {
      expect(resolveAppBaseUrl(raw, false)).toBeNull();
    }
    expect(resolveAppBaseUrl("http://localhost:8080", false)).toBeNull();
    expect(resolveAppBaseUrl("http://localhost:8080", true)).toBe("http://localhost:8080");
  });
});
