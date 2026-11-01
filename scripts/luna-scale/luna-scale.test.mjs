// MINT-82 (RC-07) — generator, SQL and guard tests for the Luna-scale seed.
// Pure: no database, no network. `npm run test:luna-scale`.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ISOLATION_GATE_LOGINS,
  LUNA_ORG_ID,
  PRODUCTION_CLUSTER,
  PRODUCTION_PROJECT_REF,
  STAGING_CLUSTER,
  STAGING_PROJECT_REF,
  SYNTHETIC_NPI_PREFIX_INDIVIDUAL,
  SYNTHETIC_NPI_PREFIX_ORGANIZATION,
  UAT_ORGANIZATION_IDS,
  assertConfirmation,
  assertDatabaseIdentity,
  assertLunaTarget,
  assertMemberEmails,
  confirmationToken,
  isEntryPoint,
  lunaUuid,
  maskConnection,
  parseDatabaseUrl,
  psqlConnectionEnvironment,
} from "./luna-fixture.mjs";
import {
  CASE_STATUS_MIX,
  CANONICAL_STATUS_CONFIGS,
  FUNNEL_STAGES,
  LUNA_TABLES,
  PROVIDER_SCENARIOS,
  STATELESS_LOCATIONS,
  UNGROUPED_LOCATIONS,
  buildLunaDataset,
  planCounts,
  summarizeDataset,
} from "./luna-dataset.mjs";
import {
  INSERT_CHUNK_ROWS,
  SEED_TABLES,
  TABLE_COLUMNS,
  TEARDOWN_TABLES,
  buildApplySql,
  buildFingerprintSql,
  buildTeardownSql,
  buildVerifySql,
  sqlLiteral,
} from "./luna-sql.mjs";
import { main, parseArgs, runPsql } from "./seed-luna-scale.mjs";
import {
  checkSnapshot,
  lastJsonLine,
  main as verifyMain,
  parseVerifyArgs,
  plannedCounts,
} from "./verify-luna-scale.mjs";

const ANCHOR = "2026-10-30";
const dataset = buildLunaDataset({ anchorDate: ANCHOR });
const { tables } = dataset;
const STAGING = { kind: "staging", projectRef: STAGING_PROJECT_REF };

// ---------- an independent reading of the rules the seed must satisfy ----------

/** Textbook Luhn over the CMS 80840 prefix: valid when the sum is 0 mod 10. */
function luhnValidNpi(npi) {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split("").map(Number).reverse();
  const sum = digits.reduce((acc, digit, index) => {
    if (index % 2 === 0) return acc + digit;
    const doubled = digit * 2;
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return sum % 10 === 0;
}

const dayDiff = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The Provider Onboarding funnel rules (MINT-81's onboardingFunnel.ts as
 * reworked in #560 through Addendum 8, platform-default configuration),
 * restated from its header comment, plus the gaps that put the provider there.
 * Inputs mirror getOnboardingFunnelInput's filters: active, non-reference
 * locations; memberships in active groups that have not ended. */
function classifyFunnel(source = tables, today = ANCHOR) {
  const validState = (state) => typeof state === "string" && /^[A-Z]{2}$/.test(state);
  const licensesBy = new Map();
  for (const row of source.state_licenses) {
    if (row.status !== null && row.status !== "active") continue;
    licensesBy.set(row.provider_id, [...(licensesBy.get(row.provider_id) ?? []), row]);
  }
  const activeGroups = new Set(source.provider_groups.filter((g) => g.is_active).map((g) => g.id));
  const facilityById = new Map(
    source.facilities.filter((f) => f.is_active && !f.reference_only).map((f) => [f.id, f]),
  );
  const locationsBy = new Map();
  for (const row of source.provider_facility_assignments) {
    const facility = facilityById.get(row.facility_id);
    if (facility)
      locationsBy.set(row.provider_id, [...(locationsBy.get(row.provider_id) ?? []), facility]);
  }
  const groupsBy = new Map();
  for (const row of source.provider_group_assignments) {
    if (!activeGroups.has(row.group_id) || (row.end_date && row.end_date < today)) continue;
    groupsBy.set(
      row.provider_id,
      new Set([...(groupsBy.get(row.provider_id) ?? []), row.group_id]),
    );
  }
  const withCases = new Set(source.credential_cases.map((row) => row.provider_id));
  const result = new Map();
  for (const p of source.providers) {
    if (p.status === "terminated" || p.reference_only || p.is_test_provider) continue;
    const gaps = [];
    if (withCases.has(p.id)) {
      result.set(p.id, { stage: "credentialing", gaps });
      continue;
    }
    const licenses = (licensesBy.get(p.id) ?? []).filter((l) => validState(l.state));
    const licenseStates = new Set(licenses.map((l) => l.state));
    const locations = locationsBy.get(p.id) ?? [];
    const work = [...new Set(locations.map((l) => l.state).filter(validState))];
    if (!p.npi) gaps.push("no_npi");
    if (!p.caqh_id) gaps.push("no_caqh");
    if (!p.date_of_birth) gaps.push("no_dob");
    if (!p.ssn_last4) gaps.push("no_ssn_last4");
    if (licenses.length === 0) gaps.push("no_license");
    else if (work.some((state) => !licenseStates.has(state))) gaps.push("no_work_state_license");
    if (gaps.length > 0) {
      result.set(p.id, { stage: "profile_incomplete", gaps });
      continue;
    }
    // Licenses are judged for the valid states of their active locations;
    // with no valid working state, every license on file.
    for (const state of work.length > 0 ? work : [...licenseStates]) {
      const best = licenses
        .filter((l) => l.state === state)
        .sort(
          (a, b) =>
            Number(b.verified_status === "verified") - Number(a.verified_status === "verified") ||
            (b.expiration_date ?? "").localeCompare(a.expiration_date ?? ""),
        )[0];
      if (!best) continue;
      if (best.verified_status !== "verified") gaps.push("license_unverified");
      if (!best.expiration_date || best.expiration_date < today) gaps.push("license_expired");
    }
    const attested = p.caqh_last_attested_date;
    const age = attested ? dayDiff(attested, today) : null;
    if (age === null || age < 0 || age > 120) gaps.push("caqh_stale");
    if (p.verification_state === "pending_verification") gaps.push("pending_verification");
    // Verified is not enough: Ready needs a current group, and a location
    // that counts: under one of their current groups, or under no group at
    // all (an in-home address counts for anyone, A22). Group problems are
    // staff-side (A23): with no current group, "No group assigned yet" comes
    // first, and a location that fails only because its group is not theirs
    // is a group gap too. Only staff-side lists (awaiting assignment) show
    // group gaps; Submitted never does.
    const groups = groupsBy.get(p.id) ?? new Set();
    const assignmentGaps = [];
    const stateGaps = [];
    const groupGaps = groups.size === 0 ? ["no_group_assigned"] : [];
    if (locations.length === 0) assignmentGaps.push("needs_location");
    else if (locations.every((l) => l.group_id !== null && !groups.has(l.group_id)))
      (groups.size === 0 ? groupGaps : assignmentGaps).push("location_other_group");
    if (locations.some((l) => !validState(l.state))) stateGaps.push("location_no_state");
    const placement = { assignmentGaps, groupGaps };
    const locationHolds = [...assignmentGaps, ...stateGaps];
    const holds = [...locationHolds, ...groupGaps];
    if (gaps.length > 0)
      result.set(p.id, { stage: "submitted", gaps: [...gaps, ...locationHolds], ...placement });
    else if (holds.length > 0)
      result.set(p.id, { stage: "verified_awaiting_assignment", gaps: holds, ...placement });
    else result.set(p.id, { stage: "ready_for_credentialing", gaps, ...placement });
  }
  return result;
}

/** The kinds of gap each scenario is built to show, in the order the funnel
 * lists them: one each, except "no group", whose two are both staff-side
 * group gaps ("No group assigned yet", then "Location … is under …, not the
 * provider's group"; #560 at 83775cfd). Ready scenarios show none. */
const SCENARIO_GAPS = Object.freeze({
  missing_npi: ["no_npi"],
  missing_caqh: ["no_caqh"],
  missing_dob: ["no_dob"],
  missing_ssn_last4: ["no_ssn_last4"],
  no_license: ["no_license"],
  missing_work_state_license: ["no_work_state_license"],
  license_unverified: ["license_unverified"],
  license_expired: ["license_expired"],
  caqh_stale: ["caqh_stale"],
  pending_verification: ["pending_verification"],
  no_group: ["no_group_assigned", "location_other_group"],
  no_location: ["needs_location"],
  location_other_group: ["location_other_group"],
  location_no_group: [],
  location_no_state: ["location_no_state"],
});

/** The scenarios that change a provider's group or location. */
const ASSIGNMENT_SCENARIOS = Object.freeze([
  "no_group",
  "no_location",
  "location_other_group",
  "location_no_group",
  "location_no_state",
]);

function allRows() {
  return LUNA_TABLES.flatMap((table) => tables[table].map((row) => ({ table, row })));
}

// ---------- generator ----------

test("the dataset is deterministic, and an anchor date moves dates, never ids or counts", () => {
  const again = buildLunaDataset({ anchorDate: ANCHOR });
  assert.equal(JSON.stringify(again.tables), JSON.stringify(tables));
  const later = buildLunaDataset({ anchorDate: "2026-11-15" });
  assert.deepEqual(
    later.tables.providers.map((row) => row.id),
    tables.providers.map((row) => row.id),
  );
  assert.notDeepEqual(later.tables.providers[0].start_date, tables.providers[0].start_date);
  // verify:luna-scale checks against these counts, whatever the apply day was.
  assert.deepEqual(planCounts(later), planCounts(dataset));
  assert.deepEqual(plannedCounts(), planCounts(dataset));
  assert.throws(() => buildLunaDataset({ anchorDate: "2026-02-30" }), /calendar/);
});

test("the counts match the Luna-scale brief", () => {
  const counts = planCounts(dataset);
  assert.equal(counts.organizations, 1);
  assert.equal(counts.providers, 3500);
  assert.equal(counts.provider_groups, 50);
  // 200 under the groups, plus the funnel's edge-case locations.
  assert.equal(counts.facilities, 200 + UNGROUPED_LOCATIONS + STATELESS_LOCATIONS);
  assert.equal(tables.facilities.filter((row) => row.group_id && row.state).length, 200);
  assert.equal(counts.payers, 7);
  assert.equal(new Set(tables.facilities.map((row) => row.state).filter(Boolean)).size, 25);
  assert.ok(counts.credential_cases > 3 * 1000, "cases cross the 1,000-row cap several times");
  assert.equal(counts.status_configs, 22);
  assert.equal(tables.organizations[0].name, "Luna Demo (synthetic)");
  assert.equal(
    Object.values(counts).reduce((sum, n) => sum + n, 0),
    64_644,
  );
});

test("every Provider Onboarding funnel stage and gap has members, as generated", () => {
  const funnel = classifyFunnel();
  const byStage = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0]));
  const gaps = new Set();
  for (const { stage, gaps: list } of funnel.values()) {
    byStage[stage] += 1;
    list.forEach((gap) => gaps.add(gap));
  }
  assert.deepEqual(FUNNEL_STAGES, [
    "profile_incomplete",
    "submitted",
    "verified_awaiting_assignment",
    "ready_for_credentialing",
    "credentialing",
  ]);
  for (const stage of FUNNEL_STAGES) assert.ok(byStage[stage] > 0, `${stage} has members`);
  for (const gap of Object.values(SCENARIO_GAPS).flat())
    assert.ok(gaps.has(gap), `gap ${gap} occurs`);
  // The independent classifier agrees with the scenario every provider was
  // given, and each one shows the kinds of gap it was built for.
  const stageOf = Object.fromEntries(PROVIDER_SCENARIOS.map(({ key, stage }) => [key, stage]));
  for (const [providerId, scenario] of dataset.providerScenario) {
    if (scenario === "terminated") {
      assert.equal(funnel.has(providerId), false);
      continue;
    }
    const row = funnel.get(providerId);
    assert.equal(row.stage, stageOf[scenario] ?? "credentialing", scenario);
    assert.deepEqual([...new Set(row.gaps)], SCENARIO_GAPS[scenario] ?? [], scenario);
    if (scenario === "no_group") {
      // Both reasons are staff-side group gaps; the provider's own location
      // list is empty.
      assert.deepEqual(row.groupGaps, ["no_group_assigned", "location_other_group"]);
      assert.deepEqual(row.assignmentGaps, []);
    }
    // No group text in Submitted.
    if (row.stage === "submitted") assert.ok(!row.gaps.includes("no_group_assigned"));
  }
  const summary = summarizeDataset(dataset);
  for (const stage of FUNNEL_STAGES) assert.equal(summary.funnel[stage], byStage[stage], stage);
  // A realistic share: every stage is a visible slice, credentialing the bulk.
  const total = [...funnel.values()].length;
  assert.ok(byStage.verified_awaiting_assignment / total > 0.04, "awaiting assignment > 4%");
  // The platform-default counts quoted in the README and the PR (#560 at
  // 83775cfd: a location with no group counts for anyone, A22).
  assert.deepEqual(
    FUNNEL_STAGES.map((stage) => byStage[stage]),
    [420, 348, 174, 315, 2208],
  );
  assert.ok(byStage.credentialing / total > 0.5, "credentialing is the majority");
});

