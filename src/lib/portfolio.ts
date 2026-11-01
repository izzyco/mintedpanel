// Pure Portfolio bucketing (redesign E0.0, enabler TE-2 / feature F0.0.5).
//
// Given the caller's member orgs, split them into the two business metrics the
// Portfolio surfaces and EXCLUDE archived/inactive orgs from both:
//   lifecycle_state 'active'   -> "In motion"
//   lifecycle_state 'prospect' -> "Prospects"
//   lifecycle_state 'inactive' -> excluded entirely
// Kept pure and tested so the counts are verifiable without a live DB. The raw
// lifecycle words are internal and are never rendered as a status label
// (F0.0.2); the UI shows only the business framing ("Prospects" / "In motion").
import type { LifecycleState, PortfolioOrg } from "@/types";

import { DEFAULT_LIFECYCLE_STAGES, lifecycleStage, type LifecycleStage } from "@/lib/lifecycle";

export interface PortfolioBuckets {
  /** Orgs with active work (lifecycle_state 'active'). */
  inMotion: PortfolioOrg[];
  /** Orgs captured but not yet in motion (lifecycle_state 'prospect'). */
  prospects: PortfolioOrg[];
  /** Suppressed orgs (lifecycle_state 'inactive'). Surfaced ONLY in the E0.4
   *  all-inactive fallback (see `allInactive`); excluded from both metrics and
   *  never rendered anywhere else, exactly as E0.0 shipped. */
  inactive: PortfolioOrg[];
  inMotionCount: number;
  prospectCount: number;
  inactiveCount: number;
  /** True when the caller has no orgs in either metric bucket (no active/prospect). */
  isEmpty: boolean;
  /** E0.4 F0.4.2 / TE-3: the metrics are empty AND at least one inactive org
   *  exists — the Portfolio shows the "Inactive" group + create-org CTA instead
   *  of the zero-org "No organizations yet" state. */
  allInactive: boolean;
}

// Mission Control M3: lifecycle_state is a configured stage key. Each org is
// bucketed by its stage's switcher group, read through normalizeLifecycle():
// 'prospects' (prospect, onboarding) -> Prospects; any other group (active)
// -> In motion; no group (offboarded, and the legacy inactive) -> the
// suppressed bucket, still named `inactive` here and in the UI.
export function splitPortfolio(
  orgs: PortfolioOrg[],
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): PortfolioBuckets {
  const groupOf = (o: PortfolioOrg) => lifecycleStage(o.lifecycleState, stages).switcherGroup;
  const inMotion = orgs.filter((o) => groupOf(o) !== null && groupOf(o) !== "prospects");
  const prospects = orgs.filter((o) => groupOf(o) === "prospects");
  const inactive = orgs.filter((o) => groupOf(o) === null);
  const isEmpty = inMotion.length === 0 && prospects.length === 0;
  return {
    inMotion,
    prospects,
    inactive,
    inMotionCount: inMotion.length,
    prospectCount: prospects.length,
    inactiveCount: inactive.length,
    isEmpty,
    allInactive: isEmpty && inactive.length > 0,
  };
}

// Reporting Center state breakdown (redesign E0.6, feature F0.6.4 / TE-4). Counts
// the caller's NON-inactive orgs by state — inactive excluded from the in-motion
// breakdown, consistent with the two metrics (F0.6.2). Orgs with no derivable
// state land in an "Unknown" bucket rather than being dropped (TD-5). Canonical
// seed states (NC/SC/CO/TX/WI/OR) sort first in that order, then any other state
// alphabetically, then Unknown last. Pure + tested.
export const REPORT_STATES = ["NC", "SC", "CO", "TX", "WI", "OR"] as const;
export const UNKNOWN_STATE = "Unknown";

export interface StateCount {
  state: string;
  count: number;
}

export function stateBreakdown(
  orgs: Array<{ lifecycleState: LifecycleState; state: string | null }>,
): StateCount[] {
  const counts = new Map<string, number>();
  for (const o of orgs) {
    if (lifecycleStage(o.lifecycleState).switcherGroup === null) continue;
    const s = (o.state ?? "").trim().toUpperCase() || UNKNOWN_STATE;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const ordered: StateCount[] = [];
  for (const s of REPORT_STATES) {
    if (counts.has(s)) {
      ordered.push({ state: s, count: counts.get(s) as number });
      counts.delete(s);
    }
  }
  const rest = [...counts.entries()]
    .filter(([s]) => s !== UNKNOWN_STATE)
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (const [s, c] of rest) ordered.push({ state: s, count: c });
  if (counts.has(UNKNOWN_STATE))
    ordered.push({ state: UNKNOWN_STATE, count: counts.get(UNKNOWN_STATE) as number });
  return ordered;
}
