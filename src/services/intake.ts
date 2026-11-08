// Provider intake. The provider has no Supabase login and no org, so this
// service calls /api/intake/* directly and skips requireActiveOrg() — the
// third such service (CLAUDE.md "Known warts"). The session is an HttpOnly
// cookie the browser sends on same-origin requests; nothing here stores it.
import type {
  IntakeAnswers,
  IntakePortal,
  IntakeState,
  IntakeUpload,
  RemoveDocumentResult,
  RequestHelpResult,
  SaveDraftResult,
  SaveLoginResult,
  SaveSsnResult,
  SetDocumentExpiryResult,
  SignConsentResult,
  SubmitIntakeResult,
  UploadDocumentResult,
} from "@/lib/intakeAnswers";
import { CONSENT } from "@/lib/intakeConsent";
import type { DraftStep, HelpReason } from "@/lib/intakeFlow";

interface Envelope<T> {
  data: T | null;
  error: string | null;
  meta?: { missing?: string[] } | null;
}

async function intakeFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`/api/intake/${path}`, {
    ...init,
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await response.json().catch(() => ({ data: null, error: null }))) as Envelope<T>;
  return { status: response.status, body };
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export interface IntakeLink {
  practiceName: string;
  email: string;
}

/** Null when the link is unknown, expired or revoked (one answer for all three). */
export async function readIntakeLink(token: string): Promise<IntakeLink | null> {
  const { status, body } = await intakeFetch<IntakeLink>("link", post({ t: token }));
  if (status === 404) return null;
  if (!body.data) throw new Error(body.error ?? `Request failed (${status})`);
  return body.data;
}

export async function requestIntakeCode(token: string): Promise<void> {
  const { status, body } = await intakeFetch<{ sent: boolean }>("code", post({ t: token }));
  if (!body.data) throw new Error(body.error ?? `Request failed (${status})`);
}

/** True when the code opened a session; false for any wrong, expired or used code. */
export async function openIntakeSession(token: string, code: string): Promise<boolean> {
  const { status, body } = await intakeFetch<{ signedIn: boolean }>(
    "session",
    post({ t: token, code }),
  );
  if (status === 400) return false;
  if (!body.data) throw new Error(body.error ?? `Request failed (${status})`);
  return true;
}

/** Null when there is no live session for this link. */
export async function readIntakeState(token: string): Promise<IntakeState | null> {
  const { status, body } = await intakeFetch<IntakeState>("state", post({ t: token }));
  if (status === 401) return null;
  if (!body.data) throw new Error(body.error ?? `Request failed (${status})`);
  return body.data;
}

