// Provider Onboarding funnel (Oct 20 review, RC-06; stage names from the PM,
// Oct 30, and her answers of Oct 31 and Nov 1). The funnel is the provider's
// state, not case status. Pure; "today" and the configuration are passed in.
//
// Each provider is placed by one fixed check, in this order:
//   1. Credentialing: a case in a status that counts (every status by
//      default). Never split by status; that belongs on the case board.
//   2. Profile incomplete: a required profile field is missing.
//   3. Submitted: complete but not yet verified. It says nothing about
//      anything being sent anywhere. Location gaps are listed too, never a
//      group problem (A23).
//   4. Verified, awaiting assignment: verified, but the group, a location or
//      a location's state still holds them.
//   5. Ready for credentialing.
//
// What each check reads, computed per provider:
//   complete     every required profile field is present (a setting, A26; by
//                default NPI, CAQH ID, date of birth, SSN last 4, and a
//                license with a valid state code for each working state).
//   verified     the record is not pending verification, CAQH is attested
//                within the shared window (src/lib/caqhAttestation.ts, A26;
//                checked when a CAQH ID is required or on file), and every
//                license judged is board-verified and unexpired (by default
//                one with no expiry is not current, A26). Licenses are judged
//                for the valid states of the provider's active locations;
//                with none, every license on file is.
//   assigned     a location that counts: by default one under a current group
//                of theirs or under no group at all (in-home addresses, A22).
//                One under another group never counts (A21), though its state
//                still needs a license.
//   grouped      a current group membership. Staff assign groups, so a group
//                problem is a staff-side gap: listed under Verified, awaiting
//                assignment, never as the provider's reason (A23). Without a
//                current group, a location under another group is part of
//                that staff-side gap.
//   statesValid  every active location has a valid state.
//
// Settings (OnboardingFunnelRules) resolve field by field, organization over
// platform over default. "Ready requires a group and a location" and "a
// location with no state holds" are independent (A24); future-dated
// memberships and future-dated location assignments are separate settings
// (A27). An organization may also rename and re-describe the stages, and
// nothing else about them (S10). Its layer goes live whole or not at all.
// Nothing stores either layer yet; the Mission Control setting is MINT-125.
//
// A group membership counts while its group is active and until its end
// date passes. Billing Readiness (src/lib/billingReadiness.ts) and the
// contract SOP assignments (src/services/contractSopAssignments.ts) require
// a start date on or before today, because they ask who is working now.
//
// Invited (providers who have not sent the intake form back) needs the
// intake tables, which this read cannot see; it returns with MINT-89.
//
// Not the provider onboarding (intake) flow in src/lib/providerOnboarding.ts:
// this is the Reporting Center funnel over the provider records themselves.
// PHI rule: demographics arrive as presence booleans only.
import { DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS } from "@/lib/caqhAttestation";
import type { CaseStatus } from "@/lib/caseStatus";
import { isCaqhCurrent } from "@/lib/enrollmentReadiness";

// ---------------------------------------------------------------------------
// Settings

/** The profile fields a setting can require for "complete" (A26). */
export type OnboardingFunnelProfileField =
  "npi" | "caqhId" | "dateOfBirth" | "ssnLast4" | "stateLicense";

export interface OnboardingFunnelRules {
  /** Case statuses that do NOT count as Credentialing. Default none: every
   * case counts, whatever its status. The cases stay on record as facts. */
  caseStatusesNotCountedAsCredentialing: readonly CaseStatus[];
  /** The fields that make a profile complete (A26). Default: all five. */
  requiredProfileFields: readonly OnboardingFunnelProfileField[];
  /** Default on: a license with no expiration date is not current (A26). */
  licenseWithoutExpiryHolds: boolean;
  /** Default on: an active location with no valid state holds the provider.
   * Independent of assignmentRequiredForReady (A24). */
  statelessLocationHolds: boolean;
  /** Default on: Ready needs a current group and a location that counts. */
  assignmentRequiredForReady: boolean;
  /** Default on: a membership that starts after today already counts (A27). */
  futureMembershipCounts: boolean;
  /** Default on: a location assignment that starts after today already
   * counts (A27). */
  futureLocationAssignmentCounts: boolean;
  /** Default on: a location counts only under one of the provider's current
   * groups, or under none (see ungroupedLocationCounts). */
  locationMustBeInProviderGroup: boolean;
  /** Default on: a location under no group counts for any provider (A22). */
  ungroupedLocationCounts: boolean;
}

