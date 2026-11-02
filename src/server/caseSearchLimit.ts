// How many matching cases one extension case search answers with
// (GET /api/cases?q=). Sowmya's decisions:
//   Oct 30 (Mission Control plan D17): a platform-admin setting, default 5,
//     maximum 50 (the Platform Settings IA sketch), edited in Mission
//     Control's settings screen (milestone M6, MINT-112).
//   Oct 31 (register §9a S2): a platform default with NO organization
//     override. Per-org override is decided "no", so there is no
//     organization level.
//   Oct 31 (S3): the extension shows the first 5 and offers "more", up to the
//     fixed cap of 50. A request may ask for a page of its own with &limit=
//     (parseRequestedCaseSearchLimit); it never goes past the cap.
// The settings screen and its `platform_settings` table do not exist yet, so
// there is no setting to read: the limit is the request's &limit= when it
// names one, else CASE_SEARCH_DEFAULT_LIMIT. Above the cap is a 422, never
// clamped.
//
// The route applies that rule, passes the limit to searchOrgCases, and sends
// it to clients as `meta.limit` (the limit actually applied), so the extension
// follows the server instead of a constant of its own. When M6 adds the
// platform setting, its read (a `src/services/` function, AGENTS.md) takes the
// default's place in the route, held to the same 1 to CASE_SEARCH_MAX_LIMIT
// rule.

/** The limit when the request names none. */
export const CASE_SEARCH_DEFAULT_LIMIT = 5;

/** The fixed cap: the most a request can ask for. */
export const CASE_SEARCH_MAX_LIMIT = 50;

export type RequestedCaseSearchLimit =
  | { ok: true; /** null: the request names no limit. */ limit: number | null }
  | { ok: false; message: string };

/** The optional &limit= of GET /api/cases?q= (S3: the extension's "Show
 * more"). Absent: null, so the default applies. A whole number from 1 to
 * CASE_SEARCH_MAX_LIMIT is the limit. Anything else (empty, zero, above
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
