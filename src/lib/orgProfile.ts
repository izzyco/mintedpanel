// Organization profile vocabulary (Mission Control M3): the slug rule and the
// plan tier list. Pure.
//
// The slug is the only naming rule that exists today: a DNS label, unique,
// fixed once created (organizations_slug_format, organizations_slug_key and
// the organizations_slug_immutable trigger, migration 20261102163000). The
// database is the authority; this module prefills and checks the form.

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SLUG_MAX_LENGTH = 63;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * The slug a name suggests: accents dropped, lowercase, every run of anything
 * but a-z and 0-9 becomes one hyphen, no hyphen at either end, at most 63
 * characters. Empty when nothing usable is left (the form then asks for one).
 */
export function slugFromName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Why a slug is not usable, in the words the form shows; null when it is. */
export function slugProblem(value: string): string | null {
  if (!value) return "Enter a slug";
  if (value.length > SLUG_MAX_LENGTH) return "Use 63 characters or fewer";
  if (!isValidSlug(value)) {
    return "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number";
  }
  return null;
}

/**
 * The name two organizations "share": whitespace removed, lowercase, the same
 * normalization create_organization's own duplicate check uses. A shared name
 * is allowed in Mission Control (Sowmya, Nov 1 2026); it shows a notice.
 */
export function normalizeOrgName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/** The other organizations whose normalized name matches `name`. */
export function sameNameOrganizations<T extends { id: string; name: string }>(
  name: string,
  organizations: readonly T[],
  excludeId?: string,
): T[] {
  const target = normalizeOrgName(name);
  if (!target) return [];
  return organizations.filter(
    (org) => org.id !== excludeId && normalizeOrgName(org.name) === target,
  );
}

/** The join link an organization's members share: /join/<slug>. */
export function joinPath(slug: string): string {
  return `/join/${slug}`;
}

/** Plan tiers offered in the UI. Informational; the column takes any text, so
 * a new tier is one entry here and no migration. */
export const PLAN_TIERS = [
  { value: "pilot", label: "Pilot" },
  { value: "standard", label: "Standard" },
  { value: "enterprise", label: "Enterprise" },
] as const;

export type PlanTier = (typeof PLAN_TIERS)[number]["value"];

/** A stored plan tier's label; an unlisted value shows as stored. */
export function planTierLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return PLAN_TIERS.find((tier) => tier.value === value)?.label ?? value;
}

/**
 * The message the UI shows for an organization RPC error. The database's
 * machine messages become sentences; anything else (create_organization's
 * own sentences, such as the duplicate-name refusal) is shown as is.
 */
export function orgErrorMessage(message: string): string {
  switch (message) {
    case "slug_taken":
      return "That slug is already used by another organization";
    case "slug_invalid":
      return "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number";
    case "slug_immutable":
      return "The slug is fixed once the organization is created";
    case "org_offboarded":
      return "This organization is offboarded. Reopen it to make changes.";
    case "platform_admin_required":
    case "org_admin_required":
      return "You don't have access to change this organization";
    case "plan_tier_platform_only":
      return "Only Minted can change the plan tier";
    case "lifecycle_transition_not_allowed":
      return "That stage change isn't allowed from the current stage";
    case "lifecycle_stage_unknown":
      return "That stage isn't configured";
    case "org_not_found":
      return "This organization no longer exists";
    default:
      return message;
  }
}