test("providers outside the assignment scenarios work only at clinics of their own group", () => {
  const facilityById = new Map(tables.facilities.map((f) => [f.id, f]));
  const groupOf = new Map(
    tables.provider_group_assignments.map((a) => [a.provider_id, a.group_id]),
  );
  const locationsOf = new Map();
  for (const a of tables.provider_facility_assignments)
    locationsOf.set(a.provider_id, [
      ...(locationsOf.get(a.provider_id) ?? []),
      facilityById.get(a.facility_id),
    ]);
  const assignment = new Set(ASSIGNMENT_SCENARIOS);
  assert.deepEqual(
    PROVIDER_SCENARIOS.filter((s) => s.stage === "verified_awaiting_assignment")
      .map((s) => s.key)
      .sort(),
    ["location_no_state", "location_other_group", "no_group", "no_location"],
  );
  assert.equal(
    PROVIDER_SCENARIOS.find((s) => s.key === "location_no_group").stage,
    "ready_for_credentialing",
    "a location with no group counts for anyone (A22)",
  );
  for (const p of tables.providers) {
    const scenario = dataset.providerScenario.get(p.id);
    if (assignment.has(scenario)) continue;
    const locations = locationsOf.get(p.id) ?? [];
    assert.ok(locations.length > 0, `${scenario} has a location`);
    for (const location of locations) {
      assert.equal(location.group_id, groupOf.get(p.id), `${scenario}: a clinic of their group`);
      assert.match(location.state, /^[A-Z]{2}$/);
    }
    assert.equal(p.group_id, groupOf.get(p.id), "the frozen mirror matches the membership");
  }
  // The other side: each assignment scenario is missing exactly its piece.
  for (const p of tables.providers) {
    const scenario = dataset.providerScenario.get(p.id);
    const locations = locationsOf.get(p.id) ?? [];
    const group = groupOf.get(p.id);
    if (scenario === "no_group") {
      assert.equal(group, undefined);
      assert.equal(p.group_id, null);
      assert.ok(locations.length === 1 && locations[0].group_id);
    } else if (scenario === "no_location") {
      assert.ok(group);
      assert.equal(locations.length, 0);
    } else if (scenario === "location_other_group") {
      assert.ok(group && locations.length === 1);
      assert.notEqual(locations[0].group_id, group);
      assert.ok(locations[0].group_id);
    } else if (scenario === "location_no_group") {
      assert.ok(group && locations.length === 1);
      assert.equal(locations[0].group_id, null);
    } else if (scenario === "location_no_state") {
      assert.equal(locations.length, 2);
      assert.ok(locations.every((l) => l.group_id === group));
      assert.match(locations[0].state, /^[A-Z]{2}$/);
      assert.equal(locations[1].state, null);
    }
  }
});

test("the edge-case locations serve only their scenario, never a case or a target", () => {
  const noGroup = tables.facilities.filter((f) => f.group_id === null);
  const noState = tables.facilities.filter((f) => f.state === null);
  assert.equal(noGroup.length, UNGROUPED_LOCATIONS);
  assert.equal(noState.length, STATELESS_LOCATIONS);
  for (const f of noGroup) assert.match(f.name, /^Luna Demo Unassigned Clinic \d\d \(synthetic\)$/);
  for (const f of noState) {
    assert.match(f.name, /^Luna Demo New Clinic \d\d \(synthetic\)$/);
    assert.ok(f.group_id && f.street === null && f.zip === null && f.effective_date === null);
  }
  const edge = new Map([
    ...noGroup.map((f) => [f.id, "location_no_group"]),
    ...noState.map((f) => [f.id, "location_no_state"]),
  ]);
  for (const a of tables.provider_facility_assignments) {
    if (edge.has(a.facility_id))
      assert.equal(dataset.providerScenario.get(a.provider_id), edge.get(a.facility_id));
  }
  for (const row of [...tables.credential_cases, ...tables.case_facilities])
    assert.equal(edge.has(row.facility_id), false);
  for (const row of tables.payer_network_targets) assert.match(row.state, /^[A-Z]{2}$/);
  for (const row of tables.provider_groups)
    assert.ok(row.states.every((state) => /^[A-Z]{2}$/.test(state)));
  // Every edge location is used.
  const used = new Set(tables.provider_facility_assignments.map((a) => a.facility_id));
  for (const id of edge.keys()) assert.ok(used.has(id));
});

