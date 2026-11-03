// Provider onboarding R1 view shapes (docs/provider-onboarding/r1-ui-spec.md §5).
// Not table rows: these are what the screens render. The preview feeds them
// from fixtures; the real backend will feed the same shapes.
import type { DocumentKind } from "@/types";

export type OnboardingStage = "invited" | "started" | "submitted" | "ready" | "in_credentialing";
export type WaitingOn = "provider" | "practice" | "minted";

// Milestones are events; the stage is derived from them, never stored (rule 8).
export type OnboardingEventType =
  | "invited"
  | "invitation_resent"
  | "reminder_sent"
  | "signed_in"
  | "consent_signed"
  | "section_saved"
  | "submitted"
  | "help_requested"
  | "told_not_needed"
  | "practice_contacted"
  | "admitted"
  | "first_case_created";

export interface OnboardingEvent {
  type: OnboardingEventType;
  at: string; // ISO timestamp
}

export interface OnboardingHire {
  providerId: string;
  displayName: string;
  invitedEmail: string;
  groupName: string;
  locationName: string | null;
  source: "practice_invite";
  states: string[];
  startDate: string | null; // practice-entered only
  events: OnboardingEvent[];
}

// source null = not yet provided or confirmed by the provider. locked = the
// value is on her live record and is one she can't change here (SSN, NPI and
// date of birth; she asks for a fix instead).
export interface FieldValue<T> {
  value: T | null;
  source: { label: string; asOf: string | null } | null;
  locked?: boolean;
}

export interface HomeAddress {
  street: FieldValue<string>;
  city: FieldValue<string>;
  state: FieldValue<string>;
  zip: FieldValue<string>;
}

export interface IntakeLicense {
  state: FieldValue<string>;
  number: FieldValue<string>;
  expiresOn: FieldValue<string>;
}

// Secrets are write-only: the draft holds only the SSN's last 4 digits and
// whether each login is on file, never the full SSN or a password.
export interface IntakeDraft {
  identity: {
    firstName: FieldValue<string>;
    lastName: FieldValue<string>;
    npi: FieldValue<string>;
    taxonomyCode: FieldValue<string>;
    dateOfBirth: FieldValue<string>;
    caqhId: FieldValue<string>;
    ssn: FieldValue<string>;
  };
  contact: {
    email: string;
    mobile: FieldValue<string>;
    homeAddress: HomeAddress;
  };
  licenses: IntakeLicense[];
  logins: { caqhOnFile: boolean; pecosOnFile: boolean };
}

// Who the practice's invite matched, for the Invite dialog's outcome (board 1b).
export interface KnownPerson {
  displayName: string;
  email: string;
  npi: string | null;
  groupNames: string[];
  journey: "none" | "open" | "submitted";
}

export type InviteMatch =
  | { kind: "new" }
  | { kind: "active_on_file"; person: KnownPerson; matchedOn: "email" | "npi" }
  | { kind: "already_onboarding"; person: KnownPerson; matchedOn: "email" | "npi" }
  | { kind: "already_submitted"; person: KnownPerson; matchedOn: "email" | "npi" }
  | { kind: "on_file_other_group"; person: KnownPerson; matchedOn: "email" | "npi" }
  | { kind: "conflict"; byEmail: KnownPerson; byNpi: KnownPerson };

export interface DocumentSlot {
  key: string;
  kind: DocumentKind;
  label: string;
  required: boolean;
  licenseState?: string;
  needsExpiration: boolean;
  file: { name: string; sizeBytes: number; expiresOn: string | null } | null;
}

export interface VerificationCheck {
  key: string;
  label: string;
  status: "confirmed" | "pending";
  method: "auto" | "person";
  confirmedBy: string | null; // person checks only
  action: "test_login" | "confirm" | null;
}
