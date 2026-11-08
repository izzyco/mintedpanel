import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./guard", async () => {
  const actual = await vi.importActual<typeof import("./guard")>("./guard");
  return { ...actual, authenticate: vi.fn(), authenticateUser: vi.fn() };
});

const savedRpc = async (name: string, _args?: unknown) =>
  name === "intake_link_paused"
    ? { data: false, error: null }
    : { data: { result: "saved", version: 1 } as unknown, error: null as unknown };
const rpc = vi.fn(savedRpc);
vi.mock("./serviceClient", () => ({ getServiceClient: () => ({ rpc }) }));

import { authenticate, authenticateUser, GuardError } from "./guard";
import { handleApiRequest } from "./api";
import * as intakeRoutes from "./providerIntakeRoutes";
import * as inviteRoutes from "./providerInviteRoutes";
import { INTAKE_COOKIE } from "./intakeTokens";

function intakePost(action: string, json: unknown) {
  return new Request(`https://x.test/api/intake/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${INTAKE_COOKIE}=sess` },
    body: JSON.stringify(json),
  });
}

// A valid draft whose body is about `bytes` long. The padding key is not an
// answer, so it is dropped once the body is read.
function draftOfSize(bytes: number) {
  return {
    t: "tok",
    answers: { mobile: "7045550100" },
    step: "form",
    version: 0,
    pad: "x".repeat(bytes),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rpc.mockImplementation(savedRpc);
});

describe("api dispatch for provider onboarding", () => {
  it("serves /api/intake/* with no flag set and no JWT", async () => {
    const res = await handleApiRequest(
      new Request("https://x.test/api/intake/link", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(res.status).toBe(415);
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

  it("bounds each intake body by its action: a draft takes up to 32 KB, everything else 4 KB", async () => {
    const big = draftOfSize(20 * 1024);
    expect(JSON.stringify(big).length).toBeGreaterThan(4096);
    expect((await handleApiRequest(intakePost("draft", big))).status).toBe(200);
    expect(rpc.mock.calls.map(([name]) => name)).toContain("save_intake_draft");

    rpc.mockClear();
    const tooBig = draftOfSize(34 * 1024);
    expect(JSON.stringify(tooBig).length).toBeGreaterThan(32 * 1024);
    expect((await handleApiRequest(intakePost("draft", tooBig))).status).toBe(400);
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("save_intake_draft");

    rpc.mockClear();
    const longConsent = { t: "tok", typedName: "Anita Rao", version: 1, pad: "x".repeat(5000) };
    expect((await handleApiRequest(intakePost("consent", longConsent))).status).toBe(400);
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("sign_intake_consent");

    rpc.mockClear();
    const longSsn = { t: "tok", ssn: "123-45-6789", pad: "x".repeat(5000) };
    expect((await handleApiRequest(intakePost("ssn", longSsn))).status).toBe(400);
    const longLogin = { t: "tok", portal: "caqh", username: "u", password: "p".repeat(5000) };
    expect((await handleApiRequest(intakePost("login", longLogin))).status).toBe(400);
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("store_intake_ssn");
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("store_intake_portal_login");
  });

  it("answers a vault that can't encrypt with a 500 that carries and logs no SSN or login", async () => {
    vi.stubEnv("DEV", false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // PostgREST puts a rejected row in `details`; the log must never carry it.
    rpc.mockImplementation(async (name: string) =>
      name === "intake_link_paused"
        ? { data: false, error: null }
        : {
            data: null,
            error: {
              code: "P0001",
              message: "Portal credentials key is not configured",
              details: "123456789 anita.caqh Pass-1",
            },
          },
    );
    const ssn = await handleApiRequest(intakePost("ssn", { t: "tok", ssn: "123-45-6789" }));
    const login = await handleApiRequest(
      intakePost("login", { t: "tok", portal: "caqh", username: "anita.caqh", password: "Pass-1" }),
    );
    for (const res of [ssn, login]) {
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.text()).not.toMatch(/6789|anita|Pass-1|not configured/);
    }
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.flat().map(String).join(" ")).not.toMatch(
      /123456789|6789|anita|Pass-1|not configured/,
    );
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

  it("hands a cancel to its handler with the guard's org context, POST only", async () => {
    const guarded = { orgId: "org-1", userId: "u1", role: "admin" } as Awaited<
      ReturnType<typeof authenticate>
    >;
    vi.mocked(authenticate).mockResolvedValue(guarded);
    const spy = vi
      .spyOn(inviteRoutes, "handleCancelProviderOnboarding")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { outcome: "closed" }, error: null, meta: null })),
      );
    const path = "https://x.test/api/provider-invites/5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f/cancel";
    expect((await handleApiRequest(new Request(path, { method: "POST" }))).status).toBe(200);
    expect(spy).toHaveBeenCalledWith("5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", guarded);
    expect((await handleApiRequest(new Request(path, { method: "GET" }))).status).toBe(405);
    expect(spy).toHaveBeenCalledOnce();
  });
});
