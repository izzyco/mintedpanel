// A32 (Sowmya, Oct 31): the taxonomy Add Provider preselects is a group-level
// setting, resolved platform → organization → group; Physical Therapist stays
// the platform default. A preset is a default nobody chose.
import { describe, expect, it } from "vitest";
import {
  PLATFORM_TAXONOMY_PRESET,
  resolveTaxonomyPreset,
  taxonomyAfterPresetChange,
  validateTaxonomyPreset,
} from "@/lib/providerTaxonomyPreset";

describe("resolveTaxonomyPreset", () => {
  it("is Physical Therapist with nothing set", () => {
    expect(PLATFORM_TAXONOMY_PRESET).toBe("225100000X");
    expect(resolveTaxonomyPreset()).toBe("225100000X");
    expect(resolveTaxonomyPreset({ org: null, group: null })).toBe("225100000X");
  });

  it("takes the group's, else the organization's; a blank layer inherits", () => {
    expect(resolveTaxonomyPreset({ org: "225X00000X", group: "2251X0800X" })).toBe("2251X0800X");
    expect(resolveTaxonomyPreset({ org: "225X00000X", group: " " })).toBe("225X00000X");
    expect(resolveTaxonomyPreset({ org: "225x00000x" })).toBe("225X00000X");
  });
});

describe("validateTaxonomyPreset", () => {
  it("accepts a blank (inherit) or a code the Taxonomy code list offers", () => {
    expect(validateTaxonomyPreset(null)).toEqual({ ok: true, value: null });
    expect(validateTaxonomyPreset("")).toEqual({ ok: true, value: null });
    expect(validateTaxonomyPreset("225x00000x")).toEqual({ ok: true, value: "225X00000X" });
  });

  it("rejects anything else", () => {
    for (const input of ["999999999X", 42, {}]) {
      expect(validateTaxonomyPreset(input)).toEqual({
        ok: false,
        error: "The preset taxonomy must be one the Taxonomy code list offers",
      });
    }
  });
});

describe("taxonomyAfterPresetChange (a group was chosen or changed)", () => {
  const change = (over: Partial<Parameters<typeof taxonomyAfterPresetChange>[0]> = {}) =>
    taxonomyAfterPresetChange({
      current: "225100000X",
      appliedPreset: "225100000X",
      nextPreset: "225X00000X",
      touched: false,
      pickWrote: null,
      ...over,
    });

  it("gives the new group's preset while the field still holds the old, untouched", () => {
    expect(change()).toBe("225X00000X");
  });

  it("leaves a taxonomy staff chose", () => {
    expect(change({ touched: true })).toBeNull();
    expect(change({ current: "2251X0800X" })).toBeNull();
  });

  it("leaves a taxonomy a pick filled, even when it equals the old preset", () => {
    expect(change({ pickWrote: "225100000X" })).toBeNull();
  });

  it("leaves a blank field blank, and changes nothing when the preset is the same", () => {
    expect(change({ current: "" })).toBeNull();
    expect(change({ nextPreset: "225100000X" })).toBeNull();
  });
});
