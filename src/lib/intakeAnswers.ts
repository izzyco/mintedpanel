// What the provider has answered on the intake form, as one flat shape shared
// by the form, the /api/intake/draft route and the saved draft
// (provider_intake_drafts.answers). Pure.
//
// A value is hers or null: null means she hasn't provided it, so Submit
// leaves the record's value alone and a later staff edit isn't overwritten by
// a stale copy. The SSN and passwords are never answers. A license row's
// state is the exception: it is kept even when it came from the record,
// because licenses are matched on state (D6).
import { format } from "date-fns";
import { ENTERED, missingDocuments, missingFields } from "@/lib/intakeForm";
import type { DraftStep, IntakeResume, LockedField } from "@/lib/intakeFlow";
import { heldFiles, slotUploads } from "@/lib/intakeUploads";
import { isIsoDate, isValidNpi } from "@/lib/providerIdentity";
import { documentSlots } from "@/lib/providerOnboarding";
import type { DocumentKind } from "@/types";
import type { FieldValue, IntakeDraft, IntakeLicense } from "@/types/providerOnboarding";

export const INTAKE_ANSWER_MAX_LENGTH = 100;
export const INTAKE_MAX_LICENSES = 60;

const ANSWER_KEYS = [
  "firstName",
  "lastName",
  "npi",
  "taxonomyCode",
  "dateOfBirth",
  "caqhId",
  "mobile",
  "homeStreet",
  "homeCity",
  "homeState",
  "homeZip",
] as const;
type AnswerKey = (typeof ANSWER_KEYS)[number];

const LICENSE_KEYS = ["state", "number", "expiresOn"] as const;

export type IntakeLicenseAnswer = Record<(typeof LICENSE_KEYS)[number], string | null>;
export type IntakeAnswers = Record<AnswerKey, string | null> & { licenses: IntakeLicenseAnswer[] };

/** The portals whose logins she saves (provider_portal_credentials.portal). */
export const INTAKE_PORTALS = ["caqh", "pecos"] as const;
export type IntakePortal = (typeof INTAKE_PORTALS)[number];
export const INTAKE_USERNAME_MAX_LENGTH = 100;
export const INTAKE_PASSWORD_MAX_LENGTH = 200;

export function isIntakePortal(value: unknown): value is IntakePortal {
  return (INTAKE_PORTALS as readonly unknown[]).includes(value);
}

/** A file she uploaded and hasn't removed (provider_intake_uploads). `fileName`
 * is its storage-safe name; only a COI carries `expiresOn`. */
export interface IntakeUpload {
  id: string;
  slotKey: string;
  kind: DocumentKind;
  fileName: string;
  sizeBytes: number;
  expiresOn: string | null;
}

/** What /api/intake/state returns: everything the form opens with. */
export interface IntakeState {
  practiceName: string;
  email: string;
  /** Her provider record, in the answers shape. */
  record: IntakeAnswers;
  lockedFields: LockedField[];
  ssnLast4: string | null;
  loginsOnFile: Record<IntakePortal, boolean>;
  consent: { signed: boolean; textVersion: number | null };
  draft: { answers: IntakeAnswers; step: DraftStep; version: number; updatedAt: string } | null;
  uploads: IntakeUpload[];
  submitted: boolean;
}

/** One draft save, as the form sees it. A conflict means another window saved first. */
export type SaveDraftResult =
  | { kind: "saved"; version: number }
  | { kind: "conflict" }
  | { kind: "signed_out" }
  | { kind: "closed" };

export type SignConsentResult = "signed" | "signed_out" | "closed";

/** One SSN save. Locked: an SSN was on file when her onboarding opened. */
export type SaveSsnResult =
  | { kind: "stored"; ssnLast4: string }
  | { kind: "locked" }
  | { kind: "signed_out" }
  | { kind: "closed" };

export type SaveLoginResult = "stored" | "signed_out" | "closed";

export type UploadDocumentResult =
  { kind: "uploaded"; upload: IntakeUpload } | { kind: "signed_out" } | { kind: "closed" };

