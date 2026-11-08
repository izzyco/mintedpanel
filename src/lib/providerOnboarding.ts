// Pure provider-onboarding derivations (docs/provider-onboarding/r1-ui-spec.md §6).
// Stage, waiting-on and document slots are computed from events and the draft
// on every read; nothing here is stored.
import type { OpenProviderOnboarding } from "@/types";
import type {
  DocumentSlot,
  IntakeDraft,
  InviteMatch,
  KnownPerson,
  OnboardingEvent,
  OnboardingEventType,
  OnboardingStage,
  VerificationCheck,
  WaitingOn,
} from "@/types/providerOnboarding";

export const INTAKE_MAX_BYTES = 10 * 1024 * 1024;
/** Where her files wait until Submit copies them into the vault. */
export const INTAKE_UPLOAD_BUCKET = "provider-intake-uploads";
export const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

/** Why a case can't be created for a held provider. The database backstop
 * (migration 20261107020000) raises the same sentence as its DETAIL. */
export const ONBOARDING_HOLD_MESSAGE =
  "This provider's onboarding isn't finished. Admit & assign on the provider's page before creating a case.";

/** Providers whose cases wait for Admit: an open journey
 * whose invite created the record. A gap-fill invite to a provider already on
 * file never pauses her cases. */
export function onboardingHeldProviderIds(open: readonly OpenProviderOnboarding[]): Set<string> {
  return new Set(open.filter((o) => o.createdRecord).map((o) => o.providerId));
}

// Highest rank first. Timestamps are ignored: a later milestone can't be undone.
const STAGE_MILESTONES: [OnboardingEventType, OnboardingStage][] = [
  ["first_case_created", "in_credentialing"],
  ["admitted", "ready"],
  ["submitted", "submitted"],
  ["signed_in", "started"],
];

function has(events: OnboardingEvent[], type: OnboardingEventType): boolean {
  return events.some((e) => e.type === type);
}

function latestAt(events: OnboardingEvent[], types: OnboardingEventType[]): number | null {
  const times = events.filter((e) => types.includes(e.type)).map((e) => Date.parse(e.at));
  return times.length > 0 ? Math.max(...times) : null;
}

export function deriveStage(events: OnboardingEvent[]): OnboardingStage {
  const milestone = STAGE_MILESTONES.find(([type]) => has(events, type));
  return milestone ? milestone[1] : "invited";
}

export function isBeforeSubmit(stage: OnboardingStage): boolean {
  return stage === "invited" || stage === "started";
}

/** A help request (either email hatch) stays open until the practice records
 * that it contacted her, before or after Submit. */
export function helpAwaitsContact(events: OnboardingEvent[]): boolean {
  const help = latestAt(events, ["help_requested", "told_not_needed"]);
  if (help === null) return false;
  const contacted = latestAt(events, ["practice_contacted"]);
  return contacted === null || help > contacted;
}

// Once she has submitted, Minted owns the next step.
export function needsPractice(events: OnboardingEvent[]): boolean {
  return isBeforeSubmit(deriveStage(events)) && helpAwaitsContact(events);
}

export function deriveWaitingOn(events: OnboardingEvent[]): WaitingOn {
  if (!isBeforeSubmit(deriveStage(events))) return "minted";
  return needsPractice(events) ? "practice" : "provider";
}

export function canResend(events: OnboardingEvent[], now: Date): boolean {
  if (!isBeforeSubmit(deriveStage(events))) return false;
  const lastSend = latestAt(events, ["invited", "invitation_resent"]);
  return lastSend === null || now.getTime() - lastSend >= RESEND_COOLDOWN_MS;
}

type SlotFile = DocumentSlot["file"];

const CV_SLOT: Omit<DocumentSlot, "file"> = {
  key: "cv",
  kind: "cv",
  label: "CV",
  required: true,
  needsExpiration: false,
};

