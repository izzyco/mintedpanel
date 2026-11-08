// The provider intake form's rules (canvas boards 5a, 5a-2 and 5b), pure.
// The error summary is built from the same "provided" rule as
// sectionProgress, so the summary and the progress chips never disagree.
// Every time arrives as an argument.
import { fmtDate } from "@/lib/format";
import type { IntakePortal } from "@/lib/intakeAnswers";
import { SSN_NOT_ISSUED_MESSAGE, isPossibleSsn, isValidNpi } from "@/lib/providerIdentity";
import type {
  DocumentSlot,
  FieldValue,
  HomeAddress,
  IntakeDraft,
  IntakeLicense,
} from "@/types/providerOnboarding";

type IdentityKey = keyof IntakeDraft["identity"];

export type FieldPath =
  | ["identity", IdentityKey]
  | ["contact", "mobile"]
  | ["address", keyof HomeAddress]
  | ["licenses", number, keyof IntakeLicense];

export interface MissingField {
  /** Which rule it is, prefixed by its progress section ("contact.address"). */
  key: string;
  label: string;
  message: string;
  /** Every input to mark invalid. The summary links to the first. */
  ids: [string, ...string[]];
}

export const LOGINS = [
  {
    key: "caqh",
    flag: "caqhOnFile",
    title: "CAQH ProView",
    userLabel: "Username",
    message: "Add your CAQH ProView username and password.",
  },
  {
    key: "pecos",
    flag: "pecosOnFile",
    title: "PECOS",
    userLabel: "User ID",
    message: "Add your PECOS user ID and password.",
  },
] as const satisfies readonly {
  key: IntakePortal;
  flag: keyof IntakeDraft["logins"];
  title: string;
  userLabel: string;
  message: string;
}[];

/** The draft once the vault holds her login for that portal. */
export function withLoginOnFile(draft: IntakeDraft, portal: IntakePortal): IntakeDraft {
  const login = LOGINS.find((l) => l.key === portal);
  return login ? { ...draft, logins: { ...draft.logins, [login.flag]: true } } : draft;
}

/** An error message and the id an input's aria-describedby points at. */
export interface FieldError {
  id: string;
  message: string;
}

/** The source label of a value she typed. A saved answer comes back with it too. */
export const ENTERED = "You entered this";
const EMPTY: FieldValue<string> = { value: null, source: null };

export function fieldId(...parts: (string | number)[]): string {
  return `intake-${parts.join("-")}`.replace(/[^\w-]/g, "-");
}

// A field counts once the provider (or a named source) has supplied it. A
// prefilled default with no source, like the Specialty select, does not.
function provided(field: FieldValue<string>): boolean {
  return field.source !== null && Boolean(field.value?.trim());
}

function blank(field: FieldValue<string>): boolean {
  return !field.value?.trim();
}

export function setField(
  draft: IntakeDraft,
  path: FieldPath,
  value: string | null,
  today: string,
): IntakeDraft {
  const source = { label: ENTERED, asOf: today };
  const entered = (field: FieldValue<string>): FieldValue<string> => {
    if (field.locked) return field;
    return value ? { value, source } : EMPTY;
  };
  switch (path[0]) {
    case "identity": {
      const key = path[1];
      return { ...draft, identity: { ...draft.identity, [key]: entered(draft.identity[key]) } };
    }
    case "contact":
      return { ...draft, contact: { ...draft.contact, mobile: entered(draft.contact.mobile) } };
    case "address": {
      const key = path[1];
      const { homeAddress } = draft.contact;
      return {
        ...draft,
        contact: {
          ...draft.contact,
          homeAddress: { ...homeAddress, [key]: entered(homeAddress[key]) },
        },
      };
    }
    case "licenses": {
      const [, index, key] = path;
      const licenses = draft.licenses.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, [key]: entered(row[key]) };
        // Filling in a row accepts the state the practice prefilled on it;
        // otherwise a state she can see would still count as missing.
        if (value && key !== "state" && !row.state.source && !blank(row.state)) {
          next.state = { ...row.state, source };
        }
        return next;
      });
      return { ...draft, licenses };
    }
  }
}