/** The platform default: the PM's decisions of Oct 30 and 31. */
export const DEFAULT_ONBOARDING_FUNNEL_RULES: Readonly<OnboardingFunnelRules> = {
  caseStatusesNotCountedAsCredentialing: [],
  requiredProfileFields: ["npi", "caqhId", "dateOfBirth", "ssnLast4", "stateLicense"],
  licenseWithoutExpiryHolds: true,
  statelessLocationHolds: true,
  assignmentRequiredForReady: true,
  futureMembershipCounts: true,
  futureLocationAssignmentCounts: true,
  locationMustBeInProviderGroup: true,
  ungroupedLocationCounts: true,
};

/** A platform or organization override; a null or missing field inherits. */
export type OnboardingFunnelRulesOverride = {
  readonly [K in keyof OnboardingFunnelRules]?: OnboardingFunnelRules[K] | null;
};

/** Field by field: the organization's value, else the platform's, else the
 * default. */
export function resolveOnboardingFunnelRules(
  platform?: OnboardingFunnelRulesOverride | null,
  organization?: OnboardingFunnelRulesOverride | null,
): OnboardingFunnelRules {
  const pick = <K extends keyof OnboardingFunnelRules>(key: K): OnboardingFunnelRules[K] =>
    organization?.[key] ?? platform?.[key] ?? DEFAULT_ONBOARDING_FUNNEL_RULES[key];
  return {
    caseStatusesNotCountedAsCredentialing: pick("caseStatusesNotCountedAsCredentialing"),
    requiredProfileFields: pick("requiredProfileFields"),
    licenseWithoutExpiryHolds: pick("licenseWithoutExpiryHolds"),
    statelessLocationHolds: pick("statelessLocationHolds"),
    assignmentRequiredForReady: pick("assignmentRequiredForReady"),
    futureMembershipCounts: pick("futureMembershipCounts"),
    futureLocationAssignmentCounts: pick("futureLocationAssignmentCounts"),
    locationMustBeInProviderGroup: pick("locationMustBeInProviderGroup"),
    ungroupedLocationCounts: pick("ungroupedLocationCounts"),
  };
}

// ---------------------------------------------------------------------------
// Stages

export type OnboardingFunnelStageKey =
  | "profile_incomplete"
  | "submitted"
  | "verified_awaiting_assignment"
  | "ready_for_credentialing"
  | "credentialing";

export interface OnboardingFunnelStageText {
  label: string;
  description: string;
}

export interface OnboardingFunnelStage extends OnboardingFunnelStageText {
  key: OnboardingFunnelStageKey;
  /** Providers here are held by gaps the report lists ("What's needed"). */
  listsGaps: boolean;
}

/** The PM's stages (Oct 30 and 31), in funnel order. Labels are free text
 * (A29); the descriptions state no rule (A18). */
export const DEFAULT_ONBOARDING_FUNNEL_STAGES: readonly OnboardingFunnelStage[] = [
  {
    key: "profile_incomplete",
    label: "Profile incomplete",
    description: "A required profile field is missing.",
    listsGaps: true,
  },
  {
    key: "submitted",
    label: "Submitted",
    description: "Information is complete but not yet verified.",
    listsGaps: true,
  },
  {
    key: "verified_awaiting_assignment",
    label: "Verified, awaiting assignment",
    description: "Verified; the group, the location, or a location's record still needs attention.",
    listsGaps: true,
  },
  {
    key: "ready_for_credentialing",
    label: "Ready for credentialing",
    description: "Meets every requirement for credentialing.",
    listsGaps: false,
  },
  {
    key: "credentialing",
    label: "Credentialing",
    description: "Has at least one credentialing case.",
    listsGaps: false,
  },
];

export interface OnboardingFunnelConfig {
  /** Minted's stages, with an organization's labels and descriptions. */
  stages: readonly OnboardingFunnelStage[];
  rules: OnboardingFunnelRules;
  /** The shared CAQH attestation window, in days: one setting with
   * enrollment readiness (resolveCaqhAttestationWindowDays, A26). */
  caqhAttestationWindowDays: number;
}