/** Throws on any other failure, so the form keeps her answers and says it couldn't save. */
export async function saveIntakeDraft(
  token: string,
  answers: IntakeAnswers,
  step: DraftStep,
  version: number,
): Promise<SaveDraftResult> {
  const { status, body } = await intakeFetch<{ version: number }>(
    "draft",
    post({ t: token, answers, step, version }),
  );
  if (status === 200 && body.data) return { kind: "saved", version: body.data.version };
  if (status === 401) return { kind: "signed_out" };
  if (status === 409 && body.error === "draft_conflict") return { kind: "conflict" };
  if (status === 409 && body.error === "intake_closed") return { kind: "closed" };
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function signIntakeConsent(
  token: string,
  typedName: string,
): Promise<SignConsentResult> {
  const { status, body } = await intakeFetch<{ signed: boolean }>(
    "consent",
    post({ t: token, typedName, version: CONSENT.version }),
  );
  if (status === 200 && body.data) return "signed";
  if (status === 401) return "signed_out";
  if (status === 409 && body.error === "intake_closed") return "closed";
  throw new Error(body.error ?? `Request failed (${status})`);
}

// The full SSN and a password go into one request body and are not kept here.
// Each throws on any other failure, so the field says it couldn't save.

export async function saveIntakeSsn(token: string, ssn: string): Promise<SaveSsnResult> {
  const { status, body } = await intakeFetch<{ ssnLast4: string }>("ssn", post({ t: token, ssn }));
  if (status === 200 && body.data) return { kind: "stored", ssnLast4: body.data.ssnLast4 };
  if (status === 401) return { kind: "signed_out" };
  if (status === 409 && body.error === "field_locked") return { kind: "locked" };
  if (status === 409 && body.error === "intake_closed") return { kind: "closed" };
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function saveIntakeLogin(
  token: string,
  portal: IntakePortal,
  username: string,
  password: string,
): Promise<SaveLoginResult> {
  const { status, body } = await intakeFetch<{ portal: IntakePortal; onFile: boolean }>(
    "login",
    post({ t: token, portal, username, password }),
  );
  if (status === 200 && body.data) return "stored";
  if (status === 401) return "signed_out";
  if (status === 409 && body.error === "intake_closed") return "closed";
  throw new Error(body.error ?? `Request failed (${status})`);
}

// A document goes in three steps: the server records it and signs an upload
// to the holding bucket, the browser puts the file there itself (it never
// passes through the server), and the server checks what arrived. Each
// throws on any other failure, so the slot says it didn't upload.
export async function uploadIntakeDocument(
  token: string,
  slot: { key: string; kind: string },
  file: File,
  expiresOn: string | null = null,
): Promise<UploadDocumentResult> {
  const intent = await intakeFetch<{ uploadId: string; uploadUrl: string }>(
    "upload-intent",
    post({
      t: token,
      slotKey: slot.key,
      kind: slot.kind,
      fileName: file.name,
      sizeBytes: file.size,
      contentType: file.type,
      expiresOn,
    }),
  );
  if (intent.status === 401) return { kind: "signed_out" };
  if (intent.status === 409 && intent.body.error === "intake_closed") return { kind: "closed" };
  if (!intent.body.data) throw new Error(intent.body.error ?? `Request failed (${intent.status})`);

  const put = await fetch(intent.body.data.uploadUrl, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);

  const { status, body } = await intakeFetch<{ upload: IntakeUpload }>(
    "upload-finalize",
    post({ t: token, uploadId: intent.body.data.uploadId }),
  );
  if (status === 200 && body.data) return { kind: "uploaded", upload: body.data.upload };
  if (status === 401) return { kind: "signed_out" };
  if (status === 409 && body.error === "intake_closed") return { kind: "closed" };
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function removeIntakeDocument(
  token: string,
  uploadId: string,
): Promise<RemoveDocumentResult> {
  const { status, body } = await intakeFetch<{ removed: boolean }>(
    "upload-remove",
    post({ t: token, uploadId }),
  );
  if ((status === 200 && body.data) || status === 404) return "removed";
  if (status === 401) return "signed_out";
  if (status === 409 && body.error === "intake_closed") return "closed";
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function setIntakeDocumentExpiry(
  token: string,
  uploadId: string,
  expiresOn: string | null,
): Promise<SetDocumentExpiryResult> {
  const { status, body } = await intakeFetch<{ expiresOn: string | null }>(
    "upload-expiry",
    post({ t: token, uploadId, expiresOn }),
  );
  if (status === 200 && body.data) return "saved";
  if (status === 401) return "signed_out";
  if (status === 409 && body.error === "intake_closed") return "closed";
  throw new Error(body.error ?? `Request failed (${status})`);
}

/** `version` is the draft version her page last saved. Throws on any other
 * failure, so the page says it couldn't send and she can try again. */
export async function submitIntake(token: string, version: number): Promise<SubmitIntakeResult> {
  const { status, body } = await intakeFetch<{ submitted: boolean }>(
    "submit",
    post({ t: token, version }),
  );
  if (status === 200 && body.data) return { kind: "submitted" };
  if (status === 401) return { kind: "signed_out" };
  if (status === 422 && body.error === "intake_incomplete") {
    return { kind: "incomplete", missing: body.meta?.missing ?? [] };
  }
  if (status === 409 && body.error === "npi_in_use") return { kind: "npi_in_use" };
  if (status === 409 && body.error === "draft_conflict") return { kind: "conflict" };
  if (status === 409 && body.error === "intake_closed") return { kind: "closed" };
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function requestIntakeHelp(
  token: string,
  reason: HelpReason,
): Promise<RequestHelpResult> {
  const { status, body } = await intakeFetch<{ sent: boolean }>("help", post({ t: token, reason }));
  if (status === 200 && body.data) return "sent";
  if (status === 401) return "signed_out";
  if (status === 409 && body.error === "intake_closed") return "closed";
  throw new Error(body.error ?? `Request failed (${status})`);
}

export async function signOutIntake(): Promise<void> {
  await intakeFetch("signout", post({}));
}
