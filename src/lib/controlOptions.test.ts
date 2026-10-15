import { describe, expect, it } from "vitest";
import {
  AUTHORABLE_TRANSFORM_OPTIONS,
  AUTHORABLE_TRANSFORMS,
  CONTROL_OPTIONS_CAP,
  OPTION_RENDER_LIMIT,
  controlOptionText,
  filterControlOptions,
  hardcodedValueMissingFromOptions,
  isAuthorableTransform,
  optionSample,
  parseControlOptions,
  validateControlOptionsInput,
} from "./controlOptions";

describe("parseControlOptions", () => {
  it("returns null for missing or malformed input", () => {
    expect(parseControlOptions(null)).toBeNull();
    expect(parseControlOptions({ value: "KS" })).toBeNull();
    expect(parseControlOptions([{ value: "KS" }])).toBeNull();
  });

  it("parses { value, label } pairs", () => {
    expect(parseControlOptions([{ value: "KS", label: "Kansas" }])).toEqual([
      { value: "KS", label: "Kansas" },
    ]);
  });
});

describe("validateControlOptionsInput", () => {
  it("accepts null as no list", () => {
    expect(validateControlOptionsInput(null)).toEqual({ kind: "ok", options: null });
  });

  it("rejects a non-array", () => {
    expect(validateControlOptionsInput("KS").kind).toBe("rejected");
  });

  it("accepts an empty array so the caller can ignore it on re-capture", () => {
    expect(validateControlOptionsInput([])).toEqual({ kind: "ok", options: [] });
  });

  // The extension's scanner caps at the same number (captureScan.ts); a
  // one-sided change 422s every long list it proposes. 1000 holds the real
  // vocabularies seen so far: 50 states + DC + territories, a 146-entry
  // specialty list, an 856-entry taxonomy menu.
  it("pins the shared cap at 1000", () => {
    expect(CONTROL_OPTIONS_CAP).toBe(1000);
  });

  it("accepts a list at the cap, including an 856-entry taxonomy menu", () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
    const taxonomy = validateControlOptionsInput(list(856));
    expect(taxonomy.kind).toBe("ok");
    expect(taxonomy.kind === "ok" && taxonomy.options?.length).toBe(856);
    const atCap = validateControlOptionsInput(list(CONTROL_OPTIONS_CAP));
    expect(atCap.kind === "ok" && atCap.options?.length).toBe(CONTROL_OPTIONS_CAP);
  });

  it("rejects a list past the cap rather than truncating it", () => {
    const over = Array.from({ length: CONTROL_OPTIONS_CAP + 1 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${i}`,
    }));
    expect(validateControlOptionsInput(over)).toEqual({
      kind: "rejected",
      message: "control_options cannot exceed 1000 entries",
    });
  });
});

describe("controlOptionText", () => {
  it("joins value and label only when they differ", () => {
    expect(controlOptionText({ value: "KS", label: "Kansas" })).toBe("KS — Kansas");
    expect(controlOptionText({ value: "Yes", label: "Yes" })).toBe("Yes");
    expect(controlOptionText({ value: "Yes", label: "" })).toBe("Yes");
  });
});

describe("filterControlOptions", () => {
  // BlueKC's specialty list: Physical Therapist is #121 of 146.
  const specialties = Array.from({ length: 146 }, (_, i) => ({
    value: String(i + 1),
    label: i === 120 ? "Physical Therapist" : `Specialty ${i + 1}`,
  }));

  it("shows everything up to the render limit for an empty query", () => {
    const { shown, matched } = filterControlOptions(specialties, "  ");
    expect(matched).toBe(146);
    expect(shown).toHaveLength(OPTION_RENDER_LIMIT);
    expect(shown[0]).toEqual(specialties[0]);
  });

  it("matches label or value case-insensitively, past the render limit", () => {
    expect(filterControlOptions(specialties, "physical").shown).toEqual([
      { value: "121", label: "Physical Therapist" },
    ]);
    expect(filterControlOptions(specialties, "121").shown.map((o) => o.label)).toEqual([
      "Physical Therapist",
    ]);
  });

  it("counts every match even when it renders fewer", () => {
    const { shown, matched } = filterControlOptions(specialties, "specialty", 10);
    expect(shown).toHaveLength(10);
    expect(matched).toBe(145);
  });

  it("returns no rows for a query nothing matches", () => {
    expect(filterControlOptions(specialties, "zzz")).toEqual({ shown: [], matched: 0 });
  });
});

describe("hardcodedValueMissingFromOptions", () => {
  const opts = [
    { value: "KS", label: "Kansas" },
    { value: "MO", label: "Missouri" },
  ];
  it("is false when there is no vocabulary or no literal", () => {
    expect(hardcodedValueMissingFromOptions("KS", null)).toBe(false);
    expect(hardcodedValueMissingFromOptions(null, opts)).toBe(false);
  });
  it("is true when the stored value is gone from the list", () => {
    expect(hardcodedValueMissingFromOptions("NE", opts)).toBe(true);
    expect(hardcodedValueMissingFromOptions("KS", opts)).toBe(false);
  });
});

describe("optionSample", () => {
  it("caps at three plus a remainder count", () => {
    const opts = [
      { value: "KS", label: "Kansas" },
      { value: "MO", label: "Missouri" },
      { value: "NE", label: "Nebraska" },
      { value: "IA", label: "Iowa" },
    ];
    expect(optionSample(opts)).toBe("KS, MO, NE; 1 more");
  });
});

describe("isAuthorableTransform", () => {
  it("allows exactly the shared shaping contract", () => {
    expect(isAuthorableTransform("state_abbrev")).toBe(true);
    expect(isAuthorableTransform("date_mmddyyyy")).toBe(true);
    expect(isAuthorableTransform("date_mmddyyyy_dash")).toBe(true);
    expect(isAuthorableTransform("date_ddmmyyyy")).toBe(true);
    expect(isAuthorableTransform("date_ddmmyyyy_dash")).toBe(true);
    expect(isAuthorableTransform("date_yyyymmdd_slash")).toBe(true);
    expect(isAuthorableTransform("date_yyyymmdd")).toBe(true);
    expect(isAuthorableTransform("zip5")).toBe(true);
    expect(isAuthorableTransform("phone_digits")).toBe(true);
    expect(isAuthorableTransform("phone_dashed")).toBe(true);
    expect(isAuthorableTransform("phone_country_dashed")).toBe(true);
    expect(isAuthorableTransform("phone_e164")).toBe(true);
    expect(isAuthorableTransform("tin_digits")).toBe(true);
    expect(isAuthorableTransform("tin_dashed")).toBe(true);
    expect(isAuthorableTransform("uppercase")).toBe(false);
    expect(AUTHORABLE_TRANSFORM_OPTIONS.map(({ value }) => value)).toEqual(AUTHORABLE_TRANSFORMS);
  });
});
