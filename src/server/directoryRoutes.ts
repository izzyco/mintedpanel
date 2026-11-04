// Workbench directory routes (Nov 4, 2026): the extension's read-only lookup
// of groups and locations, and the directory card layouts. Providers are
// served by the existing /api/providers routes (providerRoutes.ts), which
// borrow this module's matching and related lists. Spec: the vault note
// "2026-11-04 - Minted Extension - Directory Search Spec". Same composition as
// extensionRoutes.ts — inject the authenticated ctx into the service layer,
// never query here.
//
// Every read is org-guarded and open to any role (billing too), active
// records only, Cache-Control: no-store. No SSN of any kind is selected and
// nothing here is audited (groups and locations are not provider reads).
import {
  getDirectoryGroup,
  getDirectoryLocation,
  listDirectoryGroups,
  listDirectoryLocations,
} from "@/services/directory";
import { getDirectoryLayout, putDirectoryLayout } from "@/services/directoryLayouts";
import {
  DIRECTORY_CATALOGS,
  isDirectoryCardType,
  parseDirectoryQuery,
  validateDirectoryLayoutBody,
} from "@/lib/directory";
import { ok, fail } from "./envelope";
import type { AuthContext, UserContext } from "./guard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ?page= (default 1) and ?pageSize= (default 25, at most 100), as on
 * GET /api/providers. */
function paging(url: URL): { page: number; pageSize: number } {
  return {
    page: parsePositiveInt(url.searchParams.get("page"), 1),
    pageSize: Math.min(parsePositiveInt(url.searchParams.get("pageSize"), 25), 100),
  };
}

// GET /api/groups?search=&page=&pageSize= — active groups A→Z.
export async function handleListGroups(url: URL, ctx: AuthContext): Promise<Response> {
  const parsed = parseDirectoryQuery(url.searchParams.get("search"));
  if (!parsed.ok) return noStore(fail(422, parsed.message));
  const { page, pageSize } = paging(url);
  const result = await listDirectoryGroups(
    { db: ctx.db, orgId: ctx.orgId },
    parsed.query,
    page,
    pageSize,
  );
  return noStore(ok(result.rows, { total: result.total, page, pageSize }));
}

// GET /api/locations?search=&page=&pageSize= — active locations A→Z.
export async function handleListLocations(url: URL, ctx: AuthContext): Promise<Response> {
  const parsed = parseDirectoryQuery(url.searchParams.get("search"));
  if (!parsed.ok) return noStore(fail(422, parsed.message));
  const { page, pageSize } = paging(url);
  const result = await listDirectoryLocations(
    { db: ctx.db, orgId: ctx.orgId },
    parsed.query,
    page,
    pageSize,
  );
  return noStore(ok(result.rows, { total: result.total, page, pageSize }));
}

// GET /api/groups/:id
export async function handleGetGroup(id: string, ctx: AuthContext): Promise<Response> {
  if (!UUID_RE.test(id)) return noStore(fail(404, "Group not found"));
  const group = await getDirectoryGroup({ db: ctx.db, orgId: ctx.orgId }, id);
  if (!group) return noStore(fail(404, "Group not found"));
  return noStore(ok(group));
}

// GET /api/locations/:id
export async function handleGetLocation(id: string, ctx: AuthContext): Promise<Response> {
  if (!UUID_RE.test(id)) return noStore(fail(404, "Location not found"));
  const location = await getDirectoryLocation({ db: ctx.db, orgId: ctx.orgId }, id);
  if (!location) return noStore(fail(404, "Location not found"));
  return noStore(ok(location));
}

// GET /api/me/view-prefs?card=group|provider|location — that card's saved
// layout (null until saved) and its fixed catalog. Without ?card= the route is
// the quick-card layout in extensionRoutes.ts, unchanged.
export async function handleGetCardLayout(card: string, user: UserContext): Promise<Response> {
  if (!isDirectoryCardType(card)) {
    return fail(422, 'card must be "group", "provider" or "location"');
  }
  const fields = await getDirectoryLayout({ db: user.db, userId: user.userId }, card);
  return ok({ fields, catalog: DIRECTORY_CATALOGS[card] });
}

// PUT /api/me/view-prefs?card= — body { fields }; 422 unless `fields` is an
// ordered, deduplicated list of that card's catalog keys. Answers { fields }.
export async function handlePutCardLayout(
  card: string,
  body: unknown,
  user: UserContext,
): Promise<Response> {
  if (!isDirectoryCardType(card)) {
    return fail(422, 'card must be "group", "provider" or "location"');
  }
  const validation = validateDirectoryLayoutBody(card, body);
  if (!validation.ok) return fail(422, validation.message);
  await putDirectoryLayout({ db: user.db, userId: user.userId }, card, validation.fields);
  return ok({ fields: validation.fields });
}
