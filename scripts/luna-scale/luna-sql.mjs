// MINT-82 (RC-07) — SQL for the Luna-scale seed. Pure string builders; the
// runner (seed-luna-scale.mjs) pipes the output to psql in ONE transaction,
// the way scripts/uat/seed-staging-uat.mjs applies supabase/seed-uat.sql.
//
// Both scripts refuse to run unless psql is given the database identity the
// runner observed and the exact confirmation token, so pasting the SQL into
// an editor or running it with bare psql fails before any write. Every
// statement is scoped to the synthetic org's id.
import {
  LUNA_ORG_ID,
  PRODUCTION_CLUSTER,
  UAT_ORGANIZATION_IDS,
  confirmationToken,
} from "./luna-fixture.mjs";
import { LUNA_TABLES, planCounts } from "./luna-dataset.mjs";

export const INSERT_CHUNK_ROWS = 500;

// Every column the seed writes, with the type used to render its literal.
const C = {
  uuid: "uuid",
  text: "text",
  int: "int",
  bool: "bool",
  date: "date",
  ts: "timestamptz",
  textArray: "text[]",
  jsonb: "jsonb",
};
export const TABLE_COLUMNS = Object.freeze({
  organizations: { id: C.uuid, name: C.text, lifecycle_state: C.text },
  status_configs: {
    id: C.uuid,
    org_id: C.uuid,
    track: C.text,
    label: C.text,
    color: C.text,
    sort_order: C.int,
    action_bucket: C.text,
  },
  payers: {
    id: C.uuid,
    org_id: C.uuid,
    name: C.text,
    payer_kind: C.text,
    states: C.textArray,
    status: C.text,
    is_active: C.bool,
    source: C.text,
    aliases: C.textArray,
  },
  org_payer_assignments: { id: C.uuid, org_id: C.uuid, payer_id: C.uuid, status: C.text },
  provider_groups: {
    id: C.uuid,
    org_id: C.uuid,
    name: C.text,
    tin: C.text,
    npi_type2: C.text,
    states: C.textArray,
    is_active: C.bool,
    billing_street: C.text,
    billing_city: C.text,
    billing_state: C.text,
    billing_zip: C.text,
    billing_phone: C.text,
    billing_email: C.text,
    credentialing_email: C.text,
  },
  facilities: {
    id: C.uuid,
    org_id: C.uuid,
    group_id: C.uuid,
    name: C.text,
    street: C.text,
    city: C.text,
    state: C.text,
    zip: C.text,
    phone: C.text,
    email: C.text,
    is_active: C.bool,
    effective_date: C.date,
  },
  payer_network_targets: {
    id: C.uuid,
    org_id: C.uuid,
    group_id: C.uuid,
    payer_id: C.uuid,
    state: C.text,
    status: C.text,
  },
  providers: {
    id: C.uuid,
    org_id: C.uuid,
    group_id: C.uuid,
    first_name: C.text,
    last_name: C.text,
    credentials: C.text,
    npi: C.text,
    specialty: C.text,
    taxonomy_code: C.text,
    status: C.text,
    terminated_date: C.date,
    verification_state: C.text,
    reference_only: C.bool,
    is_test_provider: C.bool,
    start_date: C.date,
    caqh_id: C.text,
    caqh_last_attested_date: C.date,
    date_of_birth: C.date,
    ssn_last4: C.text,
    email: C.text,
    phone: C.text,
    home_street: C.text,
    home_city: C.text,
    home_state: C.text,
    home_zip: C.text,
  },
  provider_group_assignments: {
    id: C.uuid,
    org_id: C.uuid,
    provider_id: C.uuid,
    group_id: C.uuid,
    is_primary: C.bool,
    start_date: C.date,
  },
  provider_facility_assignments: {
    id: C.uuid,
    org_id: C.uuid,
    provider_id: C.uuid,
    facility_id: C.uuid,
    is_primary: C.bool,
    start_date: C.date,
  },
  state_licenses: {
    id: C.uuid,
    org_id: C.uuid,
    provider_id: C.uuid,
    state: C.text,
    license_number: C.text,
    license_type: C.text,
    issue_date: C.date,
    expiration_date: C.date,
    status: C.text,
    verified_status: C.text,
    verified_at: C.ts,
    verification_source_url: C.text,
  },
  credential_cases: {
    id: C.uuid,
    org_id: C.uuid,
    provider_id: C.uuid,
    group_id: C.uuid,
    facility_id: C.uuid,
    payer_id: C.uuid,
    state: C.text,
    specialty: C.text,
    case_status: C.text,
    payer_pipeline_state: C.text,
    credentialing_status_id: C.uuid,
    submitted_date: C.date,
    approved_date: C.date,
    confirmed_effective_date: C.date,
    expected_effective_date: C.date,
    termination_date: C.date,
    payer_reference_id: C.text,
    payer_individual_provider_id: C.text,
    created_at: C.ts,
    updated_at: C.ts,
  },
  case_facilities: {
    id: C.uuid,
    org_id: C.uuid,
    case_id: C.uuid,
    facility_id: C.uuid,
    is_primary: C.bool,
    created_by: C.uuid,
    created_at: C.ts,
  },
  case_status_history: {
    id: C.uuid,
    org_id: C.uuid,
    case_id: C.uuid,
    from_status: C.text,
    to_status: C.text,
    actor_kind: C.text,
    is_correction: C.bool,
    changed_at: C.ts,
  },
  tasks: {
    id: C.uuid,
    org_id: C.uuid,
    case_id: C.uuid,
    provider_id: C.uuid,
    title: C.text,
    description: C.text,
    sop_content: C.jsonb,
    status: C.text,
    sort_order: C.int,
    due_date: C.date,
    completed_date: C.date,
    is_auto_generated: C.bool,
    created_at: C.ts,
  },
  touches: {
    id: C.uuid,
    org_id: C.uuid,
    case_id: C.uuid,
    touch_date: C.date,
    entry_type: C.text,
    touch_type: C.text,
    outcome: C.text,
    notes: C.text,
    source: C.text,
    next_follow_up_date: C.date,
    clears_follow_up: C.bool,
    created_at: C.ts,
  },
  enrollment_facts: {
    id: C.uuid,
    org_id: C.uuid,
    provider_id: C.uuid,
    group_id: C.uuid,
    payer_id: C.uuid,
    state: C.text,
    effective_date: C.date,
    source: C.text,
  },
});

