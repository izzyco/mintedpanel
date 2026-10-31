// Provider Onboarding funnel (Oct 20 review, RC-06; stage names from the PM,
// Oct 30, and her answers of Oct 31). The funnel is the provider's state, not
// case status: payer work can start only once the profile is in, verified,
// and assigned to a group and a location in that group. That is "Ready for
// credentialing". Every counted provider sits in exactly one stage, derived
// at read time and never stored:
//
//   Invited                  invited to the intake form, nothing submitted.
//                            Shown only when the intake tables can be read
//                            (input.intakeReadable). Today
//                            provider_intake_invites is service-role only
//                            (MINT-89), so the stage is hidden and nobody is
//                            placed in it. Slice 2 adds the invite rows and
//                            the rule here, then turns intakeReadable on.
//   Profile incomplete       missing NPI, CAQH ID, date of birth, SSN last 4,
//                            or a license (any license with a valid state
//                            code, and one for each state they are assigned
//                            to work in). It stays for providers added by
//                            staff or by CSV, who were never invited (PM,
//                            Oct 31). Once intake data can be read, slice 2
//                            merges this vocabulary with OnboardingStage in
//                            src/types/providerOnboarding.ts (ready,
//                            in_credentialing).
//   Submitted                the information is in but not verified: a
//                            working-state license is not board-verified, is
//                            expired, or has no expiration date; CAQH is not
//                            attested within the last 120 days (a future date
//                            never counts); or the record is pending
//                            verification. A provider who also has an
//                            assignment gap stays here and lists both.
//   Verified, awaiting       verified, and the only gaps are assignment ones:
//   assignment               no current group, no active location, no
//                            location in one of their groups, or (by default)
//                            an active location with no valid state.
//   Ready for credentialing  verified, with a current group and a location in
//                            it, and no case yet.
//   Credentialing            at least one credentialing case. By default any
//                            status counts, including denied and not pursuing.
//                            The case board breaks cases down by status; this
//                            funnel does not.
//
// Group and location. A location counts toward Ready only when it is under a
// group the provider has a current membership in (facilities.group_id against
// provider_group_assignments). If none of their locations is, they are held
// with one reason per location that names the mismatch. A provider with no
// current group at all is held by "Needs a group" alone. A location under
// another group is still a place they are assigned to work, so its state
// still counts for the license checks and the state check below.
//
// Licenses are judged for the states of the provider's active locations. A
// provider with no active location has every license on file judged instead;
// that fallback only fills the gap list, since they are never Ready. By
// default a location with no valid state holds the provider ("Location has no
// valid state on record"), even when their other locations pass, and the
// all-licenses fallback never stands in for it. Billing Readiness holds such a
// location the same way. (Reference-only locations never reach this input.)
//
// A group membership counts until its end date passes. By default its start
// date is ignored: credentialing happens before a provider starts, so a
// membership that begins in the future already counts here. Billing
// Readiness (src/lib/billingReadiness.ts) and the contract SOP assignments
// (src/services/contractSopAssignments.ts) do require a start date on or
// before today, because they ask who is working now.
//
// Three of these rules are configuration, not constants (OnboardingFunnelRules):
// which case statuses count, whether a stateless location holds, and whether a
// future membership counts. The default is the behaviour above. Nothing
// stores an override yet; Mission Control will.
//
// Not the provider onboarding (intake) flow in src/lib/providerOnboarding.ts:
// this is the Reporting Center funnel over the provider records themselves.
// PHI rule: demographics arrive as presence booleans only. Pure; "today" and
// the rules are passed in.
import type { CaseStatus } from "@/lib/caseStatus";
import { isCaqhCurrent, CAQH_CURRENT_DAYS } from "@/lib/enrollmentReadiness";

export type OnboardingFunnelStage =
  | "invited"
  | "profile_incomplete"
  | "submitted"
  | "verified_awaiting_assignment"
  | "ready_for_credentialing"
  | "credentialing";

export interface OnboardingFunnelStageInfo {
  key: OnboardingFunnelStage;
  title: string;
  description: string;
  /** Shown only when the intake tables can be read (Invited). */
  needsIntakeData: boolean;
  /** Providers here are held by gaps the report lists ("What's needed"). */
  listsGaps: boolean;
}

/** Every stage, in funnel order. */
export const ONBOARDING_FUNNEL_STAGES: ReadonlyArray<OnboardingFunnelStageInfo> = [
  {
    key: "invited",
    title: "Invited",
    description: "Invited to the intake form. Nothing submitted yet.",
    needsIntakeData: true,
    listsGaps: false,
  },
  {
    key: "profile_incomplete",
    title: "Profile incomplete",
    description: "Missing NPI, CAQH ID, demographics, or a license.",
    needsIntakeData: false,
    listsGaps: true,
  },
  {
    key: "submitted",
    title: "Submitted",
    description: "Information is in, but not yet verified.",
    needsIntakeData: false,
    listsGaps: true,
  },
  {
    key: "verified_awaiting_assignment",
    title: "Verified, awaiting assignment",
    description: "Verified, but the group or location assignment is incomplete.",
    needsIntakeData: false,
    listsGaps: true,
  },
  {
    key: "ready_for_credentialing",
    title: "Ready for credentialing",
    description: "Verified and assigned to a group and one of its locations. No case yet.",
    needsIntakeData: false,
    listsGaps: false,
  },
  {
    key: "credentialing",
    title: "Credentialing",
    description: "Has at least one credentialing case, in any status.",
    needsIntakeData: false,
    listsGaps: false,
  },
];

