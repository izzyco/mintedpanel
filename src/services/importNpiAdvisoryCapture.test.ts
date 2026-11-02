// MINT-110 PR 2 — a committed import's NPI Registry advisories go to the
// capture seam as built, and nothing a capture does can throw into the commit.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Advisory } from "@/lib/advisories";

vi.mock("@/services/advisoryCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/advisoryCapture")>()),
  recordAdvisories: vi.fn(async () => ({
    recorded: false,
    reason: "advisory_store_not_built",
  })),
}));

import { recordAdvisories } from "@/services/advisoryCapture";
import { captureImportNpiAdvisories } from "./importNpiAdvisoryCapture";

const advisories: Advisory[] = [
  {
    check: "npi_registry.not_found",
    record: { table: "providers", id: "prov-1", field: "npi" },
    display: "review_step",
    whyItMatters: "The NPI Registry has no record of this NPI; it may be mistyped or deactivated.",
    context: { confirmed: false },
  },
];

afterEach(() => {
  vi.mocked(recordAdvisories).mockClear();
  vi.restoreAllMocks();
});

describe("captureImportNpiAdvisories", () => {
  it("hands the advisories to the seam exactly as built", async () => {
    await captureImportNpiAdvisories(() => advisories);
    expect(recordAdvisories).toHaveBeenCalledWith(advisories);
  });

  it("sends nothing when there is nothing to send", async () => {
    await captureImportNpiAdvisories(() => []);
    expect(recordAdvisories).not.toHaveBeenCalled();
  });

  it("a seam failure is logged with the check keys only, and never rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(recordAdvisories).mockRejectedValueOnce(
      Object.assign(new Error("value 1234567893 leaked"), { code: "23505" }),
    );
    await expect(captureImportNpiAdvisories(() => advisories)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("advisory_capture_failed", {
      event: "advisory_capture_failed",
      checks: ["npi_registry.not_found"],
      sqlstate: "23505",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("1234567893");
  });

  it("a builder that throws is logged without values and sends nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      captureImportNpiAdvisories(() => {
        throw new Error("synthetic: Avery Quill 1234567893");
      }),
    ).resolves.toBeUndefined();
    expect(recordAdvisories).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Avery");
  });
});
