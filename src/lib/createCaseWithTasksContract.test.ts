// create_case_with_tasks is the one case-creation RPC (generation confirm and
// ManualCaseModal both call it through createCase). Whenever it stamps the
// credential_cases.facility_id mirror it must also write the primary
// case_facilities row: Billing Readiness and the typed fill-submission guard
// read case_facilities only, so a mirror with no child row is a case with no
// location there.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const FIX = "20261017120000_case_creation_primary_location.sql";
const PRIOR = "20261003120000_mint44_typed_sops.sql";

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

interface Definition {
  file: string;
  args: string;
  body: string;
}

function definitionsIn(file: string): Definition[] {
  const sql = read(file);
  return [
    ...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.create_case_with_tasks\s*\(([^)]*)\)/gi),
  ].map((match) => {
    const open = sql.indexOf("$function$", match.index) + "$function$".length;
    const close = sql.indexOf("$function$", open);
    return { file, args: normalize(match[1]), body: sql.slice(open, close) };
  });
}

const definitions = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .flatMap(definitionsIn);

const PRIMARY_ROW_INSERT =
  /IF v_case\.facility_id IS NOT NULL THEN\s+INSERT INTO public\.case_facilities\s*\(\s*org_id,\s*case_id,\s*facility_id,\s*is_primary,\s*created_by\s*\)\s*VALUES\s*\(\s*v_org,\s*v_case\.id,\s*v_case\.facility_id,\s*true,\s*v_user\s*\)/i;

describe("create_case_with_tasks writes the primary case location", () => {
  it("the latest definition inserts the primary case_facilities row with the stamped mirror", () => {
    const latest = definitions.at(-1);
    if (!latest) throw new Error("No create_case_with_tasks definition found");
    const body = stripSqlComments(latest.body);
    expect(body).toMatch(PRIMARY_ROW_INSERT);
    // After the case row exists (the child row references it), before the return.
    const caseInsert = body.search(/INSERT INTO public\.credential_cases/i);
    const childInsert = body.search(/INSERT INTO public\.case_facilities/i);
    expect(caseInsert).toBeGreaterThan(-1);
    expect(childInsert).toBeGreaterThan(caseInsert);
    expect(body.search(/RETURN to_jsonb\(v_case\)/i)).toBeGreaterThan(childInsert);
  });

  it("every definition keeps the one signature, and no migration drops it", () => {
    expect(new Set(definitions.map((d) => d.args))).toEqual(
      new Set(["p_input jsonb, p_tasks jsonb default '[]'::jsonb"]),
    );
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      expect(read(file), file).not.toMatch(/DROP FUNCTION[^;]*create_case_with_tasks/i);
    }
  });

  it(`${FIX} changes nothing in the mint44 body but the primary-row block`, () => {
    const [prior] = definitionsIn(PRIOR);
    const [fix] = definitionsIn(FIX);
    expect(fix.body).toMatch(PRIMARY_ROW_INSERT);
    const withoutBlock = fix.body.replace(
      /\n {2}-- The primary location[^\n]*\n {2}IF v_case\.facility_id IS NOT NULL THEN\n[\s\S]*?\n {2}END IF;\n/,
      "",
    );
    expect(withoutBlock).toBe(prior.body);
  });

  it("leaves a live body that already writes case_facilities untouched", () => {
    const sql = stripSqlComments(read(FIX));
    const guard = sql.indexOf("prosrc ILIKE '%INSERT INTO public.case_facilities%'");
    const skip = sql.indexOf("RETURN;", guard);
    const redefine = sql.indexOf("CREATE OR REPLACE FUNCTION public.create_case_with_tasks");
    expect(guard).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(guard);
    expect(redefine).toBeGreaterThan(skip);
    // The post-check holds either way: one overload, and it writes the row.
    expect(sql).toMatch(/must have exactly one overload/);
    expect(sql).toMatch(/does not write case_facilities/);
  });

  it("backfills the E1.1 shape, skipping any case that already has a primary row", () => {
    const sql = normalize(stripSqlComments(read(FIX)));
    expect(sql).toContain(
      normalize(`
        INSERT INTO public.case_facilities (org_id, case_id, facility_id, is_primary, created_by)
        SELECT c.org_id, c.id, c.facility_id, true, NULL
        FROM public.credential_cases c
        WHERE c.facility_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.case_facilities cf
            WHERE cf.case_id = c.id AND cf.is_primary
          )
        ON CONFLICT (case_id, facility_id) DO NOTHING;
      `),
    );
  });
});
