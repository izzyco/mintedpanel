// The onboarding file sweep (20261107040000_onboarding_orphan_files.sql) names
// every file under a provider whose row is gone, on the premise that Cancel is
// the only delete of a provider. A second delete path must be weighed against
// that sweep, so this suite fails on one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const PROVIDER_DELETE = /DELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?providers\b/gi;
const FUNCTION =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)[\s\S]*?(\$\w*\$)[\s\S]*?\2/gi;

function deletingFunctions(sql: string): (string | null)[] {
  const code = sql.replace(/--[^\n]*/g, "");
  const bodies = [...code.matchAll(FUNCTION)].map((m) => ({
    name: m[1],
    start: m.index,
    end: m.index + m[0].length,
  }));
  return [...code.matchAll(PROVIDER_DELETE)].map(
    (d) => bodies.find((b) => d.index >= b.start && d.index < b.end)?.name ?? null,
  );
}

describe("one delete of a provider", () => {
  it("no migration deletes a providers row outside cancel_provider_onboarding", () => {
    const sites = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .flatMap((file) => deletingFunctions(readFileSync(join(MIGRATIONS, file), "utf8")));
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((name) => name !== "cancel_provider_onboarding")).toEqual([]);
  });
});
