// Sample data for the /dev/provider-onboarding preview and the onboarding
// derivation tests.
// Synthetic canvas names only, no real PHI. Every count a screen shows is
// computed from these rows, never typed in separately.
import type {
  FieldValue,
  IntakeDraft,
  KnownPerson,
  OnboardingHire,
  VerificationCheck,
} from "@/types/providerOnboarding";
import { deriveStage } from "@/lib/providerOnboarding";
import { NO_INTAKE_ANSWERS, type IntakeState } from "@/lib/intakeAnswers";
export { CONSENT } from "@/lib/intakeConsent";

export const PRACTICE = {
  name: "Shelby Sports Rehab",
  key: "pk_7f3a9c",
  groups: ["Shelby Sports Rehab · Charlotte", "Shelby Sports Rehab · Concord"],
  locations: ["Charlotte", "Concord"],
  address: "410 Mint St, Charlotte, NC 28202",
};

const hire = (h: Omit<OnboardingHire, "groupName" | "source">): OnboardingHire => ({
  ...h,
  groupName: PRACTICE.groups[0],
  source: "practice_invite",
});

export const HIRES: OnboardingHire[] = [
  hire({
    providerId: "fx-jisoo-kim",
    displayName: "Jisoo Kim, PT",
    invitedEmail: "jisoo.kim@example.test",
    locationName: null,
    states: ["NC"],
    startDate: null,
    events: [
      { type: "invited", at: "2026-10-12T14:00:00Z" },
      { type: "signed_in", at: "2026-10-14T18:20:00Z" },
      { type: "consent_signed", at: "2026-10-14T18:22:00Z" },
      { type: "section_saved", at: "2026-10-14T18:40:00Z" },
      { type: "help_requested", at: "2026-10-15T09:10:00Z" },
    ],
  }),
  hire({
    providerId: "fx-anita-rao",
    displayName: "Anita Rao, PT",
    invitedEmail: "anita.rao@example.test",
    locationName: null,
    states: ["NC"],
    startDate: "2026-11-03",
    events: [{ type: "invited", at: "2026-10-19T14:11:00Z" }],
  }),
  hire({
    providerId: "fx-marcus-bell",
    displayName: "Marcus Bell, DPT",
    invitedEmail: "marcus.bell@example.test",
    locationName: null,
    states: ["NC"],
    startDate: "2026-10-27",
    events: [
      { type: "invited", at: "2026-10-10T13:00:00Z" },
      { type: "reminder_sent", at: "2026-10-12T13:00:00Z" },
      { type: "signed_in", at: "2026-10-12T19:05:00Z" },
      { type: "consent_signed", at: "2026-10-12T19:07:00Z" },
      { type: "section_saved", at: "2026-10-12T19:30:00Z" },
    ],
  }),
  hire({
    providerId: "fx-lena-ortiz",
    displayName: "Lena Ortiz, PTA",
    invitedEmail: "lena.ortiz@example.test",
    locationName: null,
    states: ["NC"],
    startDate: "2026-11-10",
    events: [
      { type: "invited", at: "2026-10-13T13:40:00Z" },
      { type: "reminder_sent", at: "2026-10-15T14:00:00Z" },
      { type: "signed_in", at: "2026-10-15T22:52:00Z" },
      { type: "consent_signed", at: "2026-10-15T22:54:00Z" },
      { type: "submitted", at: "2026-10-16T23:48:00Z" },
    ],
  }),
  hire({
    providerId: "fx-owen-park",
    displayName: "Owen Park, PT",
    invitedEmail: "owen.park@example.test",
    locationName: "Charlotte",
    states: ["NC", "SC"],
    startDate: "2026-10-20",
    events: [
      { type: "invited", at: "2026-10-01T13:00:00Z" },
      { type: "signed_in", at: "2026-10-01T20:00:00Z" },
      { type: "consent_signed", at: "2026-10-01T20:02:00Z" },
      { type: "submitted", at: "2026-10-02T21:00:00Z" },
      { type: "admitted", at: "2026-10-03T15:00:00Z" },
    ],
  }),
];

// Hires already past onboarding, for screen 0's footer count.
export const EARLIER_HIRES_IN_CREDENTIALING = 9;

const INVITATION = { label: "From your invitation", asOf: "2026-10-30" };

const EMPTY: FieldValue<string> = { value: null, source: null };
const EMPTY_ADDRESS = { street: EMPTY, city: EMPTY, state: EMPTY, zip: EMPTY };

// Anita's draft as the form first shows it: the invitation supplied her name, the
// license state is a bare prefill, and nothing else is entered yet.
export function initialDraft(email: string): IntakeDraft {
  return {
    identity: {
      firstName: { value: "Anita", source: INVITATION },
      lastName: { value: "Rao", source: INVITATION },
      npi: EMPTY,
      taxonomyCode: EMPTY,
      dateOfBirth: EMPTY,
      caqhId: EMPTY,
      ssn: EMPTY,
    },
    contact: { email, mobile: EMPTY, homeAddress: EMPTY_ADDRESS },
    licenses: [{ state: { value: "NC", source: null }, number: EMPTY, expiresOn: EMPTY }],
    logins: { caqhOnFile: false, pecosOnFile: false },
  };
}

