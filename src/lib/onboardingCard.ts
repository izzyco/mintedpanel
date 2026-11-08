// The staff Onboarding card on the provider record (boards 6a and 6b). Pure:
// everything here is derived from read_provider_onboarding and the record on
// each read. Automatic checks are computed, never stored; person checks come
// from the latest provider_onboarding_checks row per key.
import { currentVersions, type DocumentVersionShape } from "@/lib/documents";
import { CAQH_CURRENT_DAYS, daysBetween } from "@/lib/enrollmentReadiness";
import { fmtDate } from "@/lib/format";
import type { IntakePortal } from "@/lib/intakeAnswers";
import { isValidNpi } from "@/lib/providerIdentity";
import {
  deriveStage,
  deriveWaitingOn,
  helpAwaitsContact,
  requiredDocumentSlots,
} from "@/lib/providerOnboarding";
import type { DocumentKind, ProviderOnboardingCheck, ProviderOnboardingRead } from "@/types";
import type {
  CheckSection,
  OnboardingEvent,
  PersonCheck,
  VerificationCheck,
  WaitingOn,
} from "@/types/providerOnboarding";

/** The checks a person answers. Mirrored by the CHECK on
 * provider_onboarding_checks.check_key (migration 20261107010000), and a test
 * holds the two together. */
export const PERSON_CHECK_KEYS = [
  "caqh_login",
  "pecos_login",
  "caqh_attestation",
] as const satisfies readonly ProviderOnboardingCheck["checkKey"][];
export type PersonCheckKey = (typeof PERSON_CHECK_KEYS)[number];

export type OnboardingJourney = ProviderOnboardingRead["journey"];

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const DELIVERIES = ["sent", "sandbox", "failed"] as const;
const SOURCES = ["staff", "practice", "api"] as const;
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return allowed.find((a) => a === v) ?? null;
}

function parseCheck(v: unknown): ProviderOnboardingCheck | null {
  const c = obj(v);
  const checkKey = oneOf(c?.check_key, PERSON_CHECK_KEYS);
  const outcome = oneOf(c?.outcome, ["confirmed", "problem"] as const);
  const checkedAt = str(c?.checked_at);
  if (!c || !checkKey || !outcome || !checkedAt) return null;
  return { checkKey, outcome, note: str(c.note), checkedByName: str(c.checked_by_name), checkedAt };
}

/** read_provider_onboarding's jsonb, or null when she has no journey. Anything
 * that isn't the documented shape reads as no journey, so a missing RPC never
 * breaks the record page. */
export function parseOnboardingRead(raw: unknown): ProviderOnboardingRead | null {
  const r = obj(raw);
  const j = obj(r?.journey);
  const id = str(j?.id);
  const openedAt = str(j?.opened_at);
  if (!r || !j || !id || !openedAt) return null;
  const invite = obj(r.invite);
  const logins = obj(r.logins_on_file);
  const inviteEmail = str(invite?.email);
  const lastSentAt = str(invite?.last_sent_at);
  return {
    journey: {
      id,
      source: oneOf(j.source, SOURCES) ?? "staff",
      createdRecord: j.created_record === true,
      openedAt,
      firstSignedInAt: str(j.first_signed_in_at),
      consentedAt: str(j.consented_at),
      submittedAt: str(j.submitted_at),
      admittedAt: str(j.admitted_at),
      admittedByName: str(j.admitted_by_name),
      admittedFacilityId: str(j.admitted_facility_id),
      cancelledAt: str(j.cancelled_at),
      lastHelpAt: str(j.last_help_at),
      lastContactedAt: str(j.last_contacted_at),
    },
    invite:
      inviteEmail && lastSentAt
        ? {
            email: inviteEmail,
            lastSentAt,
            delivery: oneOf(invite?.delivery, DELIVERIES),
            sends: typeof invite?.sends === "number" ? invite.sends : 1,
          }
        : null,
    checks: Array.isArray(r.checks) ? r.checks.flatMap((c) => parseCheck(c) ?? []) : [],
    loginsOnFile: { caqh: logins?.caqh === true, pecos: logins?.pecos === true },
    ssnOnFile: r.ssn_on_file === true,
    heldUploads: typeof r.held_uploads === "number" ? r.held_uploads : 0,
    hasCase: r.has_case === true,
    npiInUse: r.npi_in_use === true,
  };
}

