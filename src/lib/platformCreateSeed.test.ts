// platform_create_organization (Mission Control M3) seeds status_configs on
// its own path, because every create_organization overload also makes the
// caller a member and Mission Control's create must not (Sowmya, Nov 2 2026).
// This pins its 22 rows to CANONICAL_STATUSES, the hand mirror of the
// create_organization seed, so the copies cannot drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANONICAL_STATUSES } from "./canonicalStatuses";

const MIGRATION = "supabase/migrations/20261102163300_mc_platform_org_rpcs.sql";

function seededRows(sql: string) {
  const body = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.platform_create_organization"),
  );
  const block = body.slice(
    body.indexOf("INSERT INTO public.status_configs"),
    body.indexOf("INSERT INTO public.parties"),
  );
  return [
    ...block.matchAll(/\(v_org\.id, '(\w+)',\s*'([^']+)',\s*'(#[0-9A-F]{6})',\s*(\d+), '(\w+)'\)/g),
  ].map(([, track, label, color, sortOrder, actionBucket]) => ({
    track,
    label,
    color,
    sortOrder: Number(sortOrder),
    actionBucket,
  }));
}

describe("platform_create_organization status seed", () => {
  it("writes exactly the canonical 22 rows", () => {
    const rows = seededRows(readFileSync(MIGRATION, "utf8"));
    const canonical = Object.values(CANONICAL_STATUSES)
      .flat()
      .map(({ track, label, color, sortOrder, actionBucket }) => ({
        track,
        label,
        color,
        sortOrder,
        actionBucket,
      }));
    expect(rows).toHaveLength(22);
    expect(rows).toEqual(canonical);
  });

  it("inserts no membership", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.platform_create_organization"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.platform_grant_membership"),
    );
    expect(body).not.toMatch(/INSERT INTO public\.memberships/);
    expect(body).not.toMatch(/(?<!platform_)create_organization\(/);
  });
});
