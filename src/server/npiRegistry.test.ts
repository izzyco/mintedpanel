// MINT-110 — the NPPES client: what it sends, how it narrows the reply to
// public fields, and how every upstream failure becomes one plain error. No
// network: fetch is always injected.
import { describe, expect, it, vi } from "vitest";
import {
  FixedWindowRateLimiter,
  NPPES_API_URL,
  NPPES_IDENTIFIERS_MAX,
  NPPES_PRACTICE_LOCATIONS_MAX,
  NPPES_TAXONOMIES_MAX,
  NpiRegistryQueryRejectedError,
  NpiRegistryUnavailableError,
  TtlCache,
  lookupNppes,
  parseNppesResponse,
  searchNppes,
  toNpiRegistryRecord,
} from "./npiRegistry";
import { NPI_REGISTRY_UNAVAILABLE_MESSAGE } from "@/lib/npiRegistry";

// Trimmed from a real registry reply (NPPES API v2.1).
const NPPES_INDIVIDUAL = {
  addresses: [
    {
      address_1: "100 MAIN ST",
      address_purpose: "MAILING",
      city: "BOULDER",
      state: "CO",
      postal_code: "803021234",
      telephone_number: "303-555-0100",
    },
    {
      address_1: "200 CLINIC WAY",
      address_purpose: "LOCATION",
      city: "DENVER",
      state: "CO",
      postal_code: "802021234",
      telephone_number: "303-555-0199",
    },
  ],
  basic: {
    credential: "PT, DPT",
    enumeration_date: "2015-03-02",
    first_name: "JANE",
    middle_name: "A",
    last_name: "DOE",
    last_updated: "2024-01-01",
    sex: "F",
    sole_proprietor: "NO",
    status: "A",
    name_prefix: "--",
    name_suffix: "JR",
    certification_date: "2020-01-01",
  },
  created_epoch: "1425254400000",
  endpoints: [],
  enumeration_type: "NPI-1",
  identifiers: [
    { code: "05", desc: "MEDICAID", identifier: "MEDICAID-1", issuer: "", state: "CO" },
  ],
  number: "1234567893",
  other_names: [
    { type: "Former Name", code: "1", first_name: "JANE", middle_name: "Q", last_name: "SMITH" },
  ],
  practiceLocations: [
    {
      address_1: "300 SATELLITE RD",
      address_purpose: "LOCATION",
      city: "GOLDEN",
      country_code: "US",
      state: "CO",
      postal_code: "80401",
      fax_number: "303-555-0111",
    },
  ],
  taxonomies: [
    {
      code: "2251X0800X",
      desc: "Physical Therapist, Orthopedic",
      license: "PTL-1",
      primary: false,
      state: "CO",
    },
    {
      code: "225100000X",
      desc: "Physical Therapist",
      license: "PTL-2",
      primary: true,
      state: "CO",
    },
  ],
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchReturning(...responses: Array<Response | Error>) {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fn.mockRejectedValueOnce(response);
    else fn.mockResolvedValueOnce(response);
  }
  return fn;
}

function calledUrl(fn: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): URL {
  return new URL(String(fn.mock.calls[call][0]));
}

