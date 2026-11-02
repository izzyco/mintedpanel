// The registry's vocabularies are a copy of the migration's CHECKs and
// validator. This suite reads the SQL text and fails when the two drift, so a
// key, table, source, role or context rule can never be accepted in code and
// refused by the database (or the reverse). The registry additions migration
// replaces some of #568's functions and its record_table CHECK; the live one
// is the latest definition, and a replacement may only add.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVISORY_ACTOR_ROLES,
  ADVISORY_RECORD_TABLES,
  ADVISORY_SEVERITIES,
  ADVISORY_SOURCES,
  ADVISORY_UUID_PATTERN,
  BROWSER_ADVISORY_SOURCES,
  CHECKS,
  CHECK_DOMAINS,
  CHECK_KEY_PATTERN,
  CONTEXT_KEYS,
  CONTEXT_MAX_ARRAY,
  CONTEXT_MAX_COUNT_CAPACITY,
  CONTEXT_MAX_KEYS,
  CONTEXT_TOKEN_PATTERN,
  JOB_NAME_PATTERN,
  SERVER_ADVISORY_SOURCES,
  WORKFLOW_ADVISORY_COLUMNS,
  type ContextKeyKind,
} from "./advisoryChecks";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const MIGRATION_FILE = "20261101090000_mint134_workflow_advisories.sql";
const ADDITIONS_FILE = "20261102140000_mint134_registry_additions.sql";

