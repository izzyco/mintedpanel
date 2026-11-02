import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { recordJobAdvisory, recordServerAdvisory, resolveAdvisories } from "./advisories";
import { ADVISORY_RPC_TIMEOUT_MS } from "@/lib/advisoryChecks";

const ORG = "13400000-0000-4000-a000-00000000000a";
const USER = "13400000-0000-4000-a000-000000000001";
const PROVIDER = "13400000-0000-4000-a000-0000000a0001";
const TASK = "13400000-0000-4000-a000-0000000a0004";

// rpc() records the call; its builder's abortSignal() hands back `respond`.
const respond = vi.fn();
const signals: AbortSignal[] = [];
const rpc = vi.fn((..._args: unknown[]) => ({
  abortSignal: (signal: AbortSignal) => {
    signals.push(signal);
    return respond();
  },
}));
const db = { rpc } as unknown as SupabaseClient<Database>;
let warn: ReturnType<typeof vi.spyOn>;

function loggedLines(): unknown[] {
  return warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

beforeEach(() => {
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  signals.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordServerAdvisory (/api and extension routes)", () => {
  it("sends the guard's org and user as the actor, with the route's source", async () => {
    await recordServerAdvisory(
      { db, orgId: ORG, userId: USER },
      "extension",
      "task.step_out_of_order",
      { table: "tasks", id: TASK },
      { step_order: 2, earlier_open_count: 1 },
    );
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", {
      p_org_id: ORG,
      p_actor_id: USER,
      p_check_key: "task.step_out_of_order",
      p_severity: "advisory",
      p_record_table: "tasks",
      p_record_id: TASK,
      p_source: "extension",
      p_context: { step_order: 2, earlier_open_count: 1 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("never throws, and logs only the event, the key and the SQLSTATE", async () => {
    respond.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "workflow_advisory_record_not_in_org", details: "Jane" },
    });
    await expect(
      recordServerAdvisory({ db, orgId: ORG, userId: USER }, "api", "touch.other_without_context", {
        table: "touches",
        id: PROVIDER,
      }),
    ).resolves.toBeUndefined();
    respond.mockRejectedValueOnce(new Error("fetch failed for Jane"));
    await expect(
      recordServerAdvisory({ db, orgId: ORG, userId: USER }, "api", "npi.missing", {
        table: "providers",
        id: PROVIDER,
      }),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      {
        event: "advisory_record_failed",
        check_key: "touch.other_without_context",
        sqlstate: "22023",
      },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
    ]);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/Jane|13400000/);
  });

  it("refuses locally a browser source, a missing actor or an undeclared record", async () => {
    const asAny = recordServerAdvisory as unknown as (
      ctx: unknown,
      source: string,
      key: string,
      record: unknown,
    ) => Promise<void>;
    await asAny({ db, orgId: ORG, userId: USER }, "panel", "npi.missing", {
      table: "providers",
      id: PROVIDER,
    });
    await asAny({ db, orgId: ORG, userId: "" }, "api", "npi.missing", {
      table: "providers",
      id: PROVIDER,
    });
    await asAny({ db, orgId: ORG, userId: USER }, "api", "npi.missing", {
      table: "touches",
      id: PROVIDER,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toHaveLength(3);
  });
});

describe("recordJobAdvisory (scheduled jobs)", () => {
  it("sends the job name and no actor", async () => {
    await recordJobAdvisory(db, "advisory-recheck", ORG, "npi_registry.unchecked", {
      table: "providers",
      id: PROVIDER,
    });
    expect(rpc).toHaveBeenCalledWith("record_job_advisory", {
      p_job: "advisory-recheck",
      p_org_id: ORG,
      p_check_key: "npi_registry.unchecked",
      p_severity: "advisory",
      p_record_table: "providers",
      p_record_id: PROVIDER,
      p_context: {},
    });
  });

  it("treats a repeat of an open finding (null) as success", async () => {
    respond.mockResolvedValue({ data: null, error: null });
    await recordJobAdvisory(db, "advisory-recheck", ORG, "npi_registry.unchecked", {
      table: "providers",
      id: PROVIDER,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses an invalid job name locally and never throws", async () => {
    await expect(
      recordJobAdvisory(db, "Nightly Recheck", ORG, "npi_registry.unchecked", {
        table: "providers",
        id: PROVIDER,
      }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(
      recordJobAdvisory(db, "advisory-recheck", ORG, "npi_registry.unchecked", {
        table: "providers",
        id: PROVIDER,
      }),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "npi_registry.unchecked", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "npi_registry.unchecked", sqlstate: "unknown" },
    ]);
  });
});

describe("resolveAdvisories", () => {
  it("stamps the open rows for the record and returns how many", async () => {
    respond.mockResolvedValue({ data: 2, error: null });
    await expect(
      resolveAdvisories(db, ORG, "npi_registry.unchecked", { table: "providers", id: PROVIDER }),
    ).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith("resolve_workflow_advisories", {
      p_org_id: ORG,
      p_check_key: "npi_registry.unchecked",
      p_record_table: "providers",
      p_record_id: PROVIDER,
    });
  });

  it("names the resolver only when there is one", async () => {
    respond.mockResolvedValue({ data: 1, error: null });
    await resolveAdvisories(db, ORG, "npi.missing", { table: "providers", id: PROVIDER }, USER);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_resolved_by: USER });
  });

  it("returns null instead of throwing, and logs the resolve event", async () => {
    respond.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "nope" } });
    await expect(
      resolveAdvisories(db, ORG, "npi.missing", { table: "providers", id: PROVIDER }, USER),
    ).resolves.toBeNull();
    respond.mockRejectedValueOnce(new Error("down"));
    await expect(
      resolveAdvisories(db, ORG, "npi.missing", { table: "providers", id: PROVIDER }),
    ).resolves.toBeNull();
    expect(loggedLines()).toEqual([
      { event: "advisory_resolve_failed", check_key: "npi.missing", sqlstate: "42501" },
      { event: "advisory_resolve_failed", check_key: "npi.missing", sqlstate: "unknown" },
    ]);
  });
});

describe("every server call is bounded", () => {
  it("passes a timeout signal on the record, job and resolve calls", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await recordServerAdvisory({ db, orgId: ORG, userId: USER }, "api", "npi.missing", {
      table: "providers",
      id: PROVIDER,
    });
    await recordJobAdvisory(db, "advisory-recheck", ORG, "npi.missing", {
      table: "providers",
      id: PROVIDER,
    });
    respond.mockResolvedValueOnce({ data: 0, error: null });
    await resolveAdvisories(db, ORG, "npi.missing", { table: "providers", id: PROVIDER });
    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeout.mock.calls).toEqual([
      [ADVISORY_RPC_TIMEOUT_MS],
      [ADVISORY_RPC_TIMEOUT_MS],
      [ADVISORY_RPC_TIMEOUT_MS],
    ]);
  });
});