describe("toNpiRegistryRecord", () => {
  it("keeps only the public registry fields a pick can fill or show", () => {
    expect(toNpiRegistryRecord(NPPES_INDIVIDUAL)).toEqual({
      npi: "1234567893",
      enumerationType: "NPI-1",
      firstName: "JANE",
      middleName: "A",
      lastName: "DOE",
      organizationName: null,
      credential: "PT, DPT",
      primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
      practiceCity: "DENVER",
      practiceState: "CO",
      status: "active",
      enumerationDate: "2015-03-02",
      otherNames: [{ firstName: "JANE", lastName: "SMITH", middleName: "Q", type: "Former Name" }],
      suffix: "JR",
      // A36: a candidate for Gender, never filled.
      sex: "F",
      // The primary first, then registry order.
      taxonomies: [
        {
          code: "225100000X",
          description: "Physical Therapist",
          primary: true,
          license: "PTL-2",
          licenseState: "CO",
        },
        {
          code: "2251X0800X",
          description: "Physical Therapist, Orthopedic",
          primary: false,
          license: "PTL-1",
          licenseState: "CO",
        },
      ],
      practiceAddress: {
        line1: "200 CLINIC WAY",
        line2: null,
        city: "DENVER",
        state: "CO",
        postalCode: "802021234",
        countryCode: null,
        phone: "303-555-0199",
      },
      mailingAddress: {
        line1: "100 MAIN ST",
        line2: null,
        city: "BOULDER",
        state: "CO",
        postalCode: "803021234",
        countryCode: null,
        phone: "303-555-0100",
      },
      otherPracticeAddresses: [
        {
          line1: "300 SATELLITE RD",
          line2: null,
          city: "GOLDEN",
          state: "CO",
          postalCode: "80401",
          countryCode: "US",
          phone: null,
        },
      ],
      identifiers: [{ identifier: "MEDICAID-1", type: "MEDICAID", state: "CO", issuer: null }],
    });
    // Registry fields with no use here stay behind: sole proprietor, dates
    // other than enumeration, fax numbers, the prefix placeholder.
    const json = JSON.stringify(toNpiRegistryRecord(NPPES_INDIVIDUAL));
    for (const dropped of ["sole", "2024-01-01", "2020-01-01", "303-555-0111", "--"]) {
      expect(json).not.toContain(dropped);
    }
  });

  it("caps every list and drops empty rows", () => {
    const many = <T>(count: number, row: (i: number) => T) =>
      Array.from({ length: count }, (_, i) => row(i));
    const record = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      taxonomies: [
        { desc: "no code", primary: true },
        ...many(20, (i) => ({ code: `22510000${i}X`, primary: false })),
      ],
      identifiers: [{ desc: "no number" }, ...many(14, (i) => ({ identifier: `ID-${i}` }))],
      practiceLocations: [
        { address_purpose: "LOCATION" },
        ...many(8, (i) => ({ address_1: `${i} WAY` })),
      ],
      addresses: [{ address_purpose: "MAILING", address_1: "--" }],
    });
    expect(record?.taxonomies).toHaveLength(NPPES_TAXONOMIES_MAX);
    expect(record?.taxonomies?.every((row) => row.primary === false)).toBe(true);
    expect(record?.identifiers).toHaveLength(NPPES_IDENTIFIERS_MAX);
    expect(record?.otherPracticeAddresses).toHaveLength(NPPES_PRACTICE_LOCATIONS_MAX);
    expect(record?.otherPracticeAddresses?.[0].line1).toBe("0 WAY");
    expect(record).toMatchObject({
      mailingAddress: null,
      practiceAddress: null,
      practiceCity: null,
      practiceState: null,
    });
  });

  it("never makes the first taxonomy primary when the registry flags none (A35)", () => {
    const two = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      taxonomies: [
        { code: "225100000X", desc: "Physical Therapist", primary: false },
        { code: "225X00000X", desc: "Occupational Therapist", primary: false },
      ],
    });
    expect(two?.primaryTaxonomy).toBeNull();
    // One code, repeated per licensing state, is still unambiguous.
    const one = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      taxonomies: [
        { code: "225100000X", desc: "Physical Therapist", primary: false, state: "CO" },
        { code: "225100000X", desc: "Physical Therapist", primary: false, state: "WY" },
      ],
    });
    expect(one?.primaryTaxonomy).toEqual({ code: "225100000X", description: "Physical Therapist" });
    // The primary is the row that holds the code, not the first row.
    const blankFirst = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      taxonomies: [
        { code: "", desc: "Blank row", primary: false },
        { code: "225100000X", desc: "Physical Therapist", primary: false },
      ],
    });
    expect(blankFirst?.primaryTaxonomy).toEqual({
      code: "225100000X",
      description: "Physical Therapist",
    });
  });

  it("carries only F or M as the sex, from basic.sex or an older reply's basic.gender (A36)", () => {
    const withBasic = (basic: Record<string, unknown>) =>
      toNpiRegistryRecord({ ...NPPES_INDIVIDUAL, basic: { ...NPPES_INDIVIDUAL.basic, ...basic } })
        ?.sex;
    expect(withBasic({ sex: "M" })).toBe("M");
    expect(withBasic({ sex: " f " })).toBe("F");
    expect(withBasic({ sex: undefined, gender: "M" })).toBe("M");
    for (const value of ["U", "X", "Female", "", 1, null]) {
      expect(withBasic({ sex: value, gender: undefined })).toBeNull();
    }
  });

  it("names an organization and skips malformed rows", () => {
    const org = toNpiRegistryRecord({
      number: "1902833742",
      enumeration_type: "NPI-2",
      basic: { organization_name: "DENVER REHAB LLC", status: "A" },
      addresses: [],
      taxonomies: [],
    });
    expect(org).toMatchObject({
      enumerationType: "NPI-2",
      organizationName: "DENVER REHAB LLC",
      firstName: null,
      primaryTaxonomy: null,
      suffix: null,
      sex: null,
      taxonomies: [],
      practiceAddress: null,
      mailingAddress: null,
      otherPracticeAddresses: [],
      identifiers: [],
    });
    expect(toNpiRegistryRecord({ ...NPPES_INDIVIDUAL, number: "12345" })).toBeNull();
    expect(toNpiRegistryRecord({ ...NPPES_INDIVIDUAL, enumeration_type: "X" })).toBeNull();
    expect(toNpiRegistryRecord("nope")).toBeNull();
  });

  it("reads a non-A status as inactive and drops a malformed enumeration date", () => {
    const record = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      basic: { ...NPPES_INDIVIDUAL.basic, status: "D", enumeration_date: "2015-02-30" },
    });
    expect(record).toMatchObject({ status: "inactive", enumerationDate: null });
  });
});