/** The stages the report shows. Invited needs the intake tables. */
export function visibleOnboardingFunnelStages(
  intakeReadable: boolean,
): ReadonlyArray<OnboardingFunnelStageInfo> {
  return ONBOARDING_FUNNEL_STAGES.filter((stage) => intakeReadable || !stage.needsIntakeData);
}

/**
 * The funnel's configurable rules. Each field names the default so the
 * alternative is the obvious other value.
 */
export interface OnboardingFunnelRules {
  /** Case statuses that do NOT count as Credentialing. A case in one of them
   * is ignored, as if it did not exist. Default empty: every case counts,
   * whatever its status. */
  caseStatusesNotCountedAsCredentialing: readonly CaseStatus[];
  /** True (default): an active location with no valid state holds the
   * provider out of Ready. False: it counts like any other location; its
   * license cannot be judged, so with no valid working state at all every
   * license on file is judged instead. */
  statelessLocationHolds: boolean;
  /** True (default): a group membership that starts after today already
   * counts as current. False: it counts from its start date. A membership
   * with no start date counts either way. */
  futureMembershipCounts: boolean;
}

/** The platform default: the funnel's behaviour before the rules existed. */
export const DEFAULT_ONBOARDING_FUNNEL_RULES: Readonly<OnboardingFunnelRules> = Object.freeze({
  caseStatusesNotCountedAsCredentialing: Object.freeze<CaseStatus[]>([]),
  statelessLocationHolds: true,
  futureMembershipCounts: true,
});

/** A platform or organization override. A null or missing field inherits;
 * an empty list is a real value (every case counts), not an inherit. */
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
    caseStatusesNotCountedAsCredentialing: [
      ...new Set(pick("caseStatusesNotCountedAsCredentialing")),
    ],
    statelessLocationHolds: pick("statelessLocationHolds"),
    futureMembershipCounts: pick("futureMembershipCounts"),
  };
}

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
}

/** A membership in an active group. */
export interface OnboardingFunnelMembershipInput {
  providerId: string | null;
  groupId: string | null;
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
  /** False while the intake tables cannot be read (MINT-89): Invited stays hidden. */
  intakeReadable: boolean;
}

/** What the service returns: the input plus the rules resolved for the org. */
export interface OnboardingFunnelRead extends OnboardingFunnelInput {
  rules: OnboardingFunnelRules;
}

export interface OnboardingFunnelRow {
  providerId: string;
  name: string;
  npi: string | null;
  stage: OnboardingFunnelStage;
  /** What keeps the provider in their stage; empty for the last two stages. */
  gaps: string[];
  states: string[];
}

export const STATELESS_LOCATION_GAP = "Location has no valid state on record";

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

function isCurrentMembership(
  membership: OnboardingFunnelMembershipInput,
  today: string,
  rules: OnboardingFunnelRules,
): boolean {
  const start = day(membership.startDate);
  const end = day(membership.endDate);
  if (end !== null && end < today) return false;
  return rules.futureMembershipCounts || start === null || start <= today;
}

/** One reason per location, naming why it is not in the provider's group. */
function locationGroupGaps(locations: readonly OnboardingFunnelLocationInput[]): string[] {
  const sorted = [...locations].sort(
    (a, b) =>
      a.locationName.localeCompare(b.locationName) || a.locationId.localeCompare(b.locationId),
  );
  return [
    ...new Set(
      sorted.map((l) =>
        l.groupId === null
          ? `Location ${l.locationName} has no group`
          : `Location ${l.locationName} is under ${l.groupName ?? "another group"}, not the provider's group`,
      ),
    ),
  ];
}

function assignmentGaps(
  groups: ReadonlySet<string>,
  locations: readonly OnboardingFunnelLocationInput[],
  rules: OnboardingFunnelRules,
): string[] {
  const gaps: string[] = [];
  if (groups.size === 0 && locations.length === 0) gaps.push("Needs a group and a location");
  else if (groups.size === 0) gaps.push("Needs a group");
  else if (locations.length === 0) gaps.push("Needs a location");
  else if (!locations.some((l) => l.groupId !== null && groups.has(l.groupId)))
    gaps.push(...locationGroupGaps(locations));
  if (rules.statelessLocationHolds && locations.some((l) => code(l.state) === null))
    gaps.push(STATELESS_LOCATION_GAP);
  return gaps;
}

