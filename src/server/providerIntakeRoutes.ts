// Provider side of onboarding (/api/intake/*, no JWT;
// docs/provider-onboarding/slice-1-invite-to-form.md §5,
// docs/provider-onboarding/data-map.md): the link, the emailed code, the
// HttpOnly session cookie, and with that session her saved state, her draft,
// her consent, her SSN and portal logins (straight to the vaults), her
// documents (held in the provider-intake-uploads bucket until Submit), Submit
// (her answers and documents onto her record) and help requests. Every
// write is one SECURITY DEFINER RPC that is EXECUTE-granted to service_role
// only and writes its own audit rows, so these handlers never call
// writeAudit. Storage is touched only at a path one of those RPCs returned
// for her journey. Nothing here logs a body, answer, email, code, token, SSN,
// login, file name or object path. While provider_intake_settings.paused is
// set, every action here but signout answers 503 intake_paused before it
// writes anything, and so does every action for a link whose org is
// offboarded. Signout only takes access away, so a pause never blocks it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail } from "./envelope";
import { logServerError, type ErrorLogSite } from "./safeLog";
import { getServiceClient } from "./serviceClient";
import {
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  hashCode,
  hashToken,
  isJsonRequest,
  newCode,
  newToken,
  originMatchesHost,
  readSessionToken,
  sessionCookie,
} from "./intakeTokens";
import {
  PAUSED_ERROR,
  UUID,
  defaultDeps,
  recordDelivery,
  trySend,
  type IntakeDeps,
  type RpcResult,
} from "./intakeShared";
import { CONSENT } from "@/lib/intakeConsent";
import {
  INTAKE_PASSWORD_MAX_LENGTH,
  INTAKE_TYPED_NAME_MAX_LENGTH,
  INTAKE_USERNAME_MAX_LENGTH,
  intakeSubmission,
  isIntakePortal,
  parseIntakeAnswers,
  type IntakeAnswers,
  type IntakeState,
} from "@/lib/intakeAnswers";
import { isIsoDate, isPossibleSsn } from "@/lib/providerIdentity";
import {
  LOCKED_FIELD_COLUMN,
  isLockedField,
  lockedFieldOfColumn,
  type DraftStep,
  type HelpReason,
} from "@/lib/intakeFlow";
import {
  DOCUMENT_BUCKET,
  checkStoredObject,
  documentObjectPath,
  normalizeDocumentFileName,
  safeFileName,
} from "@/lib/documents";
import {
  INTAKE_MAX_BYTES,
  INTAKE_UPLOAD_BUCKET,
  intakeSlotRule,
  validateUpload,
} from "@/lib/providerOnboarding";
import type { IntakeUpload } from "@/lib/intakeAnswers";

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  return response;
}

// The off switch, or this link's org is offboarded, whose write freeze would
// refuse her sign-in after the code had gone out.
async function intakeLinkPaused(db: SupabaseClient<Database>, token: string): Promise<boolean> {
  const { data, error } = await db.rpc("intake_link_paused", { p_token_hash: hashToken(token) });
  if (error) throw error;
  return data === true;
}

interface IntakeActionRule {
  /** It changes something, so a request from another site is refused. */
  writes: boolean;
  /** Refused before its handler unless the body is an object (400) and her
   * cookie and the link are both there (401). */
  session: boolean;
  maxBytes?: number;
}

// Every provider-side action. `state` reads her session too, but checks it
// itself, so a body that isn't an object is a 401 there. A draft carries every
// answer, so it gets a bigger body bound than the rest.
const INTAKE_ACTIONS = {
  link: { writes: false, session: false },
  code: { writes: true, session: false },
  session: { writes: true, session: false },
  state: { writes: false, session: false },
  draft: { writes: true, session: true, maxBytes: 32 * 1024 },
  consent: { writes: true, session: true },
  ssn: { writes: true, session: true },
  login: { writes: true, session: true },
  "upload-intent": { writes: true, session: true },
  "upload-finalize": { writes: true, session: true },
  "upload-remove": { writes: true, session: true },
  "upload-expiry": { writes: true, session: true },
  submit: { writes: true, session: true },
  help: { writes: true, session: true },
  signout: { writes: true, session: false },
} as const satisfies Record<string, IntakeActionRule>;
const BODY_MAX_BYTES = 4096;
type IntakeAction = keyof typeof INTAKE_ACTIONS;
// Derives the ten session actions, so the switch on one below is exhaustive.
type SessionAction = {
  [A in IntakeAction]: (typeof INTAKE_ACTIONS)[A]["session"] extends true ? A : never;
}[IntakeAction];
export const INTAKE_ACTION_NAMES = Object.keys(INTAKE_ACTIONS) as IntakeAction[];

