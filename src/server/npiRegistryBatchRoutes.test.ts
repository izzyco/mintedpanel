// MINT-110 PR 2 — POST /api/npi-registry/verify-batch: writer-only; validated
// before any upstream call or budget; its own per-user budget (429 +
// Retry-After) that never touches the interactive one; per-NPI results through
// the shared cache; at most two registry calls at a time; an outage is per NPI
// and a 502 only when nothing could be checked; no NPI in the server log.
// No network: fetch is injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { AuthContext } from "./guard";
import {
  NPI_REGISTRY_BATCH_CONCURRENCY,
  handleNpiRegistryVerifyBatch,
  resetNpiRegistryBatchBudget,
} from "./npiRegistryBatchRoutes";
import {
  NPI_REGISTRY_RATE_LIMIT,
  handleNpiRegistryLookup,
  resetNpiRegistryLimits,
} from "./npiRegistryRoutes";
import type { NpiRegistryBatchResult } from "@/lib/npiRegistryBatch";
import { npiCheckDigit } from "@/lib/providerIdentity";

function ctx(role: AuthContext["role"] = "specialist", userId = "u1"): AuthContext {
  return {
    userId,
    orgId: "org-1",
    role,
    userName: "Jordan Seed",
    email: "jordan@minted.example",
    userMetadata: null,
    db: {} as AuthContext["db"],
    writeAudit: vi.fn(),
  };
}

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}
const npis = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => fakeNpi(from + i));