test("NPIs pass the CMS check digit, use the documented synthetic prefixes and never repeat", () => {
  // Vectors MINT-7's tests treat as valid/invalid.
  for (const valid of ["1234567893", "1112223338", "9998887779"])
    assert.ok(luhnValidNpi(valid), valid);
  assert.equal(luhnValidNpi("1234567890"), false);
  const individual = tables.providers.map((row) => row.npi).filter(Boolean);
  const organization = tables.provider_groups.map((row) => row.npi_type2);
  for (const npi of individual) {
    assert.ok(luhnValidNpi(npi), npi);
    assert.ok(npi.startsWith(SYNTHETIC_NPI_PREFIX_INDIVIDUAL), npi);
  }
  for (const npi of organization) {
    assert.ok(luhnValidNpi(npi), npi);
    assert.ok(npi.startsWith(SYNTHETIC_NPI_PREFIX_ORGANIZATION), npi);
  }
  assert.equal(
    new Set([...individual, ...organization]).size,
    individual.length + organization.length,
  );
  assert.equal(individual.length, 3500 - summarizeDataset(dataset).scenarios.missing_npi);
});

test("ids and natural keys never collide", () => {
  const ids = allRows().map(({ row }) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  const unique = (table, key) => {
    const keys = tables[table].map(key);
    assert.equal(new Set(keys).size, keys.length, `${table} natural key`);
  };
  unique("credential_cases", (r) => `${r.provider_id}|${r.group_id}|${r.payer_id}|${r.state}`);
  unique("credential_cases", (r) => `${r.provider_id}|${r.payer_id}|${r.state}`);
  unique("provider_group_assignments", (r) => `${r.provider_id}|${r.group_id}`);
  unique("provider_facility_assignments", (r) => `${r.provider_id}|${r.facility_id}`);
  unique("payer_network_targets", (r) => `${r.group_id}|${r.payer_id}|${r.state}`);
  unique("case_facilities", (r) => `${r.case_id}|${r.facility_id}`);
  unique("state_licenses", (r) => `${r.provider_id}|${r.state}`);
  unique("status_configs", (r) => `${r.track}|${r.label}`);
  unique("enrollment_facts", (r) => `${r.provider_id}|${r.group_id}|${r.payer_id}|${r.state}`);
  unique("org_payer_assignments", (r) => r.payer_id);
  unique("providers", (r) => `${r.first_name} ${r.last_name}`);
  const primaries = (table, owner) => {
    const owners = tables[table].filter((r) => r.is_primary).map(owner);
    assert.equal(new Set(owners).size, owners.length, `${table} one primary`);
  };
  primaries("case_facilities", (r) => r.case_id);
  primaries("provider_facility_assignments", (r) => r.provider_id);
  primaries("provider_group_assignments", (r) => r.provider_id);
});

test("every row carries the synthetic org and a deterministic v4-shaped id", () => {
  for (const { table, row } of allRows()) {
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/, table);
    if (table !== "organizations") assert.equal(row.org_id, LUNA_ORG_ID, table);
  }
  assert.equal(tables.organizations[0].id, LUNA_ORG_ID);
  assert.equal(lunaUuid("organization", 1), LUNA_ORG_ID);
  assert.notEqual(lunaUuid("provider", 1), lunaUuid("provider", 2));
  for (const id of UAT_ORGANIZATION_IDS) assert.notEqual(id, LUNA_ORG_ID);
});

test("relationships stay inside the org and match the case-key rules", () => {
  const byId = (table) => new Map(tables[table].map((row) => [row.id, row]));
  const providers = byId("providers");
  const groups = byId("provider_groups");
  const facilities = byId("facilities");
  const payers = byId("payers");
  const cases = byId("credential_cases");
  const targets = new Set(
    tables.payer_network_targets.map((r) => `${r.group_id}|${r.payer_id}|${r.state}`),
  );
  const assignments = new Set(
    tables.provider_facility_assignments.map((r) => `${r.provider_id}|${r.facility_id}`),
  );
  for (const row of tables.credential_cases) {
    const facility = facilities.get(row.facility_id);
    assert.ok(
      providers.has(row.provider_id) && groups.has(row.group_id) && payers.has(row.payer_id),
    );
    assert.equal(facility.group_id, row.group_id, "the location belongs to the case's group");
    assert.equal(facility.state, row.state, "the location is in the case's state");
    assert.ok(payers.get(row.payer_id).states.includes(row.state), "the payer covers the state");
    assert.ok(
      targets.has(`${row.group_id}|${row.payer_id}|${row.state}`),
      "an active target exists",
    );
    assert.ok(assignments.has(`${row.provider_id}|${row.facility_id}`), "the provider works there");
  }
  for (const link of tables.case_facilities) {
    const parent = cases.get(link.case_id);
    assert.ok(parent);
    assert.equal(facilities.get(link.facility_id).state, parent.state);
    assert.ok(assignments.has(`${parent.provider_id}|${link.facility_id}`));
    if (link.is_primary) assert.equal(link.facility_id, parent.facility_id, "primary mirror");
  }
  for (const table of ["case_status_history", "tasks", "touches"]) {
    for (const row of tables[table]) assert.ok(cases.has(row.case_id), table);
  }
  for (const row of tables.provider_group_assignments) assert.ok(groups.has(row.group_id));
  // Only the "no group" edge locations lack a group.
  for (const row of tables.facilities) assert.ok(row.group_id === null || groups.has(row.group_id));
  assert.equal(
    tables.facilities.filter((row) => row.group_id === null).length,
    UNGROUPED_LOCATIONS,
  );
  // Every case's history starts with the system seed row and ends at its status.
  const historyByCase = new Map();
  for (const row of tables.case_status_history) {
    historyByCase.set(row.case_id, [...(historyByCase.get(row.case_id) ?? []), row]);
  }
  for (const row of tables.credential_cases) {
    const chain = historyByCase.get(row.id);
    assert.equal(chain[0].from_status, null);
    assert.equal(chain[0].actor_kind, "system");
    assert.equal(chain.at(-1).to_status, row.case_status);
    for (let index = 1; index < chain.length; index += 1) {
      assert.equal(chain[index].from_status, chain[index - 1].to_status);
      assert.ok(chain[index].changed_at >= chain[index - 1].changed_at);
    }
  }
});

test("the case mix covers approved/effective, submitted, in review, not started and denied", () => {
  const statuses = new Set(tables.credential_cases.map((row) => row.case_status));
  for (const [status] of CASE_STATUS_MIX) assert.ok(statuses.has(status), status);
  const summary = summarizeDataset(dataset);
  assert.ok(summary.approvedEffective > 0 && summary.approvedAwaitingEffective > 0);
  assert.equal(new Set(tables.credential_cases.map((row) => row.payer_id)).size, 7);
});

test("the change feed has activity in the last 7, 30 and 90 days, and follow-ups in every bucket", () => {
  const { feed, followUps } = summarizeDataset(dataset);
  for (const window of ["7d", "30d", "90d"]) {
    assert.ok(feed[window].approvals > 0, `${window} approvals`);
    assert.ok(feed[window].licenseExpirations > 0, `${window} license expirations`);
  }
  assert.ok(feed["90d"].terminations > 0);
  assert.ok(
    feed["7d"].approvals < feed["30d"].approvals && feed["30d"].approvals < feed["90d"].approvals,
  );
  assert.ok(followUps.overdue > 0 && followUps.dueToday > 0 && followUps.upcoming > 0);
  // Approvals are user transitions with a from-status, never the system seed row.
  for (const row of tables.case_status_history.filter((r) => r.to_status === "approved")) {
    assert.equal(row.actor_kind, "user");
    assert.notEqual(row.from_status, null);
  }
});

test("touches never trip the auto-status trigger and dates never pass the anchor", () => {
  const status = new Map(tables.credential_cases.map((row) => [row.id, row.case_status]));
  const outcomes = new Set([
    "spoke_with_rep",
    "left_voicemail",
    "callback_scheduled",
    "got_reference_number",
    "sent",
    "reply_received",
    "info_requested",
    "draft_saved",
    "under_review",
    "confirmed_received",
    "no_confirmation",
    "approved",
    "denied",
  ]);
  for (const touch of tables.touches) {
    assert.equal(touch.source, "manual");
    if (touch.entry_type === "touchpoint") {
      assert.notEqual(
        status.get(touch.case_id),
        "not_started",
        "a touchpoint would auto-start the case",
      );
      assert.ok(["call", "email", "portal", "fax"].includes(touch.touch_type));
      assert.ok(outcomes.has(touch.outcome), touch.outcome);
    } else {
      assert.equal(touch.entry_type, "note");
      assert.equal(touch.touch_type, null);
    }
    assert.ok(touch.touch_date <= ANCHOR);
    if (touch.next_follow_up_date) assert.ok(touch.next_follow_up_date >= touch.touch_date);
  }
  for (const row of tables.case_status_history) assert.ok(row.changed_at.slice(0, 10) <= ANCHOR);
  for (const row of tables.credential_cases) {
    for (const key of [
      "created_at",
      "submitted_date",
      "approved_date",
      "confirmed_effective_date",
      "termination_date",
    ]) {
      if (row[key]) assert.ok(row[key].slice(0, 10) <= ANCHOR, key);
    }
  }
});

