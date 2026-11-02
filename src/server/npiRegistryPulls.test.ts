// MINT-110 PR 3 — POST /api/npi-registry/pulls: writer-only, validated, the
// provider in the caller's org and holding the NPI, the reply from the
// server's cache or the registry (never the body), `sourced` cut to what the
// save holds and the registry gave, and one insert stamped from the guard.
// No network: fetch is injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext } from "./guard";
import {
  handleNpiRegistryLookup,
  handleNpiRegistryPull,
  resetNpiRegistryLimits,
} from "./npiRegistryRoutes";
import { NPI_REGISTRY_BATCH_PER_MINUTE } from "@/lib/npiRegistryBatch";
import type { NpiRegistryPullResult } from "@/lib/npiRegistryPulls";
import { isValidNpi } from "@/lib/providerIdentity";

const ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "55555555-5555-4555-8555-555555555555";
const OTHER_PROVIDER = "66666666-6666-4666-8666-666666666666";
const NPI = "1234567893";

const NPPES_RECORD = {
  number: NPI,
  enumeration_type: "NPI-1",
  basic: { first_name: "JANE", last_name: "DOE", credential: "DPT", status: "A", sex: "F" },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "DENVER",
      state: "CO",
      country_code: "US",
      telephone_number: "303-555-0199",
    },
  ],
  taxonomies: [
    {
      code: "225100000X",
      desc: "Physical Therapist",
      primary: true,
      license: "PT-4471",
      state: "CO",
    },
  ],
};

function registry(results: unknown[] = [NPPES_RECORD]) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ result_count: results.length, results }), {
        headers: { "content-type": "application/json" },
      }),
  );
}

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () =>
        (tables[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value));
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => {
          reads.push({ table, filters });
          return { data: rows()[0] ?? null, error: null };
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          reads.push({ table, filters });
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
        insert(row: Row) {
          inserts.push({ table, row });
          return {
            select: () => ({
              single: async () => ({
                data: { id: "77777777-7777-4777-8777-777777777777", pulled_at: row.pulled_at },
                error: null,
              }),
            }),
          };
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as AuthContext["db"], inserts, reads };
}

function fixture(over: { npi?: string | null; role?: AuthContext["role"] } = {}) {
  const { db, inserts, reads } = fakeDb({
    providers: [
      {
        id: PROVIDER,
        org_id: ORG,
        npi: over.npi === undefined ? "123-456-7893" : over.npi,
        credentials: "DPT",
        taxonomy_code: "225100000X",
        gender: "female",
        phone: "303-555-0199",
      },
      { id: OTHER_PROVIDER, org_id: OTHER_ORG, npi: NPI },
    ],
    state_licenses: [
      { org_id: ORG, provider_id: PROVIDER, state: "CO", license_number: "PT-4471" },
      { org_id: OTHER_ORG, provider_id: OTHER_PROVIDER, state: "WY", license_number: "WY-1" },
    ],
  });
  const ctx: AuthContext = {
    userId: USER,
    orgId: ORG,
    role: over.role ?? "specialist",
    userName: "Jordan Seed",
    email: "jordan@minted.example",
    userMetadata: null,
    db,
    writeAudit: vi.fn(),
  };
  return { ctx, inserts, reads };
}

const BODY = {
  providerId: PROVIDER,
  npi: NPI,
  sourced: {
    credentials: "DPT",
    taxonomyCode: "225100000X",
    gender: "female",
    phone: "303-555-0199",
    licenses: [{ state: "CO", number: "PT-4471" }],
  },
  confirmed: true,
};

async function envelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  return (await response.json()) as ApiEnvelope<T>;
}

