#!/usr/bin/env node
// MINT-82 (RC-07) — apply or tear down the Luna-scale synthetic org on
// staging. Runbook: scripts/luna-scale/README.md. Exactly one mode per run;
// there is no default, so a bare invocation never writes.
import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import {
  LUNA_ORG_ID,
  LUNA_ORG_NAME,
  assertConfirmation,
  assertDatabaseIdentity,
  assertLunaTarget,
  assertMemberEmails,
  confirmationToken,
  isEntryPoint,
  parseAllowedRefs,
  maskConnection,
  psqlConnectionEnvironment,
} from "./luna-fixture.mjs";
import { LUNA_TABLES, buildLunaDataset, planCounts, summarizeDataset } from "./luna-dataset.mjs";
import { TEARDOWN_TABLES, buildApplySql, buildTeardownSql } from "./luna-sql.mjs";

const USAGE = `Usage:
  node scripts/luna-scale/seed-luna-scale.mjs --dry-run [--teardown] [--member-email <email> ...]
  node scripts/luna-scale/seed-luna-scale.mjs --apply --confirm "SEED LUNA SCALE ON <ref>"
      [--member-email <email> ...] [--member-role admin|specialist|billing] [--allow-multi-org-member]
  node scripts/luna-scale/seed-luna-scale.mjs --teardown --confirm "TEAR DOWN LUNA SCALE ON <ref>"
Target env: SUPABASE_URL, LUNA_DATABASE_URL, LUNA_SCALE_ALLOWED_PROJECT_REFS
  (+ LUNA_SCALE_EXPECTED_DATABASE_IDENTITY for any allowlisted project other than pinned staging)
Local rehearsal against loopback Supabase only: add --local-rehearsal (token "... ON local").`;

export function parseArgs(argv) {
  const args = {
    modes: [],
    confirm: null,
    memberEmails: [],
    memberRole: "admin",
    allowMultiOrgMember: false,
    localRehearsal: false,
  };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") args.modes.push("dry-run");
    else if (flag === "--apply") args.modes.push("apply");
    else if (flag === "--teardown") args.modes.push("teardown");
    else if (flag === "--confirm") {
      args.confirm = value(index, flag);
      index += 1;
    } else if (flag === "--member-email") {
      args.memberEmails.push(value(index, flag));
      index += 1;
    } else if (flag === "--member-role") {
      args.memberRole = value(index, flag);
      index += 1;
    } else if (flag === "--allow-multi-org-member") args.allowMultiOrgMember = true;
    else if (flag === "--local-rehearsal") args.localRehearsal = true;
    else if (flag === "--help" || flag === "-h") args.modes.push("help");
    else throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
  }
  // --dry-run --teardown previews the teardown; every other mode stands alone.
  const modes = new Set(args.modes);
  if (modes.has("help")) args.mode = "help";
  else if (modes.size === 2 && modes.has("dry-run") && modes.has("teardown"))
    args.mode = "dry-run-teardown";
  else if (modes.size === 1 && args.modes.length === 1) args.mode = args.modes[0];
  else throw new Error(`Choose exactly one of --dry-run, --apply, --teardown\n${USAGE}`);
  if (args.mode !== "apply" && args.mode !== "dry-run" && args.memberEmails.length > 0) {
    throw new Error("--member-email only applies to --apply (or its --dry-run)");
  }
  if (args.mode !== "apply" && args.mode !== "dry-run" && args.allowMultiOrgMember) {
    throw new Error("--allow-multi-org-member only applies to --apply (or its --dry-run)");
  }
  return args;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

const n = (value) => value.toLocaleString("en-US");

