// MINT-116 — the Add Provider start-date rules: each rule with its default and
// its alternative, the resolver's precedence, the validator, and the prefill
// and hint the forms show from them. A blank field is never filled in at save
// under any rule, and nothing refuses a save. The defaults keep MINT-96's
// behaviour.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADD_PROVIDER_RULES,
  addProviderStartDateHint,
  addProviderStartDatePrefill,
  addProviderStartDates,
  blankAssignmentStartDate,
  resolveAddProviderRules,
  validateAddProviderRules,
  type AddProviderRules,
} from "./addProviderRules";

const TODAY = "2026-10-30";
const DEFAULT = DEFAULT_ADD_PROVIDER_RULES;
const rules = (over: Partial<AddProviderRules>): AddProviderRules => ({ ...DEFAULT, ...over });
const PREFILL_TODAY = rules({ providerStartDatePrefill: "today" });
const ASSIGNMENT_NONE = rules({ assignmentStartDateDefault: "none" });
const ALL = [
  DEFAULT,
  PREFILL_TODAY,
  ASSIGNMENT_NONE,
  rules({ providerStartDatePrefill: "today", assignmentStartDateDefault: "none" }),
];

describe("DEFAULT_ADD_PROVIDER_RULES", () => {
  it("is the decided rules: the field opens blank, assignments start today", () => {
    expect(DEFAULT).toEqual({
      providerStartDatePrefill: "none",
      assignmentStartDateDefault: "today",
    });
    expect(Object.isFrozen(DEFAULT)).toBe(true);
  });
});

describe("addProviderStartDatePrefill", () => {
  it("opens the field blank by default, and with today under the prefill", () => {
    expect(addProviderStartDatePrefill(DEFAULT, TODAY)).toBe("");
    expect(addProviderStartDatePrefill(ASSIGNMENT_NONE, TODAY)).toBe("");
    expect(addProviderStartDatePrefill(PREFILL_TODAY, TODAY)).toBe(TODAY);
  });
});

describe("addProviderStartDates", () => {
  it("saves exactly what the field shows, under every rule", () => {
    for (const r of ALL) {
      expect(addProviderStartDates(r, "2026-11-15", TODAY)).toEqual({
        providerStartDate: "2026-11-15",
        assignmentStartDate: "2026-11-15",
      });
      // A prefilled today that is still in the field is what gets saved.
      expect(addProviderStartDates(r, TODAY, TODAY)).toEqual({
        providerStartDate: TODAY,
        assignmentStartDate: TODAY,
      });
    }
  });

  it("never fills a blank provider start date in at save, whatever the prefill", () => {
    for (const r of ALL) {
      expect(addProviderStartDates(r, "", TODAY).providerStartDate).toBeNull();
      expect(addProviderStartDates(r, "   ", TODAY).providerStartDate).toBeNull();
    }
  });

  it("by default a blank field starts the assignments today", () => {
    expect(addProviderStartDates(DEFAULT, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: TODAY,
    });
    // A cleared prefill behaves like any blank field.
    expect(addProviderStartDates(PREFILL_TODAY, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: TODAY,
    });
  });

  it('under assignmentStartDateDefault "none" a blank field fills nothing', () => {
    expect(addProviderStartDates(ASSIGNMENT_NONE, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: null,
    });
  });
});

describe("blankAssignmentStartDate", () => {
  it('is today by default and none under "none", whatever the prefill', () => {
    expect(blankAssignmentStartDate(DEFAULT, TODAY)).toBe(TODAY);
    expect(blankAssignmentStartDate(PREFILL_TODAY, TODAY)).toBe(TODAY);
    expect(blankAssignmentStartDate(ASSIGNMENT_NONE, TODAY)).toBeNull();
  });
});