const OPTIONAL_SLOTS: Omit<DocumentSlot, "file">[] = [
  { key: "diploma", kind: "diploma", label: "Diploma", required: false, needsExpiration: false },
  {
    key: "board_cert",
    kind: "board_cert",
    label: "Board certification",
    required: false,
    needsExpiration: false,
  },
  {
    key: "coi",
    kind: "coi",
    label: "Your own liability insurance",
    required: false,
    needsExpiration: true,
  },
  { key: "other", kind: "other", label: "Something else", required: false, needsExpiration: false },
];

/** What her documents step requires: a CV, then one license copy per license
 * state. The staff card checks the record against this same list. */
export function requiredDocumentSlots(
  licenseStates: readonly string[],
): Omit<DocumentSlot, "file">[] {
  return [
    CV_SLOT,
    // The license copy takes its expiration date from the form.
    ...licenseStates.map((state) => ({
      key: `license:${state}`,
      kind: "state_license" as const,
      label: `${state} license copy`,
      required: true,
      licenseState: state,
      needsExpiration: false,
    })),
  ];
}

// Slots are rebuilt from the draft each time, so removing a license removes
// its slot and the upload attached to it.
export function documentSlots(draft: IntakeDraft, files: Record<string, SlotFile>): DocumentSlot[] {
  const states = [
    ...new Set(
      draft.licenses
        .map((l) => l.state.value?.trim().toUpperCase())
        .filter((s): s is string => Boolean(s)),
    ),
  ];
  return [...requiredDocumentSlots(states), ...OPTIONAL_SLOTS].map((slot) => ({
    ...slot,
    file: files[slot.key] ?? null,
  }));
}

const LICENSE_SLOT_KEY = /^license:[A-Z]{2}$/;

/** What a slot key holds, or null for a key no slot has. The server checks
 * an upload against it, so the form and the routes agree on every slot. */
export function intakeSlotRule(
  slotKey: string,
): Pick<DocumentSlot, "kind" | "needsExpiration"> | null {
  if (LICENSE_SLOT_KEY.test(slotKey)) return { kind: "state_license", needsExpiration: false };
  const slot = [CV_SLOT, ...OPTIONAL_SLOTS].find((s) => s.key === slotKey);
  return slot ? { kind: slot.kind, needsExpiration: slot.needsExpiration } : null;
}

const INTAKE_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"];

export function validateUpload(file: { name: string; type: string; size: number }): string | null {
  if (!INTAKE_FILE_TYPES.includes(file.type)) return "Upload a PDF, JPG or PNG file.";
  if (file.size <= 0) return "This file is empty. Choose another file.";
  if (file.size > INTAKE_MAX_BYTES) {
    return "This file is over 10 MB. Try a photo of each page instead.";
  }
  return null;
}

// Board 1b. A same-group match splits by where her journey stands; a match in
// another group adds that group with no email (decision 4). When the email and
// the NPI point at two different people, nothing is guessed.
export function classifyInvite(
  input: { email: string; npi: string; groupName: string },
  people: KnownPerson[],
): InviteMatch {
  const email = input.email.trim().toLowerCase();
  const npi = input.npi.trim();
  const byEmail = people.find((p) => p.email.toLowerCase() === email);
  const byNpi = npi ? people.find((p) => p.npi === npi) : undefined;
  if (byEmail && byNpi && byEmail !== byNpi) return { kind: "conflict", byEmail, byNpi };
  const person = byEmail ?? byNpi;
  if (!person) return { kind: "new" };
  const matchedOn = byEmail ? "email" : "npi";
  if (!person.groupNames.includes(input.groupName)) {
    return { kind: "on_file_other_group", person, matchedOn };
  }
  const kind = {
    none: "active_on_file",
    open: "already_onboarding",
    submitted: "already_submitted",
  } as const;
  return { kind: kind[person.journey], person, matchedOn };
}

export function verificationSummary(checks: VerificationCheck[]) {
  const confirmed = checks.filter((c) => c.status === "confirmed").length;
  const problem = checks.filter((c) => c.status === "problem").length;
  return { confirmed, problem, pending: checks.length - confirmed - problem, total: checks.length };
}