export const SEED_TABLES = Object.freeze(LUNA_TABLES.filter((table) => table !== "organizations"));

/** Children before parents: every seed table, then the memberships. The
 * organization row itself is never deleted (see the runbook). */
export const TEARDOWN_TABLES = Object.freeze([...[...SEED_TABLES].reverse(), "memberships"]);

const PG_TYPES = Object.freeze({
  uuid: "uuid",
  text: "text",
  int: "integer",
  bool: "boolean",
  date: "date",
  timestamptz: "timestamptz",
  "text[]": "text[]",
  jsonb: "jsonb",
});

/** A literal with an explicit cast, so no value depends on how Postgres
 * resolves an untyped literal in a multi-row VALUES list. */
export function sqlLiteral(value, type) {
  const pgType = PG_TYPES[type];
  if (!pgType) throw new Error(`Unknown column type ${type}`);
  if (value === null || value === undefined) return `NULL::${pgType}`;
  switch (type) {
    case "int":
      if (!Number.isSafeInteger(value)) throw new Error(`Not an integer: ${value}`);
      return `${value}::integer`;
    case "bool":
      if (typeof value !== "boolean") throw new Error(`Not a boolean: ${value}`);
      return value ? "true" : "false";
    case "text[]":
      if (!Array.isArray(value)) throw new Error("Expected an array");
      return value.length === 0
        ? "'{}'::text[]"
        : `ARRAY[${value.map((item) => quote(String(item))).join(",")}]::text[]`;
    case "jsonb":
      return `${quote(JSON.stringify(value))}::jsonb`;
    default:
      return `${quote(String(value))}::${pgType}`;
  }
}

function quote(text) {
  if (/[\0\\]/.test(text)) throw new Error("Refusing a NUL or backslash in seed text");
  return `'${text.replaceAll("'", "''")}'`;
}

/** Plain multi-row INSERTs, INSERT_CHUNK_ROWS rows per statement. The apply
 * empties the org's seed tables first, so nothing is there to conflict with. */