const SIGNED_OUT = "signed_out";
const CLOSED = "intake_closed";
const DRAFT_CONFLICT = "draft_conflict";
const INVALID_EXPIRY = "invalid_expiry";
const UPLOAD_NOT_FOUND = "upload_not_found";

const INTAKE_ROUTE = /^\/api\/intake\/([a-z-]+)\/?$/;
const CODE = /^\d{6}$/;
const DRAFT_STEPS: readonly string[] = ["form", "documents"] satisfies DraftStep[];

function isAction(value: string): value is IntakeAction {
  return Object.hasOwn(INTAKE_ACTIONS, value);
}

function isSessionAction(action: IntakeAction): action is SessionAction {
  return INTAKE_ACTIONS[action].session;
}

function field(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

// The provider side. `readBody` is api.ts's JSON reader, bounded to the bytes
// asked for; it answers null for a body over the bound or that isn't JSON.
export async function handleIntakeRequest(
  request: Request,
  readBody: (maxBytes: number) => Promise<unknown>,
  deps: IntakeDeps = defaultDeps(),
  injectedDb?: SupabaseClient<Database>,
): Promise<Response> {
  return noStore(await answerIntake(request, readBody, deps, injectedDb));
}

async function answerIntake(
  request: Request,
  readBody: (maxBytes: number) => Promise<unknown>,
  deps: IntakeDeps,
  injectedDb: SupabaseClient<Database> | undefined,
): Promise<Response> {
  const action = new URL(request.url).pathname.match(INTAKE_ROUTE)?.[1] ?? "";
  if (!isAction(action)) return fail(404, "Not found");
  const rule: IntakeActionRule = INTAKE_ACTIONS[action];
  const method = request.method.toUpperCase();

  if (method !== "POST") return fail(405, "Method not allowed");
  if (!isJsonRequest(request)) return fail(415, "Send application/json");
  if (rule.writes && !originMatchesHost(request)) return fail(403, "forbidden_origin");
  // A missing email env is a server fault, so it answers 500 before the
  // database is asked anything, paused or not.
  if (action === "code" && !deps.config.emailReady) {
    return fail(500, "Provider intake is not configured");
  }
  const db = injectedDb ?? getServiceClient();
  const body = await readBody(rule.maxBytes ?? BODY_MAX_BYTES);
  if (action !== "signout" && (await intakeLinkPaused(db, field(body, "t")))) {
    return fail(503, PAUSED_ERROR);
  }

  if (!isSessionAction(action)) {
    switch (action) {
      case "link":
        return readLink(body, db);
      case "code":
        return issueCode(body, db, deps);
      case "session":
        return openSession(body, db, deps);
      case "state":
        return readState(request, body, db);
      case "signout":
        return signOut(request, db, deps);
    }
  }
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  switch (action) {
    case "draft":
      return saveDraft(keys, body, db);
    case "consent":
      return signConsent(keys, body, db);
    case "ssn":
      return storeSsn(keys, body, db);
    case "login":
      return storeLogin(keys, body, db);
    case "upload-intent":
      return beginUpload(keys, body, db);
    case "upload-finalize":
      return finishUpload(keys, body, db);
    case "upload-remove":
      return removeUpload(keys, body, db);
    case "upload-expiry":
      return setUploadExpiry(keys, body, db);
    case "submit":
      return submit(keys, body, db, deps);
    case "help":
      return requestHelp(keys, body, db, deps);
  }
}

async function readLink(body: unknown, db: SupabaseClient<Database>): Promise<Response> {
  const token = field(body, "t");
  if (!token) return fail(404, "invalid_link");
  const { data, error } = await db.rpc("read_intake_link", { p_token_hash: hashToken(token) });
  if (error) throw error;
  const link = data as RpcResult;
  if (!link) return fail(404, "invalid_link");
  return ok({ practiceName: String(link.practice_name), email: String(link.email) });
}

// Always the same answer, whether or not a code was created or sent. A missing
// email env is the one exception (handled before dispatch): that is a server
// fault, not a link state, never a "sent" nobody can receive.
async function issueCode(
  body: unknown,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  const token = field(body, "t");
  if (token) {
    const code = newCode();
    const linkHash = hashToken(token);
    const { data, error } = await db.rpc("issue_intake_code", {
      p_token_hash: linkHash,
      p_code_hash: hashCode(linkHash, code),
    });
    if (error) throw error;
    const result = data as RpcResult;
    if (result?.send === true) {
      const practiceName = String(result.practice_name ?? "");
      const delivery = await trySend(deps, {
        to: String(result.email),
        template: "intake_code",
        data: { practiceName, code },
        practiceName,
        replyTo: { email: deps.config.fromEmail as string },
      });
      await recordDelivery(db, "code", String(result.code_id), delivery, {
        method: "POST",
        route: "/api/intake/code",
      });
    }
  }
  return ok({ sent: true });
}

async function openSession(
  body: unknown,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  const token = field(body, "t");
  const code = field(body, "code");
  if (!token || !CODE.test(code)) return fail(400, "code_invalid");

  const linkHash = hashToken(token);
  const sessionToken = newToken();
  const expiresAt = new Date(deps.now().getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await db.rpc("verify_intake_code", {
    p_token_hash: linkHash,
    p_code_hash: hashCode(linkHash, code),
    p_session_hash: hashToken(sessionToken),
    p_session_expires_at: expiresAt,
  });
  if (error) throw error;
  if (data !== "ok") return fail(400, "code_invalid");

  const response = ok({ signedIn: true });
  response.headers.append(
    "set-cookie",
    sessionCookie(sessionToken, { secure: deps.config.secureCookie }),
  );
  return response;
}

type SessionKeys = { p_session_hash: string; p_token_hash: string };

// The session cookie and the link it must belong to, hashed for the RPCs.
// Null when either is missing: the caller answers signed_out.
function sessionKeys(request: Request, body: unknown): SessionKeys | null {
  const sessionToken = readSessionToken(request);
  const token = field(body, "t");
  if (!sessionToken || !token) return null;
  return { p_session_hash: hashToken(sessionToken), p_token_hash: hashToken(token) };
}

// The two answers every session RPC shares: no row is a dead session or one
// from another link, and "closed" is a journey that has ended. Anything else
// is the RPC's own row.
function sessionAnswer({
  data,
  error,
}: {
  data: unknown;
  error: unknown;
}): Record<string, unknown> | Response {
  if (error) throw error;
  if (!data) return fail(401, SIGNED_OUT);
  if (!isRecord(data)) throw new Error("a session RPC returned an unknown answer");
  if (data.result === "closed") return fail(409, CLOSED);
  return data;
}

// Bound to the link being opened: a session from another invite is signed out.
async function readState(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const row = sessionAnswer(await db.rpc("read_intake_state", keys));
  if (row instanceof Response) return row;
  return ok(toIntakeState(row));
}

// read_intake_state's row, as the form opens with it. The row's org,
// provider and held paths are the submit route's alone and go no further.
function toIntakeState(row: Record<string, unknown>): IntakeState {
  const saved = row.draft as Record<string, unknown> | null;
  // Saved answers went through the same parser on the way in, so a draft
  // that fails it now is a server fault.
  const answers = saved ? parseIntakeAnswers(saved.answers) : null;
  if (saved && !answers) throw new Error("read_intake_state returned an unreadable draft");
  return {
    practiceName: String(row.practice_name),
    email: String(row.email),
    // Built by read_intake_state in exactly the answers shape.
    record: row.record as IntakeAnswers,
    lockedFields: (row.locked_fields as string[]).flatMap((f) => lockedFieldOfColumn(f) ?? []),
    ssnLast4: typeof row.ssn_last4 === "string" ? row.ssn_last4 : null,
    loginsOnFile: {
      caqh: (row.logins_on_file as Record<string, unknown>).caqh === true,
      pecos: (row.logins_on_file as Record<string, unknown>).pecos === true,
    },
    consent: {
      signed: row.consented === true,
      textVersion: typeof row.consent_text_version === "number" ? row.consent_text_version : null,
    },
    draft:
      saved && answers
        ? {
            answers,
            step: saved.step as DraftStep,
            version: Number(saved.version),
            updatedAt: String(saved.updated_at),
          }
        : null,
    uploads: (row.uploads as Record<string, unknown>[]).map(toUpload),
    submitted: row.submitted === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function saveDraft(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const answers = parseIntakeAnswers(body.answers);
  if (!answers) return fail(422, "invalid_answers");
  if (typeof body.step !== "string" || !DRAFT_STEPS.includes(body.step)) {
    return fail(422, "invalid_step");
  }
  const version = body.version;
  if (!isVersion(version)) return fail(422, "invalid_version");

  const result = sessionAnswer(
    await db.rpc("save_intake_draft", {
      ...keys,
      p_answers: answers,
      p_step: body.step,
      p_expected_version: version,
    }),
  );
  if (result instanceof Response) return result;
  switch (result.result) {
    case "saved":
      return ok({ version: Number(result.version) });
    case "conflict":
      return fail(409, DRAFT_CONFLICT);
    default:
      throw new Error("save_intake_draft returned an unknown result");
  }
}

async function signConsent(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (body.version !== CONSENT.version) return fail(422, "consent_version");
  const typedName = field(body, "typedName");
  if (!typedName || typedName.length > INTAKE_TYPED_NAME_MAX_LENGTH) {
    return fail(422, "invalid_name");
  }

  const result = sessionAnswer(
    await db.rpc("sign_intake_consent", {
      ...keys,
      p_typed_name: typedName,
      p_text_version: CONSENT.version,
    }),
  );
  if (result instanceof Response) return result;
  switch (result.result) {
    case "signed":
      return ok({ signed: true });
    default:
      throw new Error("sign_intake_consent returned an unknown result");
  }
}

// The full number goes from her request to the vault RPC and nowhere else:
// the response carries only the last 4.
async function storeSsn(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const ssn = typeof body.ssn === "string" ? body.ssn.replace(/[\s-]/g, "") : "";
  if (!isPossibleSsn(ssn)) return fail(422, "ssn_invalid");

  const result = sessionAnswer(await db.rpc("store_intake_ssn", { ...keys, p_ssn: ssn }));
  if (result instanceof Response) return result;
  switch (result.result) {
    case "stored":
      return ok({ ssnLast4: String(result.ssn_last4) });
    case "locked":
      return fail(409, "field_locked");
    default:
      throw new Error("store_intake_ssn returned an unknown result");
  }
}

// A password is stored exactly as typed; only the username is trimmed.
async function storeLogin(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const { portal, password } = body;
  if (!isIntakePortal(portal)) return fail(422, "invalid_portal");
  const username = field(body, "username");
  if (!username || username.length > INTAKE_USERNAME_MAX_LENGTH) {
    return fail(422, "invalid_username");
  }
  if (typeof password !== "string" || !password || password.length > INTAKE_PASSWORD_MAX_LENGTH) {
    return fail(422, "invalid_password");
  }

  const result = sessionAnswer(
    await db.rpc("store_intake_portal_login", {
      ...keys,
      p_portal: portal,
      p_username: username,
      p_password: password,
    }),
  );
  if (result instanceof Response) return result;
  switch (result.result) {
    case "stored":
      return ok({ portal, onFile: true });
    default:
      throw new Error("store_intake_portal_login returned an unknown result");
  }
}

// An upload as read_intake_state and read_intake_upload build it.
function toUpload(row: Record<string, unknown>): IntakeUpload {
  return {
    id: String(row.id),
    slotKey: String(row.slot_key),
    kind: row.doc_type as IntakeUpload["kind"],
    fileName: String(row.file_name),
    sizeBytes: Number(row.size_bytes),
    expiresOn: typeof row.expires_on === "string" ? row.expires_on : null,
  };
}

function uploadIdOf(body: Record<string, unknown>): string | null {
  return typeof body.uploadId === "string" && UUID.test(body.uploadId) ? body.uploadId : null;
}

function uploadMiss(result: unknown, rpc: string): Response {
  if (result === "not_found") return fail(404, UPLOAD_NOT_FOUND);
  throw new Error(`${rpc} returned an unknown result`);
}

function uploadBucket(db: SupabaseClient<Database>) {
  return db.storage.from(INTAKE_UPLOAD_BUCKET);
}

// The browser names a slot and describes a file; the RPC picks the path. The
// raw file name goes no further than this handler: the database, the path
// and the response carry only its storage-safe form.
async function beginUpload(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const { slotKey, kind, fileName, sizeBytes, contentType } = body;
  const rule = typeof slotKey === "string" ? intakeSlotRule(slotKey) : null;
  if (!rule || kind !== rule.kind) return fail(422, "invalid_slot");
  if (
    typeof fileName !== "string" ||
    typeof contentType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes)
  ) {
    return fail(422, "invalid_file");
  }
  if (validateUpload({ name: fileName, type: contentType, size: sizeBytes })) {
    return fail(422, "invalid_file");
  }
  const expiresOn = body.expiresOn ?? null;
  if (expiresOn !== null && (!rule.needsExpiration || !isIsoDate(expiresOn))) {
    return fail(422, INVALID_EXPIRY);
  }

  const result = sessionAnswer(
    await db.rpc("begin_intake_upload", {
      ...keys,
      p_slot_key: slotKey as string,
      p_doc_type: rule.kind,
      p_file_name: safeFileName(normalizeDocumentFileName(fileName, fileName, contentType)),
      p_size_bytes: sizeBytes,
      p_content_type: contentType,
      p_expires_on: expiresOn,
    }),
  );
  if (result instanceof Response) return result;
  if (result.result !== "started")
    throw new Error("begin_intake_upload returned an unknown result");

  const bucket = uploadBucket(db);
  // The replaced row is already marked removed and keeps its path, so a file
  // left behind here can still be found and deleted later.
  if (typeof result.replaced_object_path === "string") {
    const { error: removeError } = await bucket.remove([result.replaced_object_path]);
    if (removeError) {
      logServerError("[intake] replaced upload not deleted", removeError, {
        method: "POST",
        route: "/api/intake/upload-intent",
      });
    }
  }
  const { data: signed, error: signError } = await bucket.createSignedUploadUrl(
    String(result.object_path),
  );
  if (signError || !signed) throw new Error("Failed to create a signed upload target");
  return ok({ uploadId: String(result.upload_id), uploadUrl: signed.signedUrl });
}

// The object must be at the upload's path with the size and type she
// declared before the upload counts. Anything else is deleted, so a file that
// doesn't match what was checked never waits for Submit.
async function finishUpload(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);

  const found = sessionAnswer(
    await db.rpc("read_intake_upload", { ...keys, p_upload_id: uploadId }),
  );
  if (found instanceof Response) return found;
  if (found.result !== "found") return uploadMiss(found.result, "read_intake_upload");
  const upload = toUpload(found.upload as Record<string, unknown>);
  const path = String(found.object_path);

  const bucket = uploadBucket(db);
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const { data: objects, error: listError } = await bucket.list(path.slice(0, slash), {
    search: name,
  });
  if (listError) throw listError;
  const stored = checkStoredObject(
    (objects ?? []).find((o) => o.name === name),
    {
      maxBytes: INTAKE_MAX_BYTES,
      mimeType: String(found.content_type),
      sizeBytes: upload.sizeBytes,
    },
  );
  if (!stored.ok) {
    const { error: removeError } = await bucket.remove([path]);
    if (removeError) throw removeError;
    const { error: rpcError } = await db.rpc("remove_intake_upload", {
      ...keys,
      p_upload_id: uploadId,
    });
    if (rpcError) throw rpcError;
    return fail(422, "upload_rejected");
  }

  const result = sessionAnswer(
    await db.rpc("finish_intake_upload", {
      ...keys,
      p_upload_id: uploadId,
      p_size_bytes: stored.size as number,
    }),
  );
  if (result instanceof Response) return result;
  if (result.result === "finalized") return ok({ upload });
  return uploadMiss(result.result, "finish_intake_upload");
}

// A delete that fails is a server fault: the RPC answers removed again on a
// retry, with the same path, so trying again finishes the job.
async function removeUpload(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);

  const result = sessionAnswer(
    await db.rpc("remove_intake_upload", { ...keys, p_upload_id: uploadId }),
  );
  if (result instanceof Response) return result;
  if (result.result !== "removed") return uploadMiss(result.result, "remove_intake_upload");
  const { error: removeError } = await uploadBucket(db).remove([String(result.object_path)]);
  if (removeError) throw removeError;
  return ok({ removed: true });
}

async function setUploadExpiry(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);
  const expiresOn = body.expiresOn ?? null;
  if (expiresOn !== null && !isIsoDate(expiresOn)) return fail(422, INVALID_EXPIRY);

  const result = sessionAnswer(
    await db.rpc("set_intake_upload_expiry", {
      ...keys,
      p_upload_id: uploadId,
      p_expires_on: expiresOn,
    }),
  );
  if (result instanceof Response) return result;
  if (result.result === "saved") return ok({ expiresOn });
  if (result.result === "not_dated") return fail(422, INVALID_EXPIRY);
  return uploadMiss(result.result, "set_intake_upload_expiry");
}

