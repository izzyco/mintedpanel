// New Case payer defaults. Once a group is picked, the payer picker opens on
// that group's network (payers with ≥1 ACTIVE payer_network_targets row for
// the group; archived targets do not count) with an always-visible escape to
// the full list for first-time contracting. This only shapes what the picker
// SHOWS — SOP resolution, the no-SOP block, dedupe and case creation read the
// picked payer exactly as before, in network or not.
//
// Contract keeps the full catalog: contracting is the first-time path.
import { alreadyAttachedPayerIds } from "@/lib/groupPayerAttach";
import type { CaseType } from "@/lib/caseTypes";
import type { Payer, PayerNetworkTarget } from "@/types";

export type ManualCasePayerView =
  /** No group yet, Contract, or the network read is unavailable: today's list. */
  | "full"
  /** The group's network payers (plus the current pick, if outside it). */
  | "network"
  /** The coordinator chose "Show all payers". */
  | "all"
  /** The group has no active network payers, so the full list is shown. */
  | "no_network";

export interface ManualCasePayerOptions {
  view: ManualCasePayerView;
  /** What the dropdown lists, name-sorted. */
  options: Payer[];
  /** True when the current pick is outside the picked group's network. */
  pickedOutOfNetwork: boolean;
}

export interface ManualCasePayerOptionsInput {
  /** The full caseable list — `manualCasePayers()` output, already sorted. */
  payers: readonly Payer[];
  /** The org's targets, or undefined while loading / after a failed read. */
  targets: readonly PayerNetworkTarget[] | undefined;
  /** The picked group, or null before one is picked. */
  groupId: string | null;
  /** The picked payer, or null. */
  payerId: string | null;
  caseType: CaseType;
  showAll: boolean;
}

export function manualCasePayerOptions(input: ManualCasePayerOptionsInput): ManualCasePayerOptions {
  const { payers, targets, groupId, payerId, caseType, showAll } = input;
  if (groupId === null || caseType === "contract" || targets === undefined) {
    return { view: "full", options: [...payers], pickedOutOfNetwork: false };
  }
  const network = alreadyAttachedPayerIds(targets, groupId);
  const inNetwork = payers.filter((p) => network.has(p.id));
  const pickedOutOfNetwork =
    payerId !== null && payers.some((p) => p.id === payerId) && !network.has(payerId);
  if (inNetwork.length === 0) {
    return { view: "no_network", options: [...payers], pickedOutOfNetwork };
  }
  if (showAll) {
    return { view: "all", options: [...payers], pickedOutOfNetwork };
  }
  // A pick made before a group switch stays listed, so it stays visible and
  // selected in the trigger. It is never silently cleared.
  const options = pickedOutOfNetwork
    ? payers.filter((p) => network.has(p.id) || p.id === payerId)
    : inNetwork;
  return { view: "network", options, pickedOutOfNetwork };
}
