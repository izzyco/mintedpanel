import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { parseDirectoryQuery, type DirectoryQuery } from "@/lib/directory";
import {
  getDirectoryGroup,
  getDirectoryLocation,
  getDirectoryProvider,
  searchDirectory,
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
      const run = () => {
        const out = (tables[table] ?? [])
          .filter((r) => preds.every((p) => p(r)))
          .map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : { ...r }));
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
const TODAY = "2026-11-04";
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
        name: "Sandia Physical Therapy",
        tin: "12-3456789",
        npi_type2: "1999999999",
        states: ["NM"],
        correspondence_street: "PO Box 1",
        correspondence_city: "Albuquerque",
        correspondence_state: "NM",
        correspondence_zip: "87110",
        ...contact,
      },
      { id: G2, org_id: ORG, is_active: false, name: "Sandia Closed Group", states: ["NM"] },
      { id: G3, org_id: OTHER, is_active: true, name: "Sandia Elsewhere", states: ["NM"] },
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
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.query;
}

function setup() {
  const fake = makeDb(fixture());
  const ctx: DirectoryServiceCtx = { db: fake.db, orgId: ORG };
  return { ctx, ...fake };
}

describe("searchDirectory", () => {
  it("finds the org's active groups, providers licensed there, and locations by state name", async () => {
    const { ctx, unscoped } = setup();
    const result = await searchDirectory(ctx, q("New Mexico"), TODAY);
    expect(result.groups.map((g) => g.id)).toEqual([G1]);
    expect(result.providers.map((p) => p.id)).toEqual([P1]);
    expect(result.locations.map((l) => l.id)).toEqual([F1]);
    expect(unscoped).toEqual([]);
  });

  it("matches the state code the same as the name", async () => {
    const { ctx } = setup();
    expect(await searchDirectory(ctx, q("NM"), TODAY)).toEqual(
      await searchDirectory(ctx, q("new mexico"), TODAY),
    );
  });

  it("never returns another org's or inactive records", async () => {
    const { ctx } = setup();
    const result = await searchDirectory(ctx, q("sandia"), TODAY);
    expect(result.groups.map((g) => g.name)).toEqual(["Sandia Physical Therapy"]);
    const albq = await searchDirectory(ctx, q("albuquerque"), TODAY);
    expect(albq.locations.map((l) => l.id)).toEqual([F1]);
    const terry = await searchDirectory(ctx, q("terry"), TODAY);
    expect(terry.providers).toEqual([]);
    const ada = await searchDirectory(ctx, q("ada"), TODAY);
    expect(ada.providers.map((p) => p.id)).toEqual([P1]);
  });

  it("finds a group by TIN with or without the dash, and a provider by NPI, CAQH or email", async () => {
    const { ctx } = setup();
    expect((await searchDirectory(ctx, q("123456789"), TODAY)).groups.map((g) => g.id)).toEqual([
      G1,
    ]);
    expect((await searchDirectory(ctx, q("12-3456789"), TODAY)).groups.map((g) => g.id)).toEqual([
      G1,
    ]);
    expect((await searchDirectory(ctx, q("1234567890"), TODAY)).providers.map((p) => p.id)).toEqual(
      [P1],
    );
    expect((await searchDirectory(ctx, q("55501"), TODAY)).providers.map((p) => p.id)).toEqual([
      P1,
    ]);
    expect((await searchDirectory(ctx, q("ben@"), TODAY)).providers.map((p) => p.id)).toEqual([P4]);
  });

  it("lists a provider's current active groups, primary first", async () => {
    const { ctx } = setup();
    const result = await searchDirectory(ctx, q("okafor"), TODAY);
    expect(result.providers[0].groups).toEqual([
      { id: G1, name: "Sandia Physical Therapy" },
      { id: G4, name: "Front Range Rehab" },
    ]);
    const ben = await searchDirectory(ctx, q("brooks"), TODAY);
    expect(ben.providers[0].groups).toEqual([]);
  });

  it("names a location's group", async () => {
    const { ctx } = setup();
    const result = await searchDirectory(ctx, q("87110"), TODAY);
    expect(result.locations[0].group).toEqual({ id: G1, name: "Sandia Physical Therapy" });
  });

  it("sorts each list A→Z and caps it at 10", async () => {
    const tables = fixture();
    tables.provider_groups = Array.from({ length: 12 }, (_, i) => ({
      id: uuid(100 + i),
      org_id: ORG,
      is_active: true,
      name: `Group ${String.fromCharCode(76 - i)}`,
      states: ["NM"],
    }));
    const { db } = makeDb(tables);
    const result = await searchDirectory({ db, orgId: ORG }, q("group"), TODAY);
    expect(result.groups).toHaveLength(10);
    const names = result.groups.map((g) => g.name);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("Group A");
  });

  it("never carries an SSN", async () => {
    const { ctx } = setup();
    const json = JSON.stringify(await searchDirectory(ctx, q("ada"), TODAY));
    expect(json).not.toContain("4321");
    expect(json.toLowerCase()).not.toContain("ssn");
  });
});

