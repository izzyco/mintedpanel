import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext } from "./guard";

vi.mock("@/services/fieldVerifications", () => ({ recordFieldVerifications: vi.fn() }));
vi.mock("@/services/providers", () => ({
  attachGroupsToProviders: vi.fn(),
  listProviders: vi.fn(),
  getProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
}));
vi.mock("@/services/directory", () => ({
  filterProvidersBySearch: vi.fn(),
  getProviderDirectoryExtras: vi.fn(),
}));

import {
  attachGroupsToProviders,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
} from "@/services/providers";
import { filterProvidersBySearch, getProviderDirectoryExtras } from "@/services/directory";
import { recordFieldVerifications } from "@/services/fieldVerifications";
import { CAQH_CURRENT_DAYS } from "@/lib/enrollmentReadiness";
import {
  handleListProviders,
  handleGetProvider,
  handleCreateProvider,
  handleUpdateProvider,
  handleRecordCaqhAttestation,
} from "./providerRoutes";

const listProvidersMock = vi.mocked(listProviders);
const getProviderMock = vi.mocked(getProvider);
const createProviderMock = vi.mocked(createProvider);
const updateProviderMock = vi.mocked(updateProvider);
const recordVerificationsMock = vi.mocked(recordFieldVerifications);
const attachGroupsMock = vi.mocked(attachGroupsToProviders);
const filterMock = vi.mocked(filterProvidersBySearch);
const extrasMock = vi.mocked(getProviderDirectoryExtras);
const NO_EXTRAS = { licenses: [], medicareIds: [], groups: [], locations: [] };