export function addLicense(draft: IntakeDraft): IntakeDraft {
  return {
    ...draft,
    licenses: [...draft.licenses, { state: EMPTY, number: EMPTY, expiresOn: EMPTY }],
  };
}

export function removeLicense(draft: IntakeDraft, index: number): IntakeDraft {
  return { ...draft, licenses: draft.licenses.filter((_, i) => i !== index) };
}

// The SSN as she types it: digits only, at most nine, dashed as 123-45-6789.
export function typeSsn(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function ssnProblem(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length !== 9) return `An SSN has 9 digits. You've entered ${digits.length}.`;
  if (!isPossibleSsn(digits)) return SSN_NOT_ISSUED_MESSAGE;
  return null;
}

export function npiProblem(npi: string): string | null {
  if (npi === "" || isValidNpi(npi)) return null;
  if (!/^\d{10}$/.test(npi)) return "An NPI has 10 digits.";
  return "This NPI isn't valid. Check each digit for a typo.";
}

const IDENTITY: [IdentityKey, string, string][] = [
  ["firstName", "First name", "Add your first name."],
  ["lastName", "Last name", "Add your last name."],
  ["npi", "NPI", "Add your 10-digit NPI."],
  ["taxonomyCode", "Specialty", "Pick your specialty."],
  ["dateOfBirth", "Date of birth", "Add your date of birth."],
  ["caqhId", "CAQH ID", "Add your CAQH ID."],
  ["ssn", "Social Security number", "Add your Social Security number."],
];

const ADDRESS_PARTS: [keyof HomeAddress, string][] = [
  ["street", "street address"],
  ["city", "city"],
  ["state", "state"],
  ["zip", "ZIP code"],
];

const LICENSE_PARTS: [keyof IntakeLicense, string][] = [
  ["state", "state"],
  ["number", "license number"],
  ["expiresOn", "expiration date"],
];