describe("parseNppesResponse", () => {
  it("turns the registry's own Errors body into a failure", () => {
    expect(() =>
      parseNppesResponse({ Errors: [{ description: "Field state requires additional" }] }),
    ).toThrow(NpiRegistryUnavailableError);
  });

  it("reads an Errors body about a field we sent as a rejected query, not an outage", () => {
    const body = {
      Errors: [
        {
          description:
            "Field first_name contains special character(s) or wrong number of characters",
          field: "first_name",
          number: "10",
        },
      ],
    };
    expect(() => parseNppesResponse(body)).toThrow(NpiRegistryQueryRejectedError);
    expect(() =>
      parseNppesResponse({ Errors: [{ description: "x", field: "first_name" }, { field: "db" }] }),
    ).toThrow(NpiRegistryUnavailableError);
    expect(() => parseNppesResponse({ Errors: [] })).toThrow(NpiRegistryUnavailableError);
  });

  it("keeps at most five other names", () => {
    const record = toNpiRegistryRecord({
      ...NPPES_INDIVIDUAL,
      other_names: Array.from({ length: 9 }, (_, i) => ({
        first_name: "JANE",
        last_name: `N${i}`,
      })),
    });
    expect(record?.otherNames).toHaveLength(5);
  });

  it("accepts an empty result and rejects any other shape", () => {
    expect(parseNppesResponse({ result_count: 0, results: [] })).toEqual([]);
    expect(parseNppesResponse({ result_count: 0 })).toEqual([]);
    for (const body of [null, [], "x", { results: "x" }]) {
      expect(() => parseNppesResponse(body)).toThrow(NpiRegistryUnavailableError);
    }
  });
});

describe("searchNppes", () => {
  it("sends only the typed names and state, for individuals, capped at 11", async () => {
    const fetchFn = fetchReturning(reply({ result_count: 1, results: [NPPES_INDIVIDUAL] }));
    const result = await searchNppes(
      { firstName: "José", lastName: "Doe", state: "CO" },
      { fetch: fetchFn },
    );
    expect(result).toMatchObject({ truncated: false, results: [{ npi: "1234567893" }] });
    const url = calledUrl(fetchFn);
    expect(`${url.origin}${url.pathname}`).toBe(NPPES_API_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      version: "2.1",
      enumeration_type: "NPI-1",
      first_name: "Jose",
      last_name: "Doe",
      state: "CO",
      limit: "11",
    });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits state when none is chosen and flags a list cut at ten", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...NPPES_INDIVIDUAL,
      number: String(1000000000 + i),
    }));
    // Any 10-digit number passes the parse; the check digit is not the
    // registry's job to repeat.
    const fetchFn = fetchReturning(reply({ result_count: 11, results: many }));
    const result = await searchNppes(
      { firstName: "Jane", lastName: "Doe", state: null },
      { fetch: fetchFn },
    );
    expect(result.results).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(calledUrl(fetchFn).searchParams.has("state")).toBe(false);
  });
});

