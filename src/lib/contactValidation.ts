// Pure contact-field validation shared by the create-org flow (E0.1) and the
// party/contact surfaces (E0.2/E0.3). The server (create_organization RPC and
// RLS/services) is the enforcement authority; these give the user immediate,
// friendly feedback before submit.
import type { ContactInput, InboundLeadInput } from "@/types";
import {
  US_PHONE_MESSAGE,
  isValidUsPhone,
  usPhoneError,
  type PhoneValidationRules,
} from "@/lib/phone";

// Format check mirrors the RPC's server-side regex closely enough for a
// pre-submit gate: one @, no spaces, a dot in the domain. Deliberately lenient
// (real deliverability is not knowable client-side).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

// Common misspellings of popular email domains → the intended domain. Used only
// to surface a NON-blocking "did you mean" nudge (F0.1.2), never to block submit.
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "outlok.com": "outlook.com",
  "outook.com": "outlook.com",
  "iclould.com": "icloud.com",
  "icloud.co": "icloud.com",
};

// Returns a suggested corrected email when the domain looks like a common typo,
// else null. Case-insensitive on the domain; preserves the local part as typed.
export function commonEmailDomainTypo(value: string): string | null {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  const fixed = DOMAIN_TYPOS[domain];
  return fixed ? `${local}@${fixed}` : null;
}

// Required-field validation for a CRM contact (E0.2 FR-2), mirroring the RPC's
// assert_contact_valid: name, valid email, and the meaningful split address
// parts (line2/country optional). Returns per-field messages.
//
// The office phone is NOT required (Sowmya, Nov 1, 2026, MINT-91 Addendum 9
// U8): a blank phone saves, and the gap becomes a backend advisory once the
// bypassed-checks store lands (MINT-134), with nothing shown here. An entered
// phone must still be a US number (A3, no override); on an edit pass the
// stored phone, so by default an untouched legacy value never blocks the save
// (A4, recheckStoredOnEdit).
export interface ContactFieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneOffice?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export function contactErrors(
  c: ContactInput,
  storedPhone?: string | null,
  phoneRules?: PhoneValidationRules,
): ContactFieldErrors {
  const e: ContactFieldErrors = {};
  // D6: the name is captured split, so it is validated split. The composed
  // `name` the RPC still requires is derived at the service boundary.
  if (!c.firstName.trim()) e.firstName = "First name is required";
  if (!c.lastName.trim()) e.lastName = "Last name is required";
  if (!c.email.trim()) e.email = "Email is required";
  else if (!isValidEmail(c.email)) e.email = "Enter a valid email address";
  // Blank passes (U8); usPhoneError returns null for a blank value.
  const phoneError = usPhoneError(c.phoneOffice, storedPhone, phoneRules);
  if (phoneError) e.phoneOffice = phoneError;
  if (!c.addressLine1.trim()) e.addressLine1 = "Street address is required";
  if (!c.city.trim()) e.city = "City is required";
  if (!c.state.trim()) e.state = "State is required";
  if (!c.postalCode.trim()) e.postalCode = "Postal code is required";
  return e;
}

export function hasContactErrors(e: ContactFieldErrors): boolean {
  return Object.keys(e).length > 0;
}

// The public /contact lead form (E0.5 F0.5.5), mirroring submit_inbound_lead:
// organization name, your name and a valid email are required. The phone is
// optional (MINT-91 U8, Nov 1, 2026), and an entered one must be a US number
// (A3). A lead has no organization yet, so a blank phone here records no
// advisory: there is no org to record it against.
export interface LeadErrors {
  orgName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export function leadErrors(v: InboundLeadInput): LeadErrors {
  const e: LeadErrors = {};
  if (!v.orgName.trim()) e.orgName = "Organization name is required";
  if (!v.contactName.trim()) e.contactName = "Your name is required";
  if (!v.contactEmail.trim()) e.contactEmail = "Email is required";
  else if (!isValidEmail(v.contactEmail)) e.contactEmail = "Enter a valid email address";
  if (v.contactPhone.trim() && !isValidUsPhone(v.contactPhone)) {
    e.contactPhone = US_PHONE_MESSAGE;
  }
  return e;
}
