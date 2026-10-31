// How many matching cases one extension case search answers with
// (GET /api/cases?q=). Sowmya's decision of Oct 30, 2026 (Mission Control
// plan D17) makes this a setting with a default of 5 and, per the Platform
// Settings IA sketch, a maximum of 50, edited in Mission Control's settings
// screen (milestone M6, MINT-112). Like every business-policy setting it
// resolves per organization: the organization's value, else the platform's,
// else CASE_SEARCH_DEFAULT_LIMIT, never more than CASE_SEARCH_MAX_LIMIT.
// Neither value is stored yet, so the reader below defaults to "nothing set"
// and every search gets the default.
//
// This is the one seam: the route resolves the limit here for the request's
// organization, passes it to searchOrgCases, and sends it to clients as
// `meta.limit`, so the extension follows the server instead of a constant of
// its own. Services are the only Supabase callers (AGENTS.md), so M6 adds the
// platform-setting and organization-override reads as a `src/services/`
// function and injects it here as the reader; this module never queries a
// table itself. When M6 lands, the default, the maximum, the resolver and the
// validator move to `src/lib/` (or the settings registry) so the settings
// screen validates with the same rule the server applies.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** The limit when no setting says otherwise. */
export const CASE_SEARCH_DEFAULT_LIMIT = 5;

/** The most a setting can raise it to, at either level. */
export const CASE_SEARCH_MAX_LIMIT = 50;

/** The stored raw values that apply to one request. null or undefined means
 * "not set" at that level. */
export interface CaseSearchLimitSettings {
  /** The platform-wide setting. */
  platform?: unknown;
  /** The request organization's override. */
  organization?: unknown;
}

/** Reads the stored values for the request's organization. */
export type CaseSearchLimitReader = (
  db: SupabaseClient<Database>,
  orgId: string,
) => Promise<CaseSearchLimitSettings | null>;

// Nothing stores either value before Mission Control M6 (MINT-112).
const noStoredSettings: CaseSearchLimitReader = async () => null;

function isUsableLimit(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;
}

/** A positive whole number is the limit, capped at CASE_SEARCH_MAX_LIMIT.
 * Anything else (unset, zero, negative, fractional, text) is the default, so
 * a bad setting can never empty the results or break the search. */
export function normalizeCaseSearchLimit(raw: unknown): number {
  if (!isUsableLimit(raw)) return CASE_SEARCH_DEFAULT_LIMIT;
  return Math.min(raw, CASE_SEARCH_MAX_LIMIT);
}

/** The organization's value when it is usable, else the platform's, else the
 * default; never more than CASE_SEARCH_MAX_LIMIT. An unusable value at either
 * level is skipped like a missing one. */
export function resolveCaseSearchLimitSetting(platform?: unknown, organization?: unknown): number {
  const chosen = [organization, platform].find(isUsableLimit);
  return normalizeCaseSearchLimit(chosen);
}

/** The check a value must pass before it is stored at either level.
 * Plain-language errors; an empty list means it is valid. null or undefined
 * (inherit) is always valid. */
export function validateCaseSearchLimit(raw: unknown): string[] {
  if (raw == null) return [];
  if (isUsableLimit(raw) && raw <= CASE_SEARCH_MAX_LIMIT) return [];
  const shown =
    typeof raw === "string"
      ? `"${raw}"`
      : typeof raw === "object"
        ? JSON.stringify(raw)
        : String(raw);
  return [
    `The case search limit must be a whole number from 1 to ${CASE_SEARCH_MAX_LIMIT}, not ${shown}.`,
  ];
}

/** The limit for this request's organization: its own setting, else the
 * platform's, else CASE_SEARCH_DEFAULT_LIMIT; never more than
 * CASE_SEARCH_MAX_LIMIT. */
export async function resolveCaseSearchLimit(
  db: SupabaseClient<Database>,
  orgId: string,
  readSettings: CaseSearchLimitReader = noStoredSettings,
): Promise<number> {
  const stored = await readSettings(db, orgId);
  return resolveCaseSearchLimitSetting(stored?.platform, stored?.organization);
}