// The vault path Submit copies an upload to (family = upload id, version 1).
function vaultPath(orgId: string, providerId: string, uploadId: string, fileName: string): string {
  return documentObjectPath({
    orgId,
    ownerType: "provider",
    ownerId: providerId,
    familyId: uploadId,
    version: 1,
    fileName,
  });
}

// A copy onto an object that is already there. Local Storage answers status
// 400 with statusCode "409"; other Storage versions put 409 in either field,
// as a number, or say so only in words.
function isAlreadyThere(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (String(error.statusCode) === "409" || String(error.status) === "409") return true;
  return [error.error, error.message].some(
    (text) => typeof text === "string" && /duplicate|already exists/i.test(text),
  );
}

const SUBMIT_SITE: ErrorLogSite = { method: "POST", route: "/api/intake/submit" };

// A type, not an interface, so it is assignable to the RPC's Json argument.
type VaultCopy = { upload_id: string; file_path: string };

// A Submit that did not commit leaves copies no document row points at. A
// copy that has its row stays: a thrown error can mean the RPC committed and
// only its answer was lost.
async function removeUncommittedCopies(
  db: SupabaseClient<Database>,
  orgId: string,
  copies: VaultCopy[],
): Promise<void> {
  if (copies.length === 0) return;
  try {
    const ids = copies.map((copy) => copy.upload_id);
    const { data, error } = await db
      .from("provider_documents")
      .select("id")
      .eq("org_id", orgId)
      .in("id", ids);
    if (error) throw error;
    const kept = new Set((data ?? []).map((row) => row.id));
    const paths = copies.filter((copy) => !kept.has(copy.upload_id)).map((copy) => copy.file_path);
    if (paths.length === 0) return;
    const { error: removeError } = await db.storage.from(DOCUMENT_BUCKET).remove(paths);
    if (removeError) throw removeError;
  } catch (cleanupError) {
    logServerError("[intake] uncommitted vault copies not deleted", cleanupError, SUBMIT_SITE);
  }
}

