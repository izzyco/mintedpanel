import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { parseDirectoryQuery, type DirectoryQuery } from "@/lib/directory";
import {
  filterProvidersBySearch,
  getDirectoryGroup,
  getDirectoryLocation,
  getProviderDirectoryExtras,
  listDirectoryGroups,
  listDirectoryLocations,
  type DirectoryServiceCtx,
} from "./directory";

// A small in-memory PostgREST stand-in: rows per table (snake_case), and the
// filters the service uses (eq, neq, in, is) actually applied, so org
// isolation and active-only reads are behavior, not call-shape assertions.
// `select` projects the named columns, so a column the service does not ask
// for can never reach a payload.
type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
  const queried: string[] = [];
  const unscoped: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      let cols: string[] | null = null;
      const preds: Array<(r: Row) => boolean> = [];
      let orgScoped = false;
      let orderBy: string | null = null;
      let window: [number, number] | null = null;
      const run = () => {
        let matched = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (orderBy) {
          const col = orderBy;
          matched = [...matched].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
        }
        // PostgREST's silent max-rows cap on an unranged read.
        matched = window ? matched.slice(window[0], window[1] + 1) : matched.slice(0, 1000);
        const out = matched.map((r) =>
          cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : { ...r },
        );
        if (!orgScoped && table !== "payers") unscoped.push(table);
        return out;
      };
      const builder = {
        select(c: string) {
          cols = c.split(",").map((s) => s.trim());
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "org_id") orgScoped = true;
          preds.push((r) => r[col] === val);
          return builder;
        },
        neq(col: string, val: unknown) {
          preds.push((r) => r[col] !== val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          preds.push((r) => vals.includes(r[col]));
          return builder;
        },
        order(col: string) {
          orderBy = col;
          return builder;
        },
        range(from: number, to: number) {
          window = [from, to];
          return builder;
        },
        is(col: string, val: unknown) {
          preds.push((r) => (r[col] ?? null) === val);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(res, rej),
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, queried, unscoped };
}

