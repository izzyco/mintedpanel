#!/usr/bin/env node
// End-to-end org-isolation check for the provider API, run against a real
// deploy from a host with open network egress (a GitHub runner, or your
// laptop). The Claude sandbox cannot run this — its egress policy denies both
// *.supabase.co and the *.vercel.app deploy host.
//
// It never uses the service-role key. It signs in as real users with the anon
// key + passwords (the service-role key stays server-side on Vercel), then
// calls the deploy with each user's Bearer JWT. Read-only.
//
// Required env (the GitHub workflow wires these from secrets + constants):
//   SUPABASE_URL           e.g. https://fkvuhfsqcmujywzgczmc.supabase.co
//   SUPABASE_ANON_KEY      publishable/anon key
//   API_BASE               PRODUCTION deploy base (preview SSO blocks Bearer auth)
//   KANSAS_EMAIL/PASSWORD  a Kansas-ONLY user (testkansas@minted.com, admin)
//   SPVIEW_EMAIL/PASSWORD  a South-Park-ONLY user (testsouthpark@minted.com, billing)
//   SOUTHPARK_ORG, SOUTHPARK_PROVIDER_ID, KANSAS_PROVIDER_ID
//   SOUTHPARK_FIELDMAP_ID  the one South Park-scoped portal_field_maps row
//                          (seeded fixture; id lives in the workflow env block)
//   SOUTHPARK_CASE_ID      a South Park credential_cases id (must-reject POST in
//                          assertion 9; must-404 GET context in assertion 14b)
//   SOUTHPARK_FACILITY_ID  a South Park facilities id (the must-404 profile
//                          ?facilityId in assertion 11)
// Optional:
//   VERCEL_BYPASS_SECRET   Vercel "Protection Bypass for Automation" secret. If the
//                          deploy has Deployment Protection on, set this so requests
//                          carry x-vercel-protection-bypass and reach the app.
//   EXPECTED_KANSAS_PROVIDERS / EXPECTED_SOUTHPARK_PROVIDERS
//                          Per-org provider counts for assertions 1/2. Defaults
//                          (6/4) match the mock fixtures; the workflow env pins
//                          the LIVE demo counts, which move when demo/UAT
//                          providers are added. A count mismatch is fixture
//                          drift, not a leak — the leak checks are 1b/2b/2c/3.
//   KANSAS_CASE_ID + SOUTHPARK_TASK_ID
//                          Fixtures for assertion 13 (submission-touch
//                          task-ownership isolation): a Kansas case (valid POST
//                          target) + a South Park task id (the cross-org task_id
//                          that must 404). KANSAS_CASE_ID also enables 6a,
//                          which proves the profile endpoint echoes the
//                          authorized case binding. Both must be set or
//                          assertion 13 is skipped; the in-sandbox mock run
//                          always sets them.
//   KANSAS_ORG             the Kansas org id, for the propose-only field-map
//                          write pair (20/20a): the created row must be scoped
//                          to it. Skipped when unset; the mock run always sets
//                          it. This is the ONE gate assertion that writes for
//                          real — a proposed row is inert (no token, fills
//                          nothing) and idempotent on (portal_key, selector),
//                          so repeat runs converge rather than accumulate.
//   KANSAS_DOCUMENT_ID + SOUTHPARK_DOCUMENT_ID
//                          Fixtures for the E4.5 signed-download pair (17/17b):
//                          an own-org document (positive) + a cross-org document
//                          id that must 404 before anything is signed. Skipped
//                          when unset (the real gate waits for the operator to
//                          seed + pin fixture documents); the in-sandbox mock
//                          run always sets both.
//   KANSAS_ROSTER_MAPPING_ID + SOUTHPARK_ROSTER_MAPPING_ID
//                          Optional WP1.3 roster mapping fixtures. When set,
//                          the gate verifies cross-org mapping GET returns 404.
//   SOUTHPARK_ROSTER_EXPORT_ID
//                          Optional South Park roster export fixture; the gate
//                          verifies a Kansas caller cannot download its bytes.
//   SOUTHPARK_GROUP_ID     A South Park provider_groups id for 35b (cross-org
//                          invite must 404). 35-35c SKIP while the invite routes
//                          are off; 35d and 35e run against the local mock only.
//                          35i/35j (cancel) take SOUTHPARK_PROVIDER_ID. Unless
//                          that provider has an open, unsubmitted onboarding on
//                          the target, cancel answers not_found for her from
//                          any org, so 35j proves only "no 200". The route's
//                          org scoping is pinned by the cancel tests in
//                          src/server/providerInviteRoutes.test.ts, and the
//                          RPC's by scripts/sql/provider-onboarding-cancel-smoke.sql.
//   KANSAS_INTAKE_TOKEN + SOUTHPARK_INTAKE_TOKEN
//                          Intake link tokens for 35d (a Kansas session reads
//                          and saves under its own link) and 35e-35h (the same
//                          session reads, saves, stores no SSN or login,
//                          begins, finishes and removes no upload, and submits
//                          and asks for help under none of South Park's
//                          link). Local mock only: a real token is
//                          emailed, never stored.
//   SEARCH_QUERY           Case search query for assertion 15 (default "a").
//   SEARCH_LEAK_QUERY      Case search query for 15b (default "South Park"). It
//                          must match NO Kansas case (provider name, payer
//                          name, tracking id or case number) and would match
//                          South Park's fixture case under a leak: 15b requires
//                          meta.total === 0, because the search returns only
//                          its first meta.limit rows (default 5) and a leaked
//                          row past them would escape the id check. 15c
//                          repeats it at &limit=50 (the cap, the extension's
//                          "Show more"); 15d asks for &limit=51 and needs a
//                          422 (a panel with MINT-14 S3's &limit=).
//   (no new env needed for 25/25b/26 — the document upload-intent + finalize
//   write-path pair, ASD BITE-ASD-04, closing the TD-53 gap; they reuse
//   KANSAS_PROVIDER_ID/SOUTHPARK_PROVIDER_ID as the owner ids.)
//
// Both users are single-org, so views 1-3 send no x-org-id (the guard resolves
// each caller's sole org). Only the assertion-4 spoof sends an x-org-id.
//
// Near-read-only: the write attempts (POST assertions 7/9, PATCH assertion 12)
// all target another org's case/provider, which the server must REJECT (404)
// before writing anything. Provider POST-create is intentionally NOT exercised
// here — a real create would drift the demo-org counts assertions 1/2 pin.
// The PostgREST probes of 38e (MINT-110 PR 3) go to SUPABASE_URL directly and
// are built so that even a broken grant writes nothing (no org_id and a
// CHECK-failing NPI; UPDATE and DELETE match no row).
// Nothing here writes production data.
//
// Exit code: 0 = all pass, 1 = any assertion failed, 2 = missing env,
// 3 = setup/network error. A cross-org row anywhere is a STOP-SHIP failure.

const env = process.env;
const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "API_BASE",
  "KANSAS_EMAIL",
  "KANSAS_PASSWORD",
  "SPVIEW_EMAIL",
  "SPVIEW_PASSWORD",
  "SOUTHPARK_ORG",
  "SOUTHPARK_PROVIDER_ID",
  "KANSAS_PROVIDER_ID",
  "SOUTHPARK_FIELDMAP_ID",
  "SOUTHPARK_CASE_ID",
  "SOUTHPARK_FACILITY_ID",
];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(2);
}

const API_BASE = env.API_BASE.replace(/\/+$/, "");
const BYPASS = env.VERCEL_BYPASS_SECRET || "";
const IS_LOCAL_MOCK_API = env.SUPABASE_ANON_KEY === "mock-anon-key";

async function signIn(email, password) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

// One GET against the deploy. Adds the Bearer + x-org-id when given, and the
// Vercel protection-bypass header when a secret is configured. Returns the
// parsed JSON body when possible plus the raw text (so a non-JSON SSO gate is
// visible in the logs).
async function apiGet(path, { token, orgId, extraHeaders = {} } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId) headers["x-org-id"] = orgId;
  Object.assign(headers, extraHeaders);
  if (BYPASS) {
    headers["x-vercel-protection-bypass"] = BYPASS;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }
  const res = await fetch(`${API_BASE}${path}`, { headers });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON (e.g. an SSO HTML gate) → body stays null; raw holds the page */
  }
  return {
    status: res.status,
    body,
    raw,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
  };
}

// One POST against the deploy. Same header handling as apiGet.
async function apiPost(path, payload, { token, orgId, extraHeaders = {} } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId) headers["x-org-id"] = orgId;
  Object.assign(headers, extraHeaders);
  if (BYPASS) {
    headers["x-vercel-protection-bypass"] = BYPASS;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON → body stays null; raw holds the page */
  }
  return { status: res.status, body, raw, cacheControl: res.headers.get("cache-control") };
}

// One PATCH against the deploy. Same header handling as apiPost.
async function apiPatch(path, payload, { token, orgId } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId) headers["x-org-id"] = orgId;
  if (BYPASS) {
    headers["x-vercel-protection-bypass"] = BYPASS;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON → body stays null; raw holds the page */
  }
  return { status: res.status, body, raw };
}

// One PostgREST call against Supabase itself (not the deploy), signed the way
// a browser can sign it: the anon key plus the user's JWT. Used only to prove
// a table refuses direct writes (38e); every write sent here is a probe a
// correct database refuses.
async function restCall(method, path, { token, payload } = {}) {
  const headers = { apikey: env.SUPABASE_ANON_KEY, prefer: "return=minimal" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* empty or non-JSON → body stays null */
  }
  return { status: res.status, body, raw };
}

const rows = [];
let stopShip = false;
function check(name, pass, detail, { leak = false } = {}) {
  rows.push({ name, pass, detail });
  if (leak && !pass) stopShip = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
}

function idsOf(body) {
  return new Set((body?.data ?? []).map((r) => r.id));
}

