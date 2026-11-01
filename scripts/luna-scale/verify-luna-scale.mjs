#!/usr/bin/env node
// MINT-82 (RC-07) — read-only check of the Luna-scale org after an apply or a
// teardown. Same target guards as the seed; no confirmation token, because it
// runs READ ONLY transactions and writes nothing.
//
// An active org must hold exactly planCounts of the dataset in every seed
// table; an inactive one (after a teardown) nothing, and no members.
//
//   --fingerprint       print md5 fingerprints of every row outside the Luna
//                       org and exit (the CI job diffs them)
//   --local-rehearsal   loopback local Supabase only
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import {
  assertDatabaseIdentity,
  assertLunaTarget,
  isEntryPoint,
  maskConnection,
  parseAllowedRefs,
  psqlConnectionEnvironment,
} from "./luna-fixture.mjs";
import { buildLunaDataset, planCounts } from "./luna-dataset.mjs";
import { SEED_TABLES, buildFingerprintSql, buildVerifySql } from "./luna-sql.mjs";

const IDENTITY_SQL = "SELECT system_identifier::text FROM pg_control_system()";

/** The dataset's row counts. They do not depend on the anchor date. */
export function plannedCounts() {
  return planCounts(buildLunaDataset({ anchorDate: new Date().toISOString().slice(0, 10) }));
}

/** Compare a verify snapshot with the planned counts. Returns the problems;
 * empty means verified. */
export function checkSnapshot(snapshot, planned) {
  if (!snapshot.org) return ["the Luna org does not exist; nothing has been applied"];
  const problems = [];
  const state = snapshot.org.lifecycle_state;
  if (state !== "active" && state !== "inactive") {
    problems.push(`the org is "${state}", expected active (applied) or inactive (torn down)`);
  }
  const applied = state === "active";
  for (const table of SEED_TABLES) {
    const expected = applied ? planned[table] : 0;
    const actual = snapshot.counts?.[table];
    if (actual !== expected) {
      problems.push(`${table}: ${actual} rows in the Luna org, expected ${expected}`);
    }
  }
  if (!applied && snapshot.counts?.memberships !== 0) {
    problems.push(`memberships: ${snapshot.counts?.memberships} after the teardown, expected 0`);
  }
  for (const key of ["cross_org_case_links", "cases_without_primary_location"]) {
    if (snapshot[key] !== 0) problems.push(`${key}: ${snapshot[key]}`);
  }
  return problems;
}

export function parseVerifyArgs(argv) {
  const args = { allowLocal: false, fingerprint: false };
  for (const flag of argv) {
    if (flag === "--local-rehearsal") args.allowLocal = true;
    else if (flag === "--fingerprint") args.fingerprint = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/** The last line of psql output that is a JSON object: the query result,
 * after any command tags psql printed for BEGIN or SET. */
export function lastJsonLine(raw, what) {
  const line = String(raw)
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text.startsWith("{"));
  if (!line) throw new Error(`Luna verification returned no ${what}`);
  return JSON.parse(line);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const execute = dependencies.execute ?? promisify(execFile);
  const report = dependencies.report ?? ((message) => process.stdout.write(message));
  const args = parseVerifyArgs(argv);
  const target = assertLunaTarget({
    supabaseUrl: environment.SUPABASE_URL,
    databaseUrl: environment.LUNA_DATABASE_URL,
    allowedRefs: parseAllowedRefs(environment.LUNA_SCALE_ALLOWED_PROJECT_REFS),
    allowLocal: args.allowLocal,
  });
  const databaseUrl = environment.LUNA_DATABASE_URL;
  // The validated parts travel as PG* variables; psql never sees the URL.
  const env = psqlConnectionEnvironment(databaseUrl, environment);
  const query = async (sql) => {
    const { stdout } = await execute(
      "psql",
      ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
    ).catch((error) => {
      // psql's own message, with the password masked in case it echoes one.
      const detail = maskConnection(error?.stderr, databaseUrl).trim();
      throw new Error(`Luna verification query failed${detail ? `: ${detail}` : ""}`);
    });
    return String(stdout).trim();
  };
  assertDatabaseIdentity(
    target,
    await query(IDENTITY_SQL),
    environment.LUNA_SCALE_EXPECTED_DATABASE_IDENTITY,
  );
  if (args.fingerprint) {
    const fingerprint = lastJsonLine(await query(buildFingerprintSql()), "fingerprint");
    report(`${JSON.stringify(fingerprint, Object.keys(fingerprint).sort(), 2)}\n`);
    return fingerprint;
  }
  const snapshot = lastJsonLine(await query(buildVerifySql()), "snapshot");
  report(`${JSON.stringify(snapshot, null, 2)}\n`);
  const planned = plannedCounts();
  const applied = snapshot.org?.lifecycle_state === "active";
  const width = Math.max(...SEED_TABLES.map((table) => table.length)) + 2;
  report(
    `${[
      "table".padEnd(width) + "expected".padStart(9) + "in org".padStart(9),
      ...SEED_TABLES.map(
        (table) =>
          `${table.padEnd(width)}${String(applied ? planned[table] : 0).padStart(9)}${String(snapshot.counts?.[table]).padStart(9)}`,
      ),
    ].join("\n")}\n`,
  );
  const problems = checkSnapshot(snapshot, planned);
  if (problems.length > 0) throw new Error(`Luna verification failed:\n- ${problems.join("\n- ")}`);
  report(`Luna verification passed (${applied ? "applied" : "torn down"}).\n`);
  return snapshot;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