function ctx(role: AuthContext["role"] = "specialist"): AuthContext {
  return {
    userId: "u1",
    orgId: "org-1",
    role,
    userName: "Tester",
    email: "tester@minted.com",
    userMetadata: null,
    db: {} as AuthContext["db"],
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
}

async function body(res: Response): Promise<ApiEnvelope<unknown>> {
  return (await res.json()) as ApiEnvelope<unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe("provider route handlers", () => {
  it("list returns the envelope with pagination meta", async () => {
    listProvidersMock.mockResolvedValue({ rows: [{ id: "p1" }] as never, total: 30 });
    const res = await handleListProviders(
      new URL("https://x.test/api/providers?page=2&pageSize=10"),
      ctx(),
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data).toEqual([{ id: "p1" }]);
    expect(b.meta).toEqual({ total: 30, page: 2, pageSize: 10 });
    // page/pageSize forwarded to the service
    expect(listProvidersMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ page: 2, pageSize: 10 }),
    );
  });

  it("list clamps pageSize to 100", async () => {
    listProvidersMock.mockResolvedValue({ rows: [], total: 0 });
    await handleListProviders(new URL("https://x.test/api/providers?pageSize=9999"), ctx());
    expect(listProvidersMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ pageSize: 100 }),
    );
  });

  it("list excludes terminated providers by default", async () => {
    listProvidersMock.mockResolvedValue({ rows: [], total: 0 });
    await handleListProviders(new URL("https://x.test/api/providers"), ctx());
    expect(listProvidersMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: undefined, excludeStatus: "terminated" }),
      expect.anything(),
    );
  });

  it("list respects an explicit ?status=terminated request", async () => {
    listProvidersMock.mockResolvedValue({ rows: [], total: 0 });
    await handleListProviders(new URL("https://x.test/api/providers?status=terminated"), ctx());
    expect(listProvidersMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "terminated", excludeStatus: undefined }),
      expect.anything(),
    );
  });

  it("get returns 404 when the provider is missing", async () => {
    getProviderMock.mockResolvedValue(null);
    const res = await handleGetProvider("nope", ctx());
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("Provider not found");
  });

  it("get returns 200 with the provider row and the card's related lists", async () => {
    getProviderMock.mockResolvedValue({ id: "p1" } as never);
    extrasMock.mockResolvedValue(NO_EXTRAS);
    const res = await handleGetProvider("p1", ctx());
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ id: "p1", ...NO_EXTRAS });
  });

  it("get keeps every field of the row as it was, ssnLast4 included, and only adds", async () => {
    const row = { id: "p1", firstName: "Ada", ssnLast4: "4321", dateOfBirth: "1980-01-02" };
    getProviderMock.mockResolvedValue(row as never);
    const extras = {
      licenses: [{ state: "NM", licenseNumber: "NM-1", expirationDate: null }],
      medicareIds: [{ groupId: "g1", groupName: "Sample", medicareId: "MCR-1" }],
      groups: [{ id: "g1", name: "Sample", tin: "12-3456789", isPrimary: true }],
      locations: [{ id: "f1", name: "Uptown", city: "Albuquerque", state: "NM" }],
    };
    extrasMock.mockResolvedValue(extras);
    const c = ctx("billing");
    const res = await handleGetProvider("p1", c);
    expect((await body(res)).data).toEqual({ ...row, ...extras });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(extrasMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }), "p1");
    // The route audits nothing today, and still does not.
    expect(c.writeAudit).not.toHaveBeenCalled();
  });

  it("get reads no related lists for a missing provider", async () => {
    getProviderMock.mockResolvedValue(null);
    await handleGetProvider("nope", ctx());
    expect(extrasMock).not.toHaveBeenCalled();
  });

  it("list with ?search= reads the filtered set in full, matches, then pages", async () => {
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
    listProvidersMock.mockResolvedValue({ rows: all as never, total: 3 });
    filterMock.mockResolvedValue(all as never);
    attachGroupsMock.mockImplementation(async (_c, rows) =>
      rows.map((r) => ({ ...r, groups: [] })),
    );
    const res = await handleListProviders(
      new URL("https://x.test/api/providers?search=New%20Mexico&page=2&pageSize=2&groupId=g1"),
      ctx(),
    );
    const b = await body(res);
    expect(b.data).toEqual([{ id: "c", groups: [] }]);
    expect(b.meta).toEqual({ total: 3, page: 2, pageSize: 2 });
    // Unpaged, no SQL search, the other filters and terminated exclusion kept.
    const [, filters, options] = listProvidersMock.mock.calls[0];
    expect(filters).toMatchObject({
      groupId: "g1",
      excludeStatus: "terminated",
      search: undefined,
    });
    expect(options).toEqual({ sortColumn: undefined, sortAscending: true });
    expect(filterMock.mock.calls[0][2]).toEqual({
      states: [{ code: "NM", phrase: "new mexico" }],
      terms: [],
    });
    expect(attachGroupsMock.mock.calls[0][1]).toEqual([{ id: "c" }]);
  });

  it("list with a blank or over-long ?search= keeps the plain SQL path", async () => {
    listProvidersMock.mockResolvedValue({ rows: [], total: 0 });
    await handleListProviders(new URL("https://x.test/api/providers?search=%20%20"), ctx());
    await handleListProviders(
      new URL(`https://x.test/api/providers?search=${"x".repeat(101)}`),
      ctx(),
    );
    expect(filterMock).not.toHaveBeenCalled();
    expect(listProvidersMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ search: "x".repeat(101) }),
      expect.objectContaining({ page: 1, withGroups: true }),
    );
  });

  it("create rejects a billing (read-only) role with 403", async () => {
    const res = await handleCreateProvider({ firstName: "A", lastName: "B" }, ctx("billing"));
    expect(res.status).toBe(403);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  it("create 422s when firstName/lastName are missing", async () => {
    const res = await handleCreateProvider({ firstName: "A" }, ctx());
    expect(res.status).toBe(422);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  it("create returns 201 and forwards the injected ctx", async () => {
    createProviderMock.mockResolvedValue({ id: "new" } as never);
    const c = ctx();
    const res = await handleCreateProvider({ firstName: "A", lastName: "B" }, c);
    expect(res.status).toBe(201);
    expect((await body(res)).data).toEqual({ id: "new" });
    expect(createProviderMock).toHaveBeenCalledWith(
      { firstName: "A", lastName: "B" },
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("update requires a writer and returns 200", async () => {
    getProviderMock.mockResolvedValue({ id: "p1" } as never);
    updateProviderMock.mockResolvedValue({ id: "p1", firstName: "New" } as never);
    const blocked = await handleUpdateProvider("p1", { firstName: "New" }, ctx("billing"));
    expect(blocked.status).toBe(403);

    const ok = await handleUpdateProvider("p1", { firstName: "New" }, ctx("admin"));
    expect(ok.status).toBe(200);
    expect((await body(ok)).data).toEqual({ id: "p1", firstName: "New" });
  });

  it("update returns 404 for a cross-org / nonexistent id (never a 500)", async () => {
    // getProvider is org-scoped, so a cross-org or unknown id resolves to null —
    // the same not-found signal the GET handler uses.
    getProviderMock.mockResolvedValue(null);
    const res = await handleUpdateProvider("nope", { firstName: "New" }, ctx("admin"));
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("Provider not found");
    // The update never runs once the row is absent (no cross-org write attempt).
    expect(updateProviderMock).not.toHaveBeenCalled();
  });
});

describe("handleRecordCaqhAttestation", () => {
  const ID = "prov-1";
  const TODAY = "2026-07-28";

  function attested(date: string) {
    return { id: ID, caqhLastAttestedDate: date } as never;
  }

  it("defaults to today when no date is sent", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    const res = await handleRecordCaqhAttestation(ID, {}, ctx(), TODAY);
    expect(res.status).toBe(200);
    expect(updateProviderMock).toHaveBeenCalledWith(
      ID,
      { caqhLastAttestedDate: TODAY },
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("accepts a null body (the common 'attested just now' call)", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    const res = await handleRecordCaqhAttestation(ID, null, ctx(), TODAY);
    expect(res.status).toBe(200);
  });

  it("accepts an explicit past date", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested("2026-07-01"));
    const res = await handleRecordCaqhAttestation(ID, { attested_on: "2026-07-01" }, ctx(), TODAY);
    expect(res.status).toBe(200);
    expect(updateProviderMock).toHaveBeenCalledWith(
      ID,
      { caqhLastAttestedDate: "2026-07-01" },
      expect.anything(),
    );
  });

  it("returns only the date and the shared freshness window, never the PHI row", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue({
      id: ID,
      caqhLastAttestedDate: TODAY,
      ssnLast4: "6789",
      dateOfBirth: "1980-01-01",
      homeStreet: "1 Main St",
    } as never);
    const res = await handleRecordCaqhAttestation(ID, {}, ctx(), TODAY);
    const data = (await body(res)).data as Record<string, unknown>;
    expect(data).toEqual({
      id: ID,
      caqhLastAttestedDate: TODAY,
      currentThroughDays: CAQH_CURRENT_DAYS,
      verifiedFields: 0,
    });
    // The PATCH handler returns the whole provider; this one must not.
    expect(JSON.stringify(data)).not.toContain("6789");
    expect(JSON.stringify(data)).not.toContain("1980-01-01");
  });

  it("stamps the fields the fill carried (S6.2/C6)", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    recordVerificationsMock.mockResolvedValue(2);
    const res = await handleRecordCaqhAttestation(
      ID,
      { verified_fields: ["provider.npi", "provider.caqhId"] },
      ctx(),
      TODAY,
    );
    expect(res.status).toBe(200);
    expect(recordVerificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "u1" }),
      ID,
      ["provider.npi", "provider.caqhId"],
      "caqh",
      expect.any(String),
    );
    expect(((await body(res)).data as { verifiedFields: number }).verifiedFields).toBe(2);
  });

  it("ignores malformed field entries rather than losing the attestation", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    recordVerificationsMock.mockResolvedValue(1);
    const res = await handleRecordCaqhAttestation(
      ID,
      { verified_fields: ["provider.npi", 42, "", null] },
      ctx(),
      TODAY,
    );
    expect(res.status).toBe(200);
    expect(recordVerificationsMock).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      ["provider.npi"],
      "caqh",
      expect.any(String),
    );
  });

  it("does not touch the verification table when no fields were carried", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    await handleRecordCaqhAttestation(ID, {}, ctx(), TODAY);
    expect(recordVerificationsMock).not.toHaveBeenCalled();
  });

  it("rejects a future date before writing", async () => {
    const res = await handleRecordCaqhAttestation(ID, { attested_on: "2026-07-29" }, ctx(), TODAY);
    expect(res.status).toBe(422);
    expect((await body(res)).error).toMatch(/future/);
    expect(updateProviderMock).not.toHaveBeenCalled();
  });

  it.each([["28-07-2026"], ["2026-7-1"], ["yesterday"]])(
    "rejects a malformed date %s before writing",
    async (value) => {
      const res = await handleRecordCaqhAttestation(ID, { attested_on: value }, ctx(), TODAY);
      expect(res.status).toBe(422);
      expect(updateProviderMock).not.toHaveBeenCalled();
    },
  );

  it("treats an empty string as 'no date sent' and falls back to today", async () => {
    getProviderMock.mockResolvedValue({ id: ID } as never);
    updateProviderMock.mockResolvedValue(attested(TODAY));
    const res = await handleRecordCaqhAttestation(ID, { attested_on: "" }, ctx(), TODAY);
    expect(res.status).toBe(200);
    expect(updateProviderMock).toHaveBeenCalledWith(
      ID,
      { caqhLastAttestedDate: TODAY },
      expect.anything(),
    );
  });

  it("rejects a non-string date before writing", async () => {
    const res = await handleRecordCaqhAttestation(ID, { attested_on: 20260728 }, ctx(), TODAY);
    expect(res.status).toBe(422);
    expect(updateProviderMock).not.toHaveBeenCalled();
  });

  it("404s a cross-org or nonexistent provider before writing", async () => {
    getProviderMock.mockResolvedValue(null);
    const res = await handleRecordCaqhAttestation(ID, {}, ctx(), TODAY);
    expect(res.status).toBe(404);
    expect(updateProviderMock).not.toHaveBeenCalled();
  });

  it("refuses billing with 403 before touching the service", async () => {
    const res = await handleRecordCaqhAttestation(ID, {}, ctx("billing"), TODAY);
    expect(res.status).toBe(403);
    expect(getProviderMock).not.toHaveBeenCalled();
    expect(updateProviderMock).not.toHaveBeenCalled();
  });
});