const ORG = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const uuid = (n: number) => `10000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const G1 = uuid(1); // active, NM
const G2 = uuid(2); // inactive
const G3 = uuid(3); // other org
const G4 = uuid(4); // active, CO
const P1 = uuid(11);
const P2 = uuid(12); // terminated
const P3 = uuid(13); // other org
const P4 = uuid(14);
const F1 = uuid(21);
const F2 = uuid(22); // inactive
const F3 = uuid(23); // other org
const MEDICARE = uuid(31);
const AETNA = uuid(32);

function fixture(): Record<string, Row[]> {
  const contact = {
    credentialing_phone: null,
    correspondence_phone: "(505) 555-0199",
    correspondence_fax: "(505) 555-0198",
  };
  return {
    provider_groups: [
      {
        id: G1,
        org_id: ORG,
        is_active: true,
        name: "Sample Physical Therapy",
        tin: "12-3456789",
        npi_type2: "1999999999",
        states: ["NM"],
        correspondence_street: "PO Box 1",
        correspondence_city: "Albuquerque",
        correspondence_state: "NM",
        correspondence_zip: "87110",
        ...contact,
      },
      { id: G2, org_id: ORG, is_active: false, name: "Sample Closed Group", states: ["NM"] },
      { id: G3, org_id: OTHER, is_active: true, name: "Sample Elsewhere", states: ["NM"] },
      { id: G4, org_id: ORG, is_active: true, name: "Front Range Rehab", states: ["CO"] },
    ],
    providers: [
      {
        id: P1,
        org_id: ORG,
        status: "active",
        first_name: "Ada",
        last_name: "Okafor",
        middle_initial: "M",
        credentials: "PT, DPT",
        npi: "1234567890",
        caqh_id: "55501",
        email: "ada@example.com",
        ssn_last4: "4321",
        date_of_birth: "1980-01-02",
        languages: ["English", "Igbo"],
        board_certified: true,
      },
      {
        id: P2,
        org_id: ORG,
        status: "terminated",
        first_name: "Terry",
        last_name: "Gone",
        npi: "1111111111",
      },
      { id: P3, org_id: OTHER, status: "active", first_name: "Ada", last_name: "Other" },
      {
        id: P4,
        org_id: ORG,
        status: "onboarding",
        first_name: "Ben",
        last_name: "Brooks",
        email: "ben@example.com",
      },
    ],
    state_licenses: [
      {
        org_id: ORG,
        provider_id: P1,
        state: "NM",
        license_number: "NM-1",
        expiration_date: "2027-01-01",
      },
      { org_id: ORG, provider_id: P1, state: "CO", license_number: "CO-9", expiration_date: null },
      { org_id: ORG, provider_id: P2, state: "NM", license_number: "NM-2" },
      { org_id: OTHER, provider_id: P3, state: "NM", license_number: "NM-3" },
    ],
    provider_group_assignments: [
      { org_id: ORG, provider_id: P1, group_id: G4, is_primary: false, end_date: null },
      { org_id: ORG, provider_id: P1, group_id: G1, is_primary: true, end_date: null },
      { org_id: ORG, provider_id: P1, group_id: G2, is_primary: false, end_date: null },
      { org_id: ORG, provider_id: P4, group_id: G1, is_primary: true, end_date: "2026-01-01" },
      { org_id: ORG, provider_id: P2, group_id: G1, is_primary: true, end_date: null },
    ],
    facilities: [
      {
        id: F1,
        org_id: ORG,
        is_active: true,
        group_id: G1,
        name: "Albuquerque – Uptown",
        street: "2400 Louisiana Blvd NE",
        suite: "Suite 120",
        city: "Albuquerque",
        state: "NM",
        zip: "87110",
        phone: null,
        fax: null,
        hours: {},
      },
      {
        id: F2,
        org_id: ORG,
        is_active: false,
        group_id: G1,
        name: "Albuquerque – Old",
        state: "NM",
      },
      {
        id: F3,
        org_id: OTHER,
        is_active: true,
        group_id: G3,
        name: "Albuquerque – Other",
        state: "NM",
      },
    ],
    provider_facility_assignments: [
      { org_id: ORG, provider_id: P1, facility_id: F1 },
      { org_id: ORG, provider_id: P2, facility_id: F1 },
      { org_id: ORG, provider_id: P1, facility_id: F2 },
    ],
    payers: [
      { id: MEDICARE, payer_kind: "medicare" },
      { id: AETNA, payer_kind: "commercial" },
    ],
    payer_network_targets: [
      {
        org_id: ORG,
        group_id: G1,
        payer_id: MEDICARE,
        state: "NM",
        status: "active",
        payer_issued_id: "PTAN-NM",
      },
      {
        org_id: ORG,
        group_id: G1,
        payer_id: MEDICARE,
        state: "CO",
        status: "archived",
        payer_issued_id: "OLD",
      },
      {
        org_id: ORG,
        group_id: G1,
        payer_id: AETNA,
        state: "NM",
        status: "active",
        payer_issued_id: "AET-1",
      },
      {
        org_id: OTHER,
        group_id: G1,
        payer_id: MEDICARE,
        state: "TX",
        status: "active",
        payer_issued_id: "LEAK",
      },
    ],
    enrollment_facts: [
      {
        org_id: ORG,
        provider_id: P1,
        group_id: G1,
        payer_id: MEDICARE,
        payer_issued_id: "MCR-1",
        expired_at: null,
      },
      {
        org_id: ORG,
        provider_id: P1,
        group_id: G4,
        payer_id: MEDICARE,
        payer_issued_id: "MCR-OLD",
        expired_at: "2026-01-01",
      },
      {
        org_id: ORG,
        provider_id: P1,
        group_id: G1,
        payer_id: AETNA,
        payer_issued_id: "AET-P",
        expired_at: null,
      },
      {
        org_id: ORG,
        provider_id: P1,
        group_id: G2,
        payer_id: MEDICARE,
        payer_issued_id: "MCR-INACTIVE",
        expired_at: null,
      },
    ],
    provider_documents: [
      {
        id: uuid(41),
        org_id: ORG,
        group_id: G1,
        provider_id: null,
        doc_type: "w9",
        document_family_id: "fam-w9",
        supersedes_document_id: null,
        version_number: 1,
        effective_date: "2025-01-01",
        expiration_date: null,
      },
      {
        id: uuid(42),
        org_id: ORG,
        group_id: G1,
        provider_id: null,
        doc_type: "w9",
        document_family_id: "fam-w9",
        supersedes_document_id: uuid(41),
        version_number: 2,
        effective_date: "2026-01-01",
        expiration_date: null,
      },
      {
        id: uuid(43),
        org_id: ORG,
        group_id: G1,
        provider_id: P1,
        doc_type: "license",
        document_family_id: "fam-lic",
        supersedes_document_id: null,
        version_number: 1,
      },
      {
        id: uuid(44),
        org_id: OTHER,
        group_id: G1,
        provider_id: null,
        doc_type: "coi",
        document_family_id: "fam-x",
        supersedes_document_id: null,
        version_number: 1,
      },
    ],
  };
}

function q(raw: string): DirectoryQuery {
  const parsed = parseDirectoryQuery(raw);
  if (!parsed.ok || !parsed.query) throw new Error("expected a query");
  return parsed.query;
}

function setup() {
  const fake = makeDb(fixture());
  const ctx: DirectoryServiceCtx = { db: fake.db, orgId: ORG };
  return { ctx, ...fake };
}

const ids = (page: { rows: { id: string }[] }) => page.rows.map((r) => r.id);

describe("listDirectoryGroups", () => {
  it("lists every active group of the org A→Z when there is no search", async () => {
    const { ctx, unscoped } = setup();
    const page = await listDirectoryGroups(ctx, null, 1, 25);
    expect(page.rows).toEqual([
      { id: G4, name: "Front Range Rehab", tin: null, states: ["CO"] },
      { id: G1, name: "Sample Physical Therapy", tin: "12-3456789", states: ["NM"] },
    ]);
    expect(page.total).toBe(2);
    expect(unscoped).toEqual([]);
  });

  it("matches name, TIN with or without the dash, Group NPI, and state code or name", async () => {
    const { ctx } = setup();
    for (const raw of ["sample", "123456789", "12-3456789", "1999999999", "NM", "New Mexico"]) {
      expect(ids(await listDirectoryGroups(ctx, q(raw), 1, 25))).toEqual([G1]);
    }
  });

  it("never returns another org's or an inactive group", async () => {
    const { ctx } = setup();
    expect(ids(await listDirectoryGroups(ctx, q("sample"), 1, 25))).toEqual([G1]);
  });

  it("pages A→Z with an exact total", async () => {
    const tables = fixture();
    tables.provider_groups = Array.from({ length: 12 }, (_, i) => ({
      id: uuid(100 + i),
      org_id: ORG,
      is_active: true,
      name: `Group ${String.fromCharCode(76 - i)}`,
      states: ["NM"],
    }));
    const { db } = makeDb(tables);
    const first = await listDirectoryGroups({ db, orgId: ORG }, q("group"), 1, 10);
    expect(first.total).toBe(12);
    expect(first.rows.map((g) => g.name)).toEqual("ABCDEFGHIJ".split("").map((c) => `Group ${c}`));
    const second = await listDirectoryGroups({ db, orgId: ORG }, q("group"), 2, 10);
    expect(second.rows.map((g) => g.name)).toEqual(["Group K", "Group L"]);
  });

  it("reads past PostgREST's 1000-row cap", async () => {
    const tables = fixture();
    tables.provider_groups = Array.from({ length: 1200 }, (_, i) => ({
      id: uuid(1000 + i),
      org_id: ORG,
      is_active: true,
      name: i === 1199 ? "Zuni Last Group" : `Filler ${i}`,
      states: [],
    }));
    const { db } = makeDb(tables);
    const page = await listDirectoryGroups({ db, orgId: ORG }, q("zuni"), 1, 10);
    expect(page.rows.map((g) => g.name)).toEqual(["Zuni Last Group"]);
    expect((await listDirectoryGroups({ db, orgId: ORG }, null, 1, 10)).total).toBe(1200);
  });
});

describe("listDirectoryLocations", () => {
  it("lists the org's active locations with their group when there is no search", async () => {
    const { ctx, unscoped } = setup();
    const page = await listDirectoryLocations(ctx, null, 1, 25);
    expect(page).toEqual({
      rows: [
        {
          id: F1,
          name: "Albuquerque – Uptown",
          city: "Albuquerque",
          state: "NM",
          group: { id: G1, name: "Sample Physical Therapy" },
        },
      ],
      total: 1,
    });
    expect(unscoped).toEqual([]);
  });

  it("matches name, street, city, ZIP, state code or name, and group name", async () => {
    const { ctx } = setup();
    for (const raw of [
      "uptown",
      "louisiana",
      "albuquerque",
      "87110",
      "NM",
      "New Mexico",
      "sample",
    ]) {
      expect(ids(await listDirectoryLocations(ctx, q(raw), 1, 25))).toEqual([F1]);
    }
    expect(ids(await listDirectoryLocations(ctx, q("front range"), 1, 25))).toEqual([]);
  });

  it("shows no group when the owning group is inactive", async () => {
    const tables = fixture();
    tables.facilities[0].group_id = G2;
    const { db } = makeDb(tables);
    const page = await listDirectoryLocations({ db, orgId: ORG }, null, 1, 25);
    expect(page.rows[0].group).toBeNull();
  });
});

describe("filterProvidersBySearch", () => {
  // What GET /api/providers hands in: the org's non-terminated list rows.
  const candidates = [
    { id: P4, firstName: "Ben", lastName: "Brooks", npi: null, email: "ben@example.com" },
    {
      id: P1,
      firstName: "Ada",
      lastName: "Okafor",
      npi: "1234567890",
      email: "ada@example.com",
      caqhId: "55501",
    },
  ];
  const match = async (raw: string) => {
    const { ctx } = setup();
    return (await filterProvidersBySearch(ctx, candidates, q(raw))).map((p) => p.id);
  };

  it("matches what the plain search did: name, NPI, email", async () => {
    expect(await match("okafor")).toEqual([P1]);
    expect(await match("1234567890")).toEqual([P1]);
    expect(await match("ben@")).toEqual([P4]);
  });

  it("also matches CAQH ID and license state by code or name", async () => {
    expect(await match("55501")).toEqual([P1]);
    expect(await match("NM")).toEqual([P1]);
    expect(await match("New Mexico")).toEqual([P1]);
  });

  it("also matches the name and TIN of a current, active group", async () => {
    expect(await match("front range")).toEqual([P1]);
    const tables = fixture();
    tables.provider_groups[3].tin = "98-7654321";
    const { db } = makeDb(tables);
    for (const tin of ["98-7654321", "987654321"]) {
      const rows = await filterProvidersBySearch({ db, orgId: ORG }, candidates, q(tin));
      expect(rows.map((p) => p.id)).toEqual([P1]);
    }
    // P4's only assignment ended; the inactive group never matches.
    expect(await match("sample")).toEqual([P1]);
    expect(await match("closed")).toEqual([]);
  });

  it("counts a group only while the assignment has no end date, as the list row does", async () => {
    const tables = fixture();
    // Ends in the future: already off the list row's groups[], so off search too.
    tables.provider_group_assignments[0].end_date = "2099-12-31";
    const { db } = makeDb(tables);
    const rows = await filterProvidersBySearch({ db, orgId: ORG }, candidates, q("front range"));
    expect(rows).toEqual([]);
  });

  it("never treats a lower-case pair as a license state", async () => {
    expect(await match("nm")).toEqual([]);
  });

  it("needs every term to match, so a name plus a group narrows", async () => {
    expect(await match("ada sample")).toEqual([P1]);
    expect(await match("ben sample")).toEqual([]);
  });

  it("keeps the caller's order and scopes every read to the org", async () => {
    const { ctx, unscoped } = setup();
    const rows = await filterProvidersBySearch(ctx, candidates, q("example"));
    expect(rows.map((p) => p.id)).toEqual([P4, P1]);
    expect(unscoped).toEqual([]);
  });
});

describe("getDirectoryGroup", () => {
  it("returns the active group card with locations, roster, PTAN and current documents", async () => {
    const { ctx, unscoped } = setup();
    const group = await getDirectoryGroup(ctx, G1);
    expect(group).toMatchObject({
      id: G1,
      name: "Sample Physical Therapy",
      legalName: null,
      tin: "12-3456789",
      npiType2: "1999999999",
      medicarePtan: "PTAN-NM",
      states: ["NM"],
      phone: "(505) 555-0199",
      mailingAddress: "PO Box 1, Albuquerque, NM 87110",
    });
    expect(group?.locations.map((l) => l.id)).toEqual([F1]);
    // P1 current; P2 terminated; P4's assignment ended.
    expect(group?.providers.map((p) => p.id)).toEqual([P1]);
    expect(group?.documents).toEqual([
      {
        id: uuid(42),
        docType: "w9",
        label: expect.any(String),
        effectiveDate: "2026-01-01",
        expirationDate: null,
      },
    ]);
    expect(unscoped).toEqual([]);
  });

  it("lists a large roster in full (ids read in chunks)", async () => {
    const tables = fixture();
    const ids = Array.from({ length: 250 }, (_, i) => uuid(5000 + i));
    tables.providers.push(
      ...ids.map((id, i) => ({
        id,
        org_id: ORG,
        status: "active",
        first_name: "P",
        last_name: `Roster${String(i).padStart(3, "0")}`,
      })),
    );
    tables.provider_group_assignments.push(
      ...ids.map((id) => ({ org_id: ORG, provider_id: id, group_id: G1, end_date: null })),
    );
    const { db } = makeDb(tables);
    const group = await getDirectoryGroup({ db, orgId: ORG }, G1);
    expect(group?.providers).toHaveLength(251);
  });

  it("returns null for an inactive or another org's group", async () => {
    const { ctx } = setup();
    expect(await getDirectoryGroup(ctx, G2)).toBeNull();
    expect(await getDirectoryGroup(ctx, G3)).toBeNull();
  });

  it("returns a null PTAN when no Medicare target holds one", async () => {
    const tables = fixture();
    tables.payer_network_targets = [];
    const { db } = makeDb(tables);
    expect((await getDirectoryGroup({ db, orgId: ORG }, G1))?.medicarePtan).toBeNull();
  });
});

describe("getProviderDirectoryExtras", () => {
  it("returns licenses, Medicare IDs, groups and locations", async () => {
    const { ctx, unscoped } = setup();
    const extras = await getProviderDirectoryExtras(ctx, P1);
    expect(extras.licenses).toEqual([
      { state: "CO", licenseNumber: "CO-9", expirationDate: null },
      { state: "NM", licenseNumber: "NM-1", expirationDate: "2027-01-01" },
    ]);
    // Only the live Medicare fact under an active group.
    expect(extras.medicareIds).toEqual([
      { groupId: G1, groupName: "Sample Physical Therapy", medicareId: "MCR-1" },
    ]);
    expect(extras.groups).toEqual([
      { id: G1, name: "Sample Physical Therapy", tin: "12-3456789", isPrimary: true },
      { id: G4, name: "Front Range Rehab", tin: null, isPrimary: false },
    ]);
    expect(extras.locations).toEqual([
      { id: F1, name: "Albuquerque – Uptown", city: "Albuquerque", state: "NM" },
    ]);
    expect(unscoped).toEqual([]);
  });

  it("never reads another org's rows", async () => {
    const { ctx } = setup();
    const extras = await getProviderDirectoryExtras(ctx, P3);
    expect(extras).toEqual({ licenses: [], medicareIds: [], groups: [], locations: [] });
  });

  it("returns empty lists when the provider has none", async () => {
    const { ctx } = setup();
    expect(await getProviderDirectoryExtras(ctx, P4)).toEqual({
      licenses: [],
      medicareIds: [],
      groups: [],
      locations: [],
    });
  });
});

describe("getDirectoryLocation", () => {
  it("returns the card with the owning group and the active providers there", async () => {
    const { ctx, unscoped } = setup();
    const loc = await getDirectoryLocation(ctx, F1);
    expect(loc).toMatchObject({
      id: F1,
      name: "Albuquerque – Uptown",
      street: "2400 Louisiana Blvd NE",
      zip: "87110",
      // No own contact: the owning group's block, as the facility page shows.
      phone: "(505) 555-0199",
      fax: "(505) 555-0198",
      placeOfService: null,
      hours: null,
      group: { id: G1, name: "Sample Physical Therapy", tin: "12-3456789", npiType2: "1999999999" },
    });
    expect(loc?.providers.map((p) => p.id)).toEqual([P1]);
    expect(unscoped).toEqual([]);
  });

  it("returns null for an inactive or another org's location", async () => {
    const { ctx } = setup();
    expect(await getDirectoryLocation(ctx, F2)).toBeNull();
    expect(await getDirectoryLocation(ctx, F3)).toBeNull();
  });
});
