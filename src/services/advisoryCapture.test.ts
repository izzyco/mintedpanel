// The capture seam maps #564's and #566's advisories to the MINT-134 ledger
// and records them through recordAdvisory: the ledger's key, the provider, the
// source and the context the registry declares. The client and the active org
// are mocked, so the suite sees exactly what the RPC would be sent. Nothing a
// capture does can throw into a form or a commit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const respond = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ abortSignal: () => respond() })));
const activeOrg = vi.hoisted(() => vi.fn(() => "13400000-0000-4000-a000-00000000000a"));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => activeOrg() }));

import type { Advisory } from "@/lib/advisories";
import { isAdvisoryContextValid } from "@/lib/advisoryChecks";
import {
  advisoryCaptureFailureLog,
  recordAdvisories,
  toLedgerAdvisory,
  type AdvisoryOrigin,
} from "@/services/advisoryCapture";

const ORG = "13400000-0000-4000-a000-00000000000a";
const PROVIDER = "13400000-0000-4000-a000-0000000a0001";
const RUN = "13400000-0000-4000-a000-0000000a0008";

function advisory(check: string, over: Partial<Advisory> = {}): Advisory {
  return {
    check,
    record: { table: "providers", id: PROVIDER, field: "npi" },
    display: "review_step",
    whyItMatters: "Why it matters.",
    context: { confirmed: false },
    ...over,
  };
}

const FORM: AdvisoryOrigin = { surface: "add_provider" };
const IMPORT: AdvisoryOrigin = { surface: "import", importRunId: RUN, line: 12 };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  activeOrg.mockReset();
  activeOrg.mockReturnValue(ORG);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toLedgerAdvisory (the mapping)", () => {
  it("maps each registry answer to the ledger's key", () => {
    const keys = [
      ["npi_registry.organization_number", "npi_registry.organization_number"],
      ["npi_registry.not_found", "npi_registry.not_found"],
      ["npi_registry.name_mismatch", "npi_registry.name_mismatch"],
      ["npi_registry.inactive", "npi_registry.inactive"],
      ["npi_registry.not_checked", "npi_registry.unchecked"],
    ];
    for (const [theirs, ours] of keys) {
      expect(toLedgerAdvisory(advisory(theirs), FORM)?.key).toBe(ours);
    }
  });

  it("drops the checks the ledger has no key for", () => {
    for (const check of [
      "npi_registry.credentials_differ",
      "npi_registry.taxonomy_differs",
      "npi_registry.license_differs",
      "npi_registry.unchecked",
      "toString",
      "",
    ]) {
      expect(toLedgerAdvisory(advisory(check), FORM)).toBeNull();
    }
  });

  it("names the saved provider, and nothing for an unsaved record", () => {
    expect(toLedgerAdvisory(advisory("npi_registry.not_found"), FORM)?.record).toEqual({
      table: "providers",
      id: PROVIDER,
    });
    expect(
      toLedgerAdvisory(
        advisory("npi_registry.not_found", {
          record: { table: "providers", id: null, field: "npi" },
        }),
        FORM,
      ),
    ).toBeNull();
  });

  it("carries the form's surface, or the import run, line and surface, and no field, display or confirmation", () => {
    const confirmed = advisory("npi_registry.name_mismatch", {
      record: { table: "providers", id: PROVIDER, field: "firstName" },
      display: "backend_only",
      context: { confirmed: true },
    });
    expect(toLedgerAdvisory(confirmed, { surface: "roster_form" })?.context).toEqual({
      surface: "roster_form",
    });
    expect(toLedgerAdvisory(confirmed, { surface: "record_edit" })?.context).toEqual({
      surface: "record_edit",
    });
    const fromImport = toLedgerAdvisory(confirmed, IMPORT);
    expect(fromImport?.context).toEqual({ surface: "import", import_run_id: RUN, line: 12 });
    expect(isAdvisoryContextValid(fromImport?.context)).toBe(true);
  });
});

describe("recordAdvisories (the seam)", () => {
  it("calls record_workflow_advisory with the ledger's fields for a form save", async () => {
    await recordAdvisories([advisory("npi_registry.not_checked")], FORM);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", {
      p_org_id: ORG,
      p_check_key: "npi_registry.unchecked",
      p_severity: "advisory",
      p_record_table: "providers",
      p_record_id: PROVIDER,
      p_source: "panel",
      p_context: { surface: "add_provider" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("records an import row's advisories with the import source, run and line", async () => {
    await recordAdvisories(
      [advisory("npi_registry.name_mismatch"), advisory("npi_registry.inactive")],
      IMPORT,
    );
    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        p_check_key: "npi_registry.name_mismatch",
        p_source: "import",
        p_context: { import_run_id: RUN, line: 12, surface: "import" },
      }),
      expect.objectContaining({
        p_check_key: "npi_registry.inactive",
        p_source: "import",
        p_context: { import_run_id: RUN, line: 12, surface: "import" },
      }),
    ]);
  });

  it("sends nothing for a check the ledger has no key for, or for nothing at all", async () => {
    await recordAdvisories([advisory("npi_registry.license_differs")], FORM);
    await recordAdvisories([], FORM);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an RPC error or rejection never throws: one safe line with the check key and SQLSTATE", async () => {
    respond.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "value 1234567893 for Jane Doe" },
    });
    respond.mockRejectedValueOnce(
      Object.assign(new Error("Jane Doe 1234567893"), { code: "08006" }),
    );
    await expect(
      recordAdvisories(
        [advisory("npi_registry.not_found"), advisory("npi_registry.inactive")],
        FORM,
      ),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])))).toEqual([
      { event: "advisory_record_failed", check_key: "npi_registry.not_found", sqlstate: "42501" },
      { event: "advisory_record_failed", check_key: "npi_registry.inactive", sqlstate: "08006" },
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const value of ["Jane", "1234567893", PROVIDER, ORG]) expect(logged).not.toContain(value);
  });

  it("no active org never throws either", async () => {
    activeOrg.mockImplementation(() => {
      throw new Error("No active organization");
    });
    await expect(
      recordAdvisories([advisory("npi_registry.not_found")], FORM),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("advisoryCaptureFailureLog", () => {
  it("keeps the event, the distinct check keys and a SQLSTATE, and nothing else", () => {
    const error = Object.assign(new Error("value (PT-1) is wrong"), {
      code: "23514",
      details: "Failing row contains (PT-1, Jane).",
      hint: "PT-1",
    });
    const log = advisoryCaptureFailureLog(error, [
      "npi_registry.license_differs",
      "npi_registry.license_differs",
      "npi_registry.not_found",
    ]);
    expect(log).toEqual({
      event: "advisory_capture_failed",
      checks: ["npi_registry.license_differs", "npi_registry.not_found"],
      sqlstate: "23514",
    });
    expect(JSON.stringify(log)).not.toContain("PT-1");
  });

  it("has no SQLSTATE for an error without a Postgres code", () => {
    for (const error of [new Error("boom"), "boom", null, { code: 42 }, { code: "not-a-state" }]) {
      expect(advisoryCaptureFailureLog(error, []).sqlstate).toBeNull();
    }
  });
});