export function buildInsertStatements(table, rows) {
  const spec = TABLE_COLUMNS[table];
  if (!spec) throw new Error(`No column spec for ${table}`);
  const columns = Object.keys(spec);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!(key in spec)) throw new Error(`${table}.${key} is not in the column spec`);
    }
  }
  const statements = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    const values = rows
      .slice(start, start + INSERT_CHUNK_ROWS)
      .map((row) => `(${columns.map((column) => sqlLiteral(row[column], spec[column])).join(",")})`)
      .join(",\n");
    statements.push(`INSERT INTO public.${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return statements;
}

function preamble(action, target) {
  const expectedToken = confirmationToken(action, target);
  const reviewOnly = target.kind === "review";
  return `BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '600s';
SET LOCAL idle_in_transaction_session_timeout = '120s';
SET LOCAL timezone = 'UTC';
SELECT set_config('minted.luna_expected_database_identity', :'expected_database_identity', true);
SELECT set_config('minted.luna_confirm_token', :'confirm_token', true);
DO $luna$
DECLARE v_identity text := (SELECT system_identifier::text FROM pg_control_system());
BEGIN
  ${reviewOnly ? "RAISE EXCEPTION 'Luna-scale SQL refused: this is a review copy (a dry-run build) and never runs';" : ""}
  IF v_identity = ${quote(PRODUCTION_CLUSTER)} THEN
    RAISE EXCEPTION 'Luna-scale SQL refused: this is the production database';
  END IF;
  IF v_identity IS DISTINCT FROM current_setting('minted.luna_expected_database_identity') THEN
    RAISE EXCEPTION 'Luna-scale SQL refused: database identity does not match the runner preflight';
  END IF;
  IF current_setting('minted.luna_confirm_token') IS DISTINCT FROM ${quote(expectedToken)} THEN
    RAISE EXCEPTION 'Luna-scale SQL refused: confirmation token mismatch';
  END IF;
END
$luna$;
`;
}

const ORG = quote(LUNA_ORG_ID);

export const OUTSIDE_ROWS_REFUSAL =
  "Luna-scale refused: rows outside the Luna org reference Luna rows";

/**
 * DELETE every row of the Luna org from each table, in the order given, after
 * a guard that keeps the delete inside the org. The guard finds every foreign
 * key, in any schema, into one of these tables that cascades, sets null or
 * sets a default, and refuses when a child row outside the Luna org (another
 * org_id, a NULL one, or a table with no org_id) points at a Luna row: the
 * delete would change it. A restricting key needs no check, since it blocks
 * the DELETE itself and the whole transaction rolls back. payer_contacts has
 * no org_id and only holds contacts of the payer it names, so a Luna payer's
 * contacts are the Luna org's. A table this role sees only through row
 * security is refused too, since its count could be short.
 */
function deleteOrgRows(tables) {
  const parents = tables.map((table) => `'public.${table}'::regclass::oid`).join(", ");
  const guard = `DO $luna$
DECLARE
  r record;
  v_count bigint;
  v_found text[] := '{}';
  v_me oid := (SELECT ro.oid FROM pg_catalog.pg_roles ro WHERE ro.rolname = current_user);
  v_bypass boolean := (SELECT ro.rolsuper OR ro.rolbypassrls FROM pg_catalog.pg_roles ro WHERE ro.rolname = current_user);
BEGIN
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS child, con.confrelid::regclass AS parent,
           NOT ch.relrowsecurity OR v_bypass OR (NOT ch.relforcerowsecurity AND ch.relowner = v_me) AS sees_all,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = con.conrelid
                     AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_org_id,
           (SELECT string_agg(format('d.%I = p.%I', ca.attname, pa.attname), ' AND ')
              FROM unnest(con.conkey, con.confkey) AS k (child_att, parent_att)
              JOIN pg_catalog.pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_att
              JOIN pg_catalog.pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_att
           ) AS join_on
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class ch ON ch.oid = con.conrelid
     WHERE con.contype = 'f' AND con.confdeltype IN ('c', 'n', 'd')
       AND con.confrelid = ANY (ARRAY[${parents}])
       AND con.conrelid IS DISTINCT FROM to_regclass('public.payer_contacts')::oid
     ORDER BY con.conrelid::regclass::text, con.conname
  LOOP
    IF NOT r.sees_all THEN
      v_found := v_found || format('%s (row security hides rows from this role)', r.child);
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %s d JOIN %s p ON %s WHERE p.org_id = %L::uuid%s',
        r.child, r.parent, r.join_on, ${ORG},
        CASE WHEN r.has_org_id THEN format(' AND d.org_id::text IS DISTINCT FROM %L', ${ORG}) ELSE '' END)
      INTO v_count;
    IF v_count > 0 THEN
      v_found := v_found || format('%s.%s: %s row(s)', r.child, r.conname, v_count);
    END IF;
  END LOOP;
  IF cardinality(v_found) > 0 THEN
    RAISE EXCEPTION '${OUTSIDE_ROWS_REFUSAL}, so deleting would change them through a cascading, set-null or set-default foreign key: %. Re-point or remove them first; nothing was changed', array_to_string(v_found, '; ');
  END IF;
