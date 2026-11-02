// MINT-110 PR 3 — the browser half of /api/npi-registry/pulls: what a
// provider form's save sends (the provider, the NPI, what it took from the
// pick, confirmed; never registry data), and a failure, the build's own
// included, that is logged without values and never reaches the save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { session: { access_token: "tok" } }, error: null })),
);
vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => "org-1" }));

import { recordNpiRegistryPullAfterSave } from "@/services/npiRegistry";
import type { NpiRegistryPullInput } from "@/lib/npiRegistryPulls";

const PULL: NpiRegistryPullInput = {
  providerId: "55555555-5555-4555-8555-555555555555",
  npi: "1234567893",
  sourced: { credentials: "DPT" },
  confirmed: true,
};

function reply(status: number, data: unknown, error: string | null = null): Response {
  return new Response(JSON.stringify({ data, error, meta: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe("recordNpiRegistryPullAfterSave", () => {
  it("posts the pull with the caller's JWT and org", async () => {
    fetchMock.mockResolvedValue(
      reply(201, { pull: { id: "p1", pulledAt: "x", sourced: {}, confirmed: true } }),
    );
    recordNpiRegistryPullAfterSave(() => PULL);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/npi-registry/pulls");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-org-id": "org-1" });
    expect(JSON.parse(String(init.body))).toEqual(PULL);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  it("builds the pull at once, so it holds the form as the save left it", () => {
    const build = vi.fn(() => null);
    recordNpiRegistryPullAfterSave(build);
    expect(build).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: a failed request, the rate limit included, is logged with the status only and not retried", async () => {
    fetchMock.mockResolvedValue(
      reply(429, null, "Too many NPI Registry checks — wait a few seconds and try again"),
    );
    expect(() => recordNpiRegistryPullAfterSave(() => PULL)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual([
      "npi_registry_pull_failed",
      { event: "npi_registry_pull_failed", status: 429 },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PULL.npi);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PULL.providerId);
  });

  it("never throws when building the pull throws, and sends nothing", async () => {
    expect(() =>
      recordNpiRegistryPullAfterSave(() => {
        throw new Error(`bad form state for ${PULL.npi}`);
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0][1]).toEqual({ event: "npi_registry_pull_failed", status: null });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PULL.npi);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