function rowsOf(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

function looksLikeVercelGate(r) {
  // Vercel Authentication returns an HTML interstitial, not our JSON envelope.
  const s = (r.raw || "").toLowerCase();
  return (
    r.body === null && (s.includes("authenticat") || s.includes("vercel") || s.includes("<html"))
  );
}

(async () => {
  console.log(`API_BASE host reachable check — bypass secret ${BYPASS ? "SET" : "not set"}`);

  // Preflight: prove the deploy is reachable and that OUR guard (JSON envelope),
  // not a Vercel SSO gate (HTML), is answering. /api/health is public in-app.
  const health = await apiGet("/api/health");
  console.log(
    `preflight GET /api/health          -> status=${health.status} body=${(health.raw || "").slice(0, 120)}`,
  );
  const noAuth = await apiGet("/api/providers");
  console.log(
    `preflight GET /api/providers noauth -> status=${noAuth.status} body=${(noAuth.raw || "").slice(0, 160)}`,
  );
  if (looksLikeVercelGate(health) || looksLikeVercelGate(noAuth)) {
    console.error(
      "\nDIAGNOSIS: the deploy is behind Vercel Deployment Protection (SSO) — an HTML\n" +
        "gate is answering instead of the app's JSON. Bearer auth can't get past it.\n" +
        "Fix: point API_BASE at a public production deploy, or set VERCEL_BYPASS_SECRET\n" +
        "(a Vercel 'Protection Bypass for Automation' secret) so requests carry the\n" +
        "x-vercel-protection-bypass header.\n",
    );
  }

  const kansasTok = await signIn(env.KANSAS_EMAIL, env.KANSAS_PASSWORD);
  const spTok = await signIn(env.SPVIEW_EMAIL, env.SPVIEW_PASSWORD);

  // Expected per-org provider counts (see the env note in the header).
  const KANSAS_COUNT = Number(env.EXPECTED_KANSAS_PROVIDERS ?? 6);
  const SOUTHPARK_COUNT = Number(env.EXPECTED_SOUTHPARK_PROVIDERS ?? 4);

  // 1. Kansas view (single-org user, no x-org-id) = the exact expected count,
  //    zero South Park.
  const k = await apiGet("/api/providers?pageSize=100", { token: kansasTok });
  const kIds = idsOf(k.body);
  check(
    `1. Kansas view returns exactly ${KANSAS_COUNT}`,
    k.status === 200 && kIds.size === KANSAS_COUNT && k.body?.meta?.total === KANSAS_COUNT,
    `status=${k.status} count=${kIds.size} meta.total=${k.body?.meta?.total}` +
      (k.status !== 200 ? ` body=${(k.raw || "").slice(0, 100)}` : ""),
  );
  check(
    "1b. Kansas view contains no South Park provider id",
    !kIds.has(env.SOUTHPARK_PROVIDER_ID),
    `southParkIdPresent=${kIds.has(env.SOUTHPARK_PROVIDER_ID)}`,
    { leak: true },
  );

  // 2. South Park view (single-org user, no x-org-id) = the exact expected
  //    count, zero Kansas.
  const s = await apiGet("/api/providers?pageSize=100", { token: spTok });
  const sIds = idsOf(s.body);
  check(
    `2. South Park view returns exactly ${SOUTHPARK_COUNT}`,
    s.status === 200 && sIds.size === SOUTHPARK_COUNT && s.body?.meta?.total === SOUTHPARK_COUNT,
    `status=${s.status} count=${sIds.size} meta.total=${s.body?.meta?.total}` +
      (s.status !== 200 ? ` body=${(s.raw || "").slice(0, 100)}` : ""),
  );
  check(
    "2b. South Park view contains no known Kansas provider id",
    !sIds.has(env.KANSAS_PROVIDER_ID),
    `kansasIdPresent=${sIds.has(env.KANSAS_PROVIDER_ID)}`,
    { leak: true },
  );
  const overlap = [...kIds].filter((id) => sIds.has(id));
  check(
    "2c. Kansas and South Park id sets are disjoint",
    overlap.length === 0,
    `overlap=${overlap.length}${overlap.length ? " " + overlap.slice(0, 3).join(",") : ""}`,
    { leak: true },
  );

  // WP1.3 roster mappings and export history are read-only in this gate. The
  // billing member may read its own organization, while all returned mapping
  // metadata and snapshot references stay inside that tenant.
  const kansasMembership = env.KANSAS_ORG
    ? { status: 200, body: { data: [{ orgId: env.KANSAS_ORG }] } }
    : await apiGet("/api/me/orgs", { token: kansasTok });
  const kansasOrgId = kansasMembership.body?.data?.[0]?.orgId;
  const kRosterMappingsResult = await apiGet("/api/rosters/mappings", { token: kansasTok });
  const sRosterMappingsResult = await apiGet("/api/rosters/mappings", { token: spTok });
  const kRosterMappings = rowsOf(kRosterMappingsResult.body);
  const sRosterMappings = rowsOf(sRosterMappingsResult.body);
  check(
    "30. Roster mapping listings contain only each caller's organization",
    Boolean(kansasOrgId) &&
      kRosterMappingsResult.status === 200 &&
      sRosterMappingsResult.status === 200 &&
      kRosterMappings.every((r) => r.orgId === kansasOrgId) &&
      sRosterMappings.every((r) => r.orgId === env.SOUTHPARK_ORG),
    `kansasStatus=${kRosterMappingsResult.status} kansasRows=${kRosterMappings.length} ` +
      `southParkStatus=${sRosterMappingsResult.status} southParkRows=${sRosterMappings.length}`,
    { leak: true },
  );
  const kRosterIds = new Set(kRosterMappings.map((r) => r.id));
  const sRosterIds = new Set(sRosterMappings.map((r) => r.id));
  const sharedRosterIds = [...kRosterIds].filter((id) => sRosterIds.has(id));
  check(
    "31. Kansas and South Park roster mapping id sets are disjoint",
    sharedRosterIds.length === 0,
    `shared=${sharedRosterIds.length}`,
    { leak: true },
  );
  const kRosterHistoryResult = await apiGet("/api/rosters/history", { token: kansasTok });
  const sRosterHistoryResult = await apiGet("/api/rosters/history", { token: spTok });
  const kRosterHistory = rowsOf(kRosterHistoryResult.body);
  const sRosterHistory = rowsOf(sRosterHistoryResult.body);
  const foreignHistoryVisible =
    kRosterHistory.some((snapshot) => sRosterIds.has(snapshot.mappingId)) ||
    sRosterHistory.some((snapshot) => kRosterIds.has(snapshot.mappingId));
  check(
    "32. Roster export history contains no other organization's mapping rows",
    kRosterHistoryResult.status === 200 &&
      sRosterHistoryResult.status === 200 &&
      !foreignHistoryVisible,
    `kansasStatus=${kRosterHistoryResult.status} kansasSnapshots=${kRosterHistory.length} ` +
      `southParkStatus=${sRosterHistoryResult.status} southParkSnapshots=${sRosterHistory.length} ` +
      `foreignMappingVisible=${foreignHistoryVisible}`,
    { leak: true },
  );
  if (env.SOUTHPARK_ROSTER_MAPPING_ID) {
    const crossOrgMapping = await apiGet(
      `/api/rosters/mappings/${encodeURIComponent(env.SOUTHPARK_ROSTER_MAPPING_ID)}`,
      { token: kansasTok },
    );
    check(
      "33. Kansas cannot read a South Park roster mapping by id",
      crossOrgMapping.status === 404,
      `status=${crossOrgMapping.status}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  33. Cross-org roster mapping GET — SOUTHPARK_ROSTER_MAPPING_ID not set");
  }
  if (env.SOUTHPARK_ROSTER_EXPORT_ID) {
    const crossOrgRosterFile = await apiGet(
      `/api/rosters/exports/${encodeURIComponent(env.SOUTHPARK_ROSTER_EXPORT_ID)}/download`,
      { token: kansasTok },
    );
    check(
      "34. Kansas cannot download South Park's stored roster bytes",
      crossOrgRosterFile.status === 404,
      `status=${crossOrgRosterFile.status}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  34. Cross-org roster export download — SOUTHPARK_ROSTER_EXPORT_ID not set");
  }

  // 3. Kansas view: GET a South Park provider by id -> 404, no row leaked.
  const x = await apiGet(`/api/providers/${env.SOUTHPARK_PROVIDER_ID}`, { token: kansasTok });
  const leakedRow = x.status === 200 && x.body?.data?.id === env.SOUTHPARK_PROVIDER_ID;
  check(
    "3. Kansas view GET-by-id on a South Park provider -> 404",
    x.status === 404 && !leakedRow,
    `status=${x.status} leakedRow=${leakedRow}`,
    { leak: true },
  );

  // 4. HEADER-SPOOF (the real one): a Kansas-only user sends x-org-id for South
  //    Park, an org they are NOT a member of. Must be DENIED and must never
  //    return South Park's data.
  const spoof = await apiGet("/api/providers?pageSize=100", {
    token: kansasTok,
    orgId: env.SOUTHPARK_ORG,
  });
  const spoofIds = idsOf(spoof.body);
  const spoofLeakedSP =
    spoofIds.has(env.SOUTHPARK_PROVIDER_ID) ||
    (spoof.status === 200 && spoof.body?.meta?.total === 4);
  check(
    "4. Header-spoof (Kansas-only user, x-org-id=SouthPark) is denied",
    spoof.status === 403 && !spoofLeakedSP,
    `status=${spoof.status} (expect 403) returnedRows=${spoofIds.size} spLeaked=${spoofLeakedSP}`,
    { leak: true },
  );

  // 5. Portal field maps (shared catalog): Kansas sees the global (org NULL)
  //    rows and never another org's org-scoped rows. 5a first proves the
  //    seeded South Park fixture row still exists (its OWN org can see it) —
  //    without that, 5b/5c would pass vacuously against a stale/deleted
  //    fixture. A 5a failure is a fixture error, not a leak: reseed the row
  //    and update SOUTHPARK_FIELDMAP_ID in the workflow env.
  const fm = await apiGet("/api/portal-field-maps", { token: kansasTok });
  const fmRows = fm.body?.data ?? [];
  const fmGlobal = fmRows.filter((r) => r.orgId === null);
  check(
    "5. Kansas field maps return the global catalog",
    fm.status === 200 && fmGlobal.length >= 1,
    `status=${fm.status} rows=${fmRows.length} globalRows=${fmGlobal.length}` +
      (fm.status !== 200 ? ` body=${(fm.raw || "").slice(0, 100)}` : ""),
  );
  const spFm = await apiGet("/api/portal-field-maps", { token: spTok });
  const spFmRows = spFm.body?.data ?? [];
  const fixturePresent = spFmRows.some(
    (r) => r.id === env.SOUTHPARK_FIELDMAP_ID && r.orgId === env.SOUTHPARK_ORG,
  );
  check(
    "5a. South Park sees its own seeded fixture row (5b/5c not vacuous)",
    spFm.status === 200 && fixturePresent,
    `status=${spFm.status} fixturePresent=${fixturePresent}` +
      (fixturePresent ? "" : " (fixture error — reseed + update SOUTHPARK_FIELDMAP_ID)"),
  );
  check(
    "5b. Kansas field maps exclude the seeded South Park row",
    !fmRows.some((r) => r.id === env.SOUTHPARK_FIELDMAP_ID),
    `seededRowPresent=${fmRows.some((r) => r.id === env.SOUTHPARK_FIELDMAP_ID)}`,
    { leak: true },
  );
  check(
    "5c. Kansas field maps contain no South Park org-scoped row",
    !fmRows.some((r) => r.orgId === env.SOUTHPARK_ORG),
    `southParkOrgRows=${fmRows.filter((r) => r.orgId === env.SOUTHPARK_ORG).length}`,
    { leak: true },
  );

  // 6. Provider profile (the PHI-dense endpoint): Kansas asking for a South
  //    Park provider's profile must 404 with no data.
  const prof = await apiGet(`/api/providers/${env.SOUTHPARK_PROVIDER_ID}/profile`, {
    token: kansasTok,
  });
  const profLeaked = prof.body?.data != null;
  check(
    "6. Kansas GET profile of a South Park provider -> 404, no data",
    prof.status === 404 && !profLeaked,
    `status=${prof.status} dataPresent=${profLeaked}`,
    { leak: true },
  );

  // A valid case is echoed on the profile response, while a real Kansas
  // provider paired to another org's case remains an indistinguishable 404.
  // This closes case binding independently from the provider-id boundary 6.
  if (env.KANSAS_CASE_ID) {
    const caseBoundProfile = await apiGet(
      `/api/providers/${env.KANSAS_PROVIDER_ID}/profile?case_id=${encodeURIComponent(env.KANSAS_CASE_ID)}`,
      { token: kansasTok },
    );
    check(
      "6a. Kansas profile echoes the authorized case_id",
      caseBoundProfile.status === 200 &&
        caseBoundProfile.body?.data?.case_id === env.KANSAS_CASE_ID,
      `status=${caseBoundProfile.status} caseId=${caseBoundProfile.body?.data?.case_id ?? "null"}`,
    );
  } else {
    console.log("SKIP  6a. Kansas profile case binding — KANSAS_CASE_ID not set");
  }

  const foreignCaseProfile = await apiGet(
    `/api/providers/${env.KANSAS_PROVIDER_ID}/profile?case_id=${encodeURIComponent(env.SOUTHPARK_CASE_ID)}`,
    { token: kansasTok },
  );
  check(
    "6b. Kansas profile paired with a South Park case -> 404, no data",
    foreignCaseProfile.status === 404 && foreignCaseProfile.body?.data == null,
    `status=${foreignCaseProfile.status} dataPresent=${foreignCaseProfile.body?.data != null}`,
    { leak: true },
  );

  // 7. Fill events (the one POST — a payload the server must REJECT): Kansas
  //    posting a South Park provider/case must 404 before anything is written.
  //    The repeat POST with the same idempotency id is the observable
  //    follow-up: had the first call inserted before rejecting, an
  //    idempotency-first implementation would return the stored row (200) on
  //    the replay. The deterministic reject-before-insert proof lives in the
  //    unit tests (no insert call on a rejected event); fill_sessions row
  //    count can additionally be checked out-of-band after a run.
  const fillPayload = {
    id: crypto.randomUUID(),
    caseId: env.SOUTHPARK_CASE_ID,
    providerId: env.SOUTHPARK_PROVIDER_ID,
    portalKey: "gate_must_reject",
    fillMode: "web",
    fieldsFilled: 0,
  };
  const fill = await apiPost("/api/fill-events", fillPayload, { token: kansasTok });
  const fillLeaked = fill.status < 400 || fill.body?.data != null;
  check(
    "7. Kansas POST fill-event for South Park case/provider is rejected",
    fill.status === 404 && !fillLeaked,
    `status=${fill.status} (expect 404) dataPresent=${fill.body?.data != null}`,
    { leak: true },
  );
  const fillReplay = await apiPost("/api/fill-events", fillPayload, { token: kansasTok });
  check(
    "7b. Replaying the rejected fill-event still rejects (nothing was stored)",
    fillReplay.status === 404 && fillReplay.body?.data == null,
    `status=${fillReplay.status} dataPresent=${fillReplay.body?.data != null}`,
    { leak: true },
  );

  // MINT-58 extends this endpoint with an exact Work v2 tuple. The local
  // contract mock proves both tuple organization and owner are checked before
  // the fill idempotency lookup. These requests carry no PHI or valid fill
  // receipt and are only sent to the in-process mock.
  if (IS_LOCAL_MOCK_API) {
    const typedCaseContext = (orgId, ownerId) => ({
      launchReceiptId: crypto.randomUUID(),
      orgId,
      ownerKind: "case",
      ownerId,
      contextVersion: 1,
      sopTemplateId: env.KANSAS_WORK_TEMPLATE_ID,
      sopVersion: 3,
      portalId: env.KANSAS_WORK_PORTAL_ID,
      portalKey: env.KANSAS_WORK_PORTAL_KEY,
      mappingGeneration: 2,
      effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
      providerId: env.SOUTHPARK_PROVIDER_ID,
      facilityId: null,
      stepIdentity: `${ownerId}:${env.SOUTHPARK_TASK_ID}:${env.KANSAS_WORK_TEMPLATE_ID}:3:${env.KANSAS_WORK_STEP_ID}`,
      taskId: env.SOUTHPARK_TASK_ID,
      stepId: env.KANSAS_WORK_STEP_ID,
    });
    const typedWrongOrgFill = await apiPost(
      "/api/fill-events",
      {
        id: crypto.randomUUID(),
        workContext: typedCaseContext(env.SOUTHPARK_ORG, env.SOUTHPARK_CASE_ID),
      },
      { token: kansasTok },
    );
    check(
      "7c. Typed Work fill with a foreign org selector is rejected before idempotency",
      typedWrongOrgFill.status === 404 && typedWrongOrgFill.body?.data == null,
      `status=${typedWrongOrgFill.status} dataPresent=${typedWrongOrgFill.body?.data != null}`,
      { leak: true },
    );
    const kansasOrgForWork =
      env.KANSAS_ORG ?? (await apiGet("/api/me/orgs", { token: kansasTok })).body?.data?.[0]?.orgId;
    const typedWrongOwnerFill = await apiPost(
      "/api/fill-events",
      {
        id: crypto.randomUUID(),
        workContext: typedCaseContext(kansasOrgForWork, env.SOUTHPARK_CASE_ID),
      },
      { token: kansasTok },
    );
    check(
      "7d. Typed Work fill with an own-org selector and foreign owner is rejected",
      Boolean(kansasOrgForWork) &&
        typedWrongOwnerFill.status === 404 &&
        typedWrongOwnerFill.body?.data == null,
      `status=${typedWrongOwnerFill.status} orgResolved=${Boolean(kansasOrgForWork)} dataPresent=${typedWrongOwnerFill.body?.data != null}`,
      { leak: true },
    );
  }

  // 8. Cases dropdown endpoint: Kansas listing its own provider's open cases
  //    works (proves 8b isn't vacuous against a dead route)...
  const ownCases = await apiGet(`/api/cases?providerId=${env.KANSAS_PROVIDER_ID}`, {
    token: kansasTok,
  });
  check(
    "8. Kansas lists own provider's open cases",
    ownCases.status === 200 && Array.isArray(ownCases.body?.data),
    `status=${ownCases.status} rows=${(ownCases.body?.data ?? []).length}` +
      (ownCases.status !== 200 ? ` body=${(ownCases.raw || "").slice(0, 100)}` : ""),
  );
  //    ...and asking for a South Park provider's cases must 404 with no rows.
  const xCases = await apiGet(`/api/cases?providerId=${env.SOUTHPARK_PROVIDER_ID}`, {
    token: kansasTok,
  });
  const casesLeaked = xCases.body?.data != null;
  check(
    "8b. Kansas GET cases of a South Park provider -> 404, no rows",
    xCases.status === 404 && !casesLeaked,
    `status=${xCases.status} dataPresent=${casesLeaked}`,
    { leak: true },
  );
  // 8c. portalTasks (Phase 4 SOP↔portal link) rides the dropdown row: the
  //     extension matches the page portal_key to these to close a task. Every
  //     own-cases row must carry a portalTasks array and none may reference a
  //     cross-org task id. Shape/positive check — non-vacuous against the mock
  //     (Kansas fixture carries one), vacuously true against a not-yet-populated
  //     prod; the leak half is 8d.
  const ownCaseRows = ownCases.body?.data ?? [];
  const ownTaskIds = ownCaseRows.flatMap((c) => (c?.portalTasks ?? []).map((t) => t?.taskId));
  check(
    "8c. Kansas own cases expose portalTasks referencing only own-org tasks",
    ownCases.status === 200 &&
      ownCaseRows.every((c) => Array.isArray(c?.portalTasks)) &&
      !ownTaskIds.includes(env.SOUTHPARK_TASK_ID),
    `rows=${ownCaseRows.length} ownTaskIds=${JSON.stringify(ownTaskIds)}`,
  );
  // 8d. The cross-org request must never leak a South Park task id via
  //     portalTasks. Rides the same 404 as 8b (no rows -> no portalTasks); a
  //     leaked case list carries the cross-org task ids, which this catches.
  const xTaskIds = (xCases.body?.data ?? []).flatMap((c) =>
    (c?.portalTasks ?? []).map((t) => t?.taskId),
  );
  check(
    "8d. Kansas GET cross-org cases never leaks a South Park task id via portalTasks",
    !xTaskIds.includes(env.SOUTHPARK_TASK_ID),
    `xTaskIds=${JSON.stringify(xTaskIds)}`,
    { leak: true },
  );

  // 9. Submission touches (the second must-reject POST): Kansas posting a
  //    touch on a South Park case must 404 before anything is written. Like
  //    assertion 7, the replay with the same idempotency id is the observable
  //    nothing-was-written follow-up: had the first call inserted before
  //    rejecting, the replay would return the stored row (200) instead.
  const touchPayload = {
    kind: "portal_submission",
    portal_key: "gate_must_reject",
    idempotency_id: crypto.randomUUID(),
  };
  const touch = await apiPost(`/api/cases/${env.SOUTHPARK_CASE_ID}/touches`, touchPayload, {
    token: kansasTok,
  });
  const touchLeaked = touch.status < 400 || touch.body?.data != null;
  check(
    "9. Kansas POST touch on a South Park case is rejected",
    touch.status === 404 && !touchLeaked,
    `status=${touch.status} (expect 404) dataPresent=${touch.body?.data != null}`,
    { leak: true },
  );
  const touchReplay = await apiPost(`/api/cases/${env.SOUTHPARK_CASE_ID}/touches`, touchPayload, {
    token: kansasTok,
  });
  check(
    "9b. Replaying the rejected touch still rejects (nothing was written)",
    touchReplay.status === 404 && touchReplay.body?.data == null,
    `status=${touchReplay.status} dataPresent=${touchReplay.body?.data != null}`,
    { leak: true },
  );

  if (IS_LOCAL_MOCK_API) {
    const kansasOrgForWork =
      env.KANSAS_ORG ?? (await apiGet("/api/me/orgs", { token: kansasTok })).body?.data?.[0]?.orgId;
    const typedTouchContext = (orgId, ownerId) => ({
      launchReceiptId: crypto.randomUUID(),
      orgId,
      ownerKind: "case",
      ownerId,
      contextVersion: 1,
      sopTemplateId: env.KANSAS_WORK_TEMPLATE_ID,
      sopVersion: 3,
      portalId: env.KANSAS_WORK_PORTAL_ID,
      portalKey: env.KANSAS_WORK_PORTAL_KEY,
      mappingGeneration: 2,
      effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
      providerId: env.SOUTHPARK_PROVIDER_ID,
      facilityId: null,
      stepIdentity: `${ownerId}:${env.SOUTHPARK_TASK_ID}:${env.KANSAS_WORK_TEMPLATE_ID}:3:${env.KANSAS_WORK_STEP_ID}`,
      taskId: env.SOUTHPARK_TASK_ID,
      stepId: env.KANSAS_WORK_STEP_ID,
    });
    const typedTouchWrongOrg = await apiPost(
      `/api/cases/${env.KANSAS_CASE_ID}/touches`,
      {
        kind: "portal_submission",
        portal_key: env.KANSAS_WORK_PORTAL_KEY,
        fill_session_id: crypto.randomUUID(),
        idempotency_id: crypto.randomUUID(),
        work_context: typedTouchContext(env.SOUTHPARK_ORG, env.SOUTHPARK_CASE_ID),
      },
      { token: kansasTok },
    );
    check(
      "9c. Typed submission with a foreign org selector is rejected before idempotency",
      typedTouchWrongOrg.status === 404 && typedTouchWrongOrg.body?.data == null,
      `status=${typedTouchWrongOrg.status} dataPresent=${typedTouchWrongOrg.body?.data != null}`,
      { leak: true },
    );
    const typedTouchWrongOwner = await apiPost(
      `/api/cases/${env.KANSAS_CASE_ID}/touches`,
      {
        kind: "portal_submission",
        portal_key: env.KANSAS_WORK_PORTAL_KEY,
        fill_session_id: crypto.randomUUID(),
        idempotency_id: crypto.randomUUID(),
        work_context: typedTouchContext(kansasOrgForWork, env.SOUTHPARK_CASE_ID),
      },
      { token: kansasTok },
    );
    check(
      "9d. Typed submission with an own-org selector and foreign owner is rejected",
      Boolean(kansasOrgForWork) &&
        typedTouchWrongOwner.status === 404 &&
        typedTouchWrongOwner.body?.data == null,
      `status=${typedTouchWrongOwner.status} orgResolved=${Boolean(kansasOrgForWork)} dataPresent=${typedTouchWrongOwner.body?.data != null}`,
      { leak: true },
    );
  }

  // 10. Org discovery (GET /api/me/orgs): the caller's OWN memberships only,
  //     derived from the JWT user id — no org header involved. testkansas is
  //     a Kansas-only fixture user, so exactly one row with the endpoint's
  //     three columns; a different count is fixture drift, while 10b is the
  //     leak half: the South Park org must never appear in Kansas's response.
  const kOrgs = await apiGet("/api/me/orgs", { token: kansasTok });
  const kOrgRows = kOrgs.body?.data ?? [];
  const kOrgShapeOk =
    kOrgRows.length === 1 &&
    typeof kOrgRows[0]?.orgId === "string" &&
    typeof kOrgRows[0]?.orgName === "string" &&
    typeof kOrgRows[0]?.role === "string";
  check(
    "10. Kansas /api/me/orgs returns exactly the caller's own membership",
    kOrgs.status === 200 && kOrgShapeOk,
    `status=${kOrgs.status} rows=${kOrgRows.length}` +
      (kOrgs.status !== 200 ? ` body=${(kOrgs.raw || "").slice(0, 100)}` : ""),
  );
  const spOrgLeaked = kOrgRows.some((r) => r?.orgId === env.SOUTHPARK_ORG);
  check(
    "10b. Kansas /api/me/orgs never contains the South Park org",
    !spOrgLeaked,
    `southParkOrgPresent=${spOrgLeaked}`,
    { leak: true },
  );

  // 30. E6.12 pre-shell access context: discovery must be scoped to the
  // verified actor before the shell mounts. Staff discovery deliberately leaves
  // selectedOrgId null; the explicit POST selection below chooses the org.
  const kAccess = await apiGet("/api/me/access-context", { token: kansasTok });
  const kAccessData = kAccess.body?.data ?? null;
  const kAccessOrgs = Array.isArray(kAccessData?.staffOrgs) ? kAccessData.staffOrgs : [];
  const kOrgId = kOrgRows[0]?.orgId ?? null;
  check(
    "30. Kansas access context resolves with a revision and unselected staff discovery",
    kAccess.status === 200 &&
      typeof kAccessData?.actorUserId === "string" &&
      typeof kAccessData?.contextRevision === "string" &&
      kOrgId != null &&
      kAccessData.selectedOrgId == null &&
      kAccessOrgs.some((row) => row?.orgId === kOrgId),
    `status=${kAccess.status} selectedOrg=${kAccessData?.selectedOrgId ?? "null"} ` +
      `revision=${typeof kAccessData?.contextRevision === "string"}`,
  );
  const accessForeignLeak = kAccessOrgs.some((row) => row?.orgId === env.SOUTHPARK_ORG);
  check(
    "30b. Kansas access context never contains a South Park org",
    !accessForeignLeak,
    `southParkOrgPresent=${accessForeignLeak}`,
    { leak: true },
  );

  // Local-only synthetic dispatcher checks for the E6.13 explicit audience
  // boundary. Hosted database authorization is covered by the disposable
  // native verifier; these assertions keep the app route boundary in the
  // existing mock-and-run matrix without requiring hosted fixture writes.
  if (env.E613_VERIFY === "1") {
    const selectedHeaders = {
      "x-enrollment-audience": "staff",
      "x-minted-context-revision": kAccessData?.contextRevision ?? "",
    };
    const e613Own = await apiGet("/api/enrollment-explorer/catalog", {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
      extraHeaders: selectedHeaders,
    });
    check(
      "31. E6.13 own-org explicit staff catalog is reachable",
      e613Own.status === 200 && Array.isArray(e613Own.body?.data?.products),
      `status=${e613Own.status}`,
    );
    const e613NoAudience = await apiGet("/api/enrollment-explorer/catalog", {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
      extraHeaders: { "x-minted-context-revision": selectedHeaders["x-minted-context-revision"] },
    });
    check(
      "31b. E6.13 requires an explicit audience",
      e613NoAudience.status === 400,
      `status=${e613NoAudience.status}`,
    );
    const e613CrossOrg = await apiGet("/api/enrollment-explorer/catalog", {
      token: kansasTok,
      orgId: env.SOUTHPARK_ORG,
      extraHeaders: selectedHeaders,
    });
    check(
      "31c. E6.13 selected org must be in the verified actor scope",
      e613CrossOrg.status === 403 && e613CrossOrg.body?.data == null,
      `status=${e613CrossOrg.status} dataPresent=${e613CrossOrg.body?.data != null}`,
      { leak: true },
    );
    const e613ClientAudience = await apiGet("/api/enrollment-explorer/catalog", {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
      extraHeaders: {
        "x-enrollment-audience": "client",
        "x-minted-context-revision": selectedHeaders["x-minted-context-revision"],
      },
    });
    check(
      "31d. E6.13 does not infer client capability from a staff session",
      e613ClientAudience.status === 403 && e613ClientAudience.body?.data == null,
      `status=${e613ClientAudience.status} dataPresent=${e613ClientAudience.body?.data != null}`,
    );

    const e614Page = await apiGet("/api/enrollment-explorer/report/page", {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
      extraHeaders: selectedHeaders,
    });
    check(
      "32. E6.14 own-org report page returns its restricted DTO",
      e614Page.status === 200 &&
        e614Page.body?.data?.accessState === "ready" &&
        typeof e614Page.body?.data?.viewToken === "string" &&
        Array.isArray(e614Page.body?.data?.providers),
      `status=${e614Page.status} accessState=${e614Page.body?.data?.accessState ?? "missing"}`,
    );
    const e614History = await apiGet(
      `/api/enrollment-explorer/scopes/${env.KANSAS_PROVIDER_ID}/history`,
      { token: kansasTok, orgId: env.KANSAS_ORG, extraHeaders: selectedHeaders },
    );
    check(
      "32b. E6.14 own-org history is paged through the authenticated route",
      e614History.status === 200 &&
        e614History.body?.data?.audience === "staff" &&
        e614History.body?.data?.scopeId === env.KANSAS_PROVIDER_ID &&
        Array.isArray(e614History.body?.data?.items),
      `status=${e614History.status}`,
    );
    const e614Csv = await apiGet(
      "/api/enrollment-explorer/report.csv?viewToken=mock-e614-view-token",
      {
        token: kansasTok,
        orgId: env.KANSAS_ORG,
        extraHeaders: selectedHeaders,
      },
    );
    check(
      "32c. E6.14 CSV uses a no-store text/csv response",
      e614Csv.status === 200 &&
        e614Csv.contentType === "text/csv; charset=utf-8" &&
        e614Csv.cacheControl?.includes("no-store") &&
        e614Csv.raw.startsWith('"Provider Name","NPI","Discipline"'),
      `status=${e614Csv.status} contentType=${e614Csv.contentType ?? "missing"} cache=${e614Csv.cacheControl ?? "missing"}`,
    );
    const e614CrossOrg = await apiGet(
      `/api/enrollment-explorer/report/page?org=${encodeURIComponent(env.SOUTHPARK_ORG)}`,
      { token: kansasTok, orgId: env.KANSAS_ORG, extraHeaders: selectedHeaders },
    );
    check(
      "32d. E6.14 rejects URL organization mismatch before report data",
      e614CrossOrg.status === 403 && e614CrossOrg.body?.data == null,
      `status=${e614CrossOrg.status} dataPresent=${e614CrossOrg.body?.data != null}`,
      { leak: true },
    );
    const e614ClientAudience = await apiGet("/api/enrollment-explorer/report/page", {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
      extraHeaders: {
        "x-enrollment-audience": "client",
        "x-minted-context-revision": selectedHeaders["x-minted-context-revision"],
      },
    });
    check(
      "32e. E6.14 does not infer client capability from staff context",
      e614ClientAudience.status === 403 && e614ClientAudience.body?.data == null,
      `status=${e614ClientAudience.status} dataPresent=${e614ClientAudience.body?.data != null}`,
    );
  }

  // 30c/30d pin the actor and stale-revision request rules. The actor query
  // must be rejected before any context data is returned, and a stale chooser
  // request must not select an org under an old authority snapshot.
  const forgedAccess = await apiGet("/api/me/access-context?actorUserId=other-user", {
    token: kansasTok,
  });
  check(
    "30c. Access context rejects a forged actor query without data",
    forgedAccess.status === 400 && forgedAccess.body?.data == null,
    `status=${forgedAccess.status} dataPresent=${forgedAccess.body?.data != null}`,
    { leak: true },
  );
  const staleAccess = await apiPost(
    "/api/me/access-context/select",
    { audience: "staff", orgId: kOrgId, contextRevision: "stale-context-revision" },
    { token: kansasTok },
  );
  check(
    "30d. Access context rejects a stale selection revision",
    staleAccess.status === 409 && staleAccess.body?.data == null,
    `status=${staleAccess.status} dataPresent=${staleAccess.body?.data != null}`,
    { leak: true },
  );
  if (kAccess.status === 200 && typeof kAccessData?.contextRevision === "string") {
    const selectedAccess = await apiPost(
      "/api/me/access-context/select",
      {
        audience: "staff",
        orgId: kOrgId,
        contextRevision: kAccessData.contextRevision,
      },
      { token: kansasTok },
    );
    check(
      "30e. Access context accepts a current staff selection",
      selectedAccess.status === 200 &&
        selectedAccess.body?.data?.selectedOrgId === kOrgId &&
        typeof selectedAccess.body?.data?.contextRevision === "string",
      `status=${selectedAccess.status} selectedOrg=${selectedAccess.body?.data?.selectedOrgId ?? "null"}`,
    );
  } else {
    console.log("SKIP  30e. current access-context selection — initial context unavailable");
  }

  // 11. Facility awareness on the profile endpoint: a Kansas provider's
  //     profile requested with a South Park facilityId must 404 with no data
  //     — facility.* tokens must never resolve from another org's facility.
  const xFac = await apiGet(
    `/api/providers/${env.KANSAS_PROVIDER_ID}/profile?facilityId=${env.SOUTHPARK_FACILITY_ID}`,
    { token: kansasTok },
  );
  const facLeaked = xFac.status < 400 || xFac.body?.data != null;
  check(
    "11. Kansas GET own profile with a South Park facilityId -> 404, no data",
    xFac.status === 404 && !facLeaked,
    `status=${xFac.status} (expect 404) dataPresent=${xFac.body?.data != null}`,
    { leak: true },
  );

  // 12. Provider WRITE isolation (the PATCH must-reject): a Kansas writer
  //     PATCHing a South Park provider by id must 404 like the GET-by-id
  //     (assertion 3) — never 200, never a cross-org write. This is safe to
  //     run against production because a cross-org id is rejected BEFORE any
  //     write (getProvider -> null -> 404), so nothing is mutated.
  //
  //     POST /api/providers is deliberately NOT asserted here: a real create
  //     would insert a live Kansas provider and drift the
  //     EXPECTED_KANSAS_PROVIDERS count that assertions 1/2 pin. POST
  //     org-scoping (body org_id stripped, row lands in the caller's org and is
  //     invisible cross-org) is covered by the mock (scripts/mock-api-server.mjs)
  //     and the handler unit tests instead.
  const patchX = await apiPatch(
    `/api/providers/${env.SOUTHPARK_PROVIDER_ID}`,
    { firstName: "GateShouldReject" },
    { token: kansasTok },
  );
  const patchLeaked = patchX.status < 400 || patchX.body?.data != null;
  check(
    "12. Kansas PATCH a South Park provider -> 404, no cross-org write",
    patchX.status === 404 && !patchLeaked,
    `status=${patchX.status} (expect 404) dataPresent=${patchX.body?.data != null}`,
    { leak: true },
  );

  // 13. Submission-touch task-ownership isolation (PR C, Story 7): a Kansas
  //     writer posting a touch on their OWN case but naming a South Park
  //     task_id must 404 "Task not found" BEFORE any write — the task close is
  //     the extension's only cross-org write surface added by the touchlog
  //     bridge. Safe against production: the task check runs before the anchor
  //     insert, so nothing lands on the real Kansas case. Optional — skipped
  //     unless both fixtures are configured (KANSAS_CASE_ID + SOUTHPARK_TASK_ID);
  //     the in-sandbox mock run always sets them.
  if (env.KANSAS_CASE_ID && env.SOUTHPARK_TASK_ID) {
    const taskSpoof = {
      kind: "portal_submission",
      portal_key: "gate_must_reject",
      idempotency_id: crypto.randomUUID(),
      task_id: env.SOUTHPARK_TASK_ID,
    };
    const t13 = await apiPost(`/api/cases/${env.KANSAS_CASE_ID}/touches`, taskSpoof, {
      token: kansasTok,
    });
    const t13Leaked = t13.status < 400 || t13.body?.data != null;
    check(
      "13. Kansas POST touch with a South Park task_id is rejected before any write",
      t13.status === 404 && !t13Leaked,
      `status=${t13.status} (expect 404) dataPresent=${t13.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  13. task-ownership isolation — KANSAS_CASE_ID / SOUTHPARK_TASK_ID not set");
  }

  // 14. Case context endpoint (P8): the Workbench reads a case's reference
  //     number(s) + latest note/touch + (E1.4) full location set after
  //     selection. Kansas reading its OWN case context works (proves 14b
  //     isn't vacuous against a dead route — conditional on KANSAS_CASE_ID,
  //     which the in-sandbox mock run always sets)...
  if (env.KANSAS_CASE_ID) {
    const ownCtx = await apiGet(`/api/cases/${env.KANSAS_CASE_ID}/context`, { token: kansasTok });
    check(
      "14. Kansas reads its own case context",
      ownCtx.status === 200 &&
        ownCtx.body?.data != null &&
        Array.isArray(ownCtx.body.data.referenceNumbers) &&
        // E1.4 — the case's full location set rides the same projection.
        Array.isArray(ownCtx.body.data.facilities),
      `status=${ownCtx.status}` +
        (ownCtx.status !== 200 ? ` body=${(ownCtx.raw || "").slice(0, 100)}` : ""),
    );
  } else {
    console.log("SKIP  14. own case context — KANSAS_CASE_ID not set");
  }
  //     ...and reading a South Park case's context must 404 with no data —
  //     which by construction means South Park's `facilities[]` (E1.4) can
  //     never ride along either: the whole payload, not just selectedFacility,
  //     is withheld before any location row is read.
  const xCtx = await apiGet(`/api/cases/${env.SOUTHPARK_CASE_ID}/context`, { token: kansasTok });
  const ctxLeaked = xCtx.status < 400 || xCtx.body?.data != null;
  check(
    "14b. Kansas GET context of a South Park case -> 404, no data (incl. facilities[])",
    xCtx.status === 404 && !ctxLeaked,
    `status=${xCtx.status} (expect 404) dataPresent=${xCtx.body?.data != null}`,
    { leak: true },
  );

  // 14c/14d — Contract owner context is an independent org-scoped read. The
  // direct form-context route returns exact SOP/step identifiers only; the
  // provider profile accepts the same owner binding but must not let a Kansas
  // provider name a South Park Contract. Optional for hosted runs until the
  // operator seeds and pins both Contract fixtures; always set by the mock.
  if (env.KANSAS_CONTRACT_ID && env.SOUTHPARK_CONTRACT_ID) {
    const ownContractContext = await apiGet(
      `/api/contracts/${env.KANSAS_CONTRACT_ID}/form-context`,
      { token: kansasTok },
    );
    check(
      "14c. Kansas reads its own assigned Contract SOP context",
      ownContractContext.status === 200 &&
        ownContractContext.cacheControl?.includes("no-store") &&
        ownContractContext.body?.data?.contract?.id === env.KANSAS_CONTRACT_ID &&
        ownContractContext.body?.data?.sop?.caseType === "contract" &&
        ownContractContext.body?.data?.steps?.length === 1 &&
        typeof ownContractContext.body.data.steps[0]?.stepIdentity === "string",
      `status=${ownContractContext.status} contractId=${ownContractContext.body?.data?.contract?.id ?? "missing"}`,
    );

    const foreignContractContext = await apiGet(
      `/api/contracts/${env.SOUTHPARK_CONTRACT_ID}/form-context`,
      { token: kansasTok },
    );
    check(
      "14d. Kansas cannot read a South Park Contract SOP context",
      foreignContractContext.status === 404 && foreignContractContext.body?.data == null,
      `status=${foreignContractContext.status} dataPresent=${foreignContractContext.body?.data != null}`,
      { leak: true },
    );

    const ownContractProfile = await apiGet(
      `/api/providers/${env.KANSAS_PROVIDER_ID}/profile?contract_id=${encodeURIComponent(env.KANSAS_CONTRACT_ID)}`,
      { token: kansasTok },
    );
    check(
      "6c. Kansas Contract profile echoes only its own Contract owner binding",
      ownContractProfile.status === 200 &&
        ownContractProfile.body?.data?.contract_context?.contract_id === env.KANSAS_CONTRACT_ID,
      `status=${ownContractProfile.status} contractId=${ownContractProfile.body?.data?.contract_context?.contract_id ?? "missing"}`,
    );

    const foreignContractProfile = await apiGet(
      `/api/providers/${env.KANSAS_PROVIDER_ID}/profile?contract_id=${encodeURIComponent(env.SOUTHPARK_CONTRACT_ID)}`,
      { token: kansasTok },
    );
    check(
      "6d. Kansas profile cannot pair an own provider with a South Park Contract",
      foreignContractProfile.status === 404 && foreignContractProfile.body?.data == null,
      `status=${foreignContractProfile.status} dataPresent=${foreignContractProfile.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  14c/14d/6c/6d. Contract context — Contract fixture IDs not set");
  }

  // MINT-56 exact Work validation contract. The positive case and Contract
  // fixtures are synthetic and run only against the local mock.
  const workCaseRequest = {
    protocolVersion: 2,
    launchReceiptId: "b7a90000-0000-4000-a000-0000000000e2",
    orgId: env.KANSAS_ORG,
    ownerKind: "case",
    ownerId: env.KANSAS_CASE_ID,
    contextVersion: 4,
    sopTemplateId: env.KANSAS_WORK_TEMPLATE_ID ?? "b7a90000-0000-4000-a000-0000000000d3",
    sopVersion: 3,
    portalId: env.KANSAS_WORK_PORTAL_ID ?? "b7a90000-0000-4000-a000-0000000000d4",
    portalKey: env.KANSAS_WORK_PORTAL_KEY ?? "bcbs_ks_enrollment_explicit",
    mappingGeneration: 2,
    effectiveMappingFingerprint: env.KANSAS_WORK_FINGERPRINT ?? "sha256:kansas-explicit-v1",
    providerId: env.KANSAS_PROVIDER_ID,
    facilityId: env.KANSAS_FACILITY_ID ?? "5f190f0d-2c5c-49f7-8953-aa05cd0a9d64",
    stepIdentity: [
      env.KANSAS_CASE_ID,
      env.KANSAS_WORK_TASK_ID ?? "b7a90000-0000-4000-a000-0000000000d1",
      env.KANSAS_WORK_TEMPLATE_ID ?? "b7a90000-0000-4000-a000-0000000000d3",
      3,
      env.KANSAS_WORK_STEP_ID ?? "b7a90000-0000-4000-a000-0000000000d2",
    ].join(":"),
    taskId: env.KANSAS_WORK_TASK_ID ?? "b7a90000-0000-4000-a000-0000000000d1",
    stepId: env.KANSAS_WORK_STEP_ID ?? "b7a90000-0000-4000-a000-0000000000d2",
  };
  const workContractRequest = {
    protocolVersion: 2,
    launchReceiptId: "b7a90000-0000-4000-a000-0000000000e3",
    orgId: env.KANSAS_ORG,
    ownerKind: "contract",
    ownerId: env.KANSAS_CONTRACT_ID,
    contextVersion: 2,
    sopTemplateId: env.KANSAS_CONTRACT_TEMPLATE_ID ?? "b7a90000-0000-4000-a000-0000000000c4",
    sopVersion: 3,
    portalId: env.KANSAS_CONTRACT_PORTAL_ID ?? "b7a90000-0000-4000-a000-0000000000d7",
    portalKey: env.KANSAS_CONTRACT_PORTAL_KEY ?? "kansas_contract_application",
    mappingGeneration: 1,
    effectiveMappingFingerprint: env.KANSAS_CONTRACT_FINGERPRINT ?? "sha256:kansas-contract-v1",
    providerId: env.KANSAS_PROVIDER_ID,
    facilityId: null,
    stepIdentity: [
      env.KANSAS_CONTRACT_ID,
      env.KANSAS_ORG,
      env.KANSAS_CONTRACT_ASSIGNMENT_ID ?? "b7a90000-0000-4000-a000-0000000000c3",
      2,
      env.KANSAS_CONTRACT_TEMPLATE_ID ?? "b7a90000-0000-4000-a000-0000000000c4",
      3,
      0,
      0,
    ].join(":"),
    assignmentId: env.KANSAS_CONTRACT_ASSIGNMENT_ID ?? "b7a90000-0000-4000-a000-0000000000c3",
    taskIndex: 0,
    stepIndex: 0,
  };
  if (IS_LOCAL_MOCK_API) {
    const exactCase = await apiPost("/api/work-context/validate", workCaseRequest, {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
    });
    const expectedCaseTuple = { ...workCaseRequest };
    delete expectedCaseTuple.protocolVersion;
    const caseTuple = exactCase.body?.data?.tuple;
    const caseTupleMatches =
      caseTuple &&
      Object.keys(expectedCaseTuple).length === Object.keys(caseTuple).length &&
      Object.entries(expectedCaseTuple).every(([key, value]) => caseTuple[key] === value);
    check(
      "14e. Exact case Work validation returns the canonical tuple and safe config",
      exactCase.status === 200 &&
        exactCase.cacheControl?.includes("no-store") &&
        caseTupleMatches &&
        exactCase.body?.data?.caseType === "enrollment" &&
        exactCase.body?.data?.formUrl === "https://example.test/bcbs/enroll" &&
        exactCase.body?.data?.requiresExplicitSelection === true &&
        exactCase.body?.data?.effectiveWebMaps?.length > 0,
      `status=${exactCase.status} tupleMatches=${Boolean(caseTupleMatches)} noStore=${exactCase.cacheControl?.includes("no-store")}`,
    );

    const exactContract = await apiPost("/api/work-context/validate", workContractRequest, {
      token: kansasTok,
      orgId: env.KANSAS_ORG,
    });
    const expectedContractTuple = { ...workContractRequest };
    delete expectedContractTuple.protocolVersion;
    const contractTuple = exactContract.body?.data?.tuple;
    const contractTupleMatches =
      contractTuple &&
      Object.keys(expectedContractTuple).length === Object.keys(contractTuple).length &&
      Object.entries(expectedContractTuple).every(([key, value]) => contractTuple[key] === value);
    check(
      "14f. Exact Contract Work validation returns the canonical tuple and safe config",
      exactContract.status === 200 &&
        exactContract.cacheControl?.includes("no-store") &&
        contractTupleMatches &&
        exactContract.body?.data?.caseType === "contract" &&
        exactContract.body?.data?.formUrl === "https://example.test/bcbs/enroll" &&
        exactContract.body?.data?.requiresExplicitSelection === true &&
        exactContract.body?.data?.effectiveWebMaps?.length > 0,
      `status=${exactContract.status} tupleMatches=${Boolean(contractTupleMatches)} noStore=${exactContract.cacheControl?.includes("no-store")}`,
    );
  }

  if (IS_LOCAL_MOCK_API) {
    const foreignWorkOwner = await apiPost(
      "/api/work-context/validate",
      {
        ...workCaseRequest,
        ownerId: env.SOUTHPARK_CASE_ID,
        providerId: env.SOUTHPARK_PROVIDER_ID,
        facilityId: env.SOUTHPARK_FACILITY_ID,
        stepIdentity: "foreign-owner-probe",
      },
      { token: kansasTok, orgId: env.KANSAS_ORG },
    );
    check(
      "14g. Kansas cannot validate a South Park Work owner",
      foreignWorkOwner.status === 404 &&
        foreignWorkOwner.body?.data == null &&
        foreignWorkOwner.cacheControl?.includes("no-store"),
      `status=${foreignWorkOwner.status} dataPresent=${foreignWorkOwner.body?.data != null} noStore=${foreignWorkOwner.cacheControl?.includes("no-store")}`,
      { leak: true },
    );

    const workUrlSpoof = await apiPost(
      "/api/work-context/validate",
      { ...workCaseRequest, portalUrl: "https://example.test/bcbs/enroll" },
      { token: kansasTok, orgId: env.KANSAS_ORG },
    );
    check(
      "14h. Work validator rejects a caller-supplied portal URL",
      workUrlSpoof.status === 422 &&
        workUrlSpoof.body?.data == null &&
        workUrlSpoof.cacheControl?.includes("no-store"),
      `status=${workUrlSpoof.status} dataPresent=${workUrlSpoof.body?.data != null} noStore=${workUrlSpoof.cacheControl?.includes("no-store")}`,
    );
  }

  // 15. Case search (E4.3 TE-11): the extension's standalone case half. Kansas
  //     searching its own cases works (proves 15b isn't vacuous against a dead
  //     route)...
  const search = await apiGet(`/api/cases?q=${encodeURIComponent(env.SEARCH_QUERY ?? "a")}`, {
    token: kansasTok,
  });
  check(
    "15. Kansas case search returns 200 with a rows array",
    search.status === 200 && Array.isArray(search.body?.data),
    `status=${search.status} rows=${(search.body?.data ?? []).length}` +
      (search.status !== 200 ? ` body=${(search.raw || "").slice(0, 100)}` : ""),
  );
  // 15b. ...and a search that would surface a South Park case under a leak must
  //      never return that case's id or its provider's id. Org-scoped in
  //      production (Kansas only ever sees Kansas cases, so the ids never
  //      appear for any query); the leak mode makes it red. The search returns
  //      only its first meta.limit rows (default 5), so a leaked case can sit
  //      past the rows checked by id: SEARCH_LEAK_QUERY matches no Kansas case,
  //      and meta.total (every match, not only the rows sent) must be 0.
  const searchLeak = await apiGet(
    `/api/cases?q=${encodeURIComponent(env.SEARCH_LEAK_QUERY ?? "South Park")}`,
    { token: kansasTok },
  );
  const searchRows = searchLeak.body?.data ?? [];
  const searchLeakedCase = searchRows.some(
    (r) => r?.id === env.SOUTHPARK_CASE_ID || r?.providerId === env.SOUTHPARK_PROVIDER_ID,
  );
  const searchLeakTotal = searchLeak.body?.meta?.total;
  check(
    "15b. Kansas case search never returns a South Park case or provider id, and matches nothing",
    searchLeak.status === 200 && !searchLeakedCase && searchLeakTotal === 0,
    `status=${searchLeak.status} rows=${searchRows.length} total=${searchLeakTotal} leaked=${searchLeakedCase}`,
    { leak: true },
  );
  // 15c. The same search at the largest page a client can ask for (&limit=50,
  //      MINT-14 S3 "Show more"): still nothing matches and no South Park id
  //      in any of up to 50 rows. A wider page must not widen the org scope.
  const searchLeakMax = await apiGet(
    `/api/cases?q=${encodeURIComponent(env.SEARCH_LEAK_QUERY ?? "South Park")}&limit=50`,
    { token: kansasTok },
  );
  const searchMaxRows = searchLeakMax.body?.data ?? [];
  const searchMaxLeaked = searchMaxRows.some(
    (r) => r?.id === env.SOUTHPARK_CASE_ID || r?.providerId === env.SOUTHPARK_PROVIDER_ID,
  );
  const searchMaxTotal = searchLeakMax.body?.meta?.total;
  check(
    "15c. Kansas case search at &limit=50 never returns a South Park case or provider id, and matches nothing",
    searchLeakMax.status === 200 &&
      searchMaxRows.length <= 50 &&
      !searchMaxLeaked &&
      searchMaxTotal === 0,
    `status=${searchLeakMax.status} rows=${searchMaxRows.length} total=${searchMaxTotal} leaked=${searchMaxLeaked}`,
    { leak: true },
  );
  // 15d. ...and the cap holds: &limit=51 is refused (422), never clamped or
  //      honoured, so no request reads a page past the cap.
  const searchOverCap = await apiGet(
    `/api/cases?q=${encodeURIComponent(env.SEARCH_LEAK_QUERY ?? "South Park")}&limit=51`,
    { token: kansasTok },
  );
  check(
    "15d. Kansas case search refuses &limit=51 with a 422 (the cap is 50)",
    searchOverCap.status === 422 && searchOverCap.body?.data == null,
    `status=${searchOverCap.status} dataPresent=${searchOverCap.body?.data != null}`,
  );

  // 16. Fill-only SSN release (E4.4 F4.4.2): a Kansas writer requesting the
  //     full SSN for a South Park provider — even naming a South Park caseId —
  //     must 404 with no data. The value is the system's most sensitive PHI;
  //     the release must never cross the org boundary. Safe against production:
  //     the case-ownership check (org_id = the caller's Kansas org) misses BEFORE
  //     the decrypt RPC is ever called, so nothing is decrypted and no vaulted
  //     value is required for this assertion to hold. The leak mode makes it red.
  const xSsn = await apiGet(
    `/api/providers/${env.SOUTHPARK_PROVIDER_ID}/ssn-release?caseId=${env.SOUTHPARK_CASE_ID}`,
    { token: kansasTok },
  );
  const ssnLeaked = xSsn.status < 400 || xSsn.body?.data != null;
  check(
    "16. Kansas GET SSN release for a South Park provider -> 404, no data",
    xSsn.status === 404 && !ssnLeaked,
    `status=${xSsn.status} (expect 404) dataPresent=${xSsn.body?.data != null}`,
    { leak: true },
  );

  // 17. Signed document download (E4.5 TE-3/TE-11): documents are the most
  //     sensitive files in the system. Kansas downloading its OWN document
  //     works (proves 17b isn't vacuous against a dead route — conditional on
  //     KANSAS_DOCUMENT_ID; the in-sandbox mock run always sets it, the real
  //     gate skips until the operator seeds + pins a fixture document)...
  if (env.KANSAS_DOCUMENT_ID) {
    const ownDoc = await apiGet(`/api/documents/${env.KANSAS_DOCUMENT_ID}/download`, {
      token: kansasTok,
    });
    check(
      "17. Kansas downloads its own document (signed URL issued)",
      ownDoc.status === 200 && typeof ownDoc.body?.data?.url === "string",
      `status=${ownDoc.status}` +
        (ownDoc.status !== 200 ? ` body=${(ownDoc.raw || "").slice(0, 100)}` : ""),
    );
  } else {
    console.log("SKIP  17. own document download — KANSAS_DOCUMENT_ID not set");
  }
  //     ...and a South Park document id must 404 with no signed URL — the
  //     org-scoped metadata lookup misses BEFORE anything is signed, so no
  //     storage access ever happens for a cross-org id. Conditional on
  //     SOUTHPARK_DOCUMENT_ID (mock run always sets it); leak mode
  //     "documentdownload" makes it red.
  if (env.SOUTHPARK_DOCUMENT_ID) {
    const xDoc = await apiGet(`/api/documents/${env.SOUTHPARK_DOCUMENT_ID}/download`, {
      token: kansasTok,
    });
    const docLeaked = xDoc.status < 400 || xDoc.body?.data != null;
    check(
      "17b. Kansas GET download of a South Park document -> 404, no signed URL",
      xDoc.status === 404 && !docLeaked,
      `status=${xDoc.status} (expect 404) dataPresent=${xDoc.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  17b. cross-org document download — SOUTHPARK_DOCUMENT_ID not set");
  }

  // 18. Portals registry (shared catalog, same model as field maps): Kansas
  //     sees global (org NULL) rows plus its OWN org rows, and never another
  //     org's org-scoped portal. 18a first proves South Park actually holds an
  //     org-scoped portal, so 18b can't pass vacuously against an empty table —
  //     an 18a failure is a fixture gap, not a leak (register a South Park
  //     portal), and it downgrades to a SKIP rather than a false red.
  const portals = await apiGet("/api/portals", { token: kansasTok });
  const portalRows = portals.body?.data ?? [];
  check(
    "18. Kansas portals registry reads",
    portals.status === 200 && Array.isArray(portalRows),
    `status=${portals.status} rows=${portalRows.length}` +
      (portals.status !== 200 ? ` body=${(portals.raw || "").slice(0, 100)}` : ""),
  );
  const spPortals = await apiGet("/api/portals", { token: spTok });
  const spOwnPortals = (spPortals.body?.data ?? []).filter((r) => r.orgId === env.SOUTHPARK_ORG);
  if (spPortals.status === 200 && spOwnPortals.length >= 1) {
    check(
      "18b. Kansas portals exclude every South Park org-scoped portal",
      !portalRows.some((r) => r.orgId === env.SOUTHPARK_ORG),
      `southParkOrgRows=${portalRows.filter((r) => r.orgId === env.SOUTHPARK_ORG).length}` +
        ` (South Park holds ${spOwnPortals.length})`,
      { leak: true },
    );
  } else {
    console.log(
      "SKIP  18b. cross-org portal isolation — South Park holds no org-scoped portal fixture",
    );
  }

  // The local contract harness includes a flagged same-URL sibling so this
  // non-hosted check proves the legacy URL registry preserves the historical
  // entry while withholding configurations that require explicit selection.
  if (IS_LOCAL_MOCK_API) {
    const legacySameUrl = portalRows.find((row) => row.portalKey === "bcbs_ks_enrollment");
    const sameUrlRows = legacySameUrl
      ? portalRows.filter((row) => row.formUrl === legacySameUrl.formUrl)
      : [];
    check(
      "18c. Legacy URL registry keeps the historical row and omits its explicit-selection sibling",
      legacySameUrl?.requiresExplicitSelection === false &&
        sameUrlRows.length === 1 &&
        sameUrlRows[0]?.portalKey === "bcbs_ks_enrollment",
      `legacyVisible=${legacySameUrl != null} sameUrlRows=${sameUrlRows.length}`,
    );

    const explicitLookup = await apiGet("/api/portals?portal_key=bcbs_ks_enrollment_explicit", {
      token: kansasTok,
    });
    check(
      "18d. Exact-key legacy lookup cannot expose an explicit-selection configuration",
      explicitLookup.status === 200 &&
        Array.isArray(explicitLookup.body?.data) &&
        explicitLookup.body.data.length === 0 &&
        explicitLookup.body?.meta?.total === 0 &&
        explicitLookup.body?.meta?.registry_empty === true,
      `status=${explicitLookup.status} rows=${explicitLookup.body?.data?.length ?? "?"} ` +
        `registryEmpty=${String(explicitLookup.body?.meta?.registry_empty)}`,
    );
  }

  // 19. CAQH attestation WRITE isolation: a Kansas writer recording an
  //     attestation on a South Park provider must 404 like the PATCH
  //     (assertion 12) — never 200, never a cross-org write. Safe against
  //     production for the same reason: the cross-org id is rejected BEFORE
  //     any write (getProvider -> null -> 404), so no date is stamped.
  //
  //     The own-org write is deliberately NOT asserted: it would mutate a live
  //     provider's caqh_last_attested_date and move that provider's E1.8
  //     readiness. The happy path is covered by the handler unit tests and the
  //     mock server instead — the same reasoning that keeps POST /api/providers
  //     out of the gate.
  const caqhX = await apiPost(
    `/api/providers/${env.SOUTHPARK_PROVIDER_ID}/caqh-attestation`,
    {},
    { token: kansasTok },
  );
  const caqhLeaked = caqhX.status < 400 || caqhX.body?.data != null;
  check(
    "19. Kansas CAQH attestation on a South Park provider -> 404, no cross-org write",
    caqhX.status === 404 && !caqhLeaked,
    `status=${caqhX.status} (expect 404) dataPresent=${caqhX.body?.data != null}`,
    { leak: true },
  );

  // 20. Propose-only field-map WRITE isolation: whatever a Kansas caller
  //     proposes must land under KANSAS. This is the one write the gate can
  //     safely exercise for real — a proposed row is inert (source 'manual',
  //     no token, fills nothing) and idempotent on (portal_key, selector), so
  //     re-running the gate converges on the same row instead of accumulating.
  //     20a is the isolation half: the created row is org-scoped to the caller
  //     and never global, so an x-org-id-less caller cannot mint a shared
  //     catalog entry or write into another tenant.
  if (env.KANSAS_ORG) {
    const proposed = await apiPost(
      "/api/portal-field-maps",
      {
        portal_key: "gate_probe_portal",
        selector: "#gate-isolation-probe",
        field_label: "Gate isolation probe",
      },
      { token: kansasTok },
    );
    // S5.3 widened the response to { map, suggestion } — the row is data.map.
    const proposedRow = proposed.body?.data?.map ?? null;
    check(
      "20. Kansas can propose a field mapping",
      (proposed.status === 201 || proposed.status === 200) && proposedRow != null,
      `status=${proposed.status} (expect 200/201) dataPresent=${proposedRow != null}`,
    );
    check(
      "20a. The proposed row is scoped to Kansas, never global, never approved",
      proposedRow != null &&
        proposedRow.orgId === env.KANSAS_ORG &&
        proposedRow.status === "proposed" &&
        proposedRow.token == null,
      `orgId=${proposedRow?.orgId ?? "-"} (expect ${env.KANSAS_ORG}) ` +
        `status=${proposedRow?.status ?? "-"} token=${proposedRow?.token ?? "null"}`,
      { leak: true },
    );

    // These synthetic IDs cannot write in production: learning requires a
    // same-org completed fill plus a matching immutable submitted-touch audit.
    const learningProbe = {
      case_id: env.SOUTHPARK_CASE_ID,
      provider_id: env.SOUTHPARK_PROVIDER_ID,
      fill_session_id: "f1a70000-0000-4000-a000-0000000000f1",
      portal_key: "gate_probe_portal",
      page_url: "https://portal.example/forms/gate",
      mappings: [
        {
          selector: "#gate-learning-probe",
          token: "provider.npi",
          confidence: 0.91,
          field_type: "text",
        },
      ],
    };
    const learnedForeign = await apiPost("/api/portal-field-maps/batch-learn", learningProbe, {
      token: kansasTok,
    });
    check(
      "20b. Kansas cannot promote AI mappings from another org's case",
      learnedForeign.status === 404 && learnedForeign.body?.data == null,
      `status=${learnedForeign.status} dataPresent=${learnedForeign.body?.data != null}`,
      { leak: true },
    );

    const billingLearn = await apiPost(
      "/api/portal-field-maps/batch-learn",
      {
        ...learningProbe,
        case_id: "f1a70000-0000-4000-a000-0000000000f2",
        provider_id: "f1a70000-0000-4000-a000-0000000000f3",
      },
      { token: spTok },
    );
    check(
      "20c. Billing cannot promote AI field mappings",
      billingLearn.status === 403 && billingLearn.body?.data == null,
      `status=${billingLearn.status} dataPresent=${billingLearn.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  20/20a/20b/20c. field-map writes — KANSAS_ORG not set");
  }

  // 21. Task-step WRITE isolation (S4.3): a Kansas writer ticking a step on a
  //     South Park task must 404 BEFORE any write, like every other cross-org
  //     write path. Safe against production for the same reason as 12/19 —
  //     the org check precedes the update, so no task state is mutated. Uses
  //     a nonsense stepId so even a hypothetical org-check bypass would fail
  //     to find a step to tick.
  if (env.SOUTHPARK_TASK_ID) {
    const stepX = await apiPatch(
      `/api/tasks/${env.SOUTHPARK_TASK_ID}/steps`,
      { stepId: "gate-probe-step-does-not-exist" },
      { token: kansasTok },
    );
    const stepLeaked = stepX.status < 400 || stepX.body?.data != null;
    check(
      "21. Kansas ticking a step on a South Park task -> 404, no cross-org write",
      stepX.status === 404 && !stepLeaked,
      `status=${stepX.status} (expect 404) dataPresent=${stepX.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  21. cross-org task-step write — SOUTHPARK_TASK_ID not set");
  }

  // 22/23. E6.9 shared (org-free) training tier. These two routes deliberately
  //        carry NO org — training writes the shared form library every org
  //        inherits — so the property to hold is GLOBAL ONLY, not "the right
  //        org". 22: the shared registry read must never hand back a private
  //        org row (there is no org in scope to widen it to). 23: the shared
  //        propose must land org_id null; a row written under the caller's org
  //        would make a trained form silently private to one tenant while
  //        appearing shared. Safe on production: 23 writes a proposal with a
  //        gate-marked selector and no token, which fills nothing.
  const sharedPortals = await apiGet("/api/shared-portals", { token: kansasTok });
  const sharedRows = sharedPortals.body?.data ?? [];
  const privateLeak = sharedRows.filter((r) => r.orgId != null);
  check(
    "22. Shared portal registry returns GLOBAL rows only (no org's private rows)",
    sharedPortals.status === 200 && sharedRows.length > 0 && privateLeak.length === 0,
    `status=${sharedPortals.status} rows=${sharedRows.length} withOrg=${privateLeak.length}`,
    { leak: true },
  );

  const sharedMaps = await apiGet("/api/shared-field-maps", { token: kansasTok });
  const sharedMapRows = sharedMaps.body?.data ?? [];
  const mapOrgLeak = sharedMapRows.filter((r) => r.orgId != null);
  check(
    "22b. Shared field-map read returns GLOBAL rows only",
    sharedMaps.status === 200 && mapOrgLeak.length === 0,
    `status=${sharedMaps.status} rows=${sharedMapRows.length} withOrg=${mapOrgLeak.length}`,
    { leak: true },
  );

  const sharedProposal = await apiPost(
    "/api/shared-field-maps",
    {
      portal_key: "gate_probe_shared",
      selector: `#gate-probe-shared-${Date.now()}`,
      field_label: "Gate probe (shared tier)",
      page_step: "Page 1",
      field_type: "select",
      sort_order: 1,
      control_options: [
        { value: "KS", label: "Kansas" },
        { value: "MO", label: "Missouri" },
      ],
    },
    { token: kansasTok },
  );
  const sharedRow = sharedProposal.body?.data?.map ?? null;
  check(
    "23. Shared field-map propose lands org_id null, never under the caller's org",
    sharedProposal.status < 400 && sharedRow != null && sharedRow.orgId == null,
    `status=${sharedProposal.status} orgId=${sharedRow?.orgId ?? "null"} ` +
      `token=${sharedRow?.token ?? "null"} fieldType=${sharedRow?.fieldType ?? "null"}`,
    { leak: true },
  );

  // 24. Manual prove is GLOBAL only — naming a cross-org private portal id
  //     must 404 (never stamp proven_at on another tenant's row).
  const spPortalId = process.env.SOUTHPARK_PORTAL_ID || "portal-sp-1";
  const proveProbe = await apiPost(
    "/api/shared-portals/prove",
    { id: spPortalId },
    { token: kansasTok },
  );
  check(
    "24. Shared portal prove cannot stamp an org-scoped / foreign portal",
    proveProbe.status === 404,
    `status=${proveProbe.status}`,
    { leak: true },
  );

  // 24b. Shared test fill is is_test with null case/provider (telemetry only).
  const testFillId = crypto.randomUUID();
  const testFill = await apiPost(
    "/api/shared-test-fills",
    {
      id: testFillId,
      portalKey: "gate_probe_shared",
      fieldsFilled: 0,
      fieldsSkipped: [],
    },
    { token: kansasTok },
  );
  const testSession = testFill.body?.data?.session ?? null;
  check(
    "24b. Shared test fill records is_test with null case/provider",
    testFill.status < 400 &&
      testSession != null &&
      testSession.isTest === true &&
      testSession.caseId == null &&
      testSession.providerId == null,
    `status=${testFill.status} isTest=${testSession?.isTest} caseId=${testSession?.caseId}`,
    { leak: false },
  );

  // 25/25b/26 — document upload-intent + finalize (E4.5 TE-3, ASD
  // BITE-ASD-02/04 closing the TD-53 gap: these two write endpoints had NO
  // gate coverage — only the signed-download READ (17/17b) did). 25 proves
  // the route works for Kansas's own provider (so 25b isn't vacuous against a
  // dead route); 25b/26 are the leak checks — a South Park owner id must 404
  // BEFORE any signing or metadata insert. Safe on production: the org-scoped
  // owner lookup misses before a signed target is ever minted or a row ever
  // written, so no real Storage object or provider_documents row is touched
  // by 25b/26 regardless of leak mode. Leak "documentupload" makes both red.
  const ownIntent = await apiPost(
    "/api/documents/upload-intent",
    {
      ownerType: "provider",
      ownerId: env.KANSAS_PROVIDER_ID,
      kind: "state_license",
      fileName: "gate-probe.pdf",
      fileSize: 1024,
      mimeType: "application/pdf",
    },
    { token: kansasTok },
  );
  check(
    "25. Kansas mints an upload-intent for its own provider (signed target issued)",
    ownIntent.status === 200 && typeof ownIntent.body?.data?.uploadUrl === "string",
    `status=${ownIntent.status}` +
      (ownIntent.status !== 200 ? ` body=${(ownIntent.raw || "").slice(0, 100)}` : ""),
  );

  const xIntent = await apiPost(
    "/api/documents/upload-intent",
    {
      ownerType: "provider",
      ownerId: env.SOUTHPARK_PROVIDER_ID,
      kind: "state_license",
      fileName: "gate-probe.pdf",
      fileSize: 1024,
      mimeType: "application/pdf",
    },
    { token: kansasTok },
  );
  const intentLeaked = xIntent.status < 400 || xIntent.body?.data != null;
  check(
    "25b. Kansas POST upload-intent naming a South Park provider -> 404, no signed target",
    xIntent.status === 404 && !intentLeaked,
    `status=${xIntent.status} (expect 404) dataPresent=${xIntent.body?.data != null}`,
    { leak: true },
  );

  const xFinalize = await apiPost(
    "/api/documents/finalize",
    {
      ownerType: "provider",
      ownerId: env.SOUTHPARK_PROVIDER_ID,
      kind: "state_license",
      familyId: crypto.randomUUID(),
      versionNumber: 1,
      fileName: "gate-probe.pdf",
      mimeType: "application/pdf",
      expirationDate: "2030-01-01",
    },
    { token: kansasTok },
  );
  const finalizeLeaked = xFinalize.status < 400 || xFinalize.body?.data != null;
  check(
    "26. Kansas POST finalize naming a South Park provider -> 404, before any insert",
    xFinalize.status === 404 && !finalizeLeaked,
    `status=${xFinalize.status} (expect 404) dataPresent=${xFinalize.body?.data != null}`,
    { leak: true },
  );

  // 27. Provider list `groups` (2026-08-19): each row names the provider's
  //     groups so a search can tell two same-named providers apart. That is a
  //     SECOND org-scoped read joined onto the first, so it gets its own
  //     check — the rows can be correctly scoped while the join is not.
  //     Reuses the two org views already fetched above; non-vacuous as soon as
  //     either org has a group (27a states which).
  const groupsOf = (body) =>
    (Array.isArray(body?.data) ? body.data : []).flatMap((row) =>
      Array.isArray(row?.groups) ? row.groups : [],
    );
  const kGroups = groupsOf(k.body);
  const sGroups = groupsOf(s.body);
  const kGroupIds = new Set(kGroups.map((g) => g?.id).filter(Boolean));
  const sGroupIds = new Set(sGroups.map((g) => g?.id).filter(Boolean));
  check(
    "27a. At least one org's provider rows carry group names (27 is non-vacuous)",
    kGroupIds.size > 0 || sGroupIds.size > 0,
    `kansasGroups=${kGroupIds.size} southParkGroups=${sGroupIds.size}` +
      (kGroupIds.size + sGroupIds.size === 0
        ? " (no groups on either roster — 27 proves nothing)"
        : ""),
  );
  const groupOverlap = [...kGroupIds].filter((id) => sGroupIds.has(id));
  check(
    "27. Kansas and South Park provider-row group id sets are disjoint",
    groupOverlap.length === 0,
    `overlap=${groupOverlap.length}${groupOverlap.length ? " " + groupOverlap.slice(0, 3).join(",") : ""}`,
    { leak: true },
  );

  // 28/28b/28c/29 — Payer PDF (/api/payer-forms/*). These rows are GLOBAL: no
  // org_id, one file per payer that every org credentialing with that payer
  // sees. So the wall here is NOT tenancy — a cross-org read is the intended
  // behavior, and asserting a 404 on one would pin the opposite of the design.
  // The wall is ROLE: only an admin may change what every org sees. That makes
  // the checks below the payer-form equivalent of 25/25b/26.
  //
  // 28 proves the route works for the Kansas ADMIN (so 28b isn't vacuous
  // against a dead route). Safe on production: an intent mints a signed target
  // but writes no row, and nothing is ever PUT to it — the object never exists
  // and finalize is never called, so no payer_forms row and no storage object
  // results from this run.
  if (env.PAYER_FORM_TEMPLATE_ID) {
    const ownFormIntent = await apiPost(
      "/api/payer-forms/upload-intent",
      {
        templateId: env.PAYER_FORM_TEMPLATE_ID,
        label: "Gate probe form",
        fileName: "gate-probe.pdf",
        fileSize: 1024,
        mimeType: "application/pdf",
      },
      { token: kansasTok },
    );
    check(
      "28. Kansas admin mints a payer-form upload-intent (signed target issued)",
      ownFormIntent.status === 200 && typeof ownFormIntent.body?.data?.uploadUrl === "string",
      `status=${ownFormIntent.status}` +
        (ownFormIntent.status !== 200 ? ` body=${(ownFormIntent.raw || "").slice(0, 100)}` : ""),
    );

    // 28b — the role wall. South Park's user is BILLING (read-only), so this
    // must be a 403 with nothing signed. A leak here means any member of any
    // org can overwrite a payer form every other org depends on.
    const spFormIntent = await apiPost(
      "/api/payer-forms/upload-intent",
      {
        templateId: env.PAYER_FORM_TEMPLATE_ID,
        label: "Gate probe form",
        fileName: "gate-probe.pdf",
        fileSize: 1024,
        mimeType: "application/pdf",
      },
      { token: spTok },
    );
    const spFormLeaked = spFormIntent.status < 400 || spFormIntent.body?.data != null;
    check(
      "28b. Non-admin POST payer-form upload-intent -> 403, no signed target",
      spFormIntent.status === 403 && !spFormLeaked,
      `status=${spFormIntent.status} (expect 403) dataPresent=${spFormIntent.body?.data != null}`,
      { leak: true },
    );

    // 28c — the same wall on finalize, which is the endpoint that would insert
    // the row. 25b/26 pair the same way for documents.
    const spFormFinalize = await apiPost(
      "/api/payer-forms/finalize",
      {
        templateId: env.PAYER_FORM_TEMPLATE_ID,
        familyId: crypto.randomUUID(),
        version: 1,
        label: "Gate probe form",
        fileName: "gate-probe.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
      },
      { token: spTok },
    );
    const spFinalizeLeaked = spFormFinalize.status < 400 || spFormFinalize.body?.data != null;
    check(
      "28c. Non-admin POST payer-form finalize -> 403, before any insert",
      spFormFinalize.status === 403 && !spFinalizeLeaked,
      `status=${spFormFinalize.status} (expect 403) dataPresent=${spFormFinalize.body?.data != null}`,
      { leak: true },
    );
  } else {
    console.log("SKIP  28/28b/28c. payer-form write wall — PAYER_FORM_TEMPLATE_ID not set");
  }

  // 29. The deliberate global READ. A member of an org that did NOT upload the
  //     form still downloads it — that is the product behavior (one blank payer
  //     form, every org). This is asserted POSITIVELY and on purpose, so that a
  //     future change narrowing it to the uploading org fails here loudly
  //     instead of silently breaking every other org's cases.
  if (env.PAYER_FORM_ID) {
    const spDownload = await apiGet(`/api/payer-forms/${env.PAYER_FORM_ID}/download`, {
      token: spTok,
    });
    check(
      "29. Any org's member downloads a GLOBAL payer form (intended, not a leak)",
      spDownload.status === 200 && typeof spDownload.body?.data?.url === "string",
      `status=${spDownload.status}` +
        (spDownload.status !== 200 ? ` body=${(spDownload.raw || "").slice(0, 100)}` : ""),
    );
  } else {
    console.log("SKIP  29. global payer-form download — PAYER_FORM_ID not set");
  }

  // 35-35d — provider onboarding slice 1. 35 is the positive control: an
  // empty body must 422, which proves the route is live, so 35b/35c can't pass
  // against a dead route. A deploy without the code (404) or without the
  // email env (that exact 500) reports SKIP. 35b/35c write nothing on a
  // correct server: the cross-org group or provider misses before any insert.
  const inviteProbe = await apiPost("/api/provider-invites", {}, { token: kansasTok });
  if (inviteProbe.status === 404) {
    console.log("SKIP  35/35b/35c. provider invites — route not deployed");
  } else if (
    inviteProbe.status === 500 &&
    inviteProbe.body?.error === "Provider invites are not configured"
  ) {
    console.log("SKIP  35/35b/35c. provider invites — email env not configured on this deploy");
  } else {
    check(
      "35. Kansas POST /api/provider-invites with an empty body -> 422 (route is live)",
      inviteProbe.status === 422,
      `status=${inviteProbe.status} (expect 422)`,
    );
    if (env.SOUTHPARK_GROUP_ID) {
      const xInvite = await apiPost(
        "/api/provider-invites",
        {
          firstName: "Gate",
          lastName: "Probe",
          email: "gate.probe@example.invalid",
          groupId: env.SOUTHPARK_GROUP_ID,
        },
        { token: kansasTok },
      );
      check(
        "35b. Kansas invite into a South Park group -> 404, nothing created",
        xInvite.status === 404 && xInvite.body?.data == null,
        `status=${xInvite.status} (expect 404) dataPresent=${xInvite.body?.data != null}`,
        { leak: true },
      );
    } else {
      console.log("SKIP  35b. cross-org invite group — SOUTHPARK_GROUP_ID not set");
    }
    const xResend = await apiPost(
      `/api/provider-invites/${env.SOUTHPARK_PROVIDER_ID}/resend`,
      {},
      { token: kansasTok },
    );
    check(
      "35c. Kansas resend for a South Park provider -> 404",
      xResend.status === 404 && xResend.body?.data == null,
      `status=${xResend.status} (expect 404) dataPresent=${xResend.body?.data != null}`,
      { leak: true },
    );
  }

  // 35i/35j — staff cancel of an onboarding. 35i is the positive control
  // without a side effect: a GET on the route is a 405 only once the route is
  // deployed, so 35j's 404 can't pass against a dead route. 35j: Kansas
  // cancelling a South Park provider misses before any write, and South Park
  // still reads its provider afterwards. When that provider has no open
  // journey on the target, cancel answers not_found from any org, so 35j
  // proves only "no 200" (see the header).
  const cancelPath = `/api/provider-invites/${env.SOUTHPARK_PROVIDER_ID}/cancel`;
  const cancelProbe = await apiGet(cancelPath, { token: kansasTok });
  if (cancelProbe.status === 404) {
    console.log("SKIP  35i/35j. onboarding cancel — route not deployed");
  } else {
    check(
      "35i. Kansas GET on the cancel route -> 405 (route is live)",
      cancelProbe.status === 405,
      `status=${cancelProbe.status} (expect 405)`,
    );
    const xCancel = await apiPost(cancelPath, {}, { token: kansasTok });
    const spStill = await apiGet(`/api/providers/${env.SOUTHPARK_PROVIDER_ID}`, { token: spTok });
    check(
      "35j. Kansas cancel for a South Park provider -> 404, South Park's provider untouched",
      xCancel.status === 404 && xCancel.body?.data == null && spStill.status === 200,
      `status=${xCancel.status} (expect 404) dataPresent=${xCancel.body?.data != null} ` +
        `southParkRead=${spStill.status} (expect 200)`,
      { leak: true },
    );
  }

  // 35d/35e — a provider intake session reads and saves only under its own
  // invite's link. 35d is the positive control (her own link reads her state
  // and saves her draft), so 35e's 401s can't pass against a dead route.
  // Needs an emailed code, so it runs against the local mock only. Node's
  // fetch keeps no cookie jar; the session cookie is forwarded by hand.
  if (IS_LOCAL_MOCK_API && env.KANSAS_INTAKE_TOKEN) {
    const signIn = await fetch(`${API_BASE}/api/intake/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: env.KANSAS_INTAKE_TOKEN, code: "000000" }),
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const asKansas = { extraHeaders: { cookie } };
    const draft = (t) => ({ t, answers: { mobile: "5555550100" }, step: "form", version: 0 });
    const state = await apiPost("/api/intake/state", { t: env.KANSAS_INTAKE_TOKEN }, asKansas);
    const saved = await apiPost("/api/intake/draft", draft(env.KANSAS_INTAKE_TOKEN), asKansas);
    check(
      "35d. A Kansas intake session reads and saves only its own invite's provider",
      signIn.status === 200 &&
        state.status === 200 &&
        state.body?.data?.practiceName === "Kansas Fitness Physio" &&
        saved.status === 200,
      `session=${signIn.status} state=${state.status} practice=${state.body?.data?.practiceName} draft=${saved.status}`,
      { leak: true },
    );
    if (env.SOUTHPARK_INTAKE_TOKEN) {
      const xState = await apiPost(
        "/api/intake/state",
        { t: env.SOUTHPARK_INTAKE_TOKEN },
        asKansas,
      );
      const xDraft = await apiPost(
        "/api/intake/draft",
        draft(env.SOUTHPARK_INTAKE_TOKEN),
        asKansas,
      );
      check(
        "35e. A Kansas intake session under a South Park link -> 401, nothing read or saved",
        xState.status === 401 &&
          xState.body?.data == null &&
          xDraft.status === 401 &&
          xDraft.body?.data == null,
        `state=${xState.status} draft=${xDraft.status} statePresent=${xState.body?.data != null}`,
        { leak: true },
      );

      // 35f — the vault writes are bound the same way. Its own link stores
      // (the positive control), South Park's link stores nothing.
      const ssn = (t) => ({ t, ssn: "123-45-6789" });
      const login = (t) => ({ t, portal: "caqh", username: "gate.user", password: "Gate-Pass-1" });
      const ownSsn = await apiPost("/api/intake/ssn", ssn(env.KANSAS_INTAKE_TOKEN), asKansas);
      const ownLogin = await apiPost("/api/intake/login", login(env.KANSAS_INTAKE_TOKEN), asKansas);
      const xSsn = await apiPost("/api/intake/ssn", ssn(env.SOUTHPARK_INTAKE_TOKEN), asKansas);
      const xLogin = await apiPost(
        "/api/intake/login",
        login(env.SOUTHPARK_INTAKE_TOKEN),
        asKansas,
      );
      check(
        "35f. A Kansas intake session stores an SSN and a login only under its own link",
        ownSsn.status === 200 &&
          ownLogin.status === 200 &&
          xSsn.status === 401 &&
          xSsn.body?.data == null &&
          xLogin.status === 401 &&
          xLogin.body?.data == null,
        `own ssn=${ownSsn.status} login=${ownLogin.status}; south park ssn=${xSsn.status} login=${xLogin.status}`,
        { leak: true },
      );

      // 35g: her documents are bound the same way. Its own link begins,
      // finishes and removes an upload (the positive control); South Park's
      // link does none of the three, even with an upload id in hand.
      const begin = (t) => ({
        t,
        slotKey: "cv",
        kind: "cv",
        fileName: "gate.pdf",
        sizeBytes: 1024,
        contentType: "application/pdf",
      });
      const ownBegin = await apiPost(
        "/api/intake/upload-intent",
        begin(env.KANSAS_INTAKE_TOKEN),
        asKansas,
      );
      const uploadId = ownBegin.body?.data?.uploadId;
      const upload = (t) => ({ t, uploadId });
      const ownFinish = await apiPost(
        "/api/intake/upload-finalize",
        upload(env.KANSAS_INTAKE_TOKEN),
        asKansas,
      );
      const xBegin = await apiPost(
        "/api/intake/upload-intent",
        begin(env.SOUTHPARK_INTAKE_TOKEN),
        asKansas,
      );
      const xFinish = await apiPost(
        "/api/intake/upload-finalize",
        upload(env.SOUTHPARK_INTAKE_TOKEN),
        asKansas,
      );
      const xRemove = await apiPost(
        "/api/intake/upload-remove",
        upload(env.SOUTHPARK_INTAKE_TOKEN),
        asKansas,
      );
      const ownRemove = await apiPost(
        "/api/intake/upload-remove",
        upload(env.KANSAS_INTAKE_TOKEN),
        asKansas,
      );
      const refused = [xBegin, xFinish, xRemove];
      check(
        "35g. A Kansas intake session begins, finishes and removes an upload only under its own link",
        ownBegin.status === 200 &&
          typeof uploadId === "string" &&
          ownFinish.status === 200 &&
          ownRemove.status === 200 &&
          refused.every((r) => r.status === 401 && r.body?.data == null),
        `own begin=${ownBegin.status} finish=${ownFinish.status} remove=${ownRemove.status}; ` +
          `south park begin=${xBegin.status} finish=${xFinish.status} remove=${xRemove.status}`,
        { leak: true },
      );

      // 35h: Submit and help are bound the same way. South Park's link is
      // refused first, so the positive control's Submit can't close the
      // journey under test before it is asked.
      const xSubmit = await apiPost(
        "/api/intake/submit",
        { t: env.SOUTHPARK_INTAKE_TOKEN, version: 1 },
        asKansas,
      );
      const xHelp = await apiPost(
        "/api/intake/help",
        { t: env.SOUTHPARK_INTAKE_TOKEN, reason: { kind: "help" } },
        asKansas,
      );
      const ownHelp = await apiPost(
        "/api/intake/help",
        { t: env.KANSAS_INTAKE_TOKEN, reason: { kind: "help" } },
        asKansas,
      );
      const ownSubmit = await apiPost(
        "/api/intake/submit",
        { t: env.KANSAS_INTAKE_TOKEN, version: 1 },
        asKansas,
      );
      check(
        "35h. A Kansas intake session submits and asks for help only under its own link",
        ownSubmit.status === 200 &&
          ownHelp.status === 200 &&
          [xSubmit, xHelp].every((r) => r.status === 401 && r.body?.data == null),
        `own submit=${ownSubmit.status} help=${ownHelp.status}; ` +
          `south park submit=${xSubmit.status} help=${xHelp.status}`,
        { leak: true },
      );
    } else {
      console.log("SKIP  35e-35h. intake link binding — SOUTHPARK_INTAKE_TOKEN not set");
    }
  } else {
    console.log("SKIP  35d-35h. intake session scope — local mock only (needs an emailed code)");
  }

  // 36-36c — MINT-110 NPI Registry lookup. These routes read no org data (the
  // registry is public), so there is no cross-org row to leak; the wall to
  // prove is that the server never proxies the registry for an anonymous
  // caller or a read-only member. 36 is the positive control: an empty body
  // 422s, which proves the route is live, so 36b/36c can't pass against a dead
  // route. On a correct server none of the three reaches the registry.
  const npiProbe = await apiPost("/api/npi-registry/search", {}, { token: kansasTok });
  if (npiProbe.status === 404) {
    console.log("SKIP  36/36b/36c. NPI Registry lookup — route not deployed");
  } else {
    check(
      "36. Kansas POST /api/npi-registry/search with an empty body -> 422 (route is live)",
      npiProbe.status === 422,
      `status=${npiProbe.status} (expect 422)`,
    );
    const anonymous = await apiPost("/api/npi-registry/search", {
      firstName: "Gate",
      lastName: "Probe",
    });
    check(
      "36b. Anonymous NPI Registry search -> 401 (never an open proxy)",
      anonymous.status === 401 && anonymous.body?.data == null,
      `status=${anonymous.status} (expect 401) dataPresent=${anonymous.body?.data != null}`,
    );
    const readOnly = await apiPost(
      "/api/npi-registry/lookup",
      { npi: "1234567893" },
      { token: spTok },
    );
    check(
      "36c. Billing (read-only) NPI Registry lookup -> 403",
      readOnly.status === 403 && readOnly.body?.data == null,
      `status=${readOnly.status} (expect 403) dataPresent=${readOnly.body?.data != null}`,
    );
  }

  // 37-37d — MINT-110 PR 2: the import review's batch NPI check. The same wall
  // as 36: no org data to leak, so prove the route is live (37: an empty body
  // 422s before any registry call), that it never runs for an anonymous
  // caller (37b) or a read-only member (37c), and that its answers are
  // no-store (37d). None of these reaches the registry on a correct server:
  // validation and role both answer first.
  const batchProbe = await apiPost("/api/npi-registry/verify-batch", {}, { token: kansasTok });
  if (batchProbe.status === 404) {
    console.log("SKIP  37/37b/37c/37d. NPI Registry batch check — route not deployed");
  } else {
    check(
      "37. Kansas POST /api/npi-registry/verify-batch with an empty body -> 422 (route is live)",
      batchProbe.status === 422,
      `status=${batchProbe.status} (expect 422)`,
    );
    // Every verify-batch answer is private: never stored by a browser or proxy.
    check(
      "37d. verify-batch answers are never cached (Cache-Control: no-store)",
      /no-store/i.test(batchProbe.cacheControl ?? ""),
      `cache-control=${batchProbe.cacheControl ?? "(none)"}`,
    );
    const anonymousBatch = await apiPost("/api/npi-registry/verify-batch", {
      npis: ["1234567893"],
    });
    check(
      "37b. Anonymous NPI Registry batch check -> 401 (never an open proxy)",
      anonymousBatch.status === 401 && anonymousBatch.body?.data == null,
      `status=${anonymousBatch.status} (expect 401) dataPresent=${anonymousBatch.body?.data != null}`,
    );
    const readOnlyBatch = await apiPost(
      "/api/npi-registry/verify-batch",
      { npis: ["1234567893"] },
      { token: spTok },
    );
    check(
      "37c. Billing (read-only) NPI Registry batch check -> 403",
      readOnlyBatch.status === 403 && readOnlyBatch.body?.data == null,
      `status=${readOnlyBatch.status} (expect 403) dataPresent=${readOnlyBatch.body?.data != null}`,
    );
  }

  // 38-38e — MINT-110 PR 3: NPI Registry pulls. Unlike 36/37 this route
  // WRITES org data (provider_registry_pulls), so the wall is tenancy as well
  // as role: another org's provider is a 404 (38b), an anonymous caller a 401
  // (38c), a read-only member a 403 (38d). 38 is the positive control: an
  // empty body 422s, which proves the route is live. On a correct server none
  // of these reads a provider for the caller, calls the registry or writes:
  // validation, the org-scoped provider read and the role all answer first.
  const pullsProbe = await apiPost("/api/npi-registry/pulls", {}, { token: kansasTok });
  if (pullsProbe.status === 404) {
    console.log("SKIP  38/38b/38c/38d. NPI Registry pulls — route not deployed");
  } else {
    check(
      "38. Kansas POST /api/npi-registry/pulls with an empty body -> 422 (route is live)",
      pullsProbe.status === 422,
      `status=${pullsProbe.status} (expect 422)`,
    );
    const crossOrgPull = await apiPost(
      "/api/npi-registry/pulls",
      { providerId: env.SOUTHPARK_PROVIDER_ID, npi: "1234567893", sourced: {}, confirmed: false },
      { token: kansasTok },
    );
    check(
      "38b. Kansas pull for a South Park provider -> 404 (never another org's provider)",
      crossOrgPull.status === 404 && crossOrgPull.body?.data == null,
      `status=${crossOrgPull.status} (expect 404) dataPresent=${crossOrgPull.body?.data != null}`,
      { leak: true },
    );
    const anonymousPull = await apiPost("/api/npi-registry/pulls", {
      providerId: env.KANSAS_PROVIDER_ID,
      npi: "1234567893",
      sourced: {},
      confirmed: false,
    });
    check(
      "38c. Anonymous NPI Registry pull -> 401",
      anonymousPull.status === 401 && anonymousPull.body?.data == null,
      `status=${anonymousPull.status} (expect 401) dataPresent=${anonymousPull.body?.data != null}`,
    );
    const readOnlyPull = await apiPost(
      "/api/npi-registry/pulls",
      { providerId: env.SOUTHPARK_PROVIDER_ID, npi: "1234567893", sourced: {}, confirmed: false },
      { token: spTok },
    );
    check(
      "38d. Billing (read-only) NPI Registry pull for its own org's provider -> 403",
      readOnlyPull.status === 403 && readOnlyPull.body?.data == null,
      `status=${readOnlyPull.status} (expect 403) dataPresent=${readOnlyPull.body?.data != null}`,
    );
  }

  // 38e — the table itself, straight through PostgREST with a user's JWT: no
  // direct INSERT, UPDATE or DELETE. There is no reader yet, so nothing is
  // granted to authenticated and nothing reads it this way either. The INSERT
  // probe has no org_id and an NPI the table's CHECK refuses, and the UPDATE
  // and DELETE probes match no row, so even a broken grant writes nothing. A
  // 404 for the INSERT means the table is not applied (PGRST205).
  const noRow = "id=eq.00000000-0000-0000-0000-000000000000";
  const insertProbe = await restCall("POST", "provider_registry_pulls", {
    token: kansasTok,
    payload: {
      provider_id: env.KANSAS_PROVIDER_ID,
      npi: "gate-probe",
      pulled_at: "1970-01-01T00:00:00Z",
      pulled_by: "00000000-0000-0000-0000-000000000000",
      sourced: {},
    },
  });
  if (insertProbe.status === 404) {
    console.log("SKIP  38e. provider_registry_pulls — table not applied");
  } else {
    const writes = [
      insertProbe,
      await restCall("PATCH", `provider_registry_pulls?${noRow}`, {
        token: kansasTok,
        payload: { sourced: {} },
      }),
      await restCall("DELETE", `provider_registry_pulls?${noRow}`, { token: kansasTok }),
    ];
    check(
      "38e. PostgREST INSERT/UPDATE/DELETE on provider_registry_pulls -> refused (401/403)",
      writes.every((w) => w.status === 401 || w.status === 403),
      `statuses=${writes.map((w) => w.status).join("/")} (expect 401 or 403 each)`,
      { leak: true },
    );
  }

  // 39. Workbench directory (Nov 4, 2026): GET /api/providers/:id adds the
  //     card's related lists, and GET /api/groups and /api/locations are new
  //     read-only lists and cards, any role, org-guarded. Kansas reads its own
  //     provider card and, through the ids on it, its own location and group
  //     cards, and finds both in the lists — positives that keep the
  //     negatives below from passing against a dead route.
  const ownProvider = await apiGet(`/api/providers/${env.KANSAS_PROVIDER_ID}`, {
    token: kansasTok,
  });
  const ownCard = ownProvider.body?.data;
  check(
    "39. Kansas reads its own provider by id, with the directory card's related lists",
    ownProvider.status === 200 &&
      ownCard?.id === env.KANSAS_PROVIDER_ID &&
      ["licenses", "medicareIds", "groups", "locations"].every((k) => Array.isArray(ownCard?.[k])),
    `status=${ownProvider.status}`,
  );
  //     The card's lists are read from the provider's own org only: no South
  //     Park group, location or provider id anywhere on it.
  const southParkAnyIds = [
    env.SOUTHPARK_PROVIDER_ID,
    env.SOUTHPARK_GROUP_ID,
    env.SOUTHPARK_FACILITY_ID,
  ].filter(Boolean);
  const cardListIds = ["medicareIds", "groups", "locations"].flatMap((k) =>
    Array.isArray(ownCard?.[k]) ? ownCard[k].flatMap((x) => [x?.id, x?.groupId]) : [],
  );
  const cardLeaks = cardListIds.filter((id) => southParkAnyIds.includes(id));
  check(
    "39j. Kansas's provider card lists no South Park group, location or provider",
    ownProvider.status === 200 && cardLeaks.length === 0,
    `leaked=${cardLeaks.length}`,
    { leak: true },
  );
  const ownLocationId = ownCard?.locations?.[0]?.id;
  if (ownLocationId) {
    const ownLocation = await apiGet(`/api/locations/${ownLocationId}`, { token: kansasTok });
    check(
      "39f. Kansas reads its own location card",
      ownLocation.status === 200 && ownLocation.body?.data?.id === ownLocationId,
      `status=${ownLocation.status}`,
    );
  } else {
    console.log("SKIP  39f. own location card — the Kansas provider lists no location");
  }
  const ownGroupId = ownCard?.groups?.[0]?.id;
  if (ownGroupId) {
    const ownGroup = await apiGet(`/api/groups/${ownGroupId}`, { token: kansasTok });
    check(
      "39g. Kansas reads its own group card",
      ownGroup.status === 200 && ownGroup.body?.data?.id === ownGroupId,
      `status=${ownGroup.status}`,
    );
  } else {
    console.log("SKIP  39g. own group card — the Kansas provider lists no group");
  }
  //     The unfiltered lists: Kansas sees its own group and location, and no
  //     South Park row.
  const kansasGroups = await apiGet("/api/groups?pageSize=100", { token: kansasTok });
  const kansasLocations = await apiGet("/api/locations?pageSize=100", { token: kansasTok });
  const groupIds = Array.isArray(kansasGroups.body?.data)
    ? kansasGroups.body.data.map((g) => g.id)
    : [];
  const locationIds = Array.isArray(kansasLocations.body?.data)
    ? kansasLocations.body.data.map((l) => l.id)
    : [];
  check(
    "39h. Kansas's group and location lists include its own group and location",
    kansasGroups.status === 200 &&
      kansasLocations.status === 200 &&
      (!ownGroupId || groupIds.includes(ownGroupId)) &&
      (!ownLocationId || locationIds.includes(ownLocationId)),
    `status=${kansasGroups.status}/${kansasLocations.status}`,
  );
  // Any role reads the directory: the South Park caller is billing.
  const billingGroups = await apiGet("/api/groups", { token: spTok });
  check(
    "39i. A billing member lists its own org's groups",
    billingGroups.status === 200 && Array.isArray(billingGroups.body?.data),
    `status=${billingGroups.status}`,
  );
  const southParkIds = [env.SOUTHPARK_GROUP_ID, env.SOUTHPARK_FACILITY_ID].filter(Boolean);
  const listLeaks = [...groupIds, ...locationIds].filter((id) => southParkIds.includes(id));
  check(
    "39b. Kansas's group and location lists hold no South Park row",
    kansasGroups.status === 200 && kansasLocations.status === 200 && listLeaks.length === 0,
    `status=${kansasGroups.status}/${kansasLocations.status} leaked=${listLeaks.length}`,
    { leak: true },
  );
  //     ...another org's location and group cards are a 404 with no data...
  const xLocation = await apiGet(`/api/locations/${env.SOUTHPARK_FACILITY_ID}`, {
    token: kansasTok,
  });
  check(
    "39c. Kansas GET a South Park location card -> 404, no data",
    xLocation.status === 404 && xLocation.body?.data == null,
    `status=${xLocation.status} (expect 404)`,
    { leak: true },
  );
  if (env.SOUTHPARK_GROUP_ID) {
    const xGroup = await apiGet(`/api/groups/${env.SOUTHPARK_GROUP_ID}`, { token: kansasTok });
    check(
      "39d. Kansas GET a South Park group card -> 404, no data",
      xGroup.status === 404 && xGroup.body?.data == null,
      `status=${xGroup.status} (expect 404)`,
      { leak: true },
    );
  } else {
    console.log("SKIP  39d. cross-org group card — SOUTHPARK_GROUP_ID not set");
  }
  //     ...and searching the group and location lists for South Park's name
  //     finds nothing for Kansas (the same SEARCH_LEAK_QUERY as 15b, which
  //     matches no Kansas record).
  const directoryLeakQuery = env.SEARCH_LEAK_QUERY ?? "South Park";
  const searches = await Promise.all(
    ["groups", "locations"].map((kind) =>
      apiGet(`/api/${kind}?search=${encodeURIComponent(directoryLeakQuery)}&pageSize=10`, {
        token: kansasTok,
      }),
    ),
  );
  const searchHits = searches.reduce(
    (n, r) => n + (Array.isArray(r.body?.data) ? r.body.data.length : 0),
    0,
  );
  check(
    `39e. Kansas group and location search "${directoryLeakQuery}" -> 200, no South Park record`,
    searches.every((r) => r.status === 200) && searchHits === 0,
    `status=${searches.map((r) => r.status).join("/")} hits=${searchHits} (expect 0)`,
    { leak: true },
  );
  //     ...nor does the extended provider search, which now also matches group
  //     names and TINs: no South Park provider, and no South Park group on any
  //     row it returns.
  const xProviderSearch = await apiGet(
    `/api/providers?search=${encodeURIComponent(directoryLeakQuery)}&pageSize=10`,
    { token: kansasTok },
  );
  const providerSearchRows = Array.isArray(xProviderSearch.body?.data)
    ? xProviderSearch.body.data
    : [];
  const providerSearchLeaks = providerSearchRows.filter(
    (p) =>
      p?.id === env.SOUTHPARK_PROVIDER_ID ||
      (p?.groups ?? []).some((g) => g?.id === env.SOUTHPARK_GROUP_ID),
  ).length;
  check(
    `39k. Kansas provider search "${directoryLeakQuery}" -> 200, no South Park provider or group`,
    xProviderSearch.status === 200 && providerSearchLeaks === 0,
    `status=${xProviderSearch.status} leaked=${providerSearchLeaks}`,
    { leak: true },
  );
  //     The positive that keeps 39e honest: a search for Kansas's own group
  //     name finds that group.
  const ownGroupName = typeof ownCard?.groups?.[0]?.name === "string" ? ownCard.groups[0].name : "";
  if (ownGroupId && ownGroupName) {
    const ownGroupSearch = await apiGet(
      `/api/groups?search=${encodeURIComponent(ownGroupName)}&pageSize=10`,
      { token: kansasTok },
    );
    check(
      "39l. Kansas group search for its own group's name finds that group",
      ownGroupSearch.status === 200 &&
        Array.isArray(ownGroupSearch.body?.data) &&
        ownGroupSearch.body.data.some((g) => g.id === ownGroupId),
      `status=${ownGroupSearch.status}`,
    );
  } else {
    console.log("SKIP  39l. own group search — the Kansas provider lists no group");
  }

  // ---- Pass/fail table ----
  const w = Math.max(...rows.map((r) => r.name.length));
  const line = "+" + "-".repeat(w + 2) + "+--------+";
  const out = [];
  out.push(line);
  out.push(`| ${"Assertion".padEnd(w)} | Result |`);
  out.push(line);
  for (const r of rows) out.push(`| ${r.name.padEnd(w)} | ${r.pass ? " PASS " : " FAIL "} |`);
  out.push(line);
  const table = out.join("\n");
  console.log("\n" + table);

  const anyFail = rows.some((r) => !r.pass);
  const verdict = anyFail
    ? stopShip
      ? "RESULT: FAIL — STOP-SHIP (cross-org isolation breach)"
      : "RESULT: FAIL"
    : "RESULT: PASS — org isolation holds";
  console.log("\n" + verdict);

  // GitHub job summary (markdown), when running in Actions.
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    const md = [
      "## Provider API — org isolation",
      "",
      "| Assertion | Result |",
      "| --- | --- |",
      ...rows.map((r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`),
      "",
      `**${verdict}**`,
      "",
    ].join("\n");
    appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n");
  }

  process.exit(anyFail ? 1 : 0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(3);
});