function read(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

// Comments carry prose that quotes the vocabularies; test the statements.
function executable(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

const sql = executable(read(MIGRATION_FILE));

function quotedList(source: string): string[] {
  return [...source.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** The quoted values of every `<lhs> [NOT] IN (...)` in the migration. */
function inLists(lhs: string): string[][] {
  const pattern = new RegExp(`\\b${lhs}\\s+(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, "g");
  return [...sql.matchAll(pattern)].map((m) => quotedList(m[1]));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Every definition of a function across the migrations, oldest first, each
 *  from its CREATE to its closing $function$. */
function definitions(name: string): { file: string; body: string }[] {
  return ALL_MIGRATIONS.flatMap((file) => {
    const source = executable(read(file));
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    if (start < 0) return [];
    const open = source.indexOf("$function$", start);
    const close = source.indexOf("$function$;", open + "$function$".length);
    if (open < 0 || close < 0) throw new Error(`${name} has no $function$ body in ${file}`);
    return [{ file, body: source.slice(start, close) }];
  });
}

/** A function's live definition: its latest. */
function functionBody(name: string): string {
  const body = definitions(name).at(-1)?.body;
  if (!body) throw new Error(`${name} not found in any migration`);
  return body;
}

/** The live record_table CHECK's list: the latest migration that defines it. */
function recordTableCheck(): { file: string; tables: string[] } {
  const found = ALL_MIGRATIONS.flatMap((file) => {
    const match =
      /CONSTRAINT workflow_advisories_record_table_check CHECK \(\s*record_table IN \(([^)]*)\)/.exec(
        executable(read(file)),
      );
    return match ? [{ file, tables: quotedList(match[1]) }] : [];
  });
  const latest = found.at(-1);
  if (!latest) throw new Error("workflow_advisories_record_table_check not found");
  return latest;
}

/** A body with its VALUES list taken out, whitespace squashed. */
function outsideValues(body: string): string {
  return body
    .replace(/FROM \(VALUES[\s\S]*?\) AS ([a-z])\(/, "FROM (VALUES) AS $1(")
    .replace(/\s+/g, " ")
    .trim();
}

/** A CASE branch `WHEN '<key>' THEN EXISTS (SELECT 1 FROM public.<table> AS
 *  r ...)`, up to its closing parenthesis (one nested pair allowed). */
const CASE_BRANCH =
  /WHEN '([a-z_]+)' THEN EXISTS \(\s*SELECT 1 FROM public\.([a-z_]+) AS r(?:[^()]|\([^()]*\))*\)/g;

/** The CASE branches of a body, with their full text. */
function caseBranches(body: string): { key: string; table: string; text: string }[] {
  return [...body.matchAll(CASE_BRANCH)].map((m) => ({
    key: m[1],
    table: m[2],
    text: m[0].replace(/\s+/g, " "),
  }));
}

/** The guarded branch for a table that may not exist yet. */
function guardPattern(variable: string, key: string, table: string): RegExp {
  return new RegExp(
    `IF ${variable} = '${key}' THEN\\s+IF pg_catalog\\.to_regclass\\('public\\.${table}'\\) IS NULL THEN\\s+RETURN false;\\s+END IF;\\s+RETURN EXISTS \\(\\s*SELECT 1 FROM public\\.${table} AS r WHERE r\\.id = p_[a-z_]+ AND r\\.org_id = p_org_id\\);\\s+END IF;`,
  );
}

function guardedBranch(body: string, variable: string, key: string, table: string): boolean {
  return guardPattern(variable, key, table).test(body);
}

/** A body with its lists and branches taken out: the guarded branches, the
 *  CASE branches and the record-table list, whitespace squashed. What is left
 *  is the logic around them, which a replacement must not change. */
function skeleton(body: string): string {
  return body
    .replace(guardPattern("p_record_table", "notification_sequences", "notification_sequences"), "")
    .replace(guardPattern("p_key", "sequence_id", "notification_sequences"), "")
    .replace(CASE_BRANCH, "")
    .replace(/\bp_record_table\s+NOT\s+IN\s*\([^)]*\)/g, "p_record_table NOT IN ()")
    .replace(/\s+/g, " ")
    .trim();
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A table's column lines from the CREATE TABLE that creates it. */
function createTableBody(source: string, table: string): string | null {
  const start = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${table} \\(`, "i").exec(
    source,
  );
  if (!start) return null;
  const rest = source.slice(start.index + start[0].length);
  const end = rest.search(/^\);/m);
  return end < 0 ? null : rest.slice(0, end);
}

const ALL_MIGRATIONS = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort();

function createdBy(table: string): string | null {
  for (const file of ALL_MIGRATIONS) {
    const body = createTableBody(executable(read(file)), table);
    if (body !== null) return body;
  }
  return null;
}

function hasColumn(body: string, column: string): boolean {
  return new RegExp(`^\\s*${column}\\s`, "m").test(body);
}

function addsColumn(table: string, column: string): boolean {
  const pattern = new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS ${column}\\s`);
  return ALL_MIGRATIONS.some((file) => pattern.test(executable(read(file))));
}

describe("MINT-134 migration mirrors the registry", () => {
  it("is the only migration at its version", () => {
    for (const file of [MIGRATION_FILE, ADDITIONS_FILE]) {
      const version = file.slice(0, 14);
      expect(ALL_MIGRATIONS.filter((name) => name.startsWith(version))).toEqual([file]);
    }
  });

  it("names the columns Mission Control reads, in order, with no record_label", () => {
    const body = createTableBody(sql, "workflow_advisories");
    expect(body).not.toBeNull();
    // Columns come first; the constraints follow them.
    const columnBlock = (body ?? "").split(/^\s*CONSTRAINT /m)[0];
    const columns = columnBlock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s/.test(line))
      .map((line) => line.split(/\s/)[0]);
    expect(columns).toEqual([...WORKFLOW_ADVISORY_COLUMNS]);
    expect(columns).not.toContain("record_label");
  });

  // Review of #568: a shape regex let 'npi.jane_smith_19610412' through.
  it("accepts exactly the registered check keys, in the table and in the RPCs", () => {
    const listed = [
      ...functionBody("private.workflow_advisory_check_key_valid").matchAll(
        /\('([a-z_]+\.[a-z0-9_]+)'\)/g,
      ),
    ].map((m) => m[1]);
    expect(listed).toEqual(sorted(listed));
    expect(new Set(listed).size).toBe(listed.length);
    expect(sorted(listed)).toEqual(sorted(Object.keys(CHECKS)));
    for (const key of listed) {
      expect(key).toMatch(CHECK_KEY_PATTERN);
      expect(CHECK_DOMAINS).toContain(key.split(".")[0]);
    }
    expect(sql).toMatch(
      /CONSTRAINT workflow_advisories_check_key_check CHECK \(\s*private\.workflow_advisory_check_key_valid\(check_key\)\s*\)/,
    );
    expect(functionBody("private.workflow_advisory_assert_args")).toContain(
      "IF NOT private.workflow_advisory_check_key_valid(p_check_key) THEN",
    );
    // No shape regex is left on the key.
    expect(sql).not.toMatch(/check_key\s*!?~/);
    expect(functionBody("private.workflow_advisory_check_key_valid")).toMatch(
      /LANGUAGE sql\s+IMMUTABLE/,
    );
  });

  it("closes record_table to the registry's set, in the CHECK, the RPCs and the org check", () => {
    const check = recordTableCheck();
    expect(check.file).toBe(ADDITIONS_FILE);
    const args = [
      ...functionBody("private.workflow_advisory_assert_args").matchAll(
        /\bp_record_table\s+NOT\s+IN\s*\(([^)]*)\)/g,
      ),
    ].map((m) => quotedList(m[1]));
    expect(args).toHaveLength(1);
    for (const list of [check.tables, args[0]]) {
      expect(sorted(list)).toEqual(sorted(ADVISORY_RECORD_TABLES));
    }
    const body = functionBody("private.workflow_advisory_record_in_org");
    const branches = caseBranches(body);
    // notification_sequences (#561) is refused until the table exists.
    expect(
      guardedBranch(body, "p_record_table", "notification_sequences", "notification_sequences"),
    ).toBe(true);
    expect(sorted([...branches.map((b) => b.key), "notification_sequences"])).toEqual(
      sorted(ADVISORY_RECORD_TABLES),
    );
    for (const branch of branches) {
      expect(branch.table).toBe(branch.key);
      // An org-owned record by org_id; the org itself only as its own row.
      expect(branch.text).toContain(
        branch.key === "organizations"
          ? "WHERE r.id = p_record_id AND r.id = p_org_id"
          : "WHERE r.id = p_record_id AND r.org_id = p_org_id",
      );
    }
  });

  it("takes the record tables only from tables that carry org_id, or the org itself", () => {
    for (const table of ADVISORY_RECORD_TABLES) {
      const body = createdBy(table);
      if (table === "notification_sequences") {
        // Not on main until #561; once a migration creates it, it carries org_id.
        if (body !== null) expect(hasColumn(body, "org_id"), table).toBe(true);
        continue;
      }
      expect(body, `${table} is created by a migration`).not.toBeNull();
      if (table === "organizations") {
        expect(hasColumn(body ?? "", "org_id")).toBe(false);
        continue;
      }
      // parties gained org_id in a later migration (20260807130000).
      expect(
        hasColumn(body ?? "", "org_id") || addsColumn(table, "org_id"),
        `${table} has org_id`,
      ).toBe(true);
    }
    // profiles carries no org_id and isn't owned by one org: never a record.
    expect(createdBy("profiles")).not.toBeNull();
    expect(hasColumn(createdBy("profiles") ?? "", "org_id")).toBe(false);
    expect(ADVISORY_RECORD_TABLES).not.toContain("profiles");
  });

  // One migration extends #568, so no wiring PR's replacement can drop
  // another's additions. Each later definition keeps everything before it.
  it("replaces #568's functions and record_table CHECK only to add", () => {
    const listed = (body: string) =>
      [...body.matchAll(/\('([a-z_]+\.[a-z0-9_]+)'\)/g)].map((m) => m[1]);
    const contextRows = (body: string) =>
      new Map(
        [
          ...body.matchAll(
            /\('([a-z_]+)', '(flag|count|id|ids|token|tokens)', (NULL|\d+), (NULL|ARRAY\[[^\]]*\])\)/g,
          ),
        ].map((m) => [m[1], m[0].replace(/\s+/g, " ")]),
      );
    for (const name of [
      "private.workflow_advisory_check_key_valid",
      "private.workflow_advisory_context_valid",
      "private.workflow_advisory_assert_args",
      "private.workflow_advisory_record_in_org",
      "private.workflow_advisory_context_id_in_org",
    ]) {
      const all = definitions(name);
      expect(
        all.map(({ file }) => file),
        name,
      ).toEqual([MIGRATION_FILE, ADDITIONS_FILE]);
      for (let index = 1; index < all.length; index += 1) {
        const [earlier, later] = [all[index - 1].body, all[index].body];
        // The function's header (language, volatility, security, search_path)
        // is unchanged.
        const header = (body: string) => body.slice(0, body.indexOf("$function$"));
        expect(header(later), name).toBe(header(earlier));
        for (const key of listed(earlier)) expect(listed(later), name).toContain(key);
        const kept = contextRows(later);
        for (const [key, row] of contextRows(earlier)) expect(kept.get(key), key).toBe(row);
        for (const branch of caseBranches(earlier)) {
          expect(
            caseBranches(later).map((b) => b.text),
            name,
          ).toContain(branch.text);
        }
        const tables = (body: string) =>
          [...body.matchAll(/\bp_record_table\s+NOT\s+IN\s*\(([^)]*)\)/g)].flatMap((m) =>
            quotedList(m[1]),
          );
        for (const table of tables(earlier)) expect(tables(later)).toContain(table);
      }
    }
    // The validators' bodies around their lists are #568's.
    for (const name of [
      "private.workflow_advisory_check_key_valid",
      "private.workflow_advisory_context_valid",
    ]) {
      const [first, last] = [definitions(name)[0].body, functionBody(name)];
      expect(outsideValues(last), name).toBe(outsideValues(first));
    }
    // So are the argument check and the org checks around their lists and
    // branches: no check dropped, no fallback changed.
    for (const name of [
      "private.workflow_advisory_assert_args",
      "private.workflow_advisory_record_in_org",
      "private.workflow_advisory_context_id_in_org",
    ]) {
      const [first, last] = [definitions(name)[0].body, functionBody(name)];
      expect(skeleton(last), name).toBe(skeleton(first));
    }
    const original = createTableBody(sql, "workflow_advisories") ?? "";
    const before = quotedList(
      /CONSTRAINT workflow_advisories_record_table_check CHECK \(\s*record_table IN \(([^)]*)\)/.exec(
        original,
      )?.[1] ?? "",
    );
    expect(before).toHaveLength(9);
    for (const table of before) expect(recordTableCheck().tables).toContain(table);
    // Only REVOKEs: it grants nothing, adds no SECURITY DEFINER, drops no
    // function and changes no owner.
    const additions = executable(read(ADDITIONS_FILE));
    expect(additions).not.toMatch(/^GRANT /m);
    expect(additions).not.toMatch(/SECURITY DEFINER/);
    expect(additions).not.toMatch(/DROP FUNCTION/);
    expect(additions).not.toMatch(/\bOWNER\s+TO\b/i);
  });

  it("closes source, severity and actor_role to the registry's sets", () => {
    const sources = inLists("source");
    expect(sources).toHaveLength(1);
    expect(sorted(sources[0])).toEqual(sorted(ADVISORY_SOURCES));
    // The person RPC binds the source to the caller: the browser's two for
    // authenticated, the server's two for service_role, never job.
    const personSources = inLists("p_source");
    expect(personSources).toHaveLength(2);
    expect(sorted(personSources[0])).toEqual(sorted(BROWSER_ADVISORY_SOURCES));
    expect(sorted(personSources[1])).toEqual(sorted(SERVER_ADVISORY_SOURCES));
    expect(sorted([...BROWSER_ADVISORY_SOURCES, ...SERVER_ADVISORY_SOURCES])).toEqual(
      sorted(ADVISORY_SOURCES.filter((s) => s !== "job")),
    );
    const recordBody = functionBody("public.record_workflow_advisory");
    const authenticated = recordBody.indexOf("IF v_caller = 'authenticated' THEN");
    // E6.12: a restricted external client is refused in the browser branch.
    const restricted = recordBody.indexOf("IF app_authz.is_restricted_external() THEN");
    expect(restricted).toBeGreaterThan(authenticated);
    expect(recordBody.indexOf("ELSIF v_caller = 'service_role' THEN")).toBeGreaterThan(restricted);
    const serviceRole = recordBody.indexOf("ELSIF v_caller = 'service_role' THEN");
    const browserList = recordBody.indexOf("NOT IN ('panel', 'import')");
    const serverList = recordBody.indexOf("NOT IN ('api', 'extension')");
    expect(authenticated).toBeGreaterThan(0);
    expect(browserList).toBeGreaterThan(authenticated);
    expect(serviceRole).toBeGreaterThan(browserList);
    expect(serverList).toBeGreaterThan(serviceRole);

    for (const list of [...inLists("severity_at_time"), ...inLists("p_severity")]) {
      expect(sorted(list)).toEqual(sorted(ADVISORY_SEVERITIES));
    }
    expect(inLists("severity_at_time")).toHaveLength(1);
    expect(inLists("p_severity")).toHaveLength(1);

    const roles = inLists("actor_role");
    expect(roles).toHaveLength(1);
    expect(sorted(roles[0])).toEqual(sorted(ADVISORY_ACTOR_ROLES));
  });

  it("takes actor_role from the repo's membership roles", () => {
    const baseline = read("20260704210000_baseline_live_schema.sql");
    const check = /memberships_role_check CHECK \(\(role = ANY \(ARRAY\[([^\]]*)\]/.exec(baseline);
    expect(check).not.toBeNull();
    expect(sorted(quotedList(check?.[1] ?? ""))).toEqual(sorted(ADVISORY_ACTOR_ROLES));
    const laterRoleChecks = ALL_MIGRATIONS.filter(
      (file) =>
        file !== "20260704210000_baseline_live_schema.sql" &&
        /memberships_role_check/.test(executable(read(file))),
    );
    expect(laterRoleChecks).toEqual([]);
    const guard = readFileSync(join(process.cwd(), "src/server/guard.ts"), "utf8");
    const appRole = /export type AppRole = ([^;]*);/.exec(guard)?.[1] ?? "";
    expect(sorted([...appRole.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))).toEqual(
      sorted(ADVISORY_ACTOR_ROLES),
    );
  });

  it("checks job names with job_runs' pattern", () => {
    expect(count(sql, `'${JOB_NAME_PATTERN.source}'`)).toBe(2);
  });

  // The SQL's declared context keys: one VALUES row per key,
  // ('<key>', '<kind>', <bound or NULL>, <ARRAY[...] or NULL>).
  function sqlContextKeys(): Map<
    string,
    { kind: string; max: number | null; values: string[] | null }
  > {
    const rows = functionBody("private.workflow_advisory_context_valid").matchAll(
      /\('([a-z_]+)', '(flag|count|id|ids|token|tokens)', (NULL|\d+), (NULL|ARRAY\[([^\]]*)\])\)/g,
    );
    return new Map(
      [...rows].map((m) => [
        m[1],
        {
          kind: m[2],
          max: m[3] === "NULL" ? null : Number(m[3]),
          values: m[4] === "NULL" ? null : quotedList(m[5]),
        },
      ]),
    );
  }

  it("declares exactly CONTEXT_KEYS in SQL, with the same kinds, bounds and vocabularies", () => {
    const declared = sqlContextKeys();
    expect(sorted([...declared.keys()])).toEqual(sorted(Object.keys(CONTEXT_KEYS)));
    for (const [key, def] of Object.entries(CONTEXT_KEYS) as [string, ContextKeyKind][]) {
      const row = declared.get(key);
      expect(row?.kind, key).toBe(def.kind);
      expect(row?.max, key).toBe(def.kind === "count" ? def.max : null);
      expect(row?.values ? sorted(row.values) : null, key).toEqual(
        def.kind === "token" || def.kind === "tokens" ? sorted(def.values) : null,
      );
    }
  });

  it("accepts declared keys only, with the registry's limits, and no open tokens", () => {
    const body = functionBody("private.workflow_advisory_context_valid");
    expect(body).toMatch(/WHERE d\.context_key = v_key;\s+IF NOT FOUND THEN\s+RETURN false;/);
    expect(body).toContain(`v_keys > ${CONTEXT_MAX_KEYS}`);
    expect(body).toContain(`RETURN v_capacity < ${CONTEXT_MAX_COUNT_CAPACITY};`);
    expect(body).toContain("v_capacity := v_capacity * (v_max + 1);");
    expect(count(sql, `v_uuid constant text := '${ADVISORY_UUID_PATTERN.source}'`)).toBe(2);
    const setBody = functionBody("private.workflow_advisory_context_set_valid");
    expect(setBody).toContain(`jsonb_array_length(p_value) > ${CONTEXT_MAX_ARRAY}`);
    // Strictly ascending in byte order: sorted, no repeats.
    expect(setBody).toContain(
      'AND NOT (pair.previous COLLATE pg_catalog."C" < pair.element COLLATE pg_catalog."C")',
    );
    // No token is matched by its shape any more: every token is a listed value.
    expect(sql).not.toContain(CONTEXT_TOKEN_PATTERN.source);
    expect(sql).toMatch(
      /CONSTRAINT workflow_advisories_context_check CHECK \(\s*private\.workflow_advisory_context_valid\(context\)/,
    );
  });

  it("checks every context id against the org, one branch per id key", () => {
    const body = functionBody("private.workflow_advisory_context_id_in_org");
    const branches = caseBranches(body).map((b) => [b.key, b.table] as const);
    // sequence_id names a notification sequence, refused until #561's table exists.
    expect(guardedBranch(body, "p_key", "sequence_id", "notification_sequences")).toBe(true);
    const idKeys = (Object.entries(CONTEXT_KEYS) as [string, ContextKeyKind][])
      .filter(([, def]) => def.kind === "id" || def.kind === "ids")
      .map(([key]) => key);
    expect(sorted([...branches.map(([key]) => key), "sequence_id"])).toEqual(sorted(idKeys));
    expect(Object.fromEntries(branches)).toEqual({
      import_run_id: "import_runs",
      facility_ids: "facilities",
      recipient_id: "memberships",
      payer_id: "payers",
      template_ids: "sop_templates",
    });
    for (const name of ["public.record_workflow_advisory", "public.record_job_advisory"]) {
      expect(functionBody(name)).toContain(
        "private.workflow_advisory_context_ids_in_org(v_context, p_org_id)",
      );
    }
  });

  it("ships the three RPCs, SECURITY DEFINER with an empty search_path, granted as designed", () => {
    for (const name of [
      "record_workflow_advisory",
      "record_job_advisory",
      "resolve_workflow_advisories",
    ]) {
      const body = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$`,
      ).exec(sql)?.[0];
      expect(body, name).toBeDefined();
      expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    }
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_workflow_advisory\([^)]*\)\s+TO authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_job_advisory\([^)]*\)\s+TO service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_workflow_advisories\([^)]*\)\s+TO service_role;/,
    );
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.workflow_advisories TO service_role;/);
    // Top-level grants only: the E6.12 handoff block's own grants are inside
    // EXECUTE strings, and are checked by the helper's test below.
    expect(sql.match(/^GRANT /gm)).toHaveLength(4);
  });

  it("runs the job and resolve RPCs for service_role sessions only, not just by grant", () => {
    const guard =
      "IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN";
    for (const name of ["public.record_job_advisory", "public.resolve_workflow_advisories"]) {
      const body = functionBody(name);
      const begin = body.indexOf("BEGIN");
      expect(body.indexOf(guard), name).toBeGreaterThan(begin);
      // The guard comes before anything else the body does.
      expect(body.indexOf(guard), name).toBeLessThan(body.indexOf("PERFORM"));
    }
  });

  it("checks the actor and resolver a server names with is_restricted_external's body", () => {
    const record = functionBody("public.record_workflow_advisory");
    const serviceRole = record.indexOf("ELSIF v_caller = 'service_role' THEN");
    expect(record.indexOf("app_authz.is_restricted_external_user(v_actor)")).toBeGreaterThan(
      serviceRole,
    );
    expect(functionBody("public.resolve_workflow_advisories")).toContain(
      "app_authz.is_restricted_external_user(p_resolved_by)",
    );
    // The original's body, with p_user_id in place of auth.uid().
    const e612 = executable(read("20260925035408_e612_client_access_context.sql"));
    const original =
      /CREATE OR REPLACE FUNCTION app_authz\.is_restricted_external\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/.exec(
        e612,
      )?.[1];
    const helper =
      /CREATE OR REPLACE FUNCTION app_authz\.is_restricted_external_user\(p_user_id uuid\)[\s\S]*?AS \$body\$([\s\S]*?)\$body\$/.exec(
        sql,
      )?.[1];
    expect(original).toBeDefined();
    expect(helper).toBeDefined();
    const squash = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(squash(helper ?? "")).toBe(
      squash((original ?? "").replaceAll("auth.uid()", "p_user_id")),
    );
    expect(sql).not.toMatch(/rolbypassrls|restricted_check_unavailable/);
  });

  it("creates the helper as E6.12's owner and never grants it to a browser role", () => {
    const block =
      /\nDO \$\$\nDECLARE\n {2}v_executor_name name := current_user;[\s\S]*?\nEND\n\$\$;/.exec(
        sql,
      )?.[0];
    expect(block).toBeDefined();
    const text = block ?? "";
    // SET ROLE is checked against the session user: a session that SET
    // ROLE'd into the executor is stopped before anything changes.
    const sessionCheck = text.indexOf("IF session_user <> current_user");
    expect(sessionCheck).toBeGreaterThan(0);
    expect(sessionCheck).toBeLessThan(text.indexOf("EXECUTE format("));
    expect(text).toContain("MESSAGE = 'workflow_advisory_apply_as_the_executor_itself'");
    // E6.12's handoff capabilities, granted only if missing and put back.
    expect(text).toContain("v_owner_name constant name := 'minted_e612_authz_owner';");
    expect(text).toContain(
      "'GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER'",
    );
    expect(text).toContain(
      "EXECUTE format('GRANT CREATE ON SCHEMA app_authz TO %I', v_owner_name);",
    );
    expect(text).toContain(
      "EXECUTE format('REVOKE CREATE ON SCHEMA app_authz FROM %I', v_owner_name);",
    );
    expect(text).toContain(
      "EXECUTE format('REVOKE %I FROM %I GRANTED BY CURRENT_USER', v_owner_name, v_executor_name);",
    );
    // Created, granted and commented as the owner, then the role put back.
    const setRole = text.indexOf("EXECUTE format('SET LOCAL ROLE %I', v_owner_name);");
    const create = text.indexOf("CREATE OR REPLACE FUNCTION app_authz.is_restricted_external_user");
    const grant = text.indexOf("TO service_role, %I',");
    const back = text.indexOf("IF v_previous_role = 'none' THEN");
    expect(setRole).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(setRole);
    expect(grant).toBeGreaterThan(create);
    expect(back).toBeGreaterThan(grant);
    expect(text).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(text).toContain(
      "'REVOKE ALL ON FUNCTION app_authz.is_restricted_external_user(uuid) FROM PUBLIC, anon, authenticated'",
    );
    // It names a user: no grant to authenticated or anon, anywhere.
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_authz\.is_restricted_external_user[^;]*\b(authenticated|anon)\b/,
    );
  });

  it("is applied by the E6.13 verifier under a non-superuser executor", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts/security/verify-e613-enrollment-scope.mjs"),
      "utf8",
    );
    expect(verifier).toContain(`const mint134Migration = "${MIGRATION_FILE}";`);
    expect(verifier).toMatch(
      /applyWithRestrictedMigrator\(name, \{\s*adminOf: \["minted_e612_authz_owner"\],\s*check: mint134RestrictedMigrationChecks,/,
    );
    expect(verifier).toContain(
      "CREATE ROLE e613_restricted_migrator LOGIN CREATEROLE NOSUPERUSER BYPASSRLS;",
    );
    // Behaviour, not just ACLs: record as service_role under that owner.
    expect(verifier).toContain(
      "mint134.restricted_migrator.service_role_record_runs_under_the_non_superuser_owner",
    );
    expect(verifier).toContain("ok:true|42501:workflow_advisory_restricted_client");
  });

  it("leaves the read RPC and the platform-admin policy to the #540 follow-up", () => {
    expect(sql).not.toMatch(/list_workflow_advisories/);
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/is_platform_admin/);
  });
});