test("all personal data is obviously synthetic", () => {
  for (const row of tables.providers) {
    assert.match(row.email, /@example\.test$/);
    assert.match(row.phone, /^\(555\) 555-01\d\d$/);
    assert.ok(row.date_of_birth === null || row.date_of_birth === "1970-01-01");
    assert.ok(row.ssn_last4 === null || row.ssn_last4 === "0000");
    assert.match(
      row.home_street,
      /(Example Way|Synthetic Ave|Placeholder Rd|Fixture Ln|Sample St)$/,
    );
    assert.match(row.home_zip, /^000\d\d$/);
    assert.ok(row.caqh_id === null || /^99\d{6}$/.test(row.caqh_id));
  }
  for (const row of [...tables.facilities, ...tables.provider_groups]) {
    assert.match(row.name, /\(synthetic\)$/);
  }
  for (const row of tables.provider_groups) assert.match(row.tin, /^00\d{7}$/);
  for (const row of tables.payers) assert.match(row.name, /^Synthetic .* \(Luna demo\)$/);
  for (const row of tables.state_licenses) {
    assert.match(row.license_number, /^LUNA-SYN-[A-Z]{2}-\d{5}$/);
    if (row.verification_source_url)
      assert.match(row.verification_source_url, /^https:\/\/example\.test\//);
  }
});

test("status configs are exactly the create_organization seed", async () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  let latest = null;
  for (const name of files) {
    const text = await readFile(new URL(name, dir), "utf8");
    if (
      /FUNCTION public\.create_organization/.test(text) &&
      /INSERT INTO public\.status_configs/.test(text)
    ) {
      latest = text;
    }
  }
  assert.ok(latest, "a create_organization migration seeds status_configs");
  const block = latest.slice(latest.lastIndexOf("INSERT INTO public.status_configs"));
  const rows = [
    ...block
      .slice(0, block.indexOf(";"))
      .matchAll(/\(v_org_id, '(\w+)', +'([^']+)', +'(#[0-9A-F]{6})', +(\d+), '(\w+)'\)/g),
  ].map((m) => [m[1], m[2], m[3], Number(m[4]), m[5]]);
  assert.deepEqual(
    rows,
    CANONICAL_STATUS_CONFIGS.map((row) => [...row]),
  );
});

// ---------- SQL ----------

const applySql = buildApplySql(dataset, {
  target: STAGING,
  members: [{ email: "reviewer@example.test", role: "admin" }],
});
const teardownSql = buildTeardownSql({ target: STAGING });

test("apply SQL empties the org's seed tables, then inserts every table in chunks and checks its count", () => {
  const counts = planCounts(dataset);
  for (const table of SEED_TABLES) {
    const statements = applySql.match(new RegExp(`INSERT INTO public\\.${table} \\(`, "g")) ?? [];
    assert.equal(statements.length, Math.ceil(counts[table] / INSERT_CHUNK_ROWS), table);
    assert.ok(applySql.includes(`expected ${counts[table]}'`), `${table} count is verified`);
    assert.ok(
      applySql.includes(
        `SELECT count(*) INTO v_count FROM public.${table} WHERE org_id = '${LUNA_ORG_ID}'::uuid;`,
      ),
      `${table} is counted by the org id`,
    );
  }
  const inserts = applySql
    .split(/(?=INSERT INTO public\.)/)
    .filter((piece) => piece.startsWith("INSERT INTO public."));
  for (const statement of inserts) {
    const body = statement.slice(0, statement.indexOf(";\n") + 1);
    assert.ok(Buffer.byteLength(body) < 1_000_000, "each statement stays well under a megabyte");
  }
  // Re-apply = teardown + insert: every seed table is emptied for the org,
  // children first, before the first insert. Members and the org row stay.
  const deletes = [
    ...applySql.matchAll(/DELETE FROM public\.(\w+) WHERE org_id = '([0-9a-f-]+)'::uuid;/g),
  ];
  assert.deepEqual(
    deletes.map((m) => m[1]),
    [...SEED_TABLES].reverse(),
  );
  assert.ok(deletes.every((m) => m[2] === LUNA_ORG_ID));
  assert.ok(
    applySql.lastIndexOf("DELETE FROM public.") <
      applySql.indexOf("INSERT INTO public.status_configs"),
  );
  assert.doesNotMatch(
    applySql,
    /DELETE FROM public\.(memberships|organizations|audit_log|roster_)/,
  );
  assert.doesNotMatch(applySql, /audit_log/, "no receipts");
  assert.ok(applySql.includes("ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role"));
  assert.ok(
    applySql.indexOf(
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lifecycle_state = 'active'",
    ) < applySql.indexOf("DELETE FROM public."),
  );
  // Members are checked before the bulk work, so a refusal fails fast.
  assert.ok(
    applySql.indexOf("belongs to a UAT fixture org") < applySql.indexOf("DELETE FROM public."),
  );
  const check = applySql.indexOf("Luna-scale seed verification failed");
  assert.ok(check > applySql.lastIndexOf("INSERT INTO public.enrollment_facts"));
  assert.ok(check < applySql.lastIndexOf("COMMIT;"));
});

test("apply SQL touches no id outside the synthetic org", () => {
  const known = new Set([LUNA_ORG_ID, ...UAT_ORGANIZATION_IDS]);
  for (const { row } of allRows()) known.add(row.id);
  const uuids = new Set(
    applySql.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
  );
  for (const id of uuids) assert.ok(known.has(id), `foreign id ${id}`);
  // UAT org ids appear only in the member guard that refuses UAT personas.
  for (const id of UAT_ORGANIZATION_IDS) {
    assert.ok(applySql.indexOf(id) > applySql.indexOf("belongs to a UAT fixture org") - 400);
  }
});

test("both scripts refuse production, foreign identities and a missing confirmation inside SQL", () => {
  for (const sql of [applySql, teardownSql]) {
    assert.ok(sql.startsWith("-- Luna-scale"));
    assert.ok(sql.includes(`IF v_identity = '${PRODUCTION_CLUSTER}' THEN`));
    assert.ok(sql.includes(":'expected_database_identity'"));
    assert.ok(sql.includes(":'confirm_token'"));
    const firstWrite = Math.min(
      ...["INSERT INTO", "DELETE FROM", "UPDATE public."]
        .map((word) => sql.indexOf(word))
        .filter((index) => index >= 0),
    );
    assert.ok(
      sql.indexOf("pg_control_system()") < firstWrite,
      "the identity check runs before any write",
    );
    assert.ok(sql.indexOf("confirmation token mismatch") < firstWrite);
    assert.match(sql, /\nCOMMIT;\n/);
  }
  assert.ok(applySql.includes(`IS DISTINCT FROM '${confirmationToken("apply", STAGING)}'`));
  assert.ok(teardownSql.includes(`IS DISTINCT FROM '${confirmationToken("teardown", STAGING)}'`));
  const review = buildApplySql(dataset, { target: { kind: "review", projectRef: "REVIEW-ONLY" } });
  assert.ok(
    review.indexOf("RAISE EXCEPTION 'Luna-scale SQL refused: this is a review copy") <
      review.indexOf("INSERT INTO"),
  );
});

test("teardown covers every table written, child before parent, scoped to the org", () => {
  const written = [...SEED_TABLES, "memberships"];
  assert.deepEqual([...TEARDOWN_TABLES].sort(), [...written].sort());
  const position = (table) => teardownSql.indexOf(`DELETE FROM public.${table} WHERE`);
  for (const table of written) assert.ok(position(table) > 0, `${table} is deleted`);
  // child -> parent foreign keys among the seeded tables.
  const fks = [
    ["touches", "credential_cases"],
    ["touches", "tasks"],
    ["tasks", "credential_cases"],
    ["tasks", "providers"],
    ["case_status_history", "credential_cases"],
    ["case_status_history", "touches"],
    ["case_facilities", "credential_cases"],
    ["case_facilities", "facilities"],
    ["enrollment_facts", "providers"],
    ["enrollment_facts", "payers"],
    ["enrollment_facts", "provider_groups"],
    ["credential_cases", "providers"],
    ["credential_cases", "facilities"],
    ["credential_cases", "payers"],
    ["credential_cases", "provider_groups"],
    ["credential_cases", "status_configs"],
    ["state_licenses", "providers"],
    ["provider_facility_assignments", "providers"],
    ["provider_facility_assignments", "facilities"],
    ["provider_group_assignments", "providers"],
    ["provider_group_assignments", "provider_groups"],
    ["providers", "provider_groups"],
    ["payer_network_targets", "payers"],
    ["payer_network_targets", "provider_groups"],
    ["org_payer_assignments", "payers"],
    ["facilities", "provider_groups"],
  ];
  for (const [child, parent] of fks) {
    assert.ok(position(child) < position(parent), `${child} before ${parent}`);
  }
  for (const statement of teardownSql.match(/DELETE FROM public\.\w+ WHERE [^;]+;/g)) {
    assert.ok(statement.endsWith(`WHERE org_id = '${LUNA_ORG_ID}'::uuid;`), statement);
  }
  assert.doesNotMatch(teardownSql, /DELETE FROM public\.(organizations|audit_log|roster_)/);
  assert.doesNotMatch(teardownSql, /audit_log/, "no receipts");
  assert.match(
    teardownSql,
    new RegExp(
      `UPDATE public\\.organizations SET lifecycle_state = 'inactive' WHERE id = '${LUNA_ORG_ID}'::uuid;`,
    ),
  );
  // Every column the generator writes is in the SQL column spec, and back.
  for (const table of LUNA_TABLES) {
    for (const row of tables[table])
      assert.deepEqual(Object.keys(row).sort(), Object.keys(TABLE_COLUMNS[table]).sort(), table);
  }
});

test("SQL literals carry their type, escape quotes and refuse backslashes", () => {
  assert.equal(sqlLiteral("O'Hara", "text"), "'O''Hara'::text");
  assert.equal(sqlLiteral(null, "text"), "NULL::text");
  assert.equal(sqlLiteral(null, "uuid"), "NULL::uuid");
  assert.equal(sqlLiteral(LUNA_ORG_ID, "uuid"), `'${LUNA_ORG_ID}'::uuid`);
  assert.equal(sqlLiteral("2026-10-30", "date"), "'2026-10-30'::date");
  assert.equal(sqlLiteral(null, "date"), "NULL::date");
  assert.equal(
    sqlLiteral("2026-10-30T15:00:00Z", "timestamptz"),
    "'2026-10-30T15:00:00Z'::timestamptz",
  );
  assert.equal(sqlLiteral(5, "int"), "5::integer");
  assert.equal(sqlLiteral(null, "int"), "NULL::integer");
  assert.equal(sqlLiteral(true, "bool"), "true");
  assert.equal(sqlLiteral(null, "bool"), "NULL::boolean");
  assert.equal(sqlLiteral(null, "text[]"), "NULL::text[]");
  assert.equal(sqlLiteral(["AZ", "CA"], "text[]"), "ARRAY['AZ','CA']::text[]");
  assert.equal(sqlLiteral([], "text[]"), "'{}'::text[]");
  assert.equal(sqlLiteral({ a: "b'c" }, "jsonb"), `'{"a":"b''c"}'::jsonb`);
  assert.throws(() => sqlLiteral("a\\b", "text"), /backslash/);
  assert.throws(() => sqlLiteral(1.5, "int"), /integer/);
});

// ---------- target guards ----------

const direct = `postgres://postgres:x@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`;
const pooler = `postgres://postgres.${STAGING_PROJECT_REF}:x@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`;
const api = `https://${STAGING_PROJECT_REF}.supabase.co`;
const allowed = [STAGING_PROJECT_REF];

test("target guard accepts allowlisted staging and explicit local rehearsal only", () => {
  assert.deepEqual(
    assertLunaTarget({ supabaseUrl: api, databaseUrl: direct, allowedRefs: allowed }),
    STAGING,
  );
  assert.deepEqual(
    assertLunaTarget({
      supabaseUrl: api,
      databaseUrl: `${pooler}?sslmode=require`,
      allowedRefs: allowed,
    }),
    STAGING,
  );
  const local = {
    supabaseUrl: "http://127.0.0.1:54321",
    databaseUrl: "postgres://postgres:postgres@localhost:54322/postgres",
    allowedRefs: [],
  };
  assert.throws(() => assertLunaTarget(local), /--local-rehearsal/);
  assert.deepEqual(assertLunaTarget({ ...local, allowLocal: true }), {
    kind: "local",
    projectRef: "local",
  });
});

test("target guard refuses production outright, whatever the allowlist says", () => {
  const prodApi = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
  const prodDb = `postgres://postgres:x@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`;
  const prodPooler = `postgres://postgres.${PRODUCTION_PROJECT_REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  for (const [supabaseUrl, databaseUrl, allowedRefs] of [
    [prodApi, prodDb, [PRODUCTION_PROJECT_REF]],
    [prodApi, prodDb, allowed],
    [prodApi, prodPooler, [STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF]],
    [api, prodDb, allowed],
    [api, prodPooler, allowed],
    [api, direct, [STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF]],
  ]) {
    assert.throws(
      () => assertLunaTarget({ supabaseUrl, databaseUrl, allowedRefs }),
      /Refusing production/,
    );
  }
});

test("local mode accepts only 127.0.0.1 or localhost, whatever the allowlist says", () => {
  const ok = { kind: "local", projectRef: "local" };
  assert.deepEqual(
    assertLunaTarget({
      supabaseUrl: "http://127.0.0.1:54321",
      databaseUrl: "postgresql://postgres:x@127.0.0.1:54322/postgres",
      allowedRefs: [],
      allowLocal: true,
    }),
    ok,
  );
  assert.deepEqual(
    assertLunaTarget({
      supabaseUrl: "http://localhost:54321",
      databaseUrl: "postgres://postgres:x@localhost:54322/postgres",
      allowedRefs: allowed,
      allowLocal: true,
    }),
    ok,
  );
  // A remote host in local mode is refused, even when it is allowlisted staging.
  for (const [supabaseUrl, databaseUrl] of [
    [api, direct],
    [api, pooler],
    ["http://127.0.0.1:54321", direct],
    [api, "postgres://postgres:x@127.0.0.1:54322/postgres"],
    ["http://127.0.0.1:54321", "postgres://postgres:x@db.example.test:5432/postgres"],
    [
      "http://localhost.attacker.test:54321",
      "postgres://postgres:x@localhost.attacker.test:54322/postgres",
    ],
    ["http://[::1]:54321", "postgres://postgres:x@[::1]:54322/postgres"],
    ["http://10.0.0.5:54321", "postgres://postgres:x@10.0.0.5:54322/postgres"],
  ]) {
    assert.throws(
      () => assertLunaTarget({ supabaseUrl, databaseUrl, allowedRefs: allowed, allowLocal: true }),
      /--local-rehearsal: it accepts only 127\.0\.0\.1 or localhost|plain hostname or IPv4 address/,
      `${supabaseUrl} ${databaseUrl}`,
    );
  }
  // Production's ref is refused in local mode too, on either URL.
  for (const [supabaseUrl, databaseUrl] of [
    [
      "http://127.0.0.1:54321",
      `postgres://postgres.${PRODUCTION_PROJECT_REF}:x@127.0.0.1:54322/postgres`,
    ],
    [
      `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      "postgres://postgres:x@127.0.0.1:54322/postgres",
    ],
    [
      "http://127.0.0.1:54321",
      `postgres://postgres:x@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`,
    ],
  ]) {
    assert.throws(
      () => assertLunaTarget({ supabaseUrl, databaseUrl, allowedRefs: [], allowLocal: true }),
      /Refusing production/,
      databaseUrl,
    );
  }
  assert.throws(
    () =>
      assertLunaTarget({
        supabaseUrl: "http://127.0.0.1:54321",
        databaseUrl: "postgres://postgres:x@127.0.0.1:54322/postgres",
        allowedRefs: [PRODUCTION_PROJECT_REF],
        allowLocal: true,
      }),
    /Refusing production/,
  );
  // Local mode keeps its own confirmation token.
  assert.equal(confirmationToken("apply", ok), "SEED LUNA SCALE ON local");
  assert.throws(
    () => assertConfirmation("apply", ok, `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`),
    /ON local/,
  );
});

