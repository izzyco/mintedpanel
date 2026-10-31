// MINT-110 PR 2 — /api/npi-registry/verify-batch dispatch: behind the full org
// guard, POST only, the body bounded before parsing, and handed to its handler
// with the guard's context and the request's abort signal.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./guard", async () => {
  const actual = await vi.importActual<typeof import("./guard")>("./guard");
  return { ...actual, authenticate: vi.fn(), authenticateUser: vi.fn() };
});
vi.mock("./npiRegistryBatchRoutes", () => ({
  handleNpiRegistryVerifyBatch: vi.fn(),
}));

import { authenticate, authenticateUser, GuardError, type AuthContext } from "./guard";
import { handleApiRequest } from "./api";
import { handleNpiRegistryVerifyBatch } from "./npiRegistryBatchRoutes";

const CTX = { userId: "u1", orgId: "org-1", role: "admin" } as AuthContext;
const PATH = "/api/npi-registry/verify-batch";

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

describe("api dispatch for /api/npi-registry/verify-batch", () => {
  it("is behind the full org guard: an anonymous caller is a 401 and never reaches the handler", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    vi.mocked(authenticate).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    const res = await handleApiRequest(post(PATH, JSON.stringify({ npis: ["1234567893"] })));
    expect(res.status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(handleNpiRegistryVerifyBatch).not.toHaveBeenCalled();
  });

  it("hands the parsed body and the guard's context to the handler", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    vi.mocked(handleNpiRegistryVerifyBatch).mockResolvedValue(new Response("{}", { status: 200 }));
    const body = { npis: ["1234567893", "123-456-7893"] };
    await handleApiRequest(post(PATH, JSON.stringify(body)));
    // The request's own abort signal goes along, so a caller who leaves stops
    // the registry calls.
    expect(handleNpiRegistryVerifyBatch).toHaveBeenCalledWith(
      body,
      CTX,
      {},
      expect.any(AbortSignal),
    );
    await handleApiRequest(post(`${PATH}/`, JSON.stringify(body)));
    expect(handleNpiRegistryVerifyBatch).toHaveBeenCalledTimes(2);
  });

  it("hands an oversized body over as null instead of parsing it", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    vi.mocked(handleNpiRegistryVerifyBatch).mockResolvedValue(new Response("{}", { status: 422 }));
    const big = JSON.stringify({ npis: Array(300).fill("1234567893") });
    await handleApiRequest(post(PATH, big));
    expect(handleNpiRegistryVerifyBatch).toHaveBeenCalledWith(
      null,
      CTX,
      {},
      expect.any(AbortSignal),
    );
  });

  it("is POST only, and a near-miss path is a 404", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "skip context"));
    vi.mocked(authenticate).mockResolvedValue(CTX);
    const get = await handleApiRequest(
      new Request(`https://x.test${PATH}`, { headers: { authorization: "Bearer t" } }),
    );
    expect(get.status).toBe(405);
    const near = await handleApiRequest(post("/api/npi-registry/verify-batches", "{}"));
    expect(near.status).toBe(404);
    expect(handleNpiRegistryVerifyBatch).not.toHaveBeenCalled();
  });
});
