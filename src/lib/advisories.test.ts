// The advisory shape a check hands to the capture: facts only (Sowmya's
// standing rule, Oct 31; A35 — no registry value goes into the advisory
// ledger). Whatever a form's view adds stays behind.
import { describe, expect, it } from "vitest";
import { advisoriesForRecord, toCapturedAdvisory, type Advisory } from "@/lib/advisories";

const shown = {
  check: "npi_registry.license_differs",
  record: { table: "providers" as const, id: null, field: "licenses.0.number" },
  display: "review_step" as const,
  whyItMatters: "A license number differs from the NPI Registry's in that state for this NPI.",
  context: { confirmed: false },
  // A form's view of the advisory: values for the screen only.
  id: "npi_registry.license_differs:0",
  title: "CO license PT-1 — the registry has PT-4471",
  detail: null,
  registryValue: "PT-4471",
};

describe("toCapturedAdvisory", () => {
  it("keeps the check key, the record, where it showed, why it matters and the facts", () => {
    expect(toCapturedAdvisory(shown)).toEqual({
      check: "npi_registry.license_differs",
      record: { table: "providers", id: null, field: "licenses.0.number" },
      display: "review_step",
      whyItMatters: "A license number differs from the NPI Registry's in that state for this NPI.",
      context: { confirmed: false },
    });
  });

  it("drops every value a form's view carries", () => {
    const text = JSON.stringify(toCapturedAdvisory(shown));
    expect(text).not.toContain("PT-4471");
    expect(text).not.toContain("PT-1");
    expect(text).not.toContain("title");
  });

  it("drops extra keys inside the record and the context too", () => {
    const sneaky = {
      ...shown,
      record: { ...shown.record, value: "PT-4471" },
      context: { confirmed: true, registryNumber: "PT-4471" },
    } as unknown as Advisory;
    expect(JSON.stringify(toCapturedAdvisory(sneaky))).not.toContain("PT-4471");
  });
});

describe("advisoriesForRecord", () => {
  it("names the saved record, captured shape", () => {
    expect(advisoriesForRecord([shown], "prov-9")).toEqual([
      {
        check: "npi_registry.license_differs",
        record: { table: "providers", id: "prov-9", field: "licenses.0.number" },
        display: "review_step",
        whyItMatters:
          "A license number differs from the NPI Registry's in that state for this NPI.",
        context: { confirmed: false },
      },
    ]);
  });
});
