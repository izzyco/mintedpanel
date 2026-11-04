import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext, UserContext } from "./guard";

vi.mock("@/services/directory", () => ({
  searchDirectory: vi.fn(),
  getDirectoryGroup: vi.fn(),
  getDirectoryProvider: vi.fn(),
  getDirectoryLocation: vi.fn(),
}));
vi.mock("@/services/directoryLayouts", () => ({
  getDirectoryLayouts: vi.fn(),
  putDirectoryLayout: vi.fn(),
}));

import {
  getDirectoryGroup,
  getDirectoryLocation,
  getDirectoryProvider,
  searchDirectory,
} from "@/services/directory";
import { getDirectoryLayouts, putDirectoryLayout } from "@/services/directoryLayouts";
import { DIRECTORY_CATALOGS } from "@/lib/directory";
import {
  handleDirectoryGroup,
  handleDirectoryLocation,
  handleDirectoryProvider,
  handleDirectorySearch,
  handleGetDirectoryLayouts,
  handlePutDirectoryLayout,
} from "./directoryRoutes";

const searchMock = vi.mocked(searchDirectory);
const groupMock = vi.mocked(getDirectoryGroup);
const providerMock = vi.mocked(getDirectoryProvider);
const locationMock = vi.mocked(getDirectoryLocation);
const getLayoutsMock = vi.mocked(getDirectoryLayouts);
const putLayoutMock = vi.mocked(putDirectoryLayout);

const ID = "10000000-0000-4000-a000-000000000001";

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "u1",
    orgId: "org-1",
    role: "billing",
    userName: null,
    email: null,
    userMetadata: null,
    db: {} as AuthContext["db"],
    writeAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function userCtx(userId = "u1"): UserContext {
  return { userId, email: "t@minted.com", userMetadata: null, db: {} as UserContext["db"] };
}

async function body(res: Response): Promise<ApiEnvelope<unknown>> {
  return (await res.json()) as ApiEnvelope<unknown>;
}

const url = (q: string | null) =>
  new URL(`https://x.test/api/directory/search${q == null ? "" : `?q=${encodeURIComponent(q)}`}`);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/directory/search", () => {
  it.each([[null], [""], ["a"], [" a "], ["x".repeat(101)]])(
    "422s q=%j before reading anything",
    async (q) => {
      const res = await handleDirectorySearch(url(q), ctx());
      expect(res.status).toBe(422);
      expect(searchMock).not.toHaveBeenCalled();
    },
  );

  it("reads with the caller's org and answers no-store", async () => {
    const result = { groups: [], providers: [], locations: [] };
    searchMock.mockResolvedValue(result);
    const res = await handleDirectorySearch(url("New Mexico"), ctx({ orgId: "org-A" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await body(res)).data).toEqual(result);
    const [svcCtx, query] = searchMock.mock.calls[0];
    expect(svcCtx).toMatchObject({ orgId: "org-A" });
    expect(query).toEqual({ states: [{ code: "NM", phrase: "new mexico" }], terms: [] });
  });

  it("writes no audit row", async () => {
    searchMock.mockResolvedValue({ groups: [], providers: [], locations: [] });
    const c = ctx();
    await handleDirectorySearch(url("sandia"), c);
    expect(c.writeAudit).not.toHaveBeenCalled();
  });
});

describe.each([
  ["groups", handleDirectoryGroup, groupMock, "Group not found"],
  ["providers", handleDirectoryProvider, providerMock, "Provider not found"],
  ["locations", handleDirectoryLocation, locationMock, "Location not found"],
] as const)("GET /api/directory/%s/:id", (_kind, handler, mock, notFound) => {
  it("404s a non-UUID id without reading", async () => {
    const res = await handler("not-a-uuid", ctx());
    expect(res.status).toBe(404);
    expect(mock).not.toHaveBeenCalled();
  });

  it("404s a record the service does not find (other org, inactive) with no data", async () => {
    mock.mockResolvedValue(null);
    const c = ctx();
    const res = await handler(ID, c);
    expect(res.status).toBe(404);
    const env = await body(res);
    expect(env.data).toBeNull();
    expect(env.error).toBe(notFound);
    expect(c.writeAudit).not.toHaveBeenCalled();
  });

  it("serves the card no-store, scoped to the caller's org", async () => {
    mock.mockResolvedValue({ id: ID } as never);
    const res = await handler(ID, ctx({ orgId: "org-A" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.mock.calls[0][0]).toMatchObject({ orgId: "org-A" });
  });
});

describe("audit mirrors the profile read", () => {
  it("writes one READ row per provider card read, never a value", async () => {
    providerMock.mockResolvedValue({ id: ID, dateOfBirth: "1980-01-01" } as never);
    const c = ctx();
    await handleDirectoryProvider(ID, c);
    expect(c.writeAudit).toHaveBeenCalledTimes(1);
    const row = vi.mocked(c.writeAudit).mock.calls[0][0];
    expect(row).toMatchObject({ actionType: "READ", entityType: "provider", entityId: ID });
    expect(JSON.stringify(row)).not.toContain("1980");
  });

  it("fails the request when the audit write fails", async () => {
    providerMock.mockResolvedValue({ id: ID } as never);
    const c = ctx({ writeAudit: vi.fn().mockRejectedValue(new Error("audit down")) });
    await expect(handleDirectoryProvider(ID, c)).rejects.toThrow("audit down");
  });

  it("writes nothing for group and location cards", async () => {
    groupMock.mockResolvedValue({ id: ID } as never);
    locationMock.mockResolvedValue({ id: ID } as never);
    const c = ctx();
    await handleDirectoryGroup(ID, c);
    await handleDirectoryLocation(ID, c);
    expect(c.writeAudit).not.toHaveBeenCalled();
  });
});

describe("GET /api/me/directory-layouts", () => {
  it("returns the saved layouts and the fixed catalogs, scoped by the JWT user", async () => {
    const layouts = { group: ["tin"], provider: null, location: null };
    getLayoutsMock.mockResolvedValue(layouts);
    const res = await handleGetDirectoryLayouts(userCtx("uA"));
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ layouts, catalogs: DIRECTORY_CATALOGS });
    expect(getLayoutsMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "uA" }));
  });
});

describe("PUT /api/me/directory-layouts", () => {
  it.each([
    ["null body", null],
    ["array body", []],
    ["unknown type", { type: "payer", fields: [] }],
    ["fields not an array", { type: "group", fields: "tin" }],
    ["unknown key", { type: "group", fields: ["ssn"] }],
    ["another type's key", { type: "location", fields: ["npi"] }],
    ["duplicate key", { type: "provider", fields: ["npi", "npi"] }],
  ])("422s a %s before writing", async (_name, badBody) => {
    const res = await handlePutDirectoryLayout(badBody, userCtx());
    expect(res.status).toBe(422);
    expect(putLayoutMock).not.toHaveBeenCalled();
  });

  it("saves a valid layout under the JWT user and echoes it", async () => {
    putLayoutMock.mockResolvedValue(undefined);
    const fields = ["list.providers", "tin", "ptan"];
    const res = await handlePutDirectoryLayout({ type: "group", fields }, userCtx("uB"));
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ type: "group", fields });
    expect(putLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uB" }),
      "group",
      fields,
    );
  });

  it("ignores a body-supplied user id", async () => {
    putLayoutMock.mockResolvedValue(undefined);
    await handlePutDirectoryLayout({ type: "group", fields: [], userId: "evil" }, userCtx("uB"));
    expect(putLayoutMock.mock.calls[0][0]).toMatchObject({ userId: "uB" });
  });
});