describe("addProviderStartDateHint", () => {
  const field = (startDate: string, facilityCount: number) => ({
    startDate,
    facilityCount,
    today: TODAY,
  });

  it("by default names today for the assignments only when a facility is selected", () => {
    expect(addProviderStartDateHint(DEFAULT, field("", 1))).toBe(
      "If left blank, facility assignments start today (Oct 30, 2026).",
    );
    expect(addProviderStartDateHint(DEFAULT, field("", 0))).toBeUndefined();
    expect(addProviderStartDateHint(DEFAULT, field("2026-11-15", 1))).toBeUndefined();
    // Typing today by hand is not a prefill.
    expect(addProviderStartDateHint(DEFAULT, field(TODAY, 1))).toBeUndefined();
  });

  it("under the prefill says so while today is still in the field", () => {
    expect(addProviderStartDateHint(PREFILL_TODAY, field(TODAY, 0))).toBe(
      "Prefilled with today; change or clear it.",
    );
    expect(addProviderStartDateHint(PREFILL_TODAY, field(TODAY, 2))).toBe(
      "Prefilled with today; change or clear it.",
    );
    expect(addProviderStartDateHint(PREFILL_TODAY, field("2026-11-15", 2))).toBeUndefined();
    // Cleared: the blank-field hint takes over.
    expect(addProviderStartDateHint(PREFILL_TODAY, field("", 1))).toBe(
      "If left blank, facility assignments start today (Oct 30, 2026).",
    );
  });

  it('under assignmentStartDateDefault "none" it says the assignments save without a date', () => {
    expect(addProviderStartDateHint(ASSIGNMENT_NONE, field("", 1))).toBe(
      "If left blank, facility assignments are saved without a start date.",
    );
    expect(addProviderStartDateHint(ASSIGNMENT_NONE, field("", 0))).toBeUndefined();
    expect(addProviderStartDateHint(ASSIGNMENT_NONE, field("2026-11-15", 1))).toBeUndefined();
  });
});

describe("resolveAddProviderRules", () => {
  it("is the defaults with nothing stored", () => {
    expect(resolveAddProviderRules()).toEqual(DEFAULT);
    expect(resolveAddProviderRules(null, null)).toEqual(DEFAULT);
  });

  it("takes the organization's value, else the platform's, else the default, field by field", () => {
    const platform: AddProviderRules = {
      providerStartDatePrefill: "today",
      assignmentStartDateDefault: "none",
    };
    expect(resolveAddProviderRules(platform)).toEqual(platform);
    expect(resolveAddProviderRules(platform, { providerStartDatePrefill: "none" })).toEqual({
      providerStartDatePrefill: "none",
      assignmentStartDateDefault: "none",
    });
    expect(
      resolveAddProviderRules(
        { providerStartDatePrefill: "today" },
        { assignmentStartDateDefault: "none" },
      ),
    ).toEqual({ providerStartDatePrefill: "today", assignmentStartDateDefault: "none" });
  });

  it("inherits on null or undefined", () => {
    expect(
      resolveAddProviderRules(PREFILL_TODAY, {
        providerStartDatePrefill: null,
        assignmentStartDateDefault: undefined,
      }),
    ).toEqual(PREFILL_TODAY);
  });

  it("skips a value of the wrong shape like a missing one", () => {
    for (const bad of ["tomorrow", "Today", "", true, 0]) {
      const override = {
        providerStartDatePrefill: bad,
        assignmentStartDateDefault: bad,
      } as unknown as AddProviderRules;
      expect(resolveAddProviderRules(override)).toEqual(DEFAULT);
      expect(resolveAddProviderRules(PREFILL_TODAY, override)).toEqual(PREFILL_TODAY);
    }
  });

  it("ignores a save-time provider start-date default: there is no such rule", () => {
    const stored = { providerStartDateDefault: "today" } as unknown as AddProviderRules;
    expect(resolveAddProviderRules(stored, stored)).toEqual(DEFAULT);
  });
});

describe("validateAddProviderRules", () => {
  it("passes the defaults, each alternative, an empty override and nothing", () => {
    for (const r of ALL) expect(validateAddProviderRules(r)).toEqual([]);
    expect(validateAddProviderRules({})).toEqual([]);
    expect(validateAddProviderRules({ providerStartDatePrefill: null })).toEqual([]);
    expect(validateAddProviderRules(null)).toEqual([]);
  });

  it("refuses a save-time provider start-date default, pointing to the prefill", () => {
    expect(validateAddProviderRules({ providerStartDateDefault: "today" })).toEqual([
      "A blank provider start date is never filled in at save: it fills payer forms. To open the field with today's date, set the Start date prefill instead.",
    ]);
  });

  it("rejects unknown values and rules, in plain language", () => {
    expect(
      validateAddProviderRules({
        providerStartDatePrefill: "tomorrow",
        assignmentStartDateDefault: "blank",
      }),
    ).toEqual([
      'The Start date field must open blank ("none") or filled with today ("today").',
      'A blank facility assignment start date must be today ("today") or stay blank ("none").',
    ]);
    expect(validateAddProviderRules({ startDateDefault: "today" })).toEqual([
      '"startDateDefault" is not an Add Provider rule.',
    ]);
    expect(validateAddProviderRules("none")).toEqual([
      "The Add Provider rules must be a set of named rules.",
    ]);
  });
});
