// Workbench directory routes (Nov 4, 2026): the extension's read-only lookup
// of groups, providers and locations, plus the caller's card layouts. Spec and
// pinned contract: the vault note "2026-11-04 - Minted Extension - Directory
// Search Spec". Same composition as extensionRoutes.ts — inject the
// authenticated ctx into the service layer, never query here.
//
// Every directory read is org-guarded and open to any role (billing too).
// Card payloads carry DOB, license and DEA numbers, so every response is
// Cache-Control: no-store and nothing here logs a body. No SSN of any kind is
// selected. Audit mirrors /api/providers/:id/profile: one READ row per
// provider read, nothing for groups, locations or search.
import {
  getDirectoryGroup,
  getDirectoryLocation,
  getDirectoryProvider,
  searchDirectory,
} from "@/services/directory";
import { getDirectoryLayouts, putDirectoryLayout } from "@/services/directoryLayouts";
import {
  DIRECTORY_CATALOGS,
  parseDirectoryQuery,
  validateDirectoryLayoutBody,
} from "@/lib/directory";
import { ok, fail } from "./envelope";
import type { AuthContext, UserContext } from "./guard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Date-only ISO for "is this assignment current" — a server clock read at the
// route boundary, never inside the pure module.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

// GET /api/directory/search?q= — groups, providers, locations; each A→Z, ≤10.
export async function handleDirectorySearch(url: URL, ctx: AuthContext): Promise<Response> {
  const parsed = parseDirectoryQuery(url.searchParams.get("q"));
  if (!parsed.ok) return noStore(fail(422, parsed.message));
  const result = await searchDirectory({ db: ctx.db, orgId: ctx.orgId }, parsed.query, todayIso());
  return noStore(ok(result));
}

// GET /api/directory/groups/:id
export async function handleDirectoryGroup(id: string, ctx: AuthContext): Promise<Response> {
  if (!UUID_RE.test(id)) return noStore(fail(404, "Group not found"));
  const group = await getDirectoryGroup({ db: ctx.db, orgId: ctx.orgId }, id, todayIso());
  if (!group) return noStore(fail(404, "Group not found"));
  return noStore(ok(group));
}

// GET /api/directory/providers/:id
export async function handleDirectoryProvider(id: string, ctx: AuthContext): Promise<Response> {
  if (!UUID_RE.test(id)) return noStore(fail(404, "Provider not found"));
  const provider = await getDirectoryProvider({ db: ctx.db, orgId: ctx.orgId }, id, todayIso());
  if (!provider) return noStore(fail(404, "Provider not found"));
  // The profile read's audit, mirrored: one READ row per successful provider
  // read (actor, provider, route), never a value. A failed audit write fails
  // the request. A 404 is not a read.
  await ctx.writeAudit({
    actionType: "READ",
    entityType: "provider",
    entityId: id,
    after: { route: "/api/directory/providers/:id" },
    description: "Provider directory read (extension)",
  });
  return noStore(ok(provider));
}

// GET /api/directory/locations/:id
export async function handleDirectoryLocation(id: string, ctx: AuthContext): Promise<Response> {
  if (!UUID_RE.test(id)) return noStore(fail(404, "Location not found"));
  const location = await getDirectoryLocation({ db: ctx.db, orgId: ctx.orgId }, id);
  if (!location) return noStore(fail(404, "Location not found"));
  return noStore(ok(location));
}

// GET /api/me/directory-layouts — saved layouts plus the fixed catalogs.
// User-scoped like /api/me/view-prefs: layouts follow the user across orgs.
export async function handleGetDirectoryLayouts(user: UserContext): Promise<Response> {
  const layouts = await getDirectoryLayouts({ db: user.db, userId: user.userId });
  return ok({ layouts, catalogs: DIRECTORY_CATALOGS });
}

// PUT /api/me/directory-layouts — body { type, fields }; 422 unless `fields`
// is an ordered, deduplicated list of that type's catalog keys. Answers with
// the saved { type, fields }.
export async function handlePutDirectoryLayout(
  body: unknown,
  user: UserContext,
): Promise<Response> {
  const validation = validateDirectoryLayoutBody(body);
  if (!validation.ok) return fail(422, validation.message);
  await putDirectoryLayout(
    { db: user.db, userId: user.userId },
    validation.type,
    validation.fields,
  );
  return ok({ type: validation.type, fields: validation.fields });
}