describe("searchNppes folding", () => {
  it("sends transliterated, suffix-free names upstream", async () => {
    const fetchFn = fetchReturning(reply({ result_count: 0, results: [] }));
    await searchNppes(
      { firstName: "\u0141ukasz", lastName: "Strau\u00df Jr.", state: null },
      { fetch: fetchFn },
    );
    const params = calledUrl(fetchFn).searchParams;
    expect(params.get("first_name")).toBe("Lukasz");
    expect(params.get("last_name")).toBe("Strauss");
  });
});

describe("lookupNppes", () => {
  it("asks by number only and returns null for a miss", async () => {
    const fetchFn = fetchReturning(
      reply({ result_count: 1, results: [NPPES_INDIVIDUAL] }),
      reply({ result_count: 0, results: [] }),
    );
    expect((await lookupNppes("1234567893", { fetch: fetchFn })).record?.lastName).toBe("DOE");
    expect(Object.fromEntries(calledUrl(fetchFn).searchParams)).toEqual({
      version: "2.1",
      number: "1234567893",
    });
    // The answer carries when the registry gave it (A35's pull date).
    const now = () => new Date("2026-10-31T15:00:00Z");
    expect(await lookupNppes("1902833742", { fetch: fetchFn, now })).toEqual({
      record: null,
      pulledAt: "2026-10-31T15:00:00.000Z",
    });
  });

  it("stamps a search with when the registry answered", async () => {
    const fetchFn = fetchReturning(reply({ result_count: 1, results: [NPPES_INDIVIDUAL] }));
    const now = () => new Date("2026-10-31T15:00:00Z");
    const result = await searchNppes(
      { firstName: "Jane", lastName: "Doe", state: null },
      { fetch: fetchFn, now },
    );
    expect(result.pulledAt).toBe("2026-10-31T15:00:00.000Z");
  });
});

describe("upstream failures", () => {
  const cases: Array<[string, Response | Error, string]> = [
    ["network error", new TypeError("fetch failed"), "network"],
    ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
    ["HTTP 503", new Response("down", { status: 503 }), "http"],
    ["non-JSON body", new Response("<html>", { status: 200 }), "invalid_response"],
    ["registry error body", reply({ Errors: [{ description: "x" }] }), "registry_error"],
  ];
  for (const [label, response, kind] of cases) {
    it(`maps a ${label} to "NPI Registry is unavailable"`, async () => {
      const error = await lookupNppes("1234567893", { fetch: fetchReturning(response) }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NpiRegistryUnavailableError);
      expect((error as NpiRegistryUnavailableError).kind).toBe(kind);
      expect((error as Error).message).toBe(NPI_REGISTRY_UNAVAILABLE_MESSAGE);
    });
  }

  it("refuses an oversized reply, declared or streamed, without parsing it", async () => {
    const big = JSON.stringify({ result_count: 1, results: [NPPES_INDIVIDUAL] });
    const streamed = await lookupNppes("1234567893", {
      fetch: fetchReturning(new Response(big)),
      maxResponseBytes: 100,
    }).catch((e: unknown) => e);
    expect((streamed as NpiRegistryUnavailableError).kind).toBe("invalid_response");
    const declared = await lookupNppes("1234567893", {
      fetch: fetchReturning(new Response("{}", { headers: { "content-length": "999999999" } })),
    }).catch((e: unknown) => e);
    expect((declared as NpiRegistryUnavailableError).kind).toBe("invalid_response");
    expect(
      (
        await lookupNppes("1234567893", {
          fetch: fetchReturning(new Response(big)),
          maxResponseBytes: 100_000,
        })
      ).record?.npi,
    ).toBe("1234567893");
  });

  it("gives up after the timeout", async () => {
    const hang = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = await lookupNppes("1234567893", { fetch: hang, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect((error as NpiRegistryUnavailableError).kind).toBe("timeout");
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the oldest past the size bound", () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    now = 1000;
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});

describe("FixedWindowRateLimiter", () => {
  it("allows the limit per key per window, then says when to retry", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);
    expect(limiter.take("u1")).toEqual({ allowed: true });
    expect(limiter.take("u1")).toEqual({ allowed: true });
    expect(limiter.take("u2")).toEqual({ allowed: true });
    now = 15_000;
    expect(limiter.take("u1")).toEqual({ allowed: false, retryAfterSeconds: 45 });
    now = 60_000;
    expect(limiter.take("u1")).toEqual({ allowed: true });
  });
});