END
$luna$;`;
  return [
    guard,
    ...tables.map((table) => `DELETE FROM public.${table} WHERE org_id = ${ORG}::uuid;`),
  ];
}

/** One member: refuse logins that do not exist, UAT persona org members and
 * (unless allowed) members of any other org; then grant the role. */
function memberSql(member, allowMultiOrgMember) {
  const uatOrgs = UAT_ORGANIZATION_IDS.map((id) => `${quote(id)}::uuid`).join(", ");
  const multiOrg = allowMultiOrgMember
    ? "  -- --allow-multi-org-member: membership in other orgs was accepted by the operator.\n"
    : `  IF EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = v_user AND m.org_id <> ${ORG}::uuid) THEN
    RAISE EXCEPTION 'Luna-scale seed refused: the member already belongs to another organization; re-run with --allow-multi-org-member to add them anyway';
  END IF;
`;
  return `DO $luna$
DECLARE v_user uuid;
BEGIN
  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = ${quote(member.email)};
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Luna-scale seed refused: no Auth user has the member email (create the login first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user) THEN
    RAISE EXCEPTION 'Luna-scale seed refused: the member has no profiles row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = v_user AND m.org_id = ANY (ARRAY[${uatOrgs}])) THEN
    RAISE EXCEPTION 'Luna-scale seed refused: the member belongs to a UAT fixture org';
  END IF;
${multiOrg}  INSERT INTO public.memberships (org_id, user_id, role)
  VALUES (${ORG}::uuid, v_user, ${quote(member.role)})
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
END
$luna$;`;
}

/**
 * The apply transaction: guards; the org row (created, or reactivated);
 * members; every seed table emptied for the org, children first (after the
 * outside-rows guard in deleteOrgRows), and filled again from the dataset;
 * then each table's row count in the org checked against planCounts. A
 * re-apply is a teardown plus an insert, in one transaction. Members stay
 * until the teardown.
 */
export function buildApplySql(dataset, { target, members = [], allowMultiOrgMember = false }) {
  const counts = planCounts(dataset);
  const checks = SEED_TABLES.map(
    (table) => `  SELECT count(*) INTO v_count FROM public.${table} WHERE org_id = ${ORG}::uuid;
  IF v_count <> ${counts[table]} THEN
    RAISE EXCEPTION 'Luna-scale seed verification failed: ${table} holds % rows, expected ${counts[table]}', v_count;
  END IF;`,
  ).join("\n");
  const parts = [
    `-- Luna-scale synthetic organization (MINT-82). Generated by scripts/luna-scale/seed-luna-scale.mjs.`,
    `-- Anchor ${dataset.anchorDate}. Run only through the runner.`,
    preamble("apply", target),
    `INSERT INTO public.organizations (id, name, lifecycle_state) VALUES (${ORG}, ${quote(dataset.tables.organizations[0].name)}, 'active')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lifecycle_state = 'active';`,
    ...members.map((member) => memberSql(member, allowMultiOrgMember)),
    `-- Empty the org's seed tables, children first.`,
    ...deleteOrgRows([...SEED_TABLES].reverse()),
  ];
  for (const table of SEED_TABLES) {
    parts.push(`-- ${table}: ${counts[table]} rows`);
    parts.push(...buildInsertStatements(table, dataset.tables[table]));
  }
  parts.push(`DO $luna$
DECLARE v_count bigint;
BEGIN
${checks}
END
$luna$;`);
  parts.push("COMMIT;");
  parts.push(`\\echo 'Luna-scale synthetic org committed'`);
  return `${parts.join("\n")}\n`;
}

