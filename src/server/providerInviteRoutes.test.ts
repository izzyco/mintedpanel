import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "./guard";
import { EmailError } from "./email/sendgrid";
import { hashToken } from "./intakeTokens";
import { resolveAppBaseUrl } from "./intakeShared";
import {
  handleCancelProviderOnboarding,
  handleCreateProviderInvite,
  handleResendProviderInvite,
} from "./providerInviteRoutes";
import {
  CONFIG,
  PAUSED,
  PROVIDER,
  body,
  fakeDb,
  makeDeps,
  rpcArgs,
  rpcNames,
  type RpcReply,
} from "./providerIntakeRoutes.testkit";

const GROUP = "0b6a3a52-3c9f-4f3e-9a51-6a1d2f6e7c11";
const INVITE_ID = "9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a";

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

  it("tells staff and records on the invite what happened to the email, and a failed send is still a 201", async () => {
    const outcomes = [
      ["sent", vi.fn().mockResolvedValue({ status: 202, sandbox: false })],
      ["sandbox", vi.fn().mockResolvedValue({ status: 200, sandbox: true })],
      ["failed", vi.fn().mockRejectedValue(new EmailError("provider_rejected", "x", 400))],
    ] as const;
    for (const [delivery, send] of outcomes) {
      const db = fakeDb({ result: "created", provider_id: PROVIDER, invite_id: INVITE_ID });
      const res = await handleCreateProviderInvite(INVITE, ctx(db), makeDeps({ send }).deps);
      expect(res.status, delivery).toBe(201);
      expect((await body(res)).data).toMatchObject({ delivery });
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