export const DEFAULT_ONBOARDING_FUNNEL_CONFIG: Readonly<OnboardingFunnelConfig> = {
  stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
  rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
  caqhAttestationWindowDays: DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS,
};

/** An organization's layer (S10): it may rename and re-describe Minted's
 * stages and set rules; Minted sets them at onboarding and org admins only
 * read them. */
export interface OnboardingFunnelOrganizationOverride {
  stageText?: Partial<Record<OnboardingFunnelStageKey, OnboardingFunnelStageText>> | null;
  rules?: OnboardingFunnelRulesOverride | null;
}

/** Minted's rules, with the organization's layer on top. The layer goes
 * live whole (copy and rules) or not at all: one blank label or description
 * and Minted's copy and rules apply. */
export function resolveOnboardingFunnelConfig(
  platformRules: OnboardingFunnelRulesOverride | null | undefined,
  organization: OnboardingFunnelOrganizationOverride | null | undefined,
  caqhAttestationWindowDays: number,
): OnboardingFunnelConfig {
  const text = Object.values(organization?.stageText ?? {});
  const org = text.every((t) => t.label.trim() && t.description.trim()) ? organization : null;
  return {
    stages: DEFAULT_ONBOARDING_FUNNEL_STAGES.map((stage) => {
      const copy = org?.stageText?.[stage.key];
      return copy
        ? { ...stage, label: copy.label.trim(), description: copy.description.trim() }
        : stage;
    }),
    rules: resolveOnboardingFunnelRules(platformRules, org?.rules),
    caqhAttestationWindowDays,
  };
}

/** The stages the report shows. With both of the rules that hold a verified
 * provider off (A24), nobody can be awaiting assignment, so it is hidden. */
export function visibleOnboardingFunnelStages(
  config: OnboardingFunnelConfig,
): OnboardingFunnelStage[] {
  const { assignmentRequiredForReady, statelessLocationHolds } = config.rules;
  return config.stages.filter(
    (stage) =>
      stage.key !== "verified_awaiting_assignment" ||
      assignmentRequiredForReady ||
      statelessLocationHolds,
  );
}

// ---------------------------------------------------------------------------
// Placement

/** What the fixed check reads, per provider. */
export interface OnboardingFunnelDimensions {
  complete: boolean;
  completenessGaps: string[];
  verified: boolean;
  verificationGaps: string[];
  /** Has an active, non-reference location that counts. */
  assigned: boolean;
  assignmentGaps: string[];
  /** Has a current group membership. Group gaps are staff-side (A23). */
  grouped: boolean;
  groupGaps: string[];
  /** Every active location has a valid state. */
  statesValid: boolean;
  stateGaps: string[];
  /** At least one case in a status that counts as Credentialing. */
  hasCountedCase: boolean;
}

const unique = (gaps: string[]) => [...new Set(gaps)];

/** The fixed check: case, incomplete, unverified, placement held, ready. */
export function placeOnboardingFunnelStage(
  d: OnboardingFunnelDimensions,
  rules: OnboardingFunnelRules,
): { stage: OnboardingFunnelStageKey; gaps: string[] } {
  if (d.hasCountedCase) return { stage: "credentialing", gaps: [] };
  if (!d.complete) return { stage: "profile_incomplete", gaps: d.completenessGaps };
  // The location gaps the provider may see; never the group (A23).
  const locationGaps = [
    ...(rules.assignmentRequiredForReady ? d.assignmentGaps : []),
    ...(rules.statelessLocationHolds ? d.stateGaps : []),
  ];
  if (!d.verified)
    return { stage: "submitted", gaps: unique([...d.verificationGaps, ...locationGaps]) };
  const held =
    (rules.assignmentRequiredForReady && (!d.assigned || !d.grouped)) ||
    (rules.statelessLocationHolds && !d.statesValid);
  if (held) {
    const groupGaps = rules.assignmentRequiredForReady ? d.groupGaps : [];
    return { stage: "verified_awaiting_assignment", gaps: unique([...locationGaps, ...groupGaps]) };
  }
  return { stage: "ready_for_credentialing", gaps: [] };
}

// ---------------------------------------------------------------------------
// Input and rows

export interface OnboardingFunnelProviderFacts {
  providerId: string;
  name: string;
  npi: string | null;
  caqhIdPresent: boolean;
  caqhLastAttestedDate: string | null;
  dobPresent: boolean;
  ssnLast4Present: boolean;
  pendingVerification: boolean;
}