const ON_FILE = { label: "On file", asOf: "2026-03-14" };
const onFile = (value: string, locked = false): FieldValue<string> => ({
  value,
  source: ON_FILE,
  locked,
});

// Board 5a-2: Priya is already an active provider, re-invited to review her
// details. SSN, NPI and date of birth are on her live record, so they lock.
export function reviewDraft(email: string): IntakeDraft {
  return {
    identity: {
      firstName: onFile("Priya"),
      lastName: onFile("Shah"),
      npi: onFile("1730195835", true),
      taxonomyCode: onFile("225100000X"),
      dateOfBirth: onFile("1988-07-21", true),
      caqhId: onFile("12345678"),
      ssn: onFile("6789", true),
    },
    contact: {
      email,
      mobile: EMPTY,
      homeAddress: {
        street: onFile("18 Elm St"),
        city: onFile("Charlotte"),
        state: onFile("NC"),
        zip: onFile("28203"),
      },
    },
    licenses: [
      { state: onFile("NC"), number: onFile("PT-48213"), expiresOn: onFile("2027-12-31") },
    ],
    logins: { caqhOnFile: true, pecosOnFile: false },
  };
}

function intakeState(email: string, patch: Partial<IntakeState>): IntakeState {
  return {
    practiceName: PRACTICE.name,
    email,
    record: NO_INTAKE_ANSWERS,
    lockedFields: [],
    ssnLast4: null,
    loginsOnFile: { caqh: false, pecos: false },
    consent: { signed: false, textVersion: null },
    draft: null,
    uploads: [],
    submitted: false,
    ...patch,
  };
}

// What /api/intake/state answers for the preview's two people before they
// start: Anita's record holds only her invited name; Priya's is a full record
// whose SSN, NPI and date of birth lock.
export function newHireState(email: string): IntakeState {
  return intakeState(email, {
    record: { ...NO_INTAKE_ANSWERS, firstName: "Anita", lastName: "Rao" },
  });
}

export function reviewState(email: string): IntakeState {
  return intakeState(email, {
    record: {
      ...NO_INTAKE_ANSWERS,
      firstName: "Priya",
      lastName: "Shah",
      npi: "1730195835",
      taxonomyCode: "225100000X",
      dateOfBirth: "1988-07-21",
      caqhId: "12345678",
      homeStreet: "18 Elm St",
      homeCity: "Charlotte",
      homeState: "NC",
      homeZip: "28203",
      licenses: [{ state: "NC", number: "PT-48213", expiresOn: "2027-12-31" }],
    },
    lockedFields: ["ssn", "npi", "dateOfBirth"],
    ssnLast4: "6789",
  });
}

// Everyone an invite can match (board 1b): the hires above plus providers
// already on the roster. Each journey is derived from the hire's events.
export const KNOWN_PEOPLE: KnownPerson[] = [
  ...HIRES.map((h) => {
    const stage = deriveStage(h.events);
    const journey: KnownPerson["journey"] =
      stage === "invited" || stage === "started"
        ? "open"
        : stage === "submitted"
          ? "submitted"
          : "none";
    return {
      displayName: h.displayName,
      email: h.invitedEmail,
      npi: null,
      groupNames: [h.groupName],
      journey,
    };
  }),
  {
    displayName: "Priya Shah, PT",
    email: "priya.shah@example.test",
    npi: "1730195835",
    groupNames: [PRACTICE.groups[0]],
    journey: "none",
  },
  {
    displayName: "Dev Patel, PT",
    email: "dev.patel@example.test",
    npi: "1588667638",
    groupNames: [PRACTICE.groups[1]],
    journey: "none",
  },
];

const auto = (key: string, label: string): VerificationCheck => ({
  key,
  label,
  status: "confirmed",
  detail: null,
  method: "auto",
  section: null,
});

// Lena's Verification block (board 6b): ten automatic checks, three for a person.
export const VERIFICATION_CHECKS: VerificationCheck[] = [
  {
    key: "caqh_login",
    label: "CAQH login",
    status: "pending",
    detail: null,
    method: "person",
    portal: { key: "caqh", name: "CAQH" },
    confirmedBy: null,
    checkedAt: null,
    action: "test_login",
  },
  {
    key: "pecos_login",
    label: "PECOS login",
    status: "pending",
    detail: null,
    method: "person",
    portal: { key: "pecos", name: "PECOS" },
    confirmedBy: null,
    checkedAt: null,
    action: "test_login",
  },
  {
    key: "caqh_attestation",
    label: "CAQH attested within 120 days",
    status: "pending",
    detail: null,
    method: "person",
    portal: null,
    confirmedBy: null,
    checkedAt: null,
    action: "confirm",
  },
  auto("npi", "NPI"),
  auto("caqh_id", "CAQH ID"),
  auto("license_nc", "NC license verified"),
  auto("license_per_state", "License per target state · NC"),
  auto("dob_ssn", "Date of birth and SSN on file"),
  auto("logins_on_file", "CAQH and PECOS logins on file"),
  auto("group_docs", "Group W-9, COI, contract, location in state"),
  auto("required_docs", "Required documents on file (CV, license copy)"),
  auto("no_duplicate", "No duplicate NPI in group"),
  auto("group_location", "Group and location assigned"),
];