test("target guard refuses unlisted refs, mixed targets, spoofed hosts and overrides", () => {
  assert.throws(
    () => assertLunaTarget({ supabaseUrl: api, databaseUrl: direct, allowedRefs: [] }),
    /is empty/,
  );
  const other = "abcdefghijklmnopqrst";
  assert.throws(
    () =>
      assertLunaTarget({
        supabaseUrl: `https://${other}.supabase.co`,
        databaseUrl: `postgres://postgres:x@db.${other}.supabase.co/postgres`,
        allowedRefs: allowed,
      }),
    /not in LUNA_SCALE_ALLOWED_PROJECT_REFS/,
  );
  for (const databaseUrl of [
    direct.replace(".supabase.co", ".supabase.co.attacker.invalid"),
    `${direct}?host=db.other.supabase.co`,
    `${direct}?hostaddr=192.0.2.1`,
    `${direct}?sslmode=disable`,
    `${direct}#x`,
    direct.replace("/postgres", "/other"),
    direct.replace(":5432", ":6543"),
    `postgres://postgres:x@db.${other}.supabase.co:5432/postgres`,
    pooler.replace("ca-central-1", "us-west-1"),
    pooler.replace(`postgres.${STAGING_PROJECT_REF}`, "postgres.wrong"),
    "postgres://postgres:postgres@localhost:54322/postgres",
  ]) {
    assert.throws(
      () =>
        assertLunaTarget({ supabaseUrl: api, databaseUrl, allowedRefs: allowed, allowLocal: true }),
      databaseUrl,
    );
  }
  assert.throws(
    () =>
      assertLunaTarget({ supabaseUrl: `${api}/rest`, databaseUrl: direct, allowedRefs: allowed }),
    /SUPABASE_URL/,
  );
});

