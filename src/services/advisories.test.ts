import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recordAdvisory is a browser-path service: mock the client and the active org
// so the suite sees exactly what would be sent. rpc() records the call and
// returns a builder whose abortSignal() hands back `respond`'s result, like
// PostgREST's filter builder.
const respond = vi.hoisted(() => vi.fn());
const signals = vi.hoisted(() => [] as AbortSignal[]);
const rpc = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({
    abortSignal: (signal: AbortSignal) => {
      signals.push(signal);
      return respond();
    },
  })),
);
const activeOrg = vi.hoisted(() => vi.fn(() => "13400000-0000-4000-a000-00000000000a"));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => activeOrg() }));

import { recordAdvisory } from "./advisories";
import { ADVISORY_RPC_TIMEOUT_MS } from "@/lib/advisoryChecks";

const ORG = "13400000-0000-4000-a000-00000000000a";
const PROVIDER = "13400000-0000-4000-a000-0000000a0001";
const RUN = "13400000-0000-4000-a000-0000000a0008";

let warn: ReturnType<typeof vi.spyOn>;

function loggedLines(): unknown[] {
  return warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

beforeEach(() => {
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  signals.length = 0;
  activeOrg.mockReset();
  activeOrg.mockReturnValue(ORG);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordAdvisory (browser)", () => {
  it("sends the registry's key and severity for the active org, with no actor", async () => {
    await recordAdvisory(
      "npi_registry.not_found",
      { table: "providers", id: PROVIDER },
      { import_run_id: RUN, line: 12, surface: "import" },
      "import",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", {
      p_org_id: ORG,
      p_check_key: "npi_registry.not_found",
      p_severity: "advisory",
      p_record_table: "providers",
      p_record_id: PROVIDER,
      p_source: "import",
      p_context: { import_run_id: RUN, line: 12, surface: "import" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to the panel source and an empty context, and records a critical check as block", async () => {
    await recordAdvisory("notification.sms_disabled", { table: "providers", id: PROVIDER });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_source: "panel",
      p_severity: "block",
      p_context: {},
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_actor_id");
  });

  it("drops undeclared keys and values outside their kind before the call", async () => {
    const leaky = {
      line: 12,
      surface: "record_edit",
      provider_name: "Jane Smith",
      npi: "1234567893",
      import_run_id: "not-a-uuid",
    } as unknown as { line: number; surface: "record_edit" };
    await recordAdvisory("npi_registry.name_mismatch", { table: "providers", id: PROVIDER }, leaky);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_context: { line: 12, surface: "record_edit" } });
    expect((rpc.mock.calls[0][1] as { p_context: unknown }).p_context).toEqual({
      line: 12,
      surface: "record_edit",
    });
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/Jane|1234567893/);
  });

  it("never throws when the RPC refuses, and logs no values", async () => {
    respond.mockResolvedValue({
      data: null,
      error: {
        code: "42501",
        message: "workflow_advisory_not_a_member",
        details: "Failing row contains (Jane Smith, 1961-04-12)",
        hint: null,
      },
    });
    await expect(
      recordAdvisory(
        "import.phone_dropped",
        { table: "providers", id: PROVIDER },
        { import_run_id: RUN, line: 7, column: "billing_phone" },
      ),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "import.phone_dropped", sqlstate: "42501" },
    ]);
    const line = String(warn.mock.calls[0][0]);
    for (const leak of ["Jane", "1961", PROVIDER, RUN, ORG, "billing_phone", "Failing"]) {
      expect(line).not.toContain(leak);
    }
  });

  it("never throws when the ledger isn't applied yet", async () => {
    respond.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    await expect(
      recordAdvisory("npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "PGRST202" },
    ]);
  });

  it("never throws when the call itself throws or rejects", async () => {
    rpc.mockImplementationOnce(() => {
      throw new TypeError("Failed to fetch https://example.supabase.co?name=Jane");
    });
    await expect(
      recordAdvisory("npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeUndefined();
    respond.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      recordAdvisory("npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
    ]);
  });

  it("never throws without an active org, and sends nothing", async () => {
    activeOrg.mockImplementation(() => {
      throw new Error("No active organization");
    });
    await expect(
      recordAdvisory("npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
    ]);
  });

  it("refuses locally, without a call, what the registry doesn't allow", async () => {
    const asAny = recordAdvisory as unknown as (
      key: string,
      record: unknown,
      context?: unknown,
      source?: string,
    ) => Promise<void>;
    await asAny("npi.missing", { table: "tasks", id: PROVIDER });
    await asAny("npi.missing", { table: "providers", id: "1234567893" });
    await asAny("digest.org_failed", { table: "providers", id: PROVIDER });
    await asAny("npi.missing", { table: "providers", id: PROVIDER }, {}, "api");
    await asAny("jane.smith", { table: "providers", id: PROVIDER });
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "digest.org_failed", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "unknown", sqlstate: "22023" },
    ]);
  });

  it("never throws even when logging throws", async () => {
    warn.mockImplementation(() => {
      throw new Error("console unavailable");
    });
    respond.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    await expect(
      recordAdvisory("npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeUndefined();
  });

  it("bounds the call with a timeout, so a hung RPC can't hold a save", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    // A call that never answers until its signal fires, then reports the abort
    // the way PostgREST does (code "").
    respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          signals[0].addEventListener("abort", () =>
            resolve({ data: null, error: { code: "", message: "AbortError: timed out" } }),
          );
        }),
    );
    const pending = recordAdvisory("npi.missing", { table: "providers", id: PROVIDER });
    expect(timeout).toHaveBeenCalledWith(ADVISORY_RPC_TIMEOUT_MS);
    expect(signals[0]).toBe(controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
    ]);
  });

  it("signals every call, with a bound of a few seconds", async () => {
    await recordAdvisory("npi.missing", { table: "providers", id: PROVIDER });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(ADVISORY_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(ADVISORY_RPC_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
