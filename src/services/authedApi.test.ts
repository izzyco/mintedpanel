// MINT-110 PR 2 — authedApiFetch keeps a failed response's status and its
// Retry-After (seconds) on the thrown ApiRequestError, with the envelope's
// message unchanged, so the import's NPI checks can tell a 429 from an
// outage. The Supabase session and the network are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "synthetic-token" } },
        error: null,
      })),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => "org-1" }));

import { ApiRequestError, authedApiFetch } from "./authedApi";

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("authedApiFetch errors", () => {
  it("carries a 429's status and Retry-After", async () => {
    fetchMock.mockResolvedValue(
      reply(429, { data: null, error: "Too many NPI Registry checks" }, { "Retry-After": "7" }),
    );
    const error = await authedApiFetch("/api/npi-registry/verify-batch", {
      method: "POST",
      body: "{}",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Too many NPI Registry checks",
      status: 429,
      retryAfterSeconds: 7,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
    expect(new Headers(init?.headers).get("x-org-id")).toBe("org-1");
  });

  it("has no Retry-After when none (or a date) is sent, and keeps the status", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(502, { data: null, error: "NPI Registry is unavailable" }),
    );
    await expect(authedApiFetch("/api/x")).rejects.toMatchObject({
      message: "NPI Registry is unavailable",
      status: 502,
      retryAfterSeconds: null,
    });
    fetchMock.mockResolvedValueOnce(
      reply(503, { data: null, error: null }, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    await expect(authedApiFetch("/api/x")).rejects.toMatchObject({
      message: "Request failed (503)",
      status: 503,
      retryAfterSeconds: null,
    });
  });

  it("returns the data on success", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { results: [] }, error: null }));
    await expect(authedApiFetch("/api/x")).resolves.toEqual({ results: [] });
  });
});