export function formatPlan(dataset, { target, members, sqlBytes }) {
  const counts = planCounts(dataset);
  const summary = summarizeDataset(dataset);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const width = Math.max(...LUNA_TABLES.map((table) => table.length)) + 2;
  const lines = [
    `Luna-scale synthetic org: DRY RUN (no connection; nothing written)`,
    `  org "${LUNA_ORG_NAME}" ${LUNA_ORG_ID} · anchor ${dataset.anchorDate}`,
    `  target: ${target}`,
    "",
    "Rows per table after the apply (apply order). The apply first empties these",
    "tables for the Luna org, so a re-apply rebuilds them; members stay.",
    ...LUNA_TABLES.map((table) => `  ${table.padEnd(width)}${n(counts[table]).padStart(8)}`),
    `  ${"memberships".padEnd(width)}${n(members.length).padStart(8)}  (from --member-email)`,
    `  ${"total".padEnd(width)}${n(total + members.length).padStart(8)}`,
    `  A new organization row also gets 3 roster_templates rows from its insert trigger (append-only).`,
    `  SQL: ${(sqlBytes / 1_048_576).toFixed(1)} MiB in one transaction.`,
    "",
    "Provider Onboarding funnel (under the platform-default funnel configuration):",
    `  profile incomplete ${n(summary.funnel.profile_incomplete)} (no NPI ${summary.scenarios.missing_npi ?? 0}, no CAQH ID ${summary.scenarios.missing_caqh ?? 0}, no DOB ${summary.scenarios.missing_dob ?? 0}, no SSN last 4 ${summary.scenarios.missing_ssn_last4 ?? 0}, no license ${summary.scenarios.no_license ?? 0}, no working-state license ${summary.scenarios.missing_work_state_license ?? 0})`,
    `  submitted ${n(summary.funnel.submitted)} (unverified license ${summary.scenarios.license_unverified ?? 0}, expired license ${summary.scenarios.license_expired ?? 0}, CAQH > 120 days ${summary.scenarios.caqh_stale ?? 0}, pending verification ${summary.scenarios.pending_verification ?? 0})`,
    `  verified, awaiting assignment ${n(summary.funnel.verified_awaiting_assignment)} (no group ${summary.scenarios.no_group ?? 0}, no location ${summary.scenarios.no_location ?? 0}, location under another group ${summary.scenarios.location_other_group ?? 0}, location with no state ${summary.scenarios.location_no_state ?? 0})`,
    `  ready for credentialing ${n(summary.funnel.ready_for_credentialing)} (${summary.scenarios.location_no_group ?? 0} of them at a location with no group) · credentialing ${n(summary.funnel.credentialing)} · terminated (not counted) ${n(summary.funnel.terminated_excluded)}`,
    "",
    "Cases by status:",
    `  ${Object.entries(summary.caseStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${status} ${n(count)}`)
      .join(" · ")}`,
    `  approved: effective ${n(summary.approvedEffective)} · awaiting effective date ${n(summary.approvedAwaitingEffective)}`,
    "",
    "Billing Readiness change feed sources (approval transitions · terminations · license expirations):",
    ...Object.entries(summary.feed).map(
      ([label, feed]) =>
        `  last ${label.padEnd(4)} ${n(feed.approvals)} · ${n(feed.terminations)} · ${n(feed.licenseExpirations)}`,
    ),
    "  (No location-link events: case_facilities.created_by references auth.users, so the seed leaves it null.)",
    "",
    `Follow-ups on open cases: overdue ${n(summary.followUps.overdue)} · due today ${n(summary.followUps.dueToday)} · upcoming ${n(summary.followUps.upcoming)}`,
    `States with a location: ${summary.states}`,
    `Locations: ${n(summary.locations.grouped)} under a group, plus ${summary.locations.noGroup} with no group and ${summary.locations.noState} with no state (edge cases for the funnel's group and location rules)`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatTeardownPlan(target) {
  return `${[
    "Luna-scale teardown: DRY RUN (no connection; nothing written)",
    `  target: ${target}`,
    `  Deletes every row of org ${LUNA_ORG_ID} from these tables, in this order:`,
    ...TEARDOWN_TABLES.map((table) => `    ${table}`),
    "  Then sets the organization inactive. It is never deleted: its roster_templates",
    "  rows are append-only.",
    "  Refuses first if a cascading, set-null or set-default foreign key would change a row",
    "  outside the Luna org. A restricting foreign key blocks the delete and rolls it all back.",
  ].join("\n")}\n`;
}

function describeTarget(environment, allowLocal, action) {
  if (!environment.SUPABASE_URL || !environment.LUNA_DATABASE_URL) {
    return "not checked (SUPABASE_URL / LUNA_DATABASE_URL unset)";
  }
  try {
    const target = assertLunaTarget({
      supabaseUrl: environment.SUPABASE_URL,
      databaseUrl: environment.LUNA_DATABASE_URL,
      allowedRefs: parseAllowedRefs(environment.LUNA_SCALE_ALLOWED_PROJECT_REFS),
      allowLocal,
    });
    return `${target.kind} ${target.projectRef} (would need --confirm "${confirmationToken(action, target)}")`;
  } catch (error) {
    return `REFUSED: ${error.message}`;
  }
}

