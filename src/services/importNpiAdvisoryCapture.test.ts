// MINT-110 PR 2 / MINT-134 — a committed import's NPI advisories reach the
// ledger's RPC with the import source, the run and each row's line, and
// nothing a capture does can throw into the commit. The client and the active
// org are mocked, so the suite sees exactly what would be sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const respond = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ abortSignal: () => respond() })));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => "13400000-0000-4000-a000-00000000000a" }));

import type { Advisory } from "@/lib/advisories";
import { captureImportNpiAdvisories, type ImportNpiCapture } from "./importNpiAdvisoryCapture";

const ORG = "13400000-0000-4000-a000-00000000000a";
const PROVIDER = "13400000-0000-4000-a000-0000000a0001";
const NPI_LESS = "13400000-0000-4000-a000-0000000a0002";
const RUN = "13400000-0000-4000-a000-0000000a0008";

const notFound: Advisory = {
  check: "npi_registry.not_found",
  record: { table: "providers", id: PROVIDER, field: "npi" },
  display: "review_step",
  whyItMatters: "The NPI Registry has no record of this NPI; it may be mistyped or deactivated.",
  context: { confirmed: false },
};

const capture: ImportNpiCapture = {
  registry: [{ line: 4, advisories: [notFound] }],
  rows: [{ check: "import.npi_missing", record: { table: "providers", id: NPI_LESS }, line: 7 }],
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureImportNpiAdvisories", () => {
  it("records the registry's answers and the run's NPI-less creates, each with the run and its line", async () => {
    await captureImportNpiAdvisories(RUN, () => capture);
    expect(rpc.mock.calls).toEqual([
      [
        "record_workflow_advisory",
        {
          p_org_id: ORG,
          p_check_key: "npi_registry.not_found",
          p_severity: "advisory",
          p_record_table: "providers",
          p_record_id: PROVIDER,
          p_source: "import",
          p_context: { import_run_id: RUN, line: 4, surface: "import" },
        },
      ],
      [
        "record_workflow_advisory",
        {
          p_org_id: ORG,
          p_check_key: "import.npi_missing",
          p_severity: "advisory",
          p_record_table: "providers",
          p_record_id: NPI_LESS,
          p_source: "import",
          p_context: { import_run_id: RUN, line: 7 },
        },
      ],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  // One RPC at a time: a burst of parallel calls would each start its own
  // timeout and could time out behind the others.
  it("sends one RPC at a time, the next only after the last one answered", async () => {
    const answers: ((value: unknown) => void)[] = [];
    respond.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const pending = captureImportNpiAdvisories(RUN, () => ({
      registry: capture.registry,
      rows: [
        ...capture.rows,
        { check: "import.npi_missing", record: { table: "providers", id: PROVIDER }, line: 9 },
      ],
    }));
    // The registry row, then each NPI-less create: each waits for the last.
    for (let sent = 1; sent <= 3; sent += 1) {
      await tick();
      expect(rpc).toHaveBeenCalledTimes(sent);
      answers[sent - 1]({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
    }
    await pending;
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("sends nothing when there is nothing to send", async () => {
    await captureImportNpiAdvisories(RUN, () => ({ registry: [], rows: [] }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an RPC failure is logged with the check key and SQLSTATE only, the rest still go, and it never rejects", async () => {
    respond.mockResolvedValueOnce({
      data: null,
      error: { code: "23505", message: "value 1234567893 leaked" },
    });
    await expect(captureImportNpiAdvisories(RUN, () => capture)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: "advisory_record_failed",
      check_key: "npi_registry.not_found",
      sqlstate: "23505",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("1234567893");
  });

  it("a builder that throws is logged without values and sends nothing", async () => {
    await expect(
      captureImportNpiAdvisories(RUN, () => {
        throw new Error("synthetic: Avery Quill 1234567893");
      }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("advisory_capture_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Avery");
  });
});