test("database identity must be the audited cluster and never production", () => {
  assert.throws(() => assertDatabaseIdentity(STAGING, PRODUCTION_CLUSTER), /production/);
  assert.throws(() => assertDatabaseIdentity(STAGING, "123"), /mismatch/);
  assert.equal(assertDatabaseIdentity(STAGING, STAGING_CLUSTER), STAGING_CLUSTER);
  const other = { kind: "staging", projectRef: "abcdefghijklmnopqrst" };
  assert.throws(
    () => assertDatabaseIdentity(other, "999"),
    /LUNA_SCALE_EXPECTED_DATABASE_IDENTITY/,
  );
  assert.equal(assertDatabaseIdentity(other, "999", "999"), "999");
  const local = { kind: "local", projectRef: "local" };
  assert.throws(() => assertDatabaseIdentity(local, STAGING_CLUSTER), /hosted staging/);
  assert.throws(() => assertDatabaseIdentity(local, "not a number"), /no identity/);
});

test("confirmation tokens are bound to the action and the project", () => {
  assert.equal(confirmationToken("apply", STAGING), `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`);
  assert.equal(
    confirmationToken("teardown", STAGING),
    `TEAR DOWN LUNA SCALE ON ${STAGING_PROJECT_REF}`,
  );
  assert.throws(() => assertConfirmation("apply", STAGING, null), /--confirm "SEED LUNA SCALE ON/);
  assert.throws(() => assertConfirmation("apply", STAGING, confirmationToken("teardown", STAGING)));
  assert.throws(() => assertConfirmation("apply", STAGING, "SEED LUNA SCALE ON otherproject"));
  assert.doesNotThrow(() =>
    assertConfirmation("teardown", STAGING, confirmationToken("teardown", STAGING)),
  );
});

test("member access refuses UAT personas and isolation-gate logins", () => {
  assert.deepEqual(
    assertMemberEmails([" Reviewer@Example.test ", "reviewer@example.test"], "admin"),
    ["reviewer@example.test"],
  );
  assert.throws(
    () => assertMemberEmails(["uat.admin.alpha@minted.invalid"], "admin"),
    /UAT persona/,
  );
  assert.throws(
    () =>
      assertMemberEmails(["kansas@example.test"], "admin", { KANSAS_EMAIL: "Kansas@example.test" }),
    /isolation-gate/,
  );
  assert.throws(
    () =>
      assertMemberEmails(["x@example.test"], "admin", {
        LUNA_SCALE_PROTECTED_EMAILS: "y@example.test, x@example.test",
      }),
    /isolation-gate/,
  );
  assert.throws(() => assertMemberEmails(["not-an-email"], "admin"), /Invalid/);
  assert.throws(() => assertMemberEmails([], "owner"), /--member-role/);
});

// ---------- the runner ----------

const stagingEnvironment = {
  SUPABASE_URL: api,
  LUNA_DATABASE_URL: `postgres://postgres:private-test-password@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
  LUNA_SCALE_ALLOWED_PROJECT_REFS: STAGING_PROJECT_REF,
  PGHOST: "production.invalid",
};

function spies(identity = STAGING_CLUSTER) {
  const calls = { identity: 0, sql: [], reports: [] };
  return {
    calls,
    deps: {
      environment: stagingEnvironment,
      today: () => ANCHOR,
      executeIdentity: async (command, args, options) => {
        calls.identity += 1;
        assert.equal(command, "psql");
        // psql never gets the URL: the validated parts travel as PG* variables,
        // and the inherited PGHOST (production.invalid) is gone.
        assert.ok(!args.some((arg) => /postgres(ql)?:\/\//.test(arg)));
        assert.deepEqual(
          Object.fromEntries(Object.entries(options.env).filter(([key]) => key.startsWith("PG"))),
          {
            PGHOST: `db.${STAGING_PROJECT_REF}.supabase.co`,
            PGPORT: "5432",
            PGUSER: "postgres",
            PGDATABASE: "postgres",
            PGPASSWORD: "private-test-password",
            PGCONNECT_TIMEOUT: "15",
          },
        );
        return { stdout: `${identity}\n` };
      },
      runSql: async (url, sql, variables) => calls.sql.push({ url, sql, variables }),
      report: (message) => calls.reports.push(message),
    },
  };
}

test("the runner never writes without a mode, a target, a confirmation and a matching identity", async () => {
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(["--apply", "--teardown"]), /exactly one/);
  for (const [argv, environment, pattern] of [
    [["--apply"], stagingEnvironment, /--confirm "SEED LUNA SCALE ON vmznysvietfaddakkegt"/],
    [
      ["--teardown", "--confirm", `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`],
      stagingEnvironment,
      /TEAR DOWN/,
    ],
    [
      ["--apply", "--confirm", "SEED LUNA SCALE ON fkvuhfsqcmujywzgczmc"],
      { ...stagingEnvironment, SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` },
      /Refusing production/,
    ],
    [
      ["--apply", "--confirm", "x"],
      { ...stagingEnvironment, LUNA_SCALE_ALLOWED_PROJECT_REFS: "" },
      /is empty/,
    ],
    [
      ["--apply", "--confirm", "x"],
      { ...stagingEnvironment, LUNA_DATABASE_URL: undefined },
      /required/,
    ],
  ]) {
    const { calls, deps } = spies();
    await assert.rejects(main(argv, { ...deps, environment }), pattern);
    assert.equal(calls.identity, 0, "no connection before the guards pass");
    assert.equal(calls.sql.length, 0);
  }
  for (const identity of [PRODUCTION_CLUSTER, "123456789", "garbage"]) {
    const { calls, deps } = spies(identity);
    await assert.rejects(
      main(["--apply", "--confirm", `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`], deps),
      /identity|production/,
    );
    assert.equal(calls.identity, 1);
    assert.equal(calls.sql.length, 0);
  }
});

test("a confirmed staging apply binds the observed identity and the token into psql", async () => {
  const { calls, deps } = spies();
  const token = `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`;
  await main(
    [
      "--apply",
      "--confirm",
      token,
      "--member-email",
      "reviewer@example.test",
      "--member-role",
      "specialist",
    ],
    deps,
  );
  assert.equal(calls.sql.length, 1);
  const [{ sql, variables }] = calls.sql;
  assert.deepEqual(variables, {
    expected_database_identity: STAGING_CLUSTER,
    confirm_token: token,
  });
  assert.ok(sql.includes(`IS DISTINCT FROM '${token}'`));
  assert.ok(sql.includes("lower(u.email) = 'reviewer@example.test'"));
  assert.ok(sql.includes("'specialist')\n  ON CONFLICT (org_id, user_id)"));
  assert.ok(sql.includes("INSERT INTO public.memberships (org_id, user_id, role)"));
  assert.ok(!calls.reports.join("").includes("private-test-password"));

  const teardown = spies();
  await main(
    ["--teardown", "--confirm", `TEAR DOWN LUNA SCALE ON ${STAGING_PROJECT_REF}`],
    teardown.deps,
  );
  assert.match(teardown.calls.sql[0].sql, /DELETE FROM public\.touches WHERE/);
  assert.doesNotMatch(teardown.calls.sql[0].sql, /INSERT INTO public\.providers/);
});

