// Provider onboarding routes (docs/provider-onboarding/slice-1-invite-to-form.md §5,
// docs/provider-onboarding/data-map.md).
//
// Staff side (full authenticate(), writers only): create, resend and cancel.
// Provider side (/api/intake/*, no JWT): the link, the emailed code, the
// HttpOnly session cookie, and with that session her saved state, her draft,
// her consent, her SSN and portal logins (straight to the vaults), her
// documents (held in the provider-intake-uploads bucket until Submit), Submit
// (her answers and documents onto her record) and help requests. Every
// write is one SECURITY DEFINER RPC that is EXECUTE-granted to service_role
// only and writes its own audit rows, so these handlers never call
// writeAudit. Storage is touched only at a path one of those RPCs returned
// for her journey. Nothing here logs a body, answer, email, code, token, SSN,
// login, file name or object path. While provider_intake_settings.paused is
// set, every route here but signout answers 503 intake_paused before it writes
// anything, and so does every intake route for a link whose org is offboarded.
// Signout only takes access away, so a pause never blocks it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail } from "./envelope";
import { isWriter, type AuthContext } from "./guard";
import { logServerError, type ErrorLogSite } from "./safeLog";
import { getServiceClient } from "./serviceClient";
import { resolveEmailEnv } from "./email/env";
import { EmailError, sendEmail } from "./email/sendgrid";
import type { SendEmailInput } from "./email/sendgrid";
import type { TemplateKey } from "./email/templates";
import {
  INVITE_TTL_DAYS,
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
  validateInviteInput,
} from "./intakeTokens";
import { CONSENT } from "@/lib/intakeConsent";
import {
  INTAKE_PASSWORD_MAX_LENGTH,
  INTAKE_USERNAME_MAX_LENGTH,
  intakeSubmission,
  isIntakePortal,
  parseIntakeAnswers,
  type IntakeAnswers,
  type IntakeState,
} from "@/lib/intakeAnswers";
import { SSN_NOT_ISSUED_MESSAGE, isIsoDate, isPossibleSsn } from "@/lib/providerIdentity";
import type { DraftStep, HelpReason, LockedField } from "@/lib/intakeFlow";
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

export interface IntakeConfig {
  appBaseUrl: string | null;
  fromEmail: string | null;
  emailReady: boolean;
  secureCookie: boolean;
  /** ONBOARDING_OPS_EMAIL: told when a provider submits or asks for help. */
  opsEmail: string | null;
}

// The origin the invite email links to. Anything but a bare https origin (or
// http://localhost in dev) counts as missing, so a typo is a 500, not a bad link.
export function resolveAppBaseUrl(raw: string | undefined, dev: boolean): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(dev && local && url.protocol === "http:")) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveIntakeConfig(): IntakeConfig {
  const email = resolveEmailEnv();
  return {
    appBaseUrl: resolveAppBaseUrl(process.env.APP_BASE_URL, Boolean(import.meta.env.DEV)),
    fromEmail: email.fromEmail ?? null,
    emailReady: Boolean(email.apiKey && email.fromEmail),
    // Safari drops Secure cookies on http://localhost.
    secureCookie: !import.meta.env.DEV,
    opsEmail: process.env.ONBOARDING_OPS_EMAIL?.trim() || null,
  };
}

export interface IntakeDeps {
  config: IntakeConfig;
  send: <K extends TemplateKey>(input: SendEmailInput<K>) => Promise<{ sandbox: boolean }>;
  now: () => Date;
}

