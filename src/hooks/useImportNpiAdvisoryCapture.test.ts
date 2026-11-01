// MINT-110 PR 2 — a committed import's NPI Registry advisories go to the
// capture seam as facts only, never throw into the commit, and never claim to
// be recorded (the seam records nothing until the advisory store lands).
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureImportNpiAdvisories } from "./useImportNpiAdvisoryCapture";
import type { Advisory } from "@/lib/advisories";
import type { AdvisoryCaptureResult } from "@/services/advisoryCapture";

const advisories: Advisory[] = [
  {
    check: "npi_registry.not_found",
    record: { table: "providers", id: "prov-1", field: "npi" },
    display: "review_step",
    whyItMatters: "The NPI Registry has no record of this NPI; it may be mistyped or deactivated.",
    context: { confirmed: false, importRunId: "run-1", line: 2 },
  },
  {
    check: "npi_registry.not_checked",
    record: { table: "providers", id: "prov-2", field: "npi" },
    display: "review_step",
    whyItMatters:
      "The import was committed before this NPI's registry check ran, so it was saved without one.",
    context: { confirmed: false, importRunId: "run-1", line: 3 },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureImportNpiAdvisories", () => {
  it("hands the facts to the seam exactly as built", async () => {
    const record = vi.fn(async (): Promise<AdvisoryCaptureResult> => ({
      recorded: false,
      reason: "advisory_store_not_built",
    }));
    await captureImportNpiAdvisories(advisories, record);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(advisories);
  });

  it("with the real seam, says nothing was recorded — never claims a capture", async () => {
    await expect(captureImportNpiAdvisories(advisories)).resolves.toEqual({
      recorded: false,
      reason: "advisory_store_not_built",
    });
  });

  it("never throws into the commit; a failure is logged with check keys only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("duplicate key value: AVERY QUILL 1234567893"), {
        code: "23505",
      });
    });
    await expect(captureImportNpiAdvisories(advisories, failing)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("advisory_capture_failed");
    expect(logged).toContain("npi_registry.not_found");
    expect(logged).toContain("23505");
    expect(logged).not.toContain("AVERY");
    expect(logged).not.toContain("1234567893");
  });

  it("sends nothing when there is nothing to send", async () => {
    const record = vi.fn();
    await expect(captureImportNpiAdvisories([], record)).resolves.toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});