test("the dry runs never connect", async () => {
  const { calls, deps } = spies();
  const result = await main(["--dry-run"], deps);
  assert.equal(calls.identity, 0);
  assert.equal(calls.sql.length, 0);
  assert.deepEqual(result.counts, planCounts(dataset));
  const output = calls.reports.join("");
  assert.match(output, /DRY RUN \(no connection; nothing written\)/);
  assert.match(output, /providers\s+3,500/);
  assert.match(output, /total\s+64,644/);
  assert.match(output, /target: staging vmznysvietfaddakkegt/);
  assert.doesNotMatch(output, /audit_log|receipt/);

  const teardown = spies();
  await main(["--dry-run", "--teardown"], teardown.deps);
  assert.match(teardown.calls.reports.join(""), /Luna-scale teardown: DRY RUN/);
  assert.equal(teardown.calls.identity + teardown.calls.sql.length, 0);

  // The fixed dataset takes no count, seed or anchor flags.
  for (const flag of ["--providers", "--seed", "--anchor-date", "--emit-sql", "--allow-unowned"])
    assert.throws(() => parseArgs(["--dry-run", flag, "5"]), /Unknown argument/, flag);
});

test("the verifier checks every seed table in the org against planCounts", () => {
  const planned = planCounts(dataset);
  const counts = Object.fromEntries(SEED_TABLES.map((t) => [t, planned[t]]));
  const good = {
    org: { name: "Luna Demo (synthetic)", lifecycle_state: "active" },
    counts: { ...counts, memberships: 1 },
    cross_org_case_links: 0,
    cases_without_primary_location: 0,
  };
  assert.deepEqual(checkSnapshot(good, planned), []);
  assert.match(
    checkSnapshot({ ...good, counts: { ...good.counts, providers: 3499 } }, planned).join(),
    /providers: 3499 rows in the Luna org, expected 3500/,
  );
  assert.match(
    checkSnapshot(
      { ...good, counts: { ...good.counts, touches: planned.touches + 1 } },
      planned,
    ).join(),
    /touches: .* expected/,
  );
  assert.match(
    checkSnapshot({ ...good, cross_org_case_links: 2 }, planned).join(),
    /cross_org_case_links/,
  );
  assert.deepEqual(checkSnapshot({ ...good, org: null }, planned), [
    "the Luna org does not exist; nothing has been applied",
  ]);
  assert.match(
    checkSnapshot({ ...good, org: { ...good.org, lifecycle_state: "onboarding" } }, planned).join(),
    /expected active \(applied\) or inactive \(torn down\)/,
  );

  // After a teardown the inactive org holds no seed rows and no members.
  const zero = Object.fromEntries(Object.keys(good.counts).map((t) => [t, 0]));
  const shell = { ...good, org: { ...good.org, lifecycle_state: "inactive" }, counts: zero };
  assert.deepEqual(checkSnapshot(shell, planned), []);
  assert.match(
    checkSnapshot({ ...shell, counts: { ...zero, tasks: 4 } }, planned).join(),
    /tasks: 4 rows in the Luna org, expected 0/,
  );
  assert.match(
    checkSnapshot({ ...shell, counts: { ...zero, memberships: 1 } }, planned).join(),
    /memberships: 1 after the teardown, expected 0/,
  );
});

test("verifier flags parse strictly", () => {
  assert.deepEqual(parseVerifyArgs([]), { allowLocal: false, fingerprint: false });
  assert.deepEqual(parseVerifyArgs(["--local-rehearsal", "--fingerprint"]), {
    allowLocal: true,
    fingerprint: true,
  });
  assert.throws(() => parseVerifyArgs(["--strict"]), /Unknown argument/);
  assert.throws(() => parseVerifyArgs(["--teardown"]), /Unknown argument/);
});

test("verify and fingerprint SQL are read-only and scoped to the Luna org", () => {
  const verifySql = buildVerifySql();
  const outside = buildFingerprintSql();
  for (const sql of [verifySql, outside]) {
    assert.ok(sql.startsWith("BEGIN READ ONLY;"));
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
  }
  for (const table of [...SEED_TABLES, "memberships"])
    assert.ok(
      verifySql.includes(
        `'${table}', (SELECT count(*) FROM public.${table} WHERE org_id = '${LUNA_ORG_ID}'::uuid)`,
      ),
      table,
    );
  // Outside: every public table, minus the Luna org's rows and its org row.
  assert.ok(outside.includes(`format('x.id <> %L::uuid', '${LUNA_ORG_ID}')`));
  assert.ok(outside.includes(`format('x.org_id IS DISTINCT FROM %L::uuid', '${LUNA_ORG_ID}')`));
  assert.match(outside, /n\.nspname = 'public' AND c\.relkind IN \('r', 'p'\)/);
  assert.match(outside, /has_table_privilege\(c\.oid, 'SELECT'\)/, "catalog OIDs, never names");
  assert.doesNotMatch(outside, /information_schema|public\.%I/);
});

test("seeded location links leave created_by null: it references auth.users", () => {
  assert.ok(tables.case_facilities.length > 0);
  for (const row of tables.case_facilities) assert.equal(row.created_by, null);
  assert.equal(
    tables.credential_cases.some((row) => "created_by" in row),
    false,
  );
});

test("the CI job proves the seed on local Supabase, in order, and only there", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("\n  luna-scale-seed:\n");
  assert.ok(start > 0, "the luna-scale-seed job exists");
  const end = workflow.indexOf("\n  release-guardrails:\n", start);
  const job = workflow.slice(start, end);
  assert.match(job, /name: Luna-scale seed \(local Supabase\)/);
  const order = [
    "20260903210001_delete_org_sop_template.sql",
    'supabase --workdir "$luna_workdir" start',
    "db reset --no-seed",
    "npm run seed:staging-uat",
    '--fingerprint > "$RUNNER_TEMP/outside-before.json"',
    "--dry-run --local-rehearsal",
    '--apply --local-rehearsal --confirm "SEED LUNA SCALE ON local"',
    "verify:luna-scale -- --local-rehearsal",
    'test "$(case_numbers)" != "$first_case_numbers"',
    "--member-email ci.luna.uat-member@example.test",
    'test "$(case_numbers)" = "$before"',
    'diff "$RUNNER_TEMP/outside-before.json" "$RUNNER_TEMP/outside-after-apply.json"',
    '--teardown --local-rehearsal --confirm "TEAR DOWN LUNA SCALE ON local"',
    'diff "$RUNNER_TEMP/outside-before.json" "$RUNNER_TEMP/outside-after-teardown.json"',
  ];
  let cursor = 0;
  for (const text of order) {
    const at = job.indexOf(text, cursor);
    assert.ok(at >= cursor, `step out of order or missing: ${text}`);
    cursor = at;
  }
  // Every seed or verify call is local; no hosted URL, key or password literal.
  for (const line of job.split("\n").filter((l) => /(seed|verify):luna-scale/.test(l))) {
    assert.match(line, /--local-rehearsal/, line);
  }
  assert.doesNotMatch(job, /supabase\.co|vmznysvietfaddakkegt|fkvuhfsqcmujywzgczmc/);
  assert.doesNotMatch(job, /postgres:postgres@|eyJ[A-Za-z0-9_-]{10,}/);
});

test("a failed identity preflight reports psql's error without the credentials", async () => {
  const { calls, deps } = spies();
  await assert.rejects(
    main(["--apply", "--confirm", `SEED LUNA SCALE ON ${STAGING_PROJECT_REF}`], {
      ...deps,
      executeIdentity: async () => {
        const error = new Error(`Command failed: psql ${stagingEnvironment.LUNA_DATABASE_URL}`);
        error.stderr = `psql: error: connection to ${stagingEnvironment.LUNA_DATABASE_URL} failed: timeout`;
        throw error;
      },
    }),
    (error) => {
      assert.match(
        error.message,
        /identity preflight failed; nothing was written: psql: error: connection to <LUNA_DATABASE_URL> failed/,
      );
      assert.ok(!error.message.includes("private-test-password"));
      return true;
    },
  );
  assert.equal(calls.sql.length, 0);

  await assert.rejects(
    verifyMain([], {
      environment: stagingEnvironment,
      report: () => {},
      execute: async () => {
        const error = new Error("Command failed");
        error.stderr = `FATAL: password authentication failed (${stagingEnvironment.LUNA_DATABASE_URL})`;
        throw error;
      },
    }),
    (error) => {
      assert.ok(!error.message.includes("private-test-password"));
      assert.match(error.message, /<LUNA_DATABASE_URL>/);
      return true;
    },
  );
});

// ---------- fix round: review of #562 ----------

