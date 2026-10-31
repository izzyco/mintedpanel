// MINT-116 — the Add Provider start-date rule: the assignment rule with its
// default and its alternative, the resolver's precedence, the validator, and
// the hint and error the wizard shows from it. The provider's own start date
// is never guessed under any rule. The default keeps MINT-96's behaviour.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADD_PROVIDER_RULES,
  addProviderStartDateError,
  addProviderStartDateHint,
  addProviderStartDates,
  resolveAddProviderRules,
  validateAddProviderRules,
  type AddProviderRules,
} from "./addProviderRules";

const TODAY = "2026-10-30";
const DEFAULT = DEFAULT_ADD_PROVIDER_RULES;
const NONE: AddProviderRules = { assignmentStartDateDefault: "none" };

describe("DEFAULT_ADD_PROVIDER_RULES", () => {
  it("is the decided rule: facility assignments start today", () => {
    expect(DEFAULT).toEqual({ assignmentStartDateDefault: "today" });
    expect(Object.isFrozen(DEFAULT)).toBe(true);
  });

  it("has no provider start-date option: that date is never guessed", () => {
    expect(Object.keys(DEFAULT)).toEqual(["assignmentStartDateDefault"]);
  });
});

describe("addProviderStartDates", () => {
  it("an entered date is both dates, under either rule", () => {
    for (const rules of [DEFAULT, NONE]) {
      expect(addProviderStartDates(rules, "2026-11-15", TODAY)).toEqual({
        providerStartDate: "2026-11-15",
        assignmentStartDate: "2026-11-15",
      });
    }
  });

  it("by default a blank stays null on the provider and the assignments start today", () => {
    expect(addProviderStartDates(DEFAULT, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: TODAY,
    });
    expect(addProviderStartDates(DEFAULT, "   ", TODAY).providerStartDate).toBeNull();
  });

  it('under "none" a blank fills nothing, and the provider date stays null either way', () => {
    expect(addProviderStartDates(NONE, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: null,
    });
  });
});

describe("addProviderStartDateHint", () => {
  const field = (startDate: string, facilityCount: number, error?: string) => ({
    startDate,
    facilityCount,
    today: TODAY,
    error,
  });

  it("by default names today for the assignments only when a facility is selected", () => {
    expect(addProviderStartDateHint(DEFAULT, field("", 1))).toBe(
      "If left blank, facility assignments start today (Oct 30, 2026).",
    );
    expect(addProviderStartDateHint(DEFAULT, field("", 0))).toBeUndefined();
    expect(addProviderStartDateHint(DEFAULT, field("2026-11-15", 1))).toBeUndefined();
  });

  it('under "none" it says the assignments need a date, until the error replaces it', () => {
    expect(addProviderStartDateHint(NONE, field("", 1))).toBe(
      "Facility assignments need a start date.",
    );
    expect(addProviderStartDateHint(NONE, field("", 0))).toBeUndefined();
    const error = addProviderStartDateError(NONE, { startDate: "", facilityCount: 1 });
    expect(error).toBeDefined();
    expect(addProviderStartDateHint(NONE, field("", 1, error))).toBeUndefined();
  });
});

describe("addProviderStartDateError", () => {
  it("never blocks under the default", () => {
    expect(addProviderStartDateError(DEFAULT, { startDate: "", facilityCount: 3 })).toBeUndefined();
  });

  it('requires a date under "none", only while a facility is selected', () => {
    expect(addProviderStartDateError(NONE, { startDate: "", facilityCount: 1 })).toBe(
      "Required while a facility is selected: facility assignments need a start date.",
    );
    expect(addProviderStartDateError(NONE, { startDate: "", facilityCount: 0 })).toBeUndefined();
    expect(
      addProviderStartDateError(NONE, { startDate: "2026-11-15", facilityCount: 1 }),
    ).toBeUndefined();
  });
});

describe("resolveAddProviderRules", () => {
  it("is the default with nothing stored", () => {
    expect(resolveAddProviderRules()).toEqual(DEFAULT);
    expect(resolveAddProviderRules(null, null)).toEqual(DEFAULT);
  });

  it("takes the organization's value, else the platform's, else the default", () => {
    expect(resolveAddProviderRules(NONE)).toEqual(NONE);
    expect(resolveAddProviderRules(NONE, { assignmentStartDateDefault: "today" })).toEqual(DEFAULT);
    expect(resolveAddProviderRules(null, NONE)).toEqual(NONE);
  });

  it("inherits on null or undefined", () => {
    expect(resolveAddProviderRules(NONE, { assignmentStartDateDefault: null })).toEqual(NONE);
    expect(resolveAddProviderRules(NONE, { assignmentStartDateDefault: undefined })).toEqual(NONE);
  });

  it("skips a value of the wrong shape like a missing one", () => {
    for (const bad of ["tomorrow", "Today", "", true, 0]) {
      const override = { assignmentStartDateDefault: bad } as unknown as AddProviderRules;
      expect(resolveAddProviderRules(override)).toEqual(DEFAULT);
      expect(resolveAddProviderRules(NONE, override)).toEqual(NONE);
    }
  });

  it("ignores a provider start-date default: there is nothing to set", () => {
    const stored = { providerStartDateDefault: "today" } as unknown as AddProviderRules;
    expect(resolveAddProviderRules(stored, stored)).toEqual(DEFAULT);
  });
});

describe("validateAddProviderRules", () => {
  it("passes the default, the alternative, an empty override and nothing", () => {
    expect(validateAddProviderRules(DEFAULT)).toEqual([]);
    expect(validateAddProviderRules(NONE)).toEqual([]);
    expect(validateAddProviderRules({})).toEqual([]);
    expect(validateAddProviderRules({ assignmentStartDateDefault: null })).toEqual([]);
    expect(validateAddProviderRules(null)).toEqual([]);
  });

  it("refuses a provider start-date default, saying why", () => {
    for (const value of ["today", "none"]) {
      expect(validateAddProviderRules({ providerStartDateDefault: value })).toEqual([
        "A blank provider start date can't be given a default: it fills payer forms, so it is never guessed.",
      ]);
    }
  });

  it("rejects unknown values and rules, in plain language", () => {
    expect(validateAddProviderRules({ assignmentStartDateDefault: "blank" })).toEqual([
      'A blank facility assignment start date must be today ("today") or be left for the coordinator to enter ("none").',
    ]);
    expect(validateAddProviderRules({ startDateDefault: "today" })).toEqual([
      '"startDateDefault" is not an Add Provider rule.',
    ]);
    expect(validateAddProviderRules("none")).toEqual([
      "The Add Provider rules must be a set of named rules.",
    ]);
  });
});
