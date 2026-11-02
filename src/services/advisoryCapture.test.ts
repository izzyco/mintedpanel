// The capture seam records nothing until the advisory store exists, and says
// so: no caller may report an advisory as captured.
import { describe, expect, it } from "vitest";
import { advisoryCaptureFailureLog, recordAdvisories } from "@/services/advisoryCapture";

describe("recordAdvisories (seam)", () => {
  it("records nothing and says why", async () => {
    await expect(
      recordAdvisories([
        {
          check: "npi_registry.not_found",
          record: { table: "providers", id: "prov-1", field: "npi" },
          display: "review_step",
          whyItMatters: "The NPI Registry has no record of this NPI.",
          context: { confirmed: false },
        },
      ]),
    ).resolves.toEqual({ recorded: false, reason: "advisory_store_not_built" });
    await expect(recordAdvisories([])).resolves.toEqual({
      recorded: false,
      reason: "advisory_store_not_built",
    });
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
