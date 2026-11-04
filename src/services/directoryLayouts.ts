// Workbench directory card layouts (Nov 4, 2026), read and written through
// GET/PUT /api/me/directory-layouts. USER-scoped like the quick-card layout in
// ./extensionViewPrefs.ts: same user_table_prefs storage, one page_key per
// card type (DIRECTORY_LAYOUT_PAGE_KEYS), value { fields: string[] }. Every
// statement is scoped by the JWT-verified user id only; on the service-role
// client that predicate IS the isolation.
//
// A layout is a list of field KEYS, never a value: no PHI, no audit row.
//
// Server-only surface (no browser-default ctx) — see caseContext.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  DIRECTORY_CARD_TYPES,
  DIRECTORY_LAYOUT_PAGE_KEYS,
  storedDirectoryLayout,
  type DirectoryCardType,
} from "@/lib/directory";

export interface DirectoryLayoutsServiceCtx {
  db: SupabaseClient<Database>;
  userId: string;
}

/** The caller's saved layout per card type; null = never saved (or a
 * malformed stored value), so the client shows the catalog defaults. */
export async function getDirectoryLayouts(
  ctx: DirectoryLayoutsServiceCtx,
): Promise<Record<DirectoryCardType, string[] | null>> {
  const { data, error } = await ctx.db
    .from("user_table_prefs")
    .select("page_key, prefs")
    .eq("user_id", ctx.userId)
    .in("page_key", Object.values(DIRECTORY_LAYOUT_PAGE_KEYS));
  if (error) throw error;
  const layouts = { group: null, provider: null, location: null } as Record<
    DirectoryCardType,
    string[] | null
  >;
  for (const type of DIRECTORY_CARD_TYPES) {
    const row = (data ?? []).find((r) => r.page_key === DIRECTORY_LAYOUT_PAGE_KEYS[type]);
    layouts[type] = row ? storedDirectoryLayout(row.prefs) : null;
  }
  return layouts;
}

/** Upsert one card type's layout (validated by the route first). Keyed on
 * (user_id, page_key); user_id comes from the verified JWT, never the body. */
export async function putDirectoryLayout(
  ctx: DirectoryLayoutsServiceCtx,
  type: DirectoryCardType,
  fields: string[],
): Promise<void> {
  const { error } = await ctx.db.from("user_table_prefs").upsert(
    {
      user_id: ctx.userId,
      page_key: DIRECTORY_LAYOUT_PAGE_KEYS[type],
      prefs: { fields } as unknown as Json,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "user_id,page_key" },
  );
  if (error) throw error;
}