/** "open": invited through submitted. "admitted": the card is one line. A
 * cancelled latest journey shows nothing, the same as never invited. */
export type CardPhase = "none" | "open" | "admitted";

export function cardPhase(read: ProviderOnboardingRead | null): CardPhase {
  if (!read || read.journey.cancelledAt) return "none";
  return read.journey.admittedAt ? "admitted" : "open";
}

// A case only moves the tracker once she is admitted: a case that predates an
// open gap-fill journey is work from before it, not this journey's last step.
export function onboardingEvents(read: ProviderOnboardingRead): OnboardingEvent[] {
  const j = read.journey;
  const events: OnboardingEvent[] = [{ type: "invited", at: j.openedAt }];
  const add = (type: OnboardingEvent["type"], at: string | null) => {
    if (at) events.push({ type, at });
  };
  if (read.invite && read.invite.sends > 1) add("invitation_resent", read.invite.lastSentAt);
  add("signed_in", j.firstSignedInAt);
  add("submitted", j.submittedAt);
  add("admitted", j.admittedAt);
  add("help_requested", j.lastHelpAt);
  add("practice_contacted", j.lastContactedAt);
  if (j.admittedAt && read.hasCase) add("first_case_created", j.admittedAt);
  return events;
}

export function waitingOnLine(
  j: OnboardingJourney,
  events: OnboardingEvent[],
  firstName: string,
): { who: WaitingOn; label: string; detail: string } {
  const who = deriveWaitingOn(events);
  if (who === "practice") {
    return {
      who,
      label: "The practice",
      detail: `${firstName} asked for help ${fmtDate(j.lastHelpAt)}`,
    };
  }
  if (who === "provider") {
    return {
      who,
      label: firstName,
      detail:
        deriveStage(events) === "started"
          ? "signed in, not submitted"
          : "invited, hasn't signed in yet",
    };
  }
  const help = helpAwaitsContact(events) ? `; asked for help ${fmtDate(j.lastHelpAt)}` : "";
  return {
    who,
    label: "Minted",
    detail: `submitted ${fmtDate(j.submittedAt)}, ready for review${help}`,
  };
}

export function inviteLine(read: ProviderOnboardingRead): string {
  const invited = fmtDate(read.journey.openedAt);
  if (!read.invite) return invited;
  const resent = read.invite.sends > 1 ? ` · resent ${fmtDate(read.invite.lastSentAt)}` : "";
  return `${invited} · ${read.invite.email}${resent}`;
}

/** What she has saved so far, before Submit. */
export function progressItems(read: ProviderOnboardingRead): string[] {
  const items: string[] = [];
  if (read.journey.consentedAt) items.push(`Consent signed ${fmtDate(read.journey.consentedAt)}`);
  if (read.heldUploads > 0) {
    items.push(`${read.heldUploads} ${read.heldUploads === 1 ? "file" : "files"} uploaded`);
  }
  if (read.ssnOnFile) items.push("SSN on file");
  const logins = [read.loginsOnFile.caqh && "CAQH", read.loginsOnFile.pecos && "PECOS"].filter(
    Boolean,
  );
  if (logins.length > 0) {
    items.push(`${logins.join(" and ")} ${logins.length === 1 ? "login" : "logins"} on file`);
  }
  return items.length > 0 ? items : ["Nothing saved yet"];
}

export function admittedLine(read: ProviderOnboardingRead, locationName: string | null): string {
  const j = read.journey;
  const by = j.admittedByName ? ` by ${j.admittedByName}` : "";
  const where = locationName ? ` · ${locationName}` : "";
  const stage = read.hasCase ? "In credentialing" : "Ready for credentialing";
  return `Admitted ${fmtDate(j.admittedAt)}${by}${where} · ${stage}`;
}