let now = 0;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = 1_000_000;
  resetNpiRegistryLimits(() => now);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("POST /api/npi-registry/pulls", () => {
  it("stores the registry's reply and what the save took from it, once, for the caller's org", async () => {
    const { ctx, inserts } = fixture();
    const fetchFn = registry();
    const pulledAt = new Date("2026-11-01T12:00:00.000Z");
    const res = await handleNpiRegistryPull(BODY, ctx, { fetch: fetchFn, now: () => pulledAt });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(fetchFn).toHaveBeenCalledOnce();
    // Only the NPI goes upstream.
    expect(String(fetchFn.mock.calls[0][0])).toContain(`number=${NPI}`);
    expect(inserts).toHaveLength(1);
    const { table, row } = inserts[0];
    expect(table).toBe("provider_registry_pulls");
    expect(row).toMatchObject({
      org_id: ORG,
      provider_id: PROVIDER,
      npi: NPI,
      pulled_at: "2026-11-01T12:00:00.000Z",
      pulled_by: USER,
      sourced: BODY.sourced,
      confirmed: true,
    });
    expect(row.reply).toMatchObject({ npi: NPI, lastName: "DOE", credential: "DPT", sex: "F" });
    const body = await envelope<NpiRegistryPullResult>(res);
    expect(body.data).toEqual({
      pull: {
        id: "77777777-7777-4777-8777-777777777777",
        pulledAt: "2026-11-01T12:00:00.000Z",
        sourced: BODY.sourced,
        confirmed: true,
      },
    });
  });

  it("reuses the server's cached answer, with its own pull time, and never the body's data", async () => {
    const { ctx, inserts } = fixture();
    const fetchFn = registry();
    const pulledAt = new Date("2026-11-01T09:30:00.000Z");
    // The form's background check already asked the registry.
    await handleNpiRegistryLookup({ npi: NPI }, ctx, { fetch: fetchFn, now: () => pulledAt });
    const res = await handleNpiRegistryPull(
      { ...BODY, confirmed: false, sourced: { credentials: "DPT" } },
      ctx,
      { fetch: fetchFn },
    );
    expect(res.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(inserts[0].row).toMatchObject({
      pulled_at: "2026-11-01T09:30:00.000Z",
      sourced: { credentials: "DPT" },
      confirmed: false,
    });
  });

  it("keeps a field in sourced only when the saved value is the registry's", async () => {
    const { ctx, inserts } = fixture();
    const fetchFn = registry([
      {
        ...NPPES_RECORD,
        basic: { ...NPPES_RECORD.basic, credential: "PT", sex: "M" },
        taxonomies: [{ code: "225100000X", desc: "Physical Therapist", primary: true }],
      },
    ]);
    const res = await handleNpiRegistryPull(BODY, ctx, { fetch: fetchFn });
    expect(res.status).toBe(201);
    expect(inserts[0].row.sourced).toEqual({
      taxonomyCode: "225100000X",
      phone: "303-555-0199",
    });
  });

  it("stores a reply with no record, and sources nothing from it", async () => {
    const { ctx, inserts } = fixture();
    const res = await handleNpiRegistryPull(BODY, ctx, { fetch: registry([]) });
    expect(res.status).toBe(201);
    expect(inserts[0].row).toMatchObject({ reply: null, sourced: {} });
  });

  it("is writer-only: billing gets 403 and nothing is read, fetched or written", async () => {
    const { ctx, inserts, reads } = fixture({ role: "billing" });
    const fetchFn = registry();
    const res = await handleNpiRegistryPull(BODY, ctx, { fetch: fetchFn });
    expect(res.status).toBe(403);
    expect(reads).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("validates the body before reading anything", async () => {
    const { ctx, inserts, reads } = fixture();
    const fetchFn = registry();
    for (const body of [{}, { ...BODY, npi: "1234567890" }, { ...BODY, sourced: { reply: {} } }]) {
      const res = await handleNpiRegistryPull(body, ctx, { fetch: fetchFn });
      expect(res.status).toBe(422);
    }
    expect(reads).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("404s another org's provider before any registry call or write", async () => {
    const { ctx, inserts, reads } = fixture();
    const fetchFn = registry();
    const res = await handleNpiRegistryPull({ ...BODY, providerId: OTHER_PROVIDER }, ctx, {
      fetch: fetchFn,
    });
    expect(res.status).toBe(404);
    expect(reads[0]).toEqual({
      table: "providers",
      filters: [
        ["org_id", ORG],
        ["id", OTHER_PROVIDER],
      ],
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("409s a provider that doesn't hold the NPI", async () => {
    for (const npi of [null, "1902833742"]) {
      const { ctx, inserts } = fixture({ npi });
      const fetchFn = registry();
      const res = await handleNpiRegistryPull(BODY, ctx, { fetch: fetchFn });
      expect(res.status).toBe(409);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    }
  });

  it("reads the provider's licenses in its own org only", async () => {
    const { ctx, reads } = fixture();
    await handleNpiRegistryPull(BODY, ctx, { fetch: registry() });
    expect(reads.find((read) => read.table === "state_licenses")?.filters).toEqual([
      ["org_id", ORG],
      ["provider_id", PROVIDER],
    ]);
  });

  it("writes nothing when the registry fails, and logs the failure kind only", async () => {
    const { ctx, inserts } = fixture();
    const down = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    const res = await handleNpiRegistryPull(BODY, ctx, { fetch: down });
    expect(res.status).toBe(502);
    expect(inserts).toEqual([]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("http 503");
    expect(logged).not.toContain(NPI);
    expect(logged).not.toContain(PROVIDER);
  });

  it("spends the batch window only on a fresh lookup", async () => {
    const fetchFn = registry();
    // A cached answer costs nothing, however often a save records it.
    const cached = fixture();
    await handleNpiRegistryLookup({ npi: NPI }, cached.ctx, { fetch: fetchFn });
    for (let i = 0; i < NPI_REGISTRY_BATCH_PER_MINUTE + 5; i += 1) {
      expect((await handleNpiRegistryPull(BODY, cached.ctx, { fetch: fetchFn })).status).toBe(201);
    }
    expect(fetchFn).toHaveBeenCalledOnce();
    // Each fresh lookup counts; past the window it is a 429 with Retry-After,
    // and nothing is written.
    const npis = validNpis(NPI_REGISTRY_BATCH_PER_MINUTE + 1);
    for (const npi of npis.slice(0, -1)) {
      const { ctx } = fixture({ npi });
      expect((await handleNpiRegistryPull({ ...BODY, npi }, ctx, { fetch: fetchFn })).status).toBe(
        201,
      );
    }
    const last = fixture({ npi: npis.at(-1) });
    const limited = await handleNpiRegistryPull({ ...BODY, npi: npis.at(-1) }, last.ctx, {
      fetch: fetchFn,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(last.inserts).toEqual([]);
  });
});

// Distinct check-digit-valid NPIs other than NPI.
function validNpis(count: number): string[] {
  const npis: string[] = [];
  for (let base = 190000000; npis.length < count; base += 1) {
    for (let digit = 0; digit < 10; digit += 1) {
      const npi = `${base}${digit}`;
      if (isValidNpi(npi) && npi !== NPI) {
        npis.push(npi);
        break;
      }
    }
  }
  return npis;
}