/** Removed also when it was already gone, say from another window. */
export type RemoveDocumentResult = "removed" | "signed_out" | "closed";

export type SetDocumentExpiryResult = "saved" | "signed_out" | "closed";

/** One Submit. Incomplete names the form's summary keys still missing;
 * npi_in_use means the NPI she entered is on another provider's record. */
export type SubmitIntakeResult =
  | { kind: "submitted" }
  | { kind: "incomplete"; missing: string[] }
  | { kind: "npi_in_use" }
  | { kind: "conflict" }
  | { kind: "signed_out" }
  | { kind: "closed" };

export type RequestHelpResult = "sent" | "signed_out" | "closed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Parsed = { ok: true; value: string | null } | { ok: false };

function parseValue(raw: unknown): Parsed {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const value = raw.trim();
  if (value.length > INTAKE_ANSWER_MAX_LENGTH) return { ok: false };
  return { ok: true, value: value || null };
}

function parseFields<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[],
): Record<K, string | null> | null {
  const out = {} as Record<K, string | null>;
  for (const key of keys) {
    const parsed = parseValue(input[key]);
    if (!parsed.ok) return null;
    out[key] = parsed.value;
  }
  return out;
}

/** The answers shape, or null for anything else. Unknown keys are dropped. */
export function parseIntakeAnswers(input: unknown): IntakeAnswers | null {
  if (!isRecord(input)) return null;
  const fields = parseFields(input, ANSWER_KEYS);
  const rawLicenses = input.licenses ?? [];
  if (!fields || !Array.isArray(rawLicenses) || rawLicenses.length > INTAKE_MAX_LICENSES) {
    return null;
  }
  const licenses: IntakeLicenseAnswer[] = [];
  for (const row of rawLicenses) {
    const license = isRecord(row) ? parseFields(row, LICENSE_KEYS) : null;
    if (!license) return null;
    licenses.push(license);
  }
  return { ...fields, licenses };
}

function hers(field: FieldValue<string>): string | null {
  if (field.locked || field.source?.label !== ENTERED) return null;
  return field.value?.trim() || null;
}

function shown(field: FieldValue<string>): string | null {
  return field.source ? field.value?.trim() || null : null;
}

export function answersFromDraft(draft: IntakeDraft): IntakeAnswers {
  const { identity, contact } = draft;
  const address = contact.homeAddress;
  return {
    firstName: hers(identity.firstName),
    lastName: hers(identity.lastName),
    npi: hers(identity.npi),
    taxonomyCode: hers(identity.taxonomyCode),
    dateOfBirth: hers(identity.dateOfBirth),
    caqhId: hers(identity.caqhId),
    mobile: hers(contact.mobile),
    homeStreet: hers(address.street),
    homeCity: hers(address.city),
    homeState: hers(address.state),
    homeZip: hers(address.zip),
    licenses: draft.licenses.map((row) => ({
      state: shown(row.state),
      number: hers(row.number),
      expiresOn: hers(row.expiresOn),
    })),
  };
}

const ON_FILE = { label: "On file", asOf: null };
const EMPTY: FieldValue<string> = { value: null, source: null };

function onFile(value: string | null): FieldValue<string> {
  return value === null ? EMPTY : { value, source: ON_FILE };
}

const LOCK_OF: Partial<Record<AnswerKey, LockedField>> = {
  npi: "npi",
  dateOfBirth: "dateOfBirth",
};