export interface CardProvider {
  npi: string | null;
  caqhId: string | null;
  caqhLastAttestedDate: string | null;
  dateOfBirth: string | null;
}

export interface CardLicense {
  state: string;
  expirationDate: string | null;
  verifiedStatus: "unverified" | "verified" | "failed";
}

export interface CardDocument extends DocumentVersionShape {
  docType: DocumentKind;
}

export interface VerificationInput {
  read: ProviderOnboardingRead;
  provider: CardProvider;
  licenses: readonly CardLicense[];
  /** Every version of her documents; only current ones count. */
  documents: readonly CardDocument[];
  today: string;
}

type Outcome = Pick<VerificationCheck, "status" | "detail">;

const confirmed: Outcome = { status: "confirmed", detail: null };

function missing(items: (string | false)[]): Outcome {
  const gaps = items.filter((i): i is string => Boolean(i));
  return gaps.length === 0
    ? confirmed
    : { status: "pending", detail: `Missing: ${gaps.join(", ")}` };
}

function auto(
  key: string,
  label: string,
  section: CheckSection | null,
  outcome: Outcome,
): VerificationCheck {
  return { key, label, method: "auto", section, ...outcome };
}

function npiOutcome(npi: string | null): Outcome {
  if (!npi) return { status: "pending", detail: "No NPI on the record" };
  return isValidNpi(npi) ? confirmed : { status: "problem", detail: "Fails the NPI check digit" };
}

function npiUniqueOutcome(npi: string | null, inUse: boolean): Outcome {
  if (!npi) return { status: "pending", detail: "No NPI on the record" };
  return inUse
    ? { status: "problem", detail: "Another provider in this organization has this NPI" }
    : confirmed;
}

// One row per license state, judged by that state's newest license: the PSV
// trail on the Licenses tab is the answer, so a check here never duplicates it.
function licenseChecks(licenses: readonly CardLicense[], today: string): VerificationCheck[] {
  const newest = new Map<string, CardLicense>();
  for (const l of licenses) {
    const held = newest.get(l.state);
    if (!held || (l.expirationDate ?? "") > (held.expirationDate ?? "")) newest.set(l.state, l);
  }
  if (newest.size === 0) {
    return [
      auto("license", "State license", "licenses", {
        status: "pending",
        detail: "No license on the record",
      }),
    ];
  }
  return [...newest.values()]
    .sort((a, b) => a.state.localeCompare(b.state))
    .map((l) => {
      let outcome: Outcome = confirmed;
      if (l.expirationDate && l.expirationDate.slice(0, 10) < today) {
        outcome = { status: "problem", detail: `Expired ${fmtDate(l.expirationDate)}` };
      } else if (l.verifiedStatus === "failed") {
        outcome = { status: "problem", detail: "Verification failed" };
      } else if (l.verifiedStatus !== "verified") {
        outcome = { status: "pending", detail: "Not verified yet" };
      }
      return auto(`license:${l.state}`, `${l.state} license verified`, "licenses", outcome);
    });
}

function documentsOutcome(
  documents: readonly CardDocument[],
  licenseStates: readonly string[],
): Outcome {
  const held = currentVersions(documents).map((d) => d.docType);
  const required = requiredDocumentSlots(licenseStates).map((s) => s.kind);
  const short = (kind: DocumentKind) =>
    required.filter((k) => k === kind).length - held.filter((k) => k === kind).length;
  const copies = short("state_license");
  return missing([
    short("cv") > 0 && "CV",
    copies > 0 && `${copies} license ${copies === 1 ? "copy" : "copies"}`,
  ]);
}

function personCheck(
  check: Pick<PersonCheck, "key" | "label" | "portal" | "action">,
  latest: ProviderOnboardingCheck | undefined,
  pendingDetail: string | null,
): PersonCheck {
  const base = { ...check, method: "person" as const };
  if (!latest) {
    return {
      ...base,
      status: "pending",
      confirmedBy: null,
      checkedAt: null,
      detail: pendingDetail,
    };
  }
  return {
    ...base,
    status: latest.outcome,
    confirmedBy: latest.checkedByName,
    checkedAt: latest.checkedAt,
    detail: latest.outcome === "problem" ? latest.note : pendingDetail,
  };
}