async function readDatabaseIdentity(executeIdentity, databaseUrl, environment) {
  // The validated parts travel as PG* variables; psql never sees the URL.
  const env = psqlConnectionEnvironment(databaseUrl, environment);
  const { stdout } = await executeIdentity(
    "psql",
    [
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT system_identifier::text FROM pg_control_system()",
    ],
    { env, timeout: 15000 },
  ).catch((error) => {
    // psql's own message, with the password masked in case it echoes one.
    const detail = maskConnection(error?.stderr, databaseUrl).trim();
    throw new Error(
      `Luna database identity preflight failed; nothing was written${detail ? `: ${detail}` : ""}`,
    );
  });
  return String(stdout).trim();
}

export async function runPsql(databaseUrl, sql, variables, environment) {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1"];
  for (const [key, value] of Object.entries(variables)) args.push("-v", `${key}=${value}`);
  args.push("-f", "-");
  const env = psqlConnectionEnvironment(databaseUrl, environment);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = spawn("psql", args, { stdio: ["pipe", "inherit", "inherit"], env });
    child.once("error", () => finish(new Error("psql could not start; nothing was written")));
    child.once("exit", (code) =>
      finish(code === 0 ? null : new Error(`psql exited ${code}; the transaction rolled back`)),
    );
    // psql stops reading at the first error (ON_ERROR_STOP), so the rest of a
    // 16 MiB script hits a closed pipe. That EPIPE is the rollback, reported by
    // the exit handler above, not a crash.
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") {
        finish(new Error("psql's input closed unexpectedly; the transaction rolled back"));
      }
    });
    child.stdin.end(sql);
  });
}

// Injected dependencies are in-process test seams; the CLI uses real ones.
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const executeIdentity = dependencies.executeIdentity ?? promisify(execFile);
  const runSql =
    dependencies.runSql ?? ((url, sql, variables) => runPsql(url, sql, variables, environment));
  const report = dependencies.report ?? ((message) => process.stdout.write(message));
  const today = dependencies.today ?? utcToday;

  const args = parseArgs(argv);
  if (args.mode === "help") {
    report(`${USAGE}\n`);
    return { mode: "help" };
  }
  const dataset = buildLunaDataset({ anchorDate: today() });

  if (args.mode === "dry-run" || args.mode === "dry-run-teardown") {
    const members = assertMemberEmails(args.memberEmails, args.memberRole, environment);
    const target = describeTarget(
      environment,
      args.localRehearsal,
      args.mode === "dry-run-teardown" ? "teardown" : "apply",
    );
    if (args.mode === "dry-run-teardown") {
      report(formatTeardownPlan(target));
    } else {
      // Built only to size it: a review target's SQL refuses to run.
      const sql = buildApplySql(dataset, {
        target: { kind: "review", projectRef: "REVIEW-ONLY" },
        members: members.map((email) => ({ email, role: args.memberRole })),
        allowMultiOrgMember: args.allowMultiOrgMember,
      });
      report(formatPlan(dataset, { target, members, sqlBytes: Buffer.byteLength(sql) }));
    }
    return { mode: args.mode, counts: planCounts(dataset) };
  }

  // --apply / --teardown: every guard before any connection.
  const target = assertLunaTarget({
    supabaseUrl: environment.SUPABASE_URL,
    databaseUrl: environment.LUNA_DATABASE_URL,
    allowedRefs: parseAllowedRefs(environment.LUNA_SCALE_ALLOWED_PROJECT_REFS),
    allowLocal: args.localRehearsal,
  });
  assertConfirmation(args.mode, target, args.confirm);
  const members =
    args.mode === "apply"
      ? assertMemberEmails(args.memberEmails, args.memberRole, environment).map((email) => ({
          email,
          role: args.memberRole,
        }))
      : [];
  const identity = assertDatabaseIdentity(
    target,
    await readDatabaseIdentity(executeIdentity, environment.LUNA_DATABASE_URL, environment),
    environment.LUNA_SCALE_EXPECTED_DATABASE_IDENTITY,
  );
  const sql =
    args.mode === "apply"
      ? buildApplySql(dataset, { target, members, allowMultiOrgMember: args.allowMultiOrgMember })
      : buildTeardownSql({ target });
  await runSql(environment.LUNA_DATABASE_URL, sql, {
    expected_database_identity: identity,
    confirm_token: args.confirm,
  });
  report(
    args.mode === "apply"
      ? `Luna-scale org ${LUNA_ORG_ID} applied on ${target.kind} ${target.projectRef} (anchor ${dataset.anchorDate}, ${members.length} member(s) added). Verify with npm run verify:luna-scale.\n`
      : `Luna-scale teardown committed on ${target.kind} ${target.projectRef}.\n`,
  );
  return { mode: args.mode, target, counts: planCounts(dataset) };
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
