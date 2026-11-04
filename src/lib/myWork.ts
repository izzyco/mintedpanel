// "My work" (sidebar Option B, 2026-11-02): the Cases page narrowed to the
// cases assigned to the signed-in user. No stored flag — it is the existing
// cases.assigned_to compared with the session user, the same field the case
// detail's coordinator line reads.
import type { CredentialCase } from "@/types";

type CaseLike = Pick<CredentialCase, "id" | "assignedTo" | "credentialingStatusId">;

/** Open = status outside the terminal ("complete") bucket; a status-less case
 * counts as open. The rule the sidebar's Cases chip has used since E6.1. */
export function isOpenCase(c: CaseLike, completeStatusIds: ReadonlySet<string>): boolean {
  return !c.credentialingStatusId || !completeStatusIds.has(c.credentialingStatusId);
}

/** Ids of the cases assigned to `userId`; an empty set when nobody is signed in. */
export function myCaseIds(cases: readonly CaseLike[], userId: string | null): Set<string> {
  if (!userId) return new Set();
  return new Set(cases.filter((c) => c.assignedTo === userId).map((c) => c.id));
}

/** Open-case count, optionally only those assigned to `userId` (null = nobody
 * signed in, so none). */
export function openCaseCount(
  cases: readonly CaseLike[],
  completeStatusIds: ReadonlySet<string>,
  userId?: string | null,
): number {
  if (userId === null) return 0;
  return cases.filter(
    (c) => isOpenCase(c, completeStatusIds) && (userId === undefined || c.assignedTo === userId),
  ).length;
}