/**
 * The teardown transaction: guards; every row of the Luna org deleted from
 * the seed tables and memberships, children first, after the outside-rows
 * guard in deleteOrgRows; the org row left inactive (its roster templates
 * are append-only, so it cannot be deleted).
 */
export function buildTeardownSql({ target }) {
  return `-- Luna-scale synthetic organization teardown (MINT-82). Generated by scripts/luna-scale/seed-luna-scale.mjs.
-- Deletes the Luna org's rows from the seed tables and memberships. Refuses first if a cascading,
-- set-null or set-default foreign key would change a row outside the Luna org; a restricting
-- foreign key blocks the delete and rolls the whole teardown back. Luna-org rows in other tables
-- that cascade from these go with them.
${preamble("teardown", target)}${deleteOrgRows(TEARDOWN_TABLES).join("\n")}
UPDATE public.organizations SET lifecycle_state = 'inactive' WHERE id = ${ORG}::uuid;
COMMIT;
\\echo 'Luna-scale teardown committed'
`;
}

/** Read-only verification query: the org row, the row count of each seed
 * table and memberships in the org, and two relationship checks. Returns
 * one JSON object. */
export function buildVerifySql() {
  const counts = [...SEED_TABLES, "memberships"]
    .map(
      (table) => `'${table}', (SELECT count(*) FROM public.${table} WHERE org_id = ${ORG}::uuid)`,
    )
    .join(",\n    ");
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT json_build_object(
  'org', (SELECT json_build_object('name', name, 'lifecycle_state', lifecycle_state) FROM public.organizations WHERE id = ${ORG}::uuid),
  'counts', json_build_object(
    ${counts}),
  'cross_org_case_links', (SELECT count(*) FROM public.credential_cases c
     LEFT JOIN public.providers p ON p.id = c.provider_id AND p.org_id = c.org_id
     LEFT JOIN public.provider_groups g ON g.id = c.group_id AND g.org_id = c.org_id
     LEFT JOIN public.payers y ON y.id = c.payer_id AND y.org_id = c.org_id
     LEFT JOIN public.facilities f ON f.id = c.facility_id AND f.org_id = c.org_id
     WHERE c.org_id = ${ORG}::uuid AND (p.id IS NULL OR g.id IS NULL OR y.id IS NULL OR f.id IS NULL)),
  'cases_without_primary_location', (SELECT count(*) FROM public.credential_cases c
     WHERE c.org_id = ${ORG}::uuid AND NOT EXISTS (
       SELECT 1 FROM public.case_facilities cf WHERE cf.case_id = c.id AND cf.is_primary AND cf.facility_id = c.facility_id))
);
COMMIT;
`;
}

/**
 * Read-only md5 fingerprints for the CI job, one per public table, of every
 * row that is NOT the Luna org's (the Luna organizations row excluded too),
 * so an apply or teardown that changes anything outside the org is caught.
 */
export function buildFingerprintSql() {
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT json_object_agg(c.relname, (xpath('/row/h/text()', query_to_xml(format(
    'SELECT md5(coalesce(string_agg(r, %L ORDER BY r), %L)) AS h FROM (SELECT row_to_json(x)::text AS r FROM %s x WHERE %s) s',
    ',', '', c.oid::regclass,
    CASE
      WHEN c.relname = 'organizations' THEN format('x.id <> %L::uuid', ${ORG})
      WHEN a.atttypid = 'uuid'::regtype THEN format('x.org_id IS DISTINCT FROM %L::uuid', ${ORG})
      WHEN a.attname IS NOT NULL THEN format('x.org_id::text IS DISTINCT FROM %L', ${ORG})
      ELSE 'true'
    END), false, true, '')))[1]::text ORDER BY c.relname)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attribute a
  ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND has_table_privilege(c.oid, 'SELECT');
COMMIT;
`;
}