describe("getDirectoryGroup", () => {
  it("returns the active group card with locations, roster, PTAN and current documents", async () => {
    const { ctx, unscoped } = setup();
    const group = await getDirectoryGroup(ctx, G1, TODAY);
    expect(group).toMatchObject({
      id: G1,
      name: "Sandia Physical Therapy",
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

  it("returns null for an inactive or another org's group", async () => {
    const { ctx } = setup();
    expect(await getDirectoryGroup(ctx, G2, TODAY)).toBeNull();
    expect(await getDirectoryGroup(ctx, G3, TODAY)).toBeNull();
  });

  it("returns a null PTAN when no Medicare target holds one", async () => {
    const tables = fixture();
    tables.payer_network_targets = [];
    const { db } = makeDb(tables);
    expect((await getDirectoryGroup({ db, orgId: ORG }, G1, TODAY))?.medicarePtan).toBeNull();
  });
});

describe("getDirectoryProvider", () => {
  it("returns the card with licenses, Medicare IDs, groups and locations", async () => {
    const { ctx, unscoped } = setup();
    const p = await getDirectoryProvider(ctx, P1, TODAY);
    expect(p).toMatchObject({
      id: P1,
      firstName: "Ada",
      middleInitial: "M",
      lastName: "Okafor",
      npi: "1234567890",
      caqhId: "55501",
      dateOfBirth: "1980-01-02",
      languages: ["English", "Igbo"],
      boardCertification: "Yes",
    });
    expect(p?.licenses.map((l) => l.state)).toEqual(["CO", "NM"]);
    // Only the live Medicare fact under an active group.
    expect(p?.medicareIds).toEqual([
      { groupId: G1, groupName: "Sandia Physical Therapy", medicareId: "MCR-1" },
    ]);
    expect(p?.groups).toEqual([
      { id: G1, name: "Sandia Physical Therapy", tin: "12-3456789", isPrimary: true },
      { id: G4, name: "Front Range Rehab", tin: null, isPrimary: false },
    ]);
    expect(p?.locations.map((l) => l.id)).toEqual([F1]);
    expect(unscoped).toEqual([]);
  });

  it("never carries an SSN or ssn_last4", async () => {
    const { ctx } = setup();
    const json = JSON.stringify(await getDirectoryProvider(ctx, P1, TODAY));
    expect(json.toLowerCase()).not.toContain("ssn");
    expect(json).not.toContain("4321");
  });

  it("returns null for a terminated or another org's provider", async () => {
    const { ctx } = setup();
    expect(await getDirectoryProvider(ctx, P2, TODAY)).toBeNull();
    expect(await getDirectoryProvider(ctx, P3, TODAY)).toBeNull();
  });

  it("returns empty lists when the provider has none", async () => {
    const { ctx } = setup();
    const p = await getDirectoryProvider(ctx, P4, TODAY);
    expect(p).toMatchObject({
      licenses: [],
      medicareIds: [],
      groups: [],
      locations: [],
      languages: [],
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
      group: { id: G1, name: "Sandia Physical Therapy", tin: "12-3456789", npiType2: "1999999999" },
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
