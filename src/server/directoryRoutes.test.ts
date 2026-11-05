import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext, UserContext } from "./guard";

vi.mock("@/services/directory", () => ({
  listDirectoryGroups: vi.fn(),
  listDirectoryLocations: vi.fn(),
  getDirectoryGroup: vi.fn(),
  getDirectoryLocation: vi.fn(),
}));
vi.mock("@/services/directoryLayouts", () => ({
  getDirectoryLayout: vi.fn(),
  putDirectoryLayout: vi.fn(),
}));

import {
  getDirectoryGroup,
  getDirectoryLocation,
  listDirectoryGroups,
  listDirectoryLocations,
} from "@/services/directory";
import { getDirectoryLayout, putDirectoryLayout } from "@/services/directoryLayouts";
import { DIRECTORY_CATALOGS } from "@/lib/directory";
import {
  handleGetCardLayout,
  handleGetGroup,
  handleGetLocation,
  handleListGroups,
  handleListLocations,
  handlePutCardLayout,
} from "./directoryRoutes";

const listGroupsMock = vi.mocked(listDirectoryGroups);
const listLocationsMock = vi.mocked(listDirectoryLocations);
const groupMock = vi.mocked(getDirectoryGroup);
const locationMock = vi.mocked(getDirectoryLocation);
const getLayoutMock = vi.mocked(getDirectoryLayout);
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

const url = (path: string, params: Record<string, string> = {}) => {
  const u = new URL(`https://x.test${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["/api/groups", handleListGroups, listGroupsMock],
  ["/api/locations", handleListLocations, listLocationsMock],
] as const)("GET %s", (path, handler, mock) => {
  it("lists everything active with no search, paged like /api/providers", async () => {
    mock.mockResolvedValue({ rows: [{ id: ID }], total: 1 } as never);
    const res = await handler(url(path), ctx({ orgId: "org-A" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const env = await body(res);
    expect(env.data).toEqual([{ id: ID }]);
    expect(env.meta).toEqual({ total: 1, page: 1, pageSize: 25 });
    const [svcCtx, query, page, pageSize] = mock.mock.calls[0];
    expect(svcCtx).toMatchObject({ orgId: "org-A" });
    expect([query, page, pageSize]).toEqual([null, 1, 25]);
  });

  it("parses the search (state names included) and caps pageSize at 100", async () => {
    mock.mockResolvedValue({ rows: [], total: 0 });
    await handler(url(path, { search: "New Mexico", pageSize: "500", page: "2" }), ctx());
    const [, query, page, pageSize] = mock.mock.calls[0];
    expect(query).toEqual({ states: [{ code: "NM", phrase: "new mexico" }], terms: [] });
    expect([page, pageSize]).toEqual([2, 100]);
  });

  it("422s a search over 100 characters before reading", async () => {
    const res = await handler(url(path, { search: "x".repeat(101) }), ctx());
    expect(res.status).toBe(422);
    expect(mock).not.toHaveBeenCalled();
  });

  it("writes no audit row", async () => {
    mock.mockResolvedValue({ rows: [], total: 0 });
    const c = ctx();
    await handler(url(path, { search: "sandia" }), c);
    expect(c.writeAudit).not.toHaveBeenCalled();
  });
});

describe.each([
  ["groups", handleGetGroup, groupMock, "Group not found"],
  ["locations", handleGetLocation, locationMock, "Location not found"],
] as const)("GET /api/%s/:id", (_kind, handler, mock, notFound) => {
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
  });

  it("serves the card no-store, scoped to the caller's org, with no audit row", async () => {
    mock.mockResolvedValue({ id: ID } as never);
    const c = ctx({ orgId: "org-A" });
    const res = await handler(ID, c);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.mock.calls[0][0]).toMatchObject({ orgId: "org-A" });
    expect(c.writeAudit).not.toHaveBeenCalled();
  });
});

describe("GET /api/me/view-prefs?card=", () => {
  it("returns that card's saved fields and its catalog, scoped by the JWT user", async () => {
    getLayoutMock.mockResolvedValue(["tin"]);
    const res = await handleGetCardLayout("group", userCtx("uA"));
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ fields: ["tin"], catalog: DIRECTORY_CATALOGS.group });
    expect(getLayoutMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "uA" }), "group");
  });

  it("answers fields: null until a layout is saved", async () => {
    getLayoutMock.mockResolvedValue(null);
    const res = await handleGetCardLayout("location", userCtx());
    expect((await body(res)).data).toEqual({
      fields: null,
      catalog: DIRECTORY_CATALOGS.location,
    });
  });

  it("422s an unknown card before reading", async () => {
    const res = await handleGetCardLayout("payer", userCtx());
    expect(res.status).toBe(422);
    expect(getLayoutMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/me/view-prefs?card=", () => {
  it.each([
    ["an unknown card", "payer", { fields: [] }],
    ["a null body", "group", null],
    ["an array body", "group", []],
    ["fields not an array", "group", { fields: "tin" }],
    ["an unknown key", "group", { fields: ["ssn"] }],
    ["another card's key", "location", { fields: ["npi"] }],
    ["a duplicate key", "provider", { fields: ["npi", "npi"] }],
  ])("422s %s before writing", async (_name, card, badBody) => {
    const res = await handlePutCardLayout(card, badBody, userCtx());
    expect(res.status).toBe(422);
    expect(putLayoutMock).not.toHaveBeenCalled();
  });

  it("saves a valid layout under the JWT user and answers { fields }", async () => {
    putLayoutMock.mockResolvedValue(undefined);
    const fields = ["list.providers", "tin", "ptan"];
    const res = await handlePutCardLayout("group", { fields }, userCtx("uB"));
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ fields });
    expect(putLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uB" }),
      "group",
      fields,
    );
  });

  it("ignores a body-supplied user id", async () => {
    putLayoutMock.mockResolvedValue(undefined);
    await handlePutCardLayout("group", { fields: [], userId: "evil" }, userCtx("uB"));
    expect(putLayoutMock.mock.calls[0][0]).toMatchObject({ userId: "uB" });
  });
});