// Submit. The checks the form runs, then each held file is copied into the
// vault, then one RPC writes her answers, the document rows and submitted_at.
// Copying first means a row never points at a missing file; a copy that is
// already there counts, so a retry after any failure converges. An
// already-submitted journey skips the checks and the copies: the RPC answers
// already_submitted and nothing is sent again.
async function submit(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  const version = body.version;
  if (!isVersion(version)) return fail(422, "invalid_version");

  const row = sessionAnswer(await db.rpc("read_intake_state", keys));
  if (row instanceof Response) return row;
  const state = toIntakeState(row);
  const orgId = String(row.org_id);
  const providerId = String(row.provider_id);
  const held = row.held_object_paths as string[];

  let uploads: IntakeUpload[] = [];
  if (!state.submitted) {
    const saved = state.draft?.version ?? 0;
    if (saved !== version) return fail(409, DRAFT_CONFLICT);
    const submission = intakeSubmission(state);
    if (submission.missing.length > 0) {
      return fail(422, "intake_incomplete", { missing: submission.missing });
    }
    uploads = submission.uploads;
  }

  const documents: VaultCopy[] = [];
  let result: RpcResult;
  try {
    const bucket = uploadBucket(db);
    for (const upload of uploads) {
      // The object_path CHECK puts the upload id in its own path segment.
      const from = held.find((path) => path.includes(`/${upload.id}/`));
      if (!from) throw new Error("read_intake_state holds no path for an upload");
      const to = vaultPath(orgId, providerId, upload.id, upload.fileName);
      const { error: copyError } = await bucket.copy(from, to, {
        destinationBucket: DOCUMENT_BUCKET,
      });
      if (copyError && !isAlreadyThere(copyError)) throw copyError;
      documents.push({ upload_id: upload.id, file_path: to });
    }
    const { data: submitted, error: submitError } = await db.rpc("submit_provider_intake", {
      ...keys,
      p_expected_version: version,
      p_documents: documents,
    });
    if (submitError) throw submitError;
    result = submitted as RpcResult;
  } catch (error) {
    await removeUncommittedCopies(db, orgId, documents);
    throw error;
  }
  if (result?.result !== "submitted" && result?.result !== "already_submitted") {
    await removeUncommittedCopies(db, orgId, documents);
  }
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "conflict":
      return fail(409, DRAFT_CONFLICT);
    case "npi_in_use":
      return fail(409, "npi_in_use");
    case "closed":
      return fail(409, CLOSED);
    case "submitted":
    case "already_submitted":
      break;
    default:
      throw new Error("submit_provider_intake returned an unknown result");
  }

  // The vault has every file now, so the holding copies go. One that can't
  // be deleted waits under her journey's prefix for the cleanup job; she is
  // not held up for it.
  if (held.length > 0) {
    const { error: removeError } = await uploadBucket(db).remove(held);
    if (removeError) {
      logServerError("[intake] held files not deleted after submit", removeError, SUBMIT_SITE);
    }
  }

  // An upload that did not go in (replaced, or its slot left her form) can
  // still have a copy from an earlier Submit that failed. This Submit wrote
  // the only document rows her journey gets, so no row points at it.
  if (result.result === "submitted") {
    const included = new Set(documents.map((document) => document.upload_id));
    const unused = held.flatMap((path) => {
      const [, , , , uploadId, fileName] = path.split("/");
      return included.has(uploadId) ? [] : [vaultPath(orgId, providerId, uploadId, fileName)];
    });
    if (unused.length > 0) {
      const { error: removeError } = await db.storage.from(DOCUMENT_BUCKET).remove(unused);
      if (removeError) {
        logServerError("[intake] unused vault copies not deleted", removeError, SUBMIT_SITE);
      }
    }
  }

  if (result.result === "submitted") {
    const practiceName = String(result.practice_name ?? "");
    const delivery = await trySend(deps, {
      to: String(result.email),
      template: "intake_submitted",
      data: { practiceName, firstName: String(result.first_name ?? "") },
      practiceName,
      replyTo: { email: deps.config.fromEmail as string },
    });
    await recordDelivery(db, "submitted", String(result.onboarding_id), delivery, SUBMIT_SITE);
    await alertOps(deps, "submitted", practiceName, String(result.provider_id));
  }
  return ok({ submitted: true });
}

