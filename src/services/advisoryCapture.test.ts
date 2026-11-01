// The capture seam records nothing until the advisory store exists, and says
// so: no caller may report an advisory as captured.
import { describe, expect, it } from "vitest";
import { recordAdvisories } from "@/services/advisoryCapture";

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