function defaultDeps(): IntakeDeps {
  return {
    config: resolveIntakeConfig(),
    send: (input) => sendEmail(input),
    now: () => new Date(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inviteExpiry(now: Date): string {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  return response;
}

// What staff are told about the email. "sandbox" means SendGrid accepted it
// in sandbox mode (SENDGRID_SANDBOX is exactly "true"), so nothing was
// delivered. A failure is never an error, because the invite is already saved.
export type Delivery = "sent" | "sandbox" | "failed";

async function trySend<K extends TemplateKey>(
  deps: IntakeDeps,
  input: SendEmailInput<K>,
): Promise<Delivery> {
  try {
    const { sandbox } = await deps.send(input);
    return sandbox ? "sandbox" : "sent";
  } catch (error) {
    if (!(error instanceof EmailError)) throw error;
    console.warn("[intake] email not sent:", error.kind, error.status ?? "");
    return "failed";
  }
}

// What happened to an email is kept on its invite or code. Losing that note
// must never fail a request whose email already went out.
async function recordDelivery(
  db: SupabaseClient<Database>,
  kind: "invite" | "code" | "submitted",
  id: string,
  delivery: Delivery,
  site: ErrorLogSite,
): Promise<void> {
  try {
    const { error } = await db.rpc("record_intake_email_delivery", {
      p_kind: kind,
      p_id: id,
      p_delivery: delivery,
    });
    if (error) throw error;
  } catch (error) {
    logServerError("[intake] email delivery not recorded", error, site);
  }
}

async function intakePaused(db: SupabaseClient<Database>): Promise<boolean> {
  const { data, error } = await db.rpc("intake_paused");
  if (error) throw error;
  return data === true;
}

// The off switch, or this link's org is offboarded, whose write freeze would
// refuse her sign-in after the code had gone out.
async function intakeLinkPaused(db: SupabaseClient<Database>, token: string): Promise<boolean> {
  const { data, error } = await db.rpc("intake_link_paused", { p_token_hash: hashToken(token) });
  if (error) throw error;
  return data === true;
}

const PAUSED_ERROR = "intake_paused";

function notConfigured(config: IntakeConfig): boolean {
  return !config.emailReady || !config.appBaseUrl || !config.fromEmail;
}

function actorName(ctx: AuthContext): string {
  return ctx.userName ?? ctx.email ?? "";
}

function replyToFor(ctx: AuthContext, config: IntakeConfig) {
  return { email: ctx.email ?? (config.fromEmail as string), name: ctx.userName ?? undefined };
}

type RpcResult = Record<string, unknown> | null;

export async function handleCreateProviderInvite(
  body: unknown,
  ctx: AuthContext,
  deps: IntakeDeps = defaultDeps(),
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can invite providers");
  if (notConfigured(deps.config)) return fail(500, "Provider invites are not configured");
  const parsed = validateInviteInput(body);
  if (!parsed.ok) return fail(422, parsed.error);
  if (await intakePaused(ctx.db)) return fail(503, PAUSED_ERROR);

  const token = newToken();
  const { data, error } = await ctx.db.rpc("create_provider_intake_invite", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_input: { ...parsed.input },
    p_token_hash: hashToken(token),
    p_expires_at: inviteExpiry(deps.now()),
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "invalid_input":
      return fail(422, "First name, last name, email and group are required");
    case "group_not_found":
      return fail(404, "Group not found");
    case "duplicate":
      return ok({ outcome: "already_exists", providerId: result.provider_id as string });
    case "added_group":
      return ok({ outcome: "added_group", providerId: result.provider_id as string });
    case "conflict":
      return fail(
        409,
        "More than one provider in this organization has this email or NPI. Nothing was saved or sent. Check their records, then invite again.",
      );
    case "created": {
      const practiceName = String(result.practice_name ?? "");
      const delivery = await trySend(deps, {
        to: parsed.input.email,
        template: "provider_invitation",
        data: {
          practiceName,
          firstName: parsed.input.first_name,
          link: `${deps.config.appBaseUrl}/intake/${token}`,
        },
        practiceName,
        replyTo: replyToFor(ctx, deps.config),
      });
      await recordDelivery(ctx.db, "invite", String(result.invite_id), delivery, {
        method: "POST",
        route: "/api/provider-invites",
      });
      return ok(
        { outcome: "created", providerId: result.provider_id as string, delivery },
        null,
        201,
      );
    }
    default:
      throw new Error("create_provider_intake_invite returned an unknown result");
  }
}

export async function handleResendProviderInvite(
  providerId: string,
  ctx: AuthContext,
  deps: IntakeDeps = defaultDeps(),
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can resend invites");
  if (notConfigured(deps.config)) return fail(500, "Provider invites are not configured");
  if (!UUID.test(providerId)) return fail(404, "Invite not found");
  if (await intakePaused(ctx.db)) return fail(503, PAUSED_ERROR);

  const token = newToken();
  const { data, error } = await ctx.db.rpc("resend_provider_intake_invite", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_provider_id: providerId,
    p_token_hash: hashToken(token),
    p_expires_at: inviteExpiry(deps.now()),
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "not_found":
      return fail(404, "Invite not found");
    case "cooldown":
      return fail(429, "An invite was sent in the last 10 minutes. Try again shortly.");
    case "resent": {
      const practiceName = String(result.practice_name ?? "");
      // The RPC picks the address (the record's current email), which may not
      // be what staff typed into the dialog, so the response says which it was.
      const email = String(result.email);
      const delivery = await trySend(deps, {
        to: email,
        template: "provider_invitation",
        data: {
          practiceName,
          firstName: String(result.first_name ?? ""),
          link: `${deps.config.appBaseUrl}/intake/${token}`,
        },
        practiceName,
        replyTo: replyToFor(ctx, deps.config),
      });
      await recordDelivery(ctx.db, "invite", String(result.invite_id), delivery, {
        method: "POST",
        route: "/api/provider-invites/:param/resend",
      });
      return ok({ delivery, email });
    }
    default:
      throw new Error("resend_provider_intake_invite returned an unknown result");
  }
}

const STORAGE_PAGE = 100;

interface StoragePrefix {
  bucket: string;
  prefix: string;
}

async function objectsUnder(
  db: SupabaseClient<Database>,
  { bucket, prefix }: StoragePrefix,
): Promise<string[]> {
  const store = db.storage.from(bucket);
  const files: string[] = [];
  const folders = [prefix.replace(/\/$/, "")];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (let offset = 0; ; offset += STORAGE_PAGE) {
      const { data, error } = await store.list(folder, { limit: STORAGE_PAGE, offset });
      if (error) throw error;
      for (const entry of data) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else files.push(path);
      }
      if (data.length < STORAGE_PAGE) break;
    }
  }
  return files;
}

// Cancel (D9). The RPC revokes her access and deletes the record or closes
// the journey in one transaction, then names the Storage prefixes that held
// her files. A file that can't be deleted waits under a journey that is no
// longer open, where a sweep can find it, and the cancel still answers 200.
export async function handleCancelProviderOnboarding(
  providerId: string,
  ctx: AuthContext,
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can cancel an onboarding");
  if (!UUID.test(providerId)) return fail(404, "Onboarding not found");

  const { data, error } = await ctx.db.rpc("cancel_provider_onboarding", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_provider_id: providerId,
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "not_found":
      return fail(404, "Onboarding not found");
    case "already_submitted":
      return fail(409, "already_submitted");
    case "deleted":
    case "closed":
      for (const prefix of result.storage as StoragePrefix[]) {
        try {
          const files = await objectsUnder(ctx.db, prefix);
          const store = ctx.db.storage.from(prefix.bucket);
          for (let i = 0; i < files.length; i += STORAGE_PAGE) {
            const { error: removeError } = await store.remove(files.slice(i, i + STORAGE_PAGE));
            if (removeError) throw removeError;
          }
        } catch (storageError) {
          logServerError("[onboarding] cancelled files not deleted", storageError, {
            method: "POST",
            route: "/api/provider-invites/:param/cancel",
          });
        }
      }
      return ok({ outcome: result.result });
    default:
      throw new Error("cancel_provider_onboarding returned an unknown result");
  }
}

// Every provider-side action, with its body bound and whether it changes
// anything (those refuse a request from another site). A draft carries every
// answer, so it gets the bigger bound.
const INTAKE_ACTIONS = {
  link: { maxBytes: 4096, writes: false },
  code: { maxBytes: 4096, writes: true },
  session: { maxBytes: 4096, writes: true },
  state: { maxBytes: 4096, writes: false },
  draft: { maxBytes: 32 * 1024, writes: true },
  consent: { maxBytes: 4096, writes: true },
  ssn: { maxBytes: 4096, writes: true },
  login: { maxBytes: 4096, writes: true },
  "upload-intent": { maxBytes: 4096, writes: true },
  "upload-finalize": { maxBytes: 4096, writes: true },
  "upload-remove": { maxBytes: 4096, writes: true },
  "upload-expiry": { maxBytes: 4096, writes: true },
  submit: { maxBytes: 4096, writes: true },
  help: { maxBytes: 4096, writes: true },
  signout: { maxBytes: 4096, writes: true },
} as const;
type IntakeAction = keyof typeof INTAKE_ACTIONS;
export const INTAKE_ACTION_NAMES = Object.keys(INTAKE_ACTIONS) as IntakeAction[];

const INTAKE_ROUTE = /^\/api\/intake\/([a-z-]+)\/?$/;
const CODE = /^\d{6}$/;
const DRAFT_STEPS: readonly string[] = ["form", "documents"] satisfies DraftStep[];
const TYPED_NAME_MAX = 200;

function isAction(value: string): value is IntakeAction {
  return Object.hasOwn(INTAKE_ACTIONS, value);
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
  const action = new URL(request.url).pathname.match(INTAKE_ROUTE)?.[1] ?? "";
  if (!isAction(action)) return fail(404, "Not found");
  const method = request.method.toUpperCase();

  if (method !== "POST") return noStore(fail(405, "Method not allowed"));
  if (!isJsonRequest(request)) return noStore(fail(415, "Send application/json"));
  if (INTAKE_ACTIONS[action].writes && !originMatchesHost(request)) {
    return noStore(fail(403, "forbidden_origin"));
  }
  // A missing email env is a server fault, so it answers 500 before the
  // database is asked anything, paused or not.
  if (action === "code" && !deps.config.emailReady) {
    return noStore(fail(500, "Provider intake is not configured"));
  }
  const db = injectedDb ?? getServiceClient();
  const body = await readBody(INTAKE_ACTIONS[action].maxBytes);
  if (action !== "signout" && (await intakeLinkPaused(db, field(body, "t")))) {
    return noStore(fail(503, PAUSED_ERROR));
  }

  switch (action) {
    case "link":
      return noStore(await readLink(body, db));
    case "code":
      return noStore(await issueCode(body, db, deps));
    case "session":
      return noStore(await openSession(body, db, deps));
    case "state":
      return noStore(await readState(request, body, db));
    case "draft":
      return noStore(await saveDraft(request, body, db));
    case "consent":
      return noStore(await signConsent(request, body, db));
    case "ssn":
      return noStore(await storeSsn(request, body, db));
    case "login":
      return noStore(await storeLogin(request, body, db));
    case "upload-intent":
      return noStore(await beginUpload(request, body, db));
    case "upload-finalize":
      return noStore(await finishUpload(request, body, db));
    case "upload-remove":
      return noStore(await removeUpload(request, body, db));
    case "upload-expiry":
      return noStore(await setUploadExpiry(request, body, db));
    case "submit":
      return noStore(await submit(request, body, db, deps));
    case "help":
      return noStore(await requestHelp(request, body, db, deps));
    case "signout":
      return noStore(await signOut(request, db, deps));
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

// The session cookie and the link it must belong to, hashed for the RPCs.
// Null when either is missing: the caller answers signed_out.
function sessionKeys(
  request: Request,
  body: unknown,
): { p_session_hash: string; p_token_hash: string } | null {
  const sessionToken = readSessionToken(request);
  const token = field(body, "t");
  if (!sessionToken || !token) return null;
  return { p_session_hash: hashToken(sessionToken), p_token_hash: hashToken(token) };
}

const SIGNED_OUT = "signed_out";
const CLOSED = "intake_closed";

const LOCKED_FIELDS: Record<string, LockedField> = {
  ssn: "ssn",
  npi: "npi",
  date_of_birth: "dateOfBirth",
};

// Bound to the link being opened: a session from another invite is signed out.
async function readState(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const { data, error } = await db.rpc("read_intake_state", keys);
  if (error) throw error;
  const row = data as RpcResult;
  if (!row) return fail(401, SIGNED_OUT);
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
    lockedFields: (row.locked_fields as string[]).flatMap((f) => LOCKED_FIELDS[f] ?? []),
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

async function saveDraft(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const answers = parseIntakeAnswers(body.answers);
  if (!answers) return fail(422, "invalid_answers");
  if (typeof body.step !== "string" || !DRAFT_STEPS.includes(body.step)) {
    return fail(422, "invalid_step");
  }
  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return fail(422, "invalid_version");
  }

  const { data, error } = await db.rpc("save_intake_draft", {
    ...keys,
    p_answers: answers,
    p_step: body.step,
    p_expected_version: version,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "saved":
      return ok({ version: Number(result.version) });
    case "conflict":
      return fail(409, "draft_conflict", { draft_version: Number(result.version) });
    case "closed":
      return fail(409, CLOSED);
    default:
      throw new Error("save_intake_draft returned an unknown result");
  }
}

async function signConsent(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  if (body.version !== CONSENT.version) return fail(422, "consent_version");
  const typedName = field(body, "typedName");
  if (!typedName || typedName.length > TYPED_NAME_MAX) return fail(422, "invalid_name");

  const { data, error } = await db.rpc("sign_intake_consent", {
    ...keys,
    p_typed_name: typedName,
    p_text_version: CONSENT.version,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "signed":
      return ok({ signed: true });
    case "closed":
      return fail(409, CLOSED);
    default:
      throw new Error("sign_intake_consent returned an unknown result");
  }
}

// The full number goes from her request to the vault RPC and nowhere else:
// the response carries only the last 4.
async function storeSsn(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const ssn = typeof body.ssn === "string" ? body.ssn.replace(/[\s-]/g, "") : "";
  if (!isPossibleSsn(ssn)) return fail(422, "ssn_invalid", { message: SSN_NOT_ISSUED_MESSAGE });

  const { data, error } = await db.rpc("store_intake_ssn", { ...keys, p_ssn: ssn });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "stored":
      return ok({ ssnLast4: String(result.ssn_last4) });
    case "locked":
      return fail(409, "field_locked");
    case "closed":
      return fail(409, CLOSED);
    default:
      throw new Error("store_intake_ssn returned an unknown result");
  }
}

// A password is stored exactly as typed; only the username is trimmed.
async function storeLogin(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const { portal, password } = body;
  if (!isIntakePortal(portal)) return fail(422, "invalid_portal");
  const username = field(body, "username");
  if (!username || username.length > INTAKE_USERNAME_MAX_LENGTH) {
    return fail(422, "invalid_username");
  }
  if (typeof password !== "string" || !password || password.length > INTAKE_PASSWORD_MAX_LENGTH) {
    return fail(422, "invalid_password");
  }

  const { data, error } = await db.rpc("store_intake_portal_login", {
    ...keys,
    p_portal: portal,
    p_username: username,
    p_password: password,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "stored":
      return ok({ portal, onFile: true });
    case "closed":
      return fail(409, CLOSED);
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

const UPLOAD_NOT_FOUND = "upload_not_found";

function uploadIdOf(body: Record<string, unknown>): string | null {
  return typeof body.uploadId === "string" && UUID.test(body.uploadId) ? body.uploadId : null;
}

function uploadMiss(result: unknown, rpc: string): Response {
  if (result === "not_found") return fail(404, UPLOAD_NOT_FOUND);
  if (result === "closed") return fail(409, CLOSED);
  throw new Error(`${rpc} returned an unknown result`);
}

function uploadBucket(db: SupabaseClient<Database>) {
  return db.storage.from(INTAKE_UPLOAD_BUCKET);
}

// The browser names a slot and describes a file; the RPC picks the path. The
// raw file name goes no further than this handler: the database, the path
// and the response carry only its storage-safe form.
async function beginUpload(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
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
  const problem = validateUpload({ name: fileName, type: contentType, size: sizeBytes });
  if (problem) return fail(422, "invalid_file", { message: problem });
  const expiresOn = body.expiresOn ?? null;
  if (expiresOn !== null && (!rule.needsExpiration || !isIsoDate(expiresOn))) {
    return fail(422, "invalid_expiry");
  }

  const { data, error } = await db.rpc("begin_intake_upload", {
    ...keys,
    p_slot_key: slotKey as string,
    p_doc_type: rule.kind,
    p_file_name: safeFileName(normalizeDocumentFileName(fileName, fileName, contentType)),
    p_size_bytes: sizeBytes,
    p_content_type: contentType,
    p_expires_on: expiresOn,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  if (result.result === "closed") return fail(409, CLOSED);
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
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);

  const { data, error } = await db.rpc("read_intake_upload", { ...keys, p_upload_id: uploadId });
  if (error) throw error;
  const found = data as RpcResult;
  if (!found) return fail(401, SIGNED_OUT);
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

  const { data: finished, error: finishError } = await db.rpc("finish_intake_upload", {
    ...keys,
    p_upload_id: uploadId,
    p_size_bytes: stored.size as number,
  });
  if (finishError) throw finishError;
  const result = finished as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  if (result.result === "finalized") return ok({ upload });
  return uploadMiss(result.result, "finish_intake_upload");
}

// A delete that fails is a server fault: the RPC answers removed again on a
// retry, with the same path, so trying again finishes the job.
async function removeUpload(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);

  const { data, error } = await db.rpc("remove_intake_upload", { ...keys, p_upload_id: uploadId });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  if (result.result !== "removed") return uploadMiss(result.result, "remove_intake_upload");
  const { error: removeError } = await uploadBucket(db).remove([String(result.object_path)]);
  if (removeError) throw removeError;
  return ok({ removed: true });
}

async function setUploadExpiry(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const uploadId = uploadIdOf(body);
  if (!uploadId) return fail(404, UPLOAD_NOT_FOUND);
  const expiresOn = body.expiresOn ?? null;
  if (expiresOn !== null && !isIsoDate(expiresOn)) return fail(422, "invalid_expiry");

  const { data, error } = await db.rpc("set_intake_upload_expiry", {
    ...keys,
    p_upload_id: uploadId,
    p_expires_on: expiresOn,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  if (result.result === "saved") return ok({ expiresOn });
  if (result.result === "not_dated") return fail(422, "invalid_expiry");
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
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return fail(422, "invalid_version");
  }

  const { data, error } = await db.rpc("read_intake_state", keys);
  if (error) throw error;
  const row = data as RpcResult;
  if (!row) return fail(401, SIGNED_OUT);
  const state = toIntakeState(row);
  const orgId = String(row.org_id);
  const providerId = String(row.provider_id);
  const held = row.held_object_paths as string[];

  let uploads: IntakeUpload[] = [];
  if (!state.submitted) {
    const saved = state.draft?.version ?? 0;
    if (saved !== version) return fail(409, "draft_conflict", { draft_version: saved });
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
      return fail(409, "draft_conflict", { draft_version: Number(result.version) });
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

  if (result.result === "submitted" && result.first_time === true) {
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

// D10: the ops inbox hears of a Submit or a help request when
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

// The database's names for what she can ask to have fixed.
const FIX_FIELDS: Record<LockedField, string> = {
  npi: "npi",
  dateOfBirth: "date_of_birth",
  ssn: "ssn",
};

function parseHelpReason(raw: unknown): HelpReason | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "help") return { kind: "help" };
  if (raw.kind === "fix" && typeof raw.field === "string" && Object.hasOwn(FIX_FIELDS, raw.field)) {
    return { kind: "fix", field: raw.field as LockedField };
  }
  return null;
}

// "I need help" and "Wrong? Tell us". A second ask within a minute is the
// same ask (a double click): it answers sent and alerts nobody again.
async function requestHelp(
  request: Request,
  body: unknown,
  db: SupabaseClient<Database>,
  deps: IntakeDeps,
): Promise<Response> {
  if (!isRecord(body)) return fail(400, "invalid_body");
  const keys = sessionKeys(request, body);
  if (!keys) return fail(401, SIGNED_OUT);
  const reason = parseHelpReason(body.reason);
  if (!reason) return fail(422, "invalid_reason");

  const { data, error } = await db.rpc("request_intake_help", {
    ...keys,
    p_kind: reason.kind,
    p_field: reason.kind === "fix" ? FIX_FIELDS[reason.field] : null,
  });
  if (error) throw error;
  const result = data as RpcResult;
  if (!result) return fail(401, SIGNED_OUT);
  switch (result.result) {
    case "requested":
      await alertOps(deps, "help", String(result.practice_name ?? ""), String(result.provider_id));
      return ok({ sent: true });
    case "recent":
      return ok({ sent: true });
    case "closed":
      return fail(409, CLOSED);
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