// The ops inbox hears of a Submit or a help request when
// ONBOARDING_OPS_EMAIL is set. The practice and a link to the record only.
async function alertOps(
  deps: IntakeDeps,
  kind: "submitted" | "help",
  practiceName: string,
  providerId: string,
): Promise<void> {
  const { opsEmail, appBaseUrl, fromEmail } = deps.config;
  if (!opsEmail || !appBaseUrl) return;
  await trySend(deps, {
    to: opsEmail,
    template: "onboarding_ops_alert",
    data: { practiceName, kind, link: `${appBaseUrl}/providers/${providerId}` },
    replyTo: { email: fromEmail ?? opsEmail },
  });
}

function parseHelpReason(raw: unknown): HelpReason | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "help") return { kind: "help" };
  if (raw.kind === "fix" && isLockedField(raw.field)) return { kind: "fix", field: raw.field };
  return null;
}

// "I need help" and "Wrong? Tell us". A second ask within a minute is the
// same ask (a double click): it answers sent and alerts nobody again.
async function requestHelp(
  keys: SessionKeys,
  body: Record<string, unknown>,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  const reason = parseHelpReason(body.reason);
  if (!reason) return fail(422, "invalid_reason");

  const result = sessionAnswer(
    await db.rpc("request_intake_help", {
      ...keys,
      p_kind: reason.kind,
      p_field: reason.kind === "fix" ? LOCKED_FIELD_COLUMN[reason.field] : null,
    }),
  );
  if (result instanceof Response) return result;
  switch (result.result) {
    case "requested":
      await alertOps(deps, "help", String(result.practice_name ?? ""), String(result.provider_id));
      return ok({ sent: true });
    case "recent":
      return ok({ sent: true });
    default:
      throw new Error("request_intake_help returned an unknown result");
  }
}

async function signOut(
  request: Request,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  const sessionToken = readSessionToken(request);
  if (sessionToken) {
    const { error } = await db.rpc("revoke_intake_session", {
      p_session_hash: hashToken(sessionToken),
    });
    if (error) throw error;
  }
  const response = ok({ signedOut: true });
  response.headers.append("set-cookie", clearSessionCookie({ secure: deps.config.secureCookie }));
  return response;
}
