import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./guard", async () => {
  const actual = await vi.importActual<typeof import("./guard")>("./guard");
  return { ...actual, authenticate: vi.fn(), authenticateUser: vi.fn() };
});

import { authenticate, authenticateUser, GuardError } from "./guard";
import { handleApiRequest } from "./api";
import * as intakeRoutes from "./providerIntakeRoutes";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("api dispatch for provider onboarding", () => {
  it("reaches /api/intake/* without a JWT, and the kill switch defaults to a JSON 404", async () => {
    vi.stubEnv("PROVIDER_ONBOARDING_ENABLED", "");
    const res = await handleApiRequest(
      new Request("https://x.test/api/intake/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: "x" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ data: null, error: "Not found", meta: null });
    expect(authenticate).not.toHaveBeenCalled();
    expect(authenticateUser).not.toHaveBeenCalled();
  });

  it("dispatches /api/intake/* before any JWT work, even when a bearer is sent", async () => {
    const spy = vi
      .spyOn(intakeRoutes, "handleIntakeRequest")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { sent: true }, error: null, meta: null })),
      );
    const res = await handleApiRequest(
      new Request("https://x.test/api/intake/code", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer staff-token" },
        body: JSON.stringify({ t: "x" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(authenticateUser).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("puts /api/provider-invites behind the normal org guard", async () => {
    vi.mocked(authenticateUser).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    vi.mocked(authenticate).mockRejectedValue(new GuardError(401, "Missing bearer token"));
    const res = await handleApiRequest(
      new Request("https://x.test/api/provider-invites", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(authenticate).toHaveBeenCalled();
  });
});