function nppesRecord(npi: string, over: Record<string, unknown> = {}) {
  return {
    number: npi,
    enumeration_type: "NPI-1",
    basic: { first_name: "SYNTH", last_name: "TESTER", status: "A" },
    addresses: [{ address_purpose: "LOCATION", city: "DENVER", state: "CO" }],
    taxonomies: [{ code: "225100000X", desc: "Physical Therapist", primary: true }],
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A registry that knows every NPI it is asked for, unless told otherwise. */
function registry(answer?: (npi: string, call: number) => Response | Promise<Response>) {
  let calls = 0;
  return vi.fn<typeof fetch>(async (input) => {
    calls += 1;
    const npi = new URL(String(input)).searchParams.get("number") ?? "";
    if (answer) return answer(npi, calls);
    return json({ result_count: 1, results: [nppesRecord(npi)] });
  });
}

async function envelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  return (await response.json()) as ApiEnvelope<T>;
}

let now = 0;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = 1_000_000;
  resetNpiRegistryLimits(() => now);
  resetNpiRegistryBatchBudget(() => now);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("POST /api/npi-registry/verify-batch", () => {
  it("answers each NPI with the public record, sending only the number upstream", async () => {
    const [found, missing] = npis(2);
    const fetchFn = registry((npi) =>
      npi === missing
        ? json({ result_count: 0, results: [] })
        : json({ result_count: 1, results: [nppesRecord(npi)] }),
    );
    const res = await handleNpiRegistryVerifyBatch(
      { npis: [`${found.slice(0, 5)}-${found.slice(5)}`, missing] },
      ctx(),
      { fetch: fetchFn },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await envelope<NpiRegistryBatchResult>(res);
    expect(body.data?.results).toEqual([
      {
        npi: found,
        status: "checked",
        record: expect.objectContaining({ npi: found, lastName: "TESTER", practiceCity: "DENVER" }),
      },
      { npi: missing, status: "checked", record: null },
    ]);
    for (const [url] of fetchFn.mock.calls) {
      const params = new URL(String(url)).searchParams;
      expect([...params.keys()].sort()).toEqual(["number", "version"]);
    }
  });

  it("returns an organization (NPI-2) record as checked — the browser warns, nothing blocks", async () => {
    const [org] = npis(1);
    const fetchFn = registry(() =>
      json({
        result_count: 1,
        results: [
          nppesRecord(org, {
            enumeration_type: "NPI-2",
            basic: { organization_name: "QUILL THERAPY LLC", status: "A" },
          }),
        ],
      }),
    );
    const res = await handleNpiRegistryVerifyBatch({ npis: [org] }, ctx(), { fetch: fetchFn });
    const body = await envelope<NpiRegistryBatchResult>(res);
    expect(body.data?.results[0]).toMatchObject({
      status: "checked",
      record: { enumerationType: "NPI-2", organizationName: "QUILL THERAPY LLC" },
    });
  });

  it("is writer-only: billing gets 403, the registry is never called and no budget is spent", async () => {
    const fetchFn = registry();
    for (let i = 0; i < 5; i += 1) {
      const res = await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx("billing"), {
        fetch: fetchFn,
      });
      expect(res.status).toBe(403);
      expect((await envelope(res)).data).toBeNull();
    }
    expect(fetchFn).not.toHaveBeenCalled();
    // The admin's burst is intact.
    for (const role of ["admin", "admin"] as const) {
      const res = await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx(role, "u-admin"), {
        fetch: fetchFn,
      });
      expect(res.status).toBe(200);
    }
  });

  it("422s a malformed request before any registry call or budget", async () => {
    const fetchFn = registry();
    const bad = `${fakeNpi(3).slice(0, 9)}${(Number(fakeNpi(3)[9]) + 1) % 10}`;
    for (const body of [null, {}, { npis: [] }, { npis: npis(11) }, { npis: [fakeNpi(1), bad] }]) {
      const res = await handleNpiRegistryVerifyBatch(body, ctx(), { fetch: fetchFn });
      expect(res.status).toBe(422);
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
    expect(fetchFn).not.toHaveBeenCalled();
    const ok = await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx(), { fetch: fetchFn });
    expect(ok.status).toBe(200);
    const ok2 = await handleNpiRegistryVerifyBatch({ npis: npis(10, 20) }, ctx(), {
      fetch: fetchFn,
    });
    expect(ok2.status).toBe(200);
  });

  it("429s with Retry-After past its own budget, per user, and refills over time", async () => {
    const fetchFn = registry();
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx(), { fetch: fetchFn })).status,
    ).toBe(200);
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 11) }, ctx(), { fetch: fetchFn }))
        .status,
    ).toBe(200);
    const limited = await handleNpiRegistryVerifyBatch({ npis: npis(10, 21) }, ctx(), {
      fetch: fetchFn,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect((await envelope(limited)).error).toBe(
      "Too many NPI Registry checks — wait a few seconds and try again",
    );
    expect(fetchFn).toHaveBeenCalledTimes(20);
    // Another user has a budget of their own.
    expect(
      (
        await handleNpiRegistryVerifyBatch({ npis: npis(10, 21) }, ctx("admin", "u2"), {
          fetch: fetchFn,
        })
      ).status,
    ).toBe(200);
    now += 10_000;
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 21) }, ctx(), { fetch: fetchFn }))
        .status,
    ).toBe(200);
  });

  it("spends a budget separate from the interactive 30 a minute, both ways", async () => {
    const fetchFn = registry();
    for (let i = 0; i < NPI_REGISTRY_RATE_LIMIT; i += 1) {
      const res = await handleNpiRegistryLookup({ npi: fakeNpi(100 + i) }, ctx(), {
        fetch: fetchFn,
      });
      expect(res.status).toBe(200);
    }
    expect(
      (await handleNpiRegistryLookup({ npi: fakeNpi(200) }, ctx(), { fetch: fetchFn })).status,
    ).toBe(429);
    // The interactive budget is gone; the import's is untouched.
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx(), { fetch: fetchFn })).status,
    ).toBe(200);
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 11) }, ctx(), { fetch: fetchFn }))
        .status,
    ).toBe(200);
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 21) }, ctx(), { fetch: fetchFn }))
        .status,
    ).toBe(429);
    // And an exhausted import budget leaves typed lookups alone.
    now += 60_000;
    expect(
      (await handleNpiRegistryLookup({ npi: fakeNpi(201) }, ctx(), { fetch: fetchFn })).status,
    ).toBe(200);
  });

  it("shares the lookup cache: an NPI already looked up costs no registry call", async () => {
    const fetchFn = registry();
    const [a, b] = npis(2);
    await handleNpiRegistryLookup({ npi: a }, ctx(), { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await handleNpiRegistryVerifyBatch({ npis: [a, b] }, ctx(), { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // …and the batch's answers serve a later typed lookup.
    const res = await handleNpiRegistryLookup({ npi: b }, ctx(), { fetch: fetchFn });
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("runs at most two registry calls at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = registry(async (npi) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return json({ result_count: 1, results: [nppesRecord(npi)] });
    });
    const res = await handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx(), { fetch: fetchFn });
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(10);
    expect(peak).toBe(NPI_REGISTRY_BATCH_CONCURRENCY);
  });

  it("502s when the registry is down, after at most two calls, and logs no NPI", async () => {
    const fetchFn = registry(() => {
      throw new TypeError("fetch failed");
    });
    const sent = npis(10);
    const res = await handleNpiRegistryVerifyBatch({ npis: sent }, ctx(), { fetch: fetchFn });
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await envelope(res)).error).toBe("NPI Registry is unavailable");
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(NPI_REGISTRY_BATCH_CONCURRENCY);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("network");
    for (const npi of sent) expect(logged).not.toContain(npi);
  });

  it("reports a mid-batch outage per NPI: checked stays checked, never-sent NPIs are deferred and refunded", async () => {
    const sent = npis(10);
    const fetchFn = registry((npi) =>
      npi === sent[0]
        ? json({ result_count: 1, results: [nppesRecord(npi)] })
        : json({ message: "busy" }, 503),
    );
    const res = await handleNpiRegistryVerifyBatch({ npis: sent }, ctx(), { fetch: fetchFn });
    expect(res.status).toBe(200);
    const body = await envelope<NpiRegistryBatchResult>(res);
    const statuses = body.data?.results.map((result) => result.status) ?? [];
    const calls = fetchFn.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(3);
    expect(statuses[0]).toBe("checked");
    // Each NPI sent and failed is "unavailable"; every NPI never sent is
    // "deferred", so the browser can ask for it again.
    expect(statuses.filter((status) => status === "unavailable")).toHaveLength(calls - 1);
    expect(statuses.filter((status) => status === "deferred")).toHaveLength(10 - calls);
    expect(warn.mock.calls.flat().join(" ")).toContain("http 503");
    // Only the NPIs sent were spent: 10 + (10 - calls) more fit in the burst.
    const healthy = registry();
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 30) }, ctx(), { fetch: healthy }))
        .status,
    ).toBe(200);
    expect(
      (
        await handleNpiRegistryVerifyBatch({ npis: npis(10 - calls, 50) }, ctx(), {
          fetch: healthy,
        })
      ).status,
    ).toBe(200);
  });

  it("stops new calls and cancels those in flight when the caller goes away", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          seen.push(signal);
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
          if (seen.length === 1) {
            resolve(json({ result_count: 1, results: [nppesRecord(npis(1)[0])] }));
          }
        }),
    );
    const pending = handleNpiRegistryVerifyBatch(
      { npis: npis(10) },
      ctx(),
      { fetch: fetchFn },
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    const before = fetchFn.mock.calls.length;
    controller.abort();
    const res = await pending;
    // The calls in flight saw the abort; no new call started after it.
    expect(seen.slice(1).every((signal) => signal.aborted)).toBe(true);
    expect(fetchFn.mock.calls.length).toBe(before);
    const body = await envelope<NpiRegistryBatchResult>(res);
    expect(body.data?.results.filter((result) => result.status === "deferred").length).toBe(
      10 - before,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends only what the import review needs: no addresses, phones, other taxonomies or identifiers", async () => {
    const [npi] = npis(1);
    const fetchFn = registry(() =>
      json({
        result_count: 1,
        results: [
          nppesRecord(npi, {
            basic: {
              first_name: "SYNTH",
              middle_name: "Q",
              last_name: "TESTER",
              name_suffix: "JR",
              credential: "PT",
              status: "A",
              enumeration_date: "2016-01-04",
            },
            addresses: [
              {
                address_purpose: "LOCATION",
                address_1: "1 SYNTHETIC WAY",
                city: "DENVER",
                state: "CO",
                postal_code: "802020000",
                telephone_number: "303-555-0100",
              },
              { address_purpose: "MAILING", address_1: "PO BOX 1", city: "DENVER", state: "CO" },
            ],
            taxonomies: [
              {
                code: "225100000X",
                desc: "Physical Therapist",
                primary: true,
                license: "PT1",
                state: "CO",
              },
              { code: "2251X0800X", desc: "Orthopedic", primary: false },
            ],
            identifiers: [{ identifier: "SYN-123", desc: "MEDICAID", state: "CO" }],
            other_names: [{ first_name: "SYNTHIA", last_name: "TESTER", type: "Former Name" }],
          }),
        ],
      }),
    );
    const res = await handleNpiRegistryVerifyBatch({ npis: [npi] }, ctx(), { fetch: fetchFn });
    const body = await envelope<NpiRegistryBatchResult>(res);
    const record = body.data?.results[0].record as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      [
        "credential",
        "enumerationDate",
        "enumerationType",
        "firstName",
        "lastName",
        "middleName",
        "npi",
        "organizationName",
        "otherNames",
        "practiceCity",
        "practiceState",
        "primaryTaxonomy",
        "status",
        "suffix",
      ].sort(),
    );
    expect(record).toMatchObject({
      practiceCity: "DENVER",
      practiceState: "CO",
      primaryTaxonomy: { description: "Physical Therapist" },
      enumerationDate: null,
      otherNames: [{ firstName: "SYNTHIA", lastName: "TESTER", middleName: null }],
    });
    const raw = JSON.stringify(body);
    for (const leaked of [
      "1 SYNTHETIC WAY",
      "303-555-0100",
      "PO BOX 1",
      "SYN-123",
      "Orthopedic",
      "PT1",
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it("defers what it could not start in time, and refunds that budget", async () => {
    // Each registry call takes 3 s of the 4 s start deadline.
    const fetchFn = registry((npi) => {
      now += 3_000;
      return json({ result_count: 1, results: [nppesRecord(npi)] });
    });
    const sent = npis(10);
    const res = await handleNpiRegistryVerifyBatch({ npis: sent }, ctx(), { fetch: fetchFn });
    expect(res.status).toBe(200);
    const body = await envelope<NpiRegistryBatchResult>(res);
    const statuses = body.data?.results.map((result) => result.status) ?? [];
    expect(statuses.slice(0, 2)).toEqual(["checked", "checked"]);
    expect(statuses.slice(2)).toEqual(Array(8).fill("deferred"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Only 2 of the 20 were spent (plus 6 s of refill): 10 more go at once,
    // and the 10 after that, which a spent budget would have refused.
    const quick = registry();
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(10, 30) }, ctx(), { fetch: quick })).status,
    ).toBe(200);
    expect(
      (await handleNpiRegistryVerifyBatch({ npis: npis(8, 40) }, ctx(), { fetch: quick })).status,
    ).toBe(200);
  });

  it("checks a repeated NPI once", async () => {
    const fetchFn = registry();
    const [a] = npis(1);
    const res = await handleNpiRegistryVerifyBatch({ npis: [a, a, ` ${a}`] }, ctx(), {
      fetch: fetchFn,
    });
    const body = await envelope<NpiRegistryBatchResult>(res);
    expect(body.data?.results).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
