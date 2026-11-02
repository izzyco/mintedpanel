// MINT-110 PR 3 — /api/npi-registry/pulls dispatch: behind the full org guard,
// POST only, the body bounded before parsing, and handed to its handler with
// the guard's context (the org and the actor never come from the body).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./guard", async () => {
  const actual = await vi.importActual<typeof import("./guard")>("./guard");
  return { ...actual, authenticate: vi.fn(), authenticateUser: vi.fn() };
});
vi.mock("./npiRegistryRoutes", () => ({
  handleNpiRegistryPull: vi.fn(),
}));

import { authenticate, authenticateUser, GuardError, type AuthContext } from "./guard";
import { handleApiRequest } from "./api";
import { handleNpiRegistryPull } from "./npiRegistryRoutes";

const CTX = { userId: "u1", orgId: "org-1", role: "admin" } as AuthContext;
const PATH = "/api/npi-registry/pulls";
const BODY = {
  providerId: "55555555-5555-4555-8555-555555555555",
  npi: "1234567893",
  sourced: {},
  confirmed: false,
};

function post(path: string, body: string): Request {
  return new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("api dispatch for /api/npi-registry/pulls", () => {
  it("is behind the full org guard: an anonymous caller is a 401 and never reaches the handler", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    vi.mocked(authenticate).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    const res = await handleApiRequest(post(PATH, JSON.stringify(BODY)));
    expect(res.status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(handleNpiRegistryPull).not.toHaveBeenCalled();
  });

  it("hands the parsed body and the guard's context to the handler", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    vi.mocked(handleNpiRegistryPull).mockResolvedValue(new Response("{}", { status: 201 }));
    const body = { ...BODY, orgId: "someone-elses-org" };
    await handleApiRequest(post(PATH, JSON.stringify(body)));
    expect(handleNpiRegistryPull).toHaveBeenCalledWith(body, CTX);
    await handleApiRequest(post(`${PATH}/`, JSON.stringify(body)));
    expect(handleNpiRegistryPull).toHaveBeenCalledTimes(2);
  });

  it("hands an oversized body over as null instead of parsing it", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    vi.mocked(handleNpiRegistryPull).mockResolvedValue(new Response("{}", { status: 422 }));
    const big = JSON.stringify({ ...BODY, sourced: { credentials: "x".repeat(5000) } });
    await handleApiRequest(post(PATH, big));
    expect(handleNpiRegistryPull).toHaveBeenCalledWith(null, CTX);
  });

  it("is POST only, and a near-miss path is a 404", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    const get = await handleApiRequest(
      new Request(`https://x.test${PATH}`, { headers: { authorization: "Bearer t" } }),
    );
    expect(get.status).toBe(405);
    const near = await handleApiRequest(post("/api/npi-registry/pull", "{}"));
    expect(near.status).toBe(404);
    expect(handleNpiRegistryPull).not.toHaveBeenCalled();
  });
});