export interface OnboardingFunnelLicenseInput {
  providerId: string | null;
  state: string;
  verifiedStatus: string;
  expirationDate: string | null;
}

/** One assignment to an active, non-reference location. */
export interface OnboardingFunnelLocationInput {
  providerId: string | null;
  locationId: string;
  locationName: string;
  state: string | null;
  /** The group the location is under; null when it has none. */
  groupId: string | null;
  groupName: string | null;
  /** The assignment's start date (provider_facility_assignments.start_date). */
  assignmentStartDate: string | null;
}

/** A group membership, current or not. */
export interface OnboardingFunnelMembershipInput {
  providerId: string | null;
  groupId: string | null;
  groupName: string | null;
  /** null when the read cannot see the group: unknown, never "inactive". */
  groupActive: boolean | null;
  startDate: string | null;
  endDate: string | null;
}

export interface OnboardingFunnelCaseInput {
  providerId: string | null;
  state: string | null;
  /** null when the stored value is not a known status; such a case counts. */
  status: CaseStatus | null;
}

export interface OnboardingFunnelInput {
  providers: readonly OnboardingFunnelProviderFacts[];
  licenses: readonly OnboardingFunnelLicenseInput[];
  locations: readonly OnboardingFunnelLocationInput[];
  groupMemberships: readonly OnboardingFunnelMembershipInput[];
  cases: readonly OnboardingFunnelCaseInput[];
}

/** What the service returns: the input plus the configuration resolved for
 * the org. */
export interface OnboardingFunnelRead extends OnboardingFunnelInput {
  config: OnboardingFunnelConfig;
}

export interface OnboardingFunnelRow {
  providerId: string;
  name: string;
  npi: string | null;
  stage: OnboardingFunnelStageKey;
  /** What keeps the provider in their stage, for stages that list gaps. */
  gaps: string[];
  /** Every state the provider touches: work, license, or any case on file. */
  states: string[];
  dimensions: OnboardingFunnelDimensions;
}

export const STATELESS_LOCATION_GAP = "Location has no valid state on record";
/** A23: staff assign groups, so this is a staff-side gap, never the
 * provider's reason. */
export const NO_GROUP_GAP = "No group assigned yet";

function code(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function day(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}

function groupByProvider<T extends { providerId: string | null }>(rows: readonly T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.providerId) continue;
    map.set(row.providerId, [...(map.get(row.providerId) ?? []), row]);
  }
  return map;
}

/** Why a membership is not current, or null when it is. */
function lapsedMembershipReason(
  membership: OnboardingFunnelMembershipInput,
  today: string,
  rules: OnboardingFunnelRules,
): string | null {
  const name = membership.groupName ?? "the provider's group";
  const start = day(membership.startDate);
  const end = day(membership.endDate);
  // A group the read cannot see is unknown: it does not count, and the
  // reason claims nothing about it.
  if (membership.groupActive === null) return "Membership group not found";
  if (!membership.groupActive)
    return membership.groupName
      ? `Group ${membership.groupName} is inactive`
      : "The provider's group is inactive";
  if (end !== null && end < today) return `Membership in ${name} ended ${end}`;
  if (!rules.futureMembershipCounts && start !== null && start > today)
    return `Membership in ${name} starts ${start}`;
  return null;
}

/** Why a location does not count, or null when it does. A group reason
 * means the location's group is not a current group of the provider's:
 * `mismatch` says so in location terms, and `membership` names the
 * provider's membership there when one exists but does not count. */
type LocationReason =
  | { kind: "location"; text: string }
  | { kind: "group"; mismatch: string; membership: string | null };

function locationReason(
  location: OnboardingFunnelLocationInput,
  current: ReadonlySet<string>,
  lapsed: ReadonlyMap<string, string>,
  today: string,
  rules: OnboardingFunnelRules,
): LocationReason | null {
  const name = location.locationName;
  if (rules.locationMustBeInProviderGroup) {
    if (location.groupId === null) {
      if (!rules.ungroupedLocationCounts)
        return { kind: "location", text: `Location ${name} has no group` };
    } else if (!current.has(location.groupId)) {
      return {
        kind: "group",
        mismatch: `Location ${name} is under ${location.groupName ?? "another group"}, not the provider's group`,
        membership: lapsed.get(location.groupId) ?? null,
      };
    }
  }
  const start = day(location.assignmentStartDate);
  if (!rules.futureLocationAssignmentCounts && start !== null && start > today)
    return { kind: "location", text: `Assignment to ${name} starts ${start}` };
  return null;
}