export function draftFromState(state: IntakeState): IntakeDraft {
  const { record, draft } = state;
  const answers = draft?.answers ?? null;
  // Her answers are dated by the save, on her calendar.
  const mine = draft
    ? { label: ENTERED, asOf: format(new Date(draft.updatedAt), "yyyy-MM-dd") }
    : null;
  const pick = (answer: string | null, recorded: string | null): FieldValue<string> =>
    answer !== null && mine ? { value: answer, source: mine } : onFile(recorded);
  const locked = (value: string | null): FieldValue<string> => ({ ...onFile(value), locked: true });
  const field = (key: AnswerKey): FieldValue<string> => {
    const lock = LOCK_OF[key];
    if (lock && state.lockedFields.includes(lock)) return locked(record[key]);
    return pick(answers?.[key] ?? null, record[key]);
  };

  const recordByState = new Map(record.licenses.map((l) => [l.state?.toUpperCase(), l]));
  const licenses: IntakeLicense[] = answers
    ? answers.licenses.map((row) => {
        const recorded = row.state ? recordByState.get(row.state.toUpperCase()) : undefined;
        return {
          state: recorded ? onFile(row.state) : pick(row.state, null),
          number: pick(row.number, recorded?.number ?? null),
          expiresOn: pick(row.expiresOn, recorded?.expiresOn ?? null),
        };
      })
    : record.licenses.map((l) => ({
        state: onFile(l.state),
        number: onFile(l.number),
        expiresOn: onFile(l.expiresOn),
      }));

  return {
    identity: {
      firstName: field("firstName"),
      lastName: field("lastName"),
      npi: field("npi"),
      taxonomyCode: field("taxonomyCode"),
      dateOfBirth: field("dateOfBirth"),
      caqhId: field("caqhId"),
      ssn: state.lockedFields.includes("ssn") ? locked(state.ssnLast4) : onFile(state.ssnLast4),
    },
    contact: {
      email: state.email,
      mobile: field("mobile"),
      homeAddress: {
        street: field("homeStreet"),
        city: field("homeCity"),
        state: field("homeState"),
        zip: field("homeZip"),
      },
    },
    licenses:
      licenses.length > 0 || answers
        ? licenses
        : [{ state: EMPTY, number: EMPTY, expiresOn: EMPTY }],
    logins: { caqhOnFile: state.loginsOnFile.caqh, pecosOnFile: state.loginsOnFile.pecos },
  };
}

export function resumeFrom(state: IntakeState): IntakeResume {
  return {
    consented: state.consent.signed,
    step: state.draft?.step ?? "form",
    submitted: state.submitted,
  };
}

// A state as the database checks it (state_licenses, providers.home_state).
const STATE_CODE = /^[A-Za-z]{2}$/;

// Answers the record can't take: the form's inputs never produce them, so
// only a request built by hand can carry one.
function unusableAnswers(state: IntakeState): string[] {
  const answers = state.draft?.answers;
  if (!answers) return [];
  const open = (field: LockedField) => !state.lockedFields.includes(field);
  const keys: string[] = [];
  if (answers.npi && open("npi") && !isValidNpi(answers.npi)) keys.push("identity.npi");
  if (answers.dateOfBirth && open("dateOfBirth") && !isIsoDate(answers.dateOfBirth)) {
    keys.push("identity.dateOfBirth");
  }
  if (answers.homeState && !STATE_CODE.test(answers.homeState)) keys.push("contact.address");
  answers.licenses.forEach((license, i) => {
    const badState = license.state !== null && !STATE_CODE.test(license.state);
    const badDate = license.expiresOn !== null && !isIsoDate(license.expiresOn);
    if (badState || badDate) keys.push(`licenses.${i}`);
  });
  return keys;
}

/** What Submit checks and carries, by the same rules the form shows
 * (missingFields, missingDocuments): the summary keys still missing or
 * holding a value the record can't take ("consent" when she hasn't signed),
 * and the held files whose slot is still on her form. */
export function intakeSubmission(state: IntakeState): {
  missing: string[];
  uploads: IntakeUpload[];
} {
  const draft = draftFromState(state);
  const files = heldFiles(slotUploads({}, { type: "opened", uploads: state.uploads }));
  const slots = documentSlots(draft, files);
  const missing = new Set(state.consent.signed ? [] : ["consent"]);
  for (const item of [...missingFields(draft), ...missingDocuments(slots)]) missing.add(item.key);
  for (const key of unusableAnswers(state)) missing.add(key);
  const onForm = new Set(slots.map((slot) => slot.key));
  return {
    missing: [...missing],
    uploads: state.uploads.filter((upload) => onForm.has(upload.slotKey)),
  };
}