test("inserts are plain multi-row INSERTs that leave case_number to the database", () => {
  const statements = applySql
    .split(/(?=INSERT INTO public\.)/)
    .filter((piece) => /^INSERT INTO public\.(?!organizations|memberships)/.test(piece));
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    const table = /^INSERT INTO public\.(\w+) /.exec(statement)[1];
    const body = statement.slice(0, statement.indexOf(";\n") + 1);
    assert.match(body, new RegExp(`^INSERT INTO public\\.${table} \\(id, [^)]+\\) VALUES\\n\\(`));
    assert.doesNotMatch(body, /ON CONFLICT|WHERE NOT EXISTS/, table);
  }
  const cases = statements.find((piece) => piece.startsWith("INSERT INTO public.credential_cases"));
  assert.doesNotMatch(
    cases.split("\n")[0],
    /case_number/,
    "the sequence default stays the database's",
  );
  assert.match(cases, /'[0-9a-f-]{36}'::uuid/);
  assert.match(cases, /NULL::date/);
  assert.match(cases, /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z'::timestamptz/);
});

test("a member already in another org is refused unless --allow-multi-org-member", () => {
  const members = [{ email: "reviewer@example.test", role: "admin" }];
  const strict = buildApplySql(dataset, { target: STAGING, members });
  const allowed = buildApplySql(dataset, { target: STAGING, members, allowMultiOrgMember: true });
  assert.ok(
    strict.includes(
      `m.user_id = v_user AND m.org_id <> '${LUNA_ORG_ID}'::uuid) THEN\n    RAISE EXCEPTION 'Luna-scale seed refused: the member already belongs to another organization`,
    ),
  );
  assert.ok(
    strict.indexOf("belongs to a UAT fixture org") <
      strict.indexOf("already belongs to another organization"),
  );
  assert.doesNotMatch(allowed, /already belongs to another organization/);
  assert.match(allowed, /belongs to a UAT fixture org/, "UAT members stay refused with the flag");
  assert.equal(parseArgs(["--apply", "--allow-multi-org-member"]).allowMultiOrgMember, true);
  assert.equal(parseArgs(["--dry-run", "--allow-multi-org-member"]).allowMultiOrgMember, true);
  assert.throws(
    () => parseArgs(["--teardown", "--allow-multi-org-member"]),
    /only applies to --apply/,
  );
});

test("isolation-gate logins are refused even when no env var names them", async () => {
  assert.deepEqual(
    [...ISOLATION_GATE_LOGINS],
    ["testkansas@minted.com", "testsouthpark@minted.com"],
  );
  for (const email of ISOLATION_GATE_LOGINS) {
    assert.throws(() => assertMemberEmails([email.toUpperCase()], "admin", {}), /isolation-gate/);
  }
  const mock = await readFile(new URL("../mock-api-server.mjs", import.meta.url), "utf8");
  assert.match(mock, /KANSAS_EMAIL: "testkansas@minted\.com"/);
  assert.match(mock, /SPVIEW_EMAIL: "testsouthpark@minted\.com"/);
});

test("database URLs that libpq and WHATWG URL read differently are refused in both modes", () => {
  const localApi = "http://127.0.0.1:54321";
  for (const url of [
    "postgresql://postgres:x@evil.example.com,y@127.0.0.1:54322/postgres",
    `postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co,db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgres://postgres:x@evil.example.com,x@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgres://postgres.${STAGING_PROJECT_REF}:x@evil.example.com,y@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`,
    "postgresql://a@b@127.0.0.1:54322/postgres",
    "postgresql://postgres:x@127.0.0.1,127.0.0.2:54322/postgres",
    "postgresql://postgres:x@127.0.0.1:54322,10.0.0.1:5432/postgres",
    "postgresql://post%2Fgres:x@127.0.0.1:54322/postgres",
    "postgresql://postgres%40evil:x@127.0.0.1:54322/postgres",
    "postgresql://postgres%2Cevil:x@127.0.0.1:54322/postgres",
    "postgresql://postgres:x@127.0.0.1%2C10.0.0.1:54322/postgres",
    "postgresql://postgres:x@[::1]:54322/postgres",
    "postgresql://postgres:x@127.0.0.1:54322/postgres?host=10.0.0.1",
    "postgresql://postgres:x@127.0.0.1:54322/postgres?hostaddr=10.0.0.1",
    "postgresql://postgres:x@127.0.0.1:54322/postgres?sslmode=require&sslmode=disable",
    "postgresql://127.0.0.1:54322/postgres",
    "postgresql://postgres:x@127.0.0.1:54322/other",
  ]) {
    assert.throws(() => parseDatabaseUrl(url), url);
    assert.throws(
      () =>
        assertLunaTarget({
          supabaseUrl: localApi,
          databaseUrl: url,
          allowedRefs: allowed,
          allowLocal: true,
        }),
      url,
    );
    assert.throws(
      () => assertLunaTarget({ supabaseUrl: api, databaseUrl: url, allowedRefs: allowed }),
      url,
    );
  }
  assert.throws(
    () =>
      assertLunaTarget({
        supabaseUrl: "http://x@127.0.0.1:54321",
        databaseUrl: "postgres://postgres:x@127.0.0.1:54322/postgres",
        allowedRefs: [],
        allowLocal: true,
      }),
    /Invalid SUPABASE_URL/,
  );
  // Valid forms parse into discrete parts; a %40 in the password is fine.
  assert.deepEqual(
    parseDatabaseUrl(
      `postgresql://postgres.${STAGING_PROJECT_REF}:p%40ss@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require`,
    ),
    {
      host: "aws-0-ca-central-1.pooler.supabase.com",
      port: "5432",
      user: `postgres.${STAGING_PROJECT_REF}`,
      password: "p@ss",
      dbname: "postgres",
      sslmode: "require",
    },
  );
  assert.deepEqual(parseDatabaseUrl("postgres://postgres:x@localhost:54322/postgres"), {
    host: "localhost",
    port: "54322",
    user: "postgres",
    password: "x",
    dbname: "postgres",
    sslmode: null,
  });
  // psql's environment: inherited PG* gone, validated parts in.
  assert.deepEqual(
    psqlConnectionEnvironment("postgres://postgres:x@127.0.0.1:54322/postgres", {
      PATH: "/bin",
      PGHOST: "prod.invalid",
      PGSERVICE: "prod",
      PGHOSTADDR: "192.0.2.1",
    }),
    {
      PATH: "/bin",
      PGHOST: "127.0.0.1",
      PGPORT: "54322",
      PGUSER: "postgres",
      PGDATABASE: "postgres",
      PGPASSWORD: "x",
      PGCONNECT_TIMEOUT: "15",
    },
  );
  assert.equal(
    maskConnection("FATAL p%40ss / p@ss", "postgres://u:p%40ss@localhost:5432/postgres"),
    "FATAL <password> / <password>",
  );
});

test("the teardown dry run prints the teardown token", async () => {
  const { calls, deps } = spies();
  await main(["--dry-run", "--teardown"], deps);
  const output = calls.reports.join("");
  assert.ok(output.includes(`--confirm "TEAR DOWN LUNA SCALE ON ${STAGING_PROJECT_REF}"`));
  assert.ok(!output.includes("SEED LUNA SCALE ON"));
  assert.match(output, new RegExp(`Deletes every row of org ${LUNA_ORG_ID} from these tables`));
});

test("the entry guard follows symlinks and paths with spaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna entry "));
  try {
    const target = new URL("./seed-luna-scale.mjs", import.meta.url);
    const link = join(dir, "seed link.mjs");
    await symlink(fileURLToPath(target), link);
    assert.equal(isEntryPoint(link, target.href), true);
    const spaced = join(dir, "real file.mjs");
    await writeFile(spaced, "");
    assert.equal(isEntryPoint(spaced, pathToFileURL(spaced).href), true);
    assert.equal(isEntryPoint(spaced, target.href), false);
    assert.equal(isEntryPoint(join(dir, "missing.mjs"), target.href), false);
    assert.equal(isEntryPoint(undefined, target.href), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("psql exiting early reports the rollback instead of crashing on EPIPE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-psql-"));
  try {
    const fake = join(dir, "psql");
    await writeFile(fake, "#!/bin/sh\nexit 3\n");
    await chmod(fake, 0o755);
    const environment = { PATH: `${dir}:${process.env.PATH}` };
    const url = "postgres://postgres:x@127.0.0.1:54322/postgres";
    await assert.rejects(
      runPsql(url, "SELECT 1;\n".repeat(400_000), { confirm_token: "x" }, environment),
      /psql exited 3; the transaction rolled back/,
    );
    await writeFile(fake, "#!/bin/sh\ncat > /dev/null\nexit 0\n");
    await runPsql(url, "SELECT 1;\n".repeat(1000), {}, environment);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the verifier reads the last JSON line of psql output", () => {
  assert.deepEqual(lastJsonLine('BEGIN\n{"a":1}\nSET\n{"a":2}\nCOMMIT\n', "snapshot"), { a: 2 });
  assert.throws(() => lastJsonLine("BEGIN\nCOMMIT", "snapshot"), /no snapshot/);
});