export function buildOnboardingFunnelRows(
  input: OnboardingFunnelInput,
  today: string,
  rules: OnboardingFunnelRules,
): OnboardingFunnelRow[] {
  const notCounted = new Set<string>(rules.caseStatusesNotCountedAsCredentialing);
  const licensesBy = groupByProvider(input.licenses);
  const locationsBy = groupByProvider(input.locations);
  // A case in a status that does not count is ignored entirely.
  const casesBy = groupByProvider(
    input.cases.filter((c) => c.status === null || !notCounted.has(c.status)),
  );
  const groupsBy = new Map<string, Set<string>>();
  for (const m of input.groupMemberships) {
    if (!m.providerId || !m.groupId || !isCurrentMembership(m, today, rules)) continue;
    groupsBy.set(m.providerId, (groupsBy.get(m.providerId) ?? new Set<string>()).add(m.groupId));
  }

  return input.providers
    .map((p): OnboardingFunnelRow => {
      const licenses = licensesBy.get(p.providerId) ?? [];
      const locations = locationsBy.get(p.providerId) ?? [];
      const workStates = [...new Set(locations.map((row) => code(row.state)))].filter(
        (s): s is string => s !== null,
      );
      const cases = casesBy.get(p.providerId) ?? [];
      const states = [
        ...new Set(
          [
            ...workStates,
            ...licenses.map((l) => code(l.state)),
            ...cases.map((c) => code(c.state)),
          ].filter((s): s is string => s !== null),
        ),
      ].sort();
      const base = { providerId: p.providerId, name: p.name, npi: p.npi, states };
      // A counted case, whatever else is open, means credentialing has started.
      if (cases.length > 0) return { ...base, stage: "credentialing", gaps: [] };

      // A license only counts once its state code is valid: one with a blank or
      // unknown state can never be checked against a working state.
      const stateLicenses = licenses.filter((l) => code(l.state) !== null);
      const licenseStates = new Set(stateLicenses.map((l) => code(l.state) as string));
      const profileGaps = [
        ...(p.npi?.trim() ? [] : ["No NPI"]),
        ...(p.caqhIdPresent ? [] : ["No CAQH ID"]),
        ...(p.dobPresent ? [] : ["No date of birth"]),
        ...(p.ssnLast4Present ? [] : ["No SSN last 4"]),
        ...(stateLicenses.length === 0
          ? [licenses.length === 0 ? "No state license" : "License state is missing or invalid"]
          : []),
        ...(stateLicenses.length === 0
          ? []
          : workStates.filter((s) => !licenseStates.has(s)).map((s) => `No ${s} license`)),
      ];
      if (profileGaps.length > 0)
        return { ...base, stage: "profile_incomplete", gaps: profileGaps };

      // Judge the licenses for the states they work in; with no location
      // yet, every license on file. While a stateless location holds, it
      // gets no fallback: its gap keeps the provider out of Ready, whatever
      // their other locations show. When it does not hold and no location
      // has a valid state, every license on file is judged instead.
      const judged =
        workStates.length > 0 || (locations.length > 0 && rules.statelessLocationHolds)
          ? workStates
          : [...licenseStates];
      const verificationGaps: string[] = [];
      for (const state of judged) {
        const best = stateLicenses
          .filter((l) => code(l.state) === state)
          .sort(
            (a, b) =>
              Number(b.verifiedStatus === "verified") - Number(a.verifiedStatus === "verified") ||
              (b.expirationDate ?? "").localeCompare(a.expirationDate ?? ""),
          )[0];
        if (!best) continue;
        if (best.verifiedStatus !== "verified")
          verificationGaps.push(`${state} license not board-verified`);
        // As in the enrollment readiness matrix, a license with no expiration
        // date is not unexpired.
        if (!best.expirationDate) verificationGaps.push(`${state} license has no expiration date`);
        else if (best.expirationDate.slice(0, 10) < today)
          verificationGaps.push(`${state} license expired`);
      }
      const attested = day(p.caqhLastAttestedDate);
      if (!isCaqhCurrent(attested, today)) {
        verificationGaps.push(
          !attested
            ? "CAQH never attested"
            : attested > today
              ? "CAQH attestation date is in the future"
              : `CAQH attestation older than ${CAQH_CURRENT_DAYS} days`,
        );
      }
      if (p.pendingVerification) verificationGaps.push("Record pending verification");

      // Verified is not enough: Ready needs a group and a location in it.
      const holds = assignmentGaps(groupsBy.get(p.providerId) ?? new Set(), locations, rules);
      if (verificationGaps.length > 0)
        return { ...base, stage: "submitted", gaps: [...verificationGaps, ...holds] };
      if (holds.length > 0) return { ...base, stage: "verified_awaiting_assignment", gaps: holds };
      return { ...base, stage: "ready_for_credentialing", gaps: [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.providerId.localeCompare(b.providerId));
}

export function onboardingFunnelStageCounts(
  rows: readonly OnboardingFunnelRow[],
): Record<OnboardingFunnelStage, number> {
  const counts: Record<OnboardingFunnelStage, number> = {
    invited: 0,
    profile_incomplete: 0,
    submitted: 0,
    verified_awaiting_assignment: 0,
    ready_for_credentialing: 0,
    credentialing: 0,
  };
  for (const row of rows) counts[row.stage] += 1;
  return counts;
}

/** Every state any provider touches (work, license, or counted case), A→Z. */
export function onboardingFunnelStates(rows: readonly OnboardingFunnelRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.states))].sort();
}