function attestationDetail(attested: string | null, today: string): string {
  if (!attested) return "No attestation date on the record";
  const age = daysBetween(attested, today);
  const on = `The record says ${fmtDate(attested)}`;
  return age >= 0 ? `${on}, ${age} ${age === 1 ? "day" : "days"} ago` : on;
}

/** Board 6b's Verification block, in display order. */
export function verificationChecks(input: VerificationInput): VerificationCheck[] {
  const { read, provider, licenses, documents, today } = input;
  const latest = new Map(read.checks.map((c) => [c.checkKey, c]));
  const licenseStates = [...new Set(licenses.map((l) => l.state))];
  const loginCheck = (key: "caqh_login" | "pecos_login", portal: IntakePortal, name: string) =>
    personCheck(
      {
        key,
        label: `${name} login works`,
        portal: { key: portal, name },
        action: read.loginsOnFile[portal] ? "test_login" : "confirm",
      },
      latest.get(key),
      read.loginsOnFile[portal] ? null : `No ${name} login on file`,
    );

  return [
    auto("npi", "NPI", "identity", npiOutcome(provider.npi)),
    auto(
      "npi_unique",
      "NPI not on another provider",
      "identity",
      npiUniqueOutcome(provider.npi, read.npiInUse),
    ),
    auto("caqh_id", "CAQH ID", "identity", missing([!provider.caqhId && "CAQH ID"])),
    personCheck(
      {
        key: "caqh_attestation",
        label: `CAQH attested within ${CAQH_CURRENT_DAYS} days`,
        portal: null,
        action: "confirm",
      },
      latest.get("caqh_attestation"),
      attestationDetail(provider.caqhLastAttestedDate, today),
    ),
    ...licenseChecks(licenses, today),
    auto(
      "dob_ssn",
      "Date of birth and SSN on file",
      "identity",
      missing([!provider.dateOfBirth && "date of birth", !read.ssnOnFile && "SSN"]),
    ),
    auto(
      "logins_on_file",
      "CAQH and PECOS logins on file",
      null,
      missing([!read.loginsOnFile.caqh && "CAQH", !read.loginsOnFile.pecos && "PECOS"]),
    ),
    auto(
      "documents",
      "Required documents on file (CV, a license copy per state)",
      "documents",
      documentsOutcome(documents, licenseStates),
    ),
    loginCheck("caqh_login", "caqh", "CAQH"),
    loginCheck("pecos_login", "pecos", "PECOS"),
  ];
}

export interface AdmitLocation {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

interface FacilityRow extends AdmitLocation {
  groupId: string | null;
  isActive: boolean;
}

/** Active locations owned by a group she is currently assigned to, A to Z. The
 * admit RPC applies the same rule. */
export function admitLocations(
  facilities: readonly FacilityRow[],
  groupAssignments: readonly { providerId: string; groupId: string; endDate: string | null }[],
  providerId: string,
): AdmitLocation[] {
  const groups = new Set(
    groupAssignments.filter((a) => a.providerId === providerId && !a.endDate).map((a) => a.groupId),
  );
  return facilities
    .filter((f) => f.isActive && f.groupId !== null && groups.has(f.groupId))
    .map(({ id, name, city, state }) => ({ id, name, city, state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Inside Admit & assign. A location outside her license states is a
 * warning she can confirm past, never a block. */
export type AdmitLocationCheck =
  | { kind: "pick" }
  | { kind: "ok" }
  | { kind: "out_of_state"; state: string | null; licenseStates: string[] };

export function admitLocationCheck(
  pickedId: string | null,
  locations: readonly AdmitLocation[],
  licenseStates: readonly string[],
): AdmitLocationCheck {
  const picked = locations.find((l) => l.id === pickedId);
  if (!picked) return { kind: "pick" };
  const states = [...new Set(licenseStates)].sort();
  if (picked.state && states.includes(picked.state)) return { kind: "ok" };
  return { kind: "out_of_state", state: picked.state, licenseStates: states };
}