function placementGaps(
  memberships: readonly OnboardingFunnelMembershipInput[],
  locations: readonly OnboardingFunnelLocationInput[],
  today: string,
  rules: OnboardingFunnelRules,
) {
  const current = new Set<string>();
  const lapsed = new Map<string, string>();
  for (const m of memberships) {
    if (!m.groupId) continue;
    const reason = lapsedMembershipReason(m, today, rules);
    if (reason === null) current.add(m.groupId);
    else lapsed.set(m.groupId, reason);
  }

  // The group (A23, staff-side): named when a membership exists but does not
  // count, else the plain fact that none is assigned.
  const grouped = current.size > 0;
  const groupGaps = grouped
    ? []
    : lapsed.size > 0
      ? [...new Set(lapsed.values())].sort()
      : [NO_GROUP_GAP];

  // The location: per-location reasons, for a provider with or without a
  // group alike. An ungrouped location can count for anyone (A22).
  // Membership and group text is always staff-side. Without a current
  // group, a location under someone else's group is part of that group gap
  // too. With one, the location's mismatch is a real location gap, said in
  // location terms, and any membership reason for its group goes with the
  // staff-side group gaps.
  let assigned = false;
  const assignmentGaps: string[] = [];
  if (locations.length === 0) assignmentGaps.push("Needs a location");
  else {
    const sorted = [...locations].sort(
      (a, b) =>
        a.locationName.localeCompare(b.locationName) || a.locationId.localeCompare(b.locationId),
    );
    const reasons = sorted.map((l) => locationReason(l, current, lapsed, today, rules));
    assigned = reasons.some((reason) => reason === null);
    if (!assigned)
      for (const reason of reasons as LocationReason[]) {
        if (reason.kind === "location") assignmentGaps.push(reason.text);
        else if (!grouped) groupGaps.push(reason.membership ?? reason.mismatch);
        else {
          assignmentGaps.push(reason.mismatch);
          if (reason.membership) groupGaps.push(reason.membership);
        }
      }
  }

  const stateGaps = locations.some((l) => code(l.state) === null) ? [STATELESS_LOCATION_GAP] : [];
  return {
    assigned,
    assignmentGaps: unique(assignmentGaps),
    grouped,
    groupGaps: unique(groupGaps),
    stateGaps,
  };
}