function joinAnd(words: string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// A group of fields that counts as one item. Names only the parts that look
// empty; a part that shows a value but has no source is named only when it is
// all that is left.
function gaps<K extends string>(
  parts: [K, string][],
  fields: Record<K, FieldValue<string>>,
  idOf: (key: K) => string,
): { names: string | null; ids: [string, ...string[]] } | null {
  const unprovided = parts.filter(([key]) => !provided(fields[key]));
  const empty = unprovided.filter(([key]) => blank(fields[key]));
  const [first, ...rest] = (empty.length > 0 ? empty : unprovided).map(([key]) => idOf(key));
  if (!first) return null;
  return {
    names: empty.length > 0 ? joinAnd(empty.map(([, name]) => name)) : null,
    ids: [first, ...rest],
  };
}

function count(flags: boolean[]): { done: number; total: number } {
  return { done: flags.filter(Boolean).length, total: flags.length };
}

function complete<K extends string>(parts: [K, string][], fields: Record<K, FieldValue<string>>) {
  return parts.every(([key]) => provided(fields[key]));
}

/** The progress chips, one count per section, from the same tables as missingFields. */
export function sectionProgress(draft: IntakeDraft) {
  const { identity, contact, licenses, logins } = draft;
  return {
    identity: count(IDENTITY.map(([key]) => provided(identity[key]))),
    // The email is verified by the sign-in code, so it always counts.
    contact: count([true, provided(contact.mobile), complete(ADDRESS_PARTS, contact.homeAddress)]),
    licenses:
      licenses.length === 0
        ? { done: 0, total: 1 }
        : count(licenses.map((row) => complete(LICENSE_PARTS, row))),
    logins: count(LOGINS.map((login) => logins[login.flag])),
  };
}

export function missingFields(draft: IntakeDraft): MissingField[] {
  const missing: MissingField[] = [];
  for (const [key, label, message] of IDENTITY) {
    if (provided(draft.identity[key])) continue;
    missing.push({ key: `identity.${key}`, label, message, ids: [fieldId("identity", key)] });
  }
  if (!provided(draft.contact.mobile)) {
    missing.push({
      key: "contact.mobile",
      label: "Mobile phone",
      message: "Add your mobile number.",
      ids: [fieldId("contact", "mobile")],
    });
  }
  const address = gaps(ADDRESS_PARTS, draft.contact.homeAddress, (k) => fieldId("address", k));
  if (address) {
    missing.push({
      key: "contact.address",
      label: "Home address",
      message: address.names ? `Add your ${address.names}.` : "Confirm your home address.",
      ids: address.ids,
    });
  }
  if (draft.licenses.length === 0) {
    missing.push({
      key: "licenses.none",
      label: "State license",
      message: "Add a state license.",
      ids: [fieldId("licenses", "add")],
    });
  }
  draft.licenses.forEach((row, i) => {
    const gap = gaps(LICENSE_PARTS, row, (k) => fieldId("licenses", i, k));
    if (!gap) return;
    const state = row.state.value?.trim().toUpperCase();
    missing.push({
      key: `licenses.${i}`,
      label: state ? `${state} license` : `License ${i + 1}`,
      message: gap.names ? `Add the ${gap.names}.` : "Confirm the license state.",
      ids: gap.ids,
    });
  });
  for (const login of LOGINS) {
    if (draft.logins[login.flag]) continue;
    missing.push({
      key: `logins.${login.key}`,
      label: `${login.title} login`,
      message: login.message,
      ids: [fieldId("logins", login.key, "username"), fieldId("logins", login.key, "password")],
    });
  }
  return missing;
}

export function canContinue(draft: IntakeDraft): boolean {
  return missingFields(draft).length === 0;
}

export function errorOf(item: MissingField | undefined): FieldError | null {
  return item ? { id: `${fieldId(item.key)}-error`, message: item.message } : null;
}

export function ariaFor(error: FieldError | null) {
  return error ? { "aria-invalid": true, "aria-describedby": error.id } : {};
}

export function thingsLeft(count: number, before: string): string {
  return `${count} ${count === 1 ? "thing" : "things"} left before you can ${before}`;
}

export function missingDocuments(slots: DocumentSlot[]): MissingField[] {
  const missing: MissingField[] = [];
  for (const slot of slots) {
    if (slot.required && !slot.file) {
      missing.push({
        key: `documents.${slot.key}`,
        label: slot.label,
        message: `Upload your ${slot.label}.`,
        ids: [fieldId("doc", slot.key)],
      });
    }
    if (slot.needsExpiration && slot.file && !slot.file.expiresOn) {
      missing.push({
        key: `documents.${slot.key}.expires`,
        label: "Policy expiration date",
        message: "Add the date this policy expires.",
        ids: [fieldId("doc", slot.key, "expires")],
      });
    }
  }
  return missing;
}

const DATE_SEGMENTS = [2, 2, 4];

// Formats what she types as MM/DD/YYYY. A phone's number pad has no slash, so
// a full segment moves on by itself; a typed slash ends a short one ("7/4").
export function typeDate(text: string): string {
  const segments = [""];
  for (const ch of text) {
    const at = segments.length - 1;
    if (/\d/.test(ch)) {
      if (segments[at].length < DATE_SEGMENTS[at]) segments[at] += ch;
      else if (at < 2) segments.push(ch);
    } else if (ch === "/" && segments[at] && at < 2) {
      segments.push("");
    }
  }
  return segments.join("/");
}

export function parseUsDate(text: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [month, day, year] = match.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function isoToUsDate(iso: string | null): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

export function provenance(source: FieldValue<string>["source"], today: string): string | null {
  if (!source) return null;
  if (!source.asOf) return source.label;
  return `${source.label} · ${source.asOf === today ? "today" : fmtDate(source.asOf)}`;
}

export function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  if (bytes < mb) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / mb).toFixed(1)} MB`;
}

// Board 5a-2: a provider already on file was re-invited to review their details.
export function isReview(draft: IntakeDraft): boolean {
  return Object.values(draft.identity).some((f) => f.locked);
}
