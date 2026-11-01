// Mission Control M3 regressions in a new synthetic-only PostgreSQL container:
// organization slug rules, lifecycle stage objects and the transition matrix,
// the offboarded write freeze, and the organization RPCs
// (platform_create_organization, platform_grant_membership,
// platform_org_summary, update_organization_profile). No existing database,
// network, data mount, hosted credentials, or image pull.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const context = process.env.MISSION_CONTROL_ORGS_DOCKER_CONTEXT || "default";
const container = `minted-mission-control-orgs-${randomUUID()}`;
const env = Object.fromEntries(
  ["PATH", "HOME", "DOCKER_CONFIG", "LANG"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
const options = { env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 };
const emit = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
  throw new Error(message);
};
const inspect = JSON.parse(execFileSync("docker", ["context", "inspect", context], options))[0];
const endpoint = inspect?.Endpoints?.docker?.Host;
if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) fail("LOCAL_DOCKER_REQUIRED");
const docker = (args, input) =>
  execFileSync("docker", ["--host", endpoint, ...args], {
    ...options,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
const sql = (input) =>
  docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-XqAt",
      "-h",
      "/tmp",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    input,
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Leak modes: each prepends one regression inside the packet's transaction
// and must turn the packet red on the named label. Nothing is committed.
const leaks = [
  {
    name: "freeze trigger missing from a tenant table",
    sql: "DROP TRIGGER block_writes_when_offboarded ON public.providers;",
    label: "freeze.installed_on_every_tenant_table",
  },
  {
    name: "transition list widened beyond the configured stages",
    sql: "UPDATE public.lifecycle_stages SET allowed_next = allowed_next || 'prospect'::text WHERE key = 'active';",
    label: "lifecycle.matrix_exact",
  },
  {
    name: "slug no longer fixed once set",
    sql: "DROP TRIGGER organizations_slug_immutable ON public.organizations;",
    label: "slug.immutable",
  },
  {
    name: "offboarded organizations treated as writable",
    sql: "CREATE OR REPLACE FUNCTION public.org_is_writable(p_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS 'SELECT true';",
    label: "freeze.legacy_inactive_frozen",
  },
];

let started = false;
try {
  const image = docker(["image", "inspect", "postgres:16", "--format", "{{.Id}}"]).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) fail("CACHED_POSTGRES_IMAGE_REQUIRED");
  docker([
    "run",
    "--detach",
    "--rm",
    "--pull",
    "never",
    "--name",
    container,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "postgres",
    "--tmpfs",
    "/tmp:rw,mode=1777",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "initdb -D /tmp/mc-data --no-locale --encoding=UTF8 --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/mc-data -k /tmp -c listen_addresses='' -c log_statement=none -c log_min_error_statement=panic",
  ]);
  started = true;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      docker(["exec", container, "pg_isready", "-q", "-h", "/tmp", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await pause(100);
    }
  }
  if (!ready) fail("LOCAL_POSTGRES_NOT_READY");
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      email_confirmed_at timestamptz,
      banned_until timestamptz,
      deleted_at timestamptz,
      is_anonymous boolean NOT NULL DEFAULT false,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), ''); $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb); $$;
    CREATE EXTENSION pgcrypto WITH SCHEMA public; CREATE EXTENSION "uuid-ossp" WITH SCHEMA public;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;`);
  const migrations = readdirSync(`${root}supabase/migrations`)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    try {
      sql(readFileSync(`${root}supabase/migrations/${name}`, "utf8"));
    } catch {
      fail(`MIGRATION_FAILED:${name}`);
    }
  }
  emit(`PASS: ${migrations.length} repository migrations applied`);

  const packet = readFileSync(`${root}supabase/tests/mission-control-organizations.sql`, "utf8");
  const output = sql(packet);
  if (!output.includes("MISSION_CONTROL_ORGANIZATIONS|PASS"))
    fail("MISSION_CONTROL_ORGANIZATIONS_PACKET_FAILED");
  const labels = output
    .split("\n")
    .filter((line) => line.endsWith("|PASS") && line !== "MISSION_CONTROL_ORGANIZATIONS|PASS");
  emit(`PASS: ${labels.length} mission control organization assertions`);
  for (const line of labels) emit(`  ${line}`);

  for (const leak of leaks) {
    let caught = false;
    try {
      sql(`BEGIN;\n${leak.sql}\n${packet}`);
    } catch (error) {
      const detail = String(error.stderr);
      caught =
        detail.includes("MISSION_CONTROL_ORGANIZATIONS_TEST_FAILED") && detail.includes(leak.label);
    }
    if (!caught) fail(`LEAK_NOT_DETECTED:${leak.name}`);
    emit(`PASS: leak mode "${leak.name}" turns ${leak.label} red`);
  }
  const persisted = sql(
    "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'organizations_slug_immutable') + (SELECT count(*) FROM pg_trigger WHERE tgname = 'block_writes_when_offboarded' AND tgrelid = 'public.providers'::regclass) + (SELECT count(*) FROM public.lifecycle_stages WHERE key = 'active' AND allowed_next = ARRAY['offboarded']) + (SELECT count(*) FROM pg_proc WHERE proname = 'org_is_writable' AND prosrc LIKE '%lifecycle_stages%');",
  ).trim();
  if (persisted !== "4") fail("LEAK_MODE_PERSISTED");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "MISSION_CONTROL_ORGANIZATIONS_VERIFICATION_FAILED"}\n`,
  );
  process.exitCode = 1;
} finally {
  if (started) {
    docker(["rm", "--force", container]);
    emit("PASS: owned synthetic test container removed");
  }
}