export function buildOnboardingFunnelRows(
  input: OnboardingFunnelInput,
  today: string,
  config: OnboardingFunnelConfig,
): OnboardingFunnelRow[] {
  const { rules, caqhAttestationWindowDays } = config;
  const required = new Set(rules.requiredProfileFields);
  const notCounted = new Set<string>(rules.caseStatusesNotCountedAsCredentialing);
  const licensesBy = groupByProvider(input.licenses);
  const locationsBy = groupByProvider(input.locations);
  const casesBy = groupByProvider(input.cases);
  const membershipsBy = groupByProvider(input.groupMemberships);
  // A license with no expiry sorts last while it is not current, first
  // while it counts as never expiring.
  const expirySortKey = (date: string | null) =>
    date ?? (rules.licenseWithoutExpiryHolds ? "" : "9999-12-31");

  return input.providers
    .map((p): OnboardingFunnelRow => {
      const licenses = licensesBy.get(p.providerId) ?? [];
      const locations = locationsBy.get(p.providerId) ?? [];
      const cases = casesBy.get(p.providerId) ?? [];
      const workStates = [...new Set(locations.map((row) => code(row.state)))].filter(
        (s): s is string => s !== null,
      );
      // Facts: every case counts toward the states the provider touches.
      const states = [
        ...new Set(
          [
            ...workStates,
            ...licenses.map((l) => code(l.state)),
            ...cases.map((c) => code(c.state)),
          ].filter((s): s is string => s !== null),
        ),
      ].sort();

      // complete, over the required fields (A26). A license only counts once
      // its state code is valid: one with a blank or unknown state can never
      // be checked against a working state.
      const stateLicenses = licenses.filter((l) => code(l.state) !== null);
      const licenseStates = new Set(stateLicenses.map((l) => code(l.state) as string));
      const licenseGaps = [
        ...(stateLicenses.length === 0
          ? [licenses.length === 0 ? "No state license" : "License state is missing or invalid"]
          : []),
        ...(stateLicenses.length === 0
          ? []
          : workStates.filter((s) => !licenseStates.has(s)).map((s) => `No ${s} license`)),
      ];
      const completenessGaps = [
        ...(required.has("npi") && !p.npi?.trim() ? ["No NPI"] : []),
        ...(required.has("caqhId") && !p.caqhIdPresent ? ["No CAQH ID"] : []),
        ...(required.has("dateOfBirth") && !p.dobPresent ? ["No date of birth"] : []),
        ...(required.has("ssnLast4") && !p.ssnLast4Present ? ["No SSN last 4"] : []),
        ...(required.has("stateLicense") ? licenseGaps : []),
      ];

      // verified. Judge the licenses for the valid states they work in;
      // with no valid working state, every license on file. A stateless
      // location is a gap of its own. While another location has a valid
      // state, no license is judged for the stateless one: the state it will
      // have is unknown (kept, Nov 1).
      const judged = workStates.length > 0 ? workStates : [...licenseStates];
      const verificationGaps: string[] = [];
      for (const state of judged) {
        const best = stateLicenses
          .filter((l) => code(l.state) === state)
          .sort(
            (a, b) =>
              Number(b.verifiedStatus === "verified") - Number(a.verifiedStatus === "verified") ||
              expirySortKey(b.expirationDate).localeCompare(expirySortKey(a.expirationDate)),
          )[0];
        if (!best) continue;
        if (best.verifiedStatus !== "verified")
          verificationGaps.push(`${state} license not board-verified`);
        if (!best.expirationDate) {
          if (rules.licenseWithoutExpiryHolds)
            verificationGaps.push(`${state} license has no expiration date`);
        } else if (best.expirationDate.slice(0, 10) < today)
          verificationGaps.push(`${state} license expired`);
      }
      // CAQH attestation is checked when a CAQH ID is required or on file:
      // a provider with neither has nothing to attest, so they are never
      // held by it.
      if (required.has("caqhId") || p.caqhIdPresent) {
        const attested = day(p.caqhLastAttestedDate);
        if (!isCaqhCurrent(attested, today, caqhAttestationWindowDays)) {
          verificationGaps.push(
            !attested
              ? "CAQH never attested"
              : attested > today
                ? "CAQH attestation date is in the future"
                : `CAQH attestation older than ${caqhAttestationWindowDays} days`,
          );
        }
      }
      if (p.pendingVerification) verificationGaps.push("Record pending verification");

      const placement = placementGaps(
        membershipsBy.get(p.providerId) ?? [],
        locations,
        today,
        rules,
      );
      const dimensions: OnboardingFunnelDimensions = {
        complete: completenessGaps.length === 0,
        completenessGaps,
        verified: verificationGaps.length === 0,
        verificationGaps,
        assigned: placement.assigned,
        assignmentGaps: placement.assignmentGaps,
        grouped: placement.grouped,
        groupGaps: placement.groupGaps,
        statesValid: placement.stateGaps.length === 0,
        stateGaps: placement.stateGaps,
        hasCountedCase: cases.some((c) => c.status === null || !notCounted.has(c.status)),
      };
      return {
        providerId: p.providerId,
        name: p.name,
        npi: p.npi,
        ...placeOnboardingFunnelStage(dimensions, rules),
        states,
        dimensions,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.providerId.localeCompare(b.providerId));
}

/** Providers per stage key, every stage present. */
export function onboardingFunnelStageCounts(
  rows: readonly OnboardingFunnelRow[],
  stages: ReadonlyArray<Pick<OnboardingFunnelStage, "key">>,
): Partial<Record<OnboardingFunnelStageKey, number>> {
  const counts: Partial<Record<OnboardingFunnelStageKey, number>> = Object.fromEntries(
    stages.map((stage) => [stage.key, 0]),
  );
  for (const row of rows) counts[row.stage] = (counts[row.stage] ?? 0) + 1;
  return counts;
}

/** Every state any provider touches (work, license, or case), A→Z. */
export function onboardingFunnelStates(rows: readonly OnboardingFunnelRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.states))].sort();
}
