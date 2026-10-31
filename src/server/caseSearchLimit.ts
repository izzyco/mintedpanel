// How many matching cases one extension case search answers with
// (GET /api/cases?q=). Sowmya's decisions:
//   Oct 30 (Mission Control plan D17): a platform-admin setting, default 5,
//     maximum 50 (the Platform Settings IA sketch), edited in Mission
//     Control's settings screen (milestone M6, MINT-112).
//   Oct 31 (register §9a S2): a platform default with NO organization
//     override. Per-org override is decided "no", so the reader takes no org
//     id and there is no organization level.
//   Oct 31 (S3): the extension shows the first 5 and offers "more", up to the
//     fixed cap of 50. A request may ask for a page of its own with &limit=
//     (parseRequestedCaseSearchLimit); it never goes past the cap.
// The settings screen and its `platform_settings` table do not exist yet, so
// the reader below defaults to "no setting" and every search without &limit=
// gets CASE_SEARCH_DEFAULT_LIMIT.
//
// This is the one seam: the route resolves the limit here, passes it to
// searchOrgCases, and sends it to clients as `meta.limit` (the limit actually
// applied), so the extension follows the server instead of a constant of its
// own. Services are the only Supabase callers (AGENTS.md), so M6 adds the
// platform-settings read as a `src/services/` function and injects it here as
// the reader; this module never queries a table itself. When M6 lands, the
// default, the maximum, normalizeCaseSearchLimit and validateCaseSearchLimit
// move to `src/lib/` (or the settings registry) so the settings screen
// validates with the same rule the server applies.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** The limit when no platform setting says otherwise. */
export const CASE_SEARCH_DEFAULT_LIMIT = 5;

/** The fixed cap: the most a platform setting or a request can ask for. */
export const CASE_SEARCH_MAX_LIMIT = 50;

/** Reads the platform setting's raw value; null or undefined means "not set".
 * Platform-wide by decision (S2): there is no organization override. */
export type CaseSearchLimitReader = (db: SupabaseClient<Database>) => Promise<unknown>;

// No platform settings table exists before Mission Control M6.
const noPlatformSetting: CaseSearchLimitReader = async () => null;

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

/** The limit for a request that names none: the platform setting when one is
 * set, otherwise CASE_SEARCH_DEFAULT_LIMIT; never more than
 * CASE_SEARCH_MAX_LIMIT. */
export async function resolveCaseSearchLimit(
  db: SupabaseClient<Database>,
  readSetting: CaseSearchLimitReader = noPlatformSetting,
): Promise<number> {
  return normalizeCaseSearchLimit(await readSetting(db));
}

/** A rejected value as an error message shows it: text in quotes, anything
 * that is not text or a number named by its kind. Never throws. */
function shownValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a set of values" : `a ${typeof value} value`;
}

/** The check the platform setting must pass before it is stored. Plain
 * language; an empty list means it is valid. null or undefined (not set) is
 * always valid. */
export function validateCaseSearchLimit(raw: unknown): string[] {
  if (raw == null) return [];
  if (isUsableLimit(raw) && raw <= CASE_SEARCH_MAX_LIMIT) return [];
  return [
    `The case search limit must be a whole number from 1 to ${CASE_SEARCH_MAX_LIMIT}, not ${shownValue(raw)}.`,
  ];
}

export type RequestedCaseSearchLimit =
  | { ok: true; /** null: the request names no limit. */ limit: number | null }
  | { ok: false; message: string };

/** The optional &limit= of GET /api/cases?q= (S3: the extension's "Show
 * more"). Absent: null, so the platform setting applies. A whole number from
 * 1 to CASE_SEARCH_MAX_LIMIT is the limit. Anything else (empty, zero, above
 * the cap, a fraction, a sign, spaces, text) is refused with a plain message,
 * never clamped or guessed. */
export function parseRequestedCaseSearchLimit(raw: string | null): RequestedCaseSearchLimit {
  if (raw === null) return { ok: true, limit: null };
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= CASE_SEARCH_MAX_LIMIT) {
    return { ok: true, limit };
  }
  return {
    ok: false,
    message: `limit must be a whole number from 1 to ${CASE_SEARCH_MAX_LIMIT}`,
  };
}
