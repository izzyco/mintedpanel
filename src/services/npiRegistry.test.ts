// MINT-110 PR 3 — the browser half of /api/npi-registry/pulls: what a save
// sends (the provider, the NPI, what it took from the pick, confirmed; never
// registry data), one request at a time, and a failure that is logged without
// values and never reaches the save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { session: { access_token: "tok" } }, error: null })),
);
vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => "org-1" }));

import { recordNpiRegistryPulls } from "@/services/npiRegistry";
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

describe("recordNpiRegistryPulls", () => {
  it("posts each pull with the caller's JWT and org, one at a time", async () => {
    let inFlight = 0;
    let most = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return reply(201, { pull: { id: "p1", pulledAt: "x", sourced: {}, confirmed: false } });
    });
    const second = { ...PULL, npi: "1902833742", sourced: {}, confirmed: false };
    await recordNpiRegistryPulls([PULL, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/npi-registry/pulls");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-org-id": "org-1" });
    expect(JSON.parse(String(init.body))).toEqual(PULL);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual(
      second,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("never rejects: a failure is logged with counts and the status only", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(502, null, "NPI Registry is unavailable"))
      .mockResolvedValueOnce(reply(201, { pull: {} }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(recordNpiRegistryPulls([PULL, PULL, PULL])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual([
      "npi_registry_pull_failed",
      { event: "npi_registry_pull_failed", failed: 2, of: 3, status: null },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PULL.npi);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PULL.providerId);
  });

  it("logs the last HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(reply(404, null, "Provider not found"));
    await recordNpiRegistryPulls([PULL]);
    expect(warn.mock.calls[0][1]).toEqual({
      event: "npi_registry_pull_failed",
      failed: 1,
      of: 1,
      status: 404,
    });
  });

  it("sends nothing for no pulls", async () => {
    await recordNpiRegistryPulls([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
