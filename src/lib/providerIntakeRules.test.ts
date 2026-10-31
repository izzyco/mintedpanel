// MINT-116 — the Add Provider start-date rules: each rule with its default and
// its alternative, the resolver's precedence, the validator, and the hint and
// error the wizard shows from them. The defaults keep MINT-96's behaviour.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_INTAKE_RULES,
  intakeStartDateError,
  intakeStartDateHint,
  intakeStartDates,
  resolveProviderIntakeRules,
  validateProviderIntakeRules,
  type ProviderIntakeRules,
} from "./providerIntakeRules";

const TODAY = "2026-10-30";
const DEFAULT = DEFAULT_PROVIDER_INTAKE_RULES;
const rules = (over: Partial<ProviderIntakeRules>): ProviderIntakeRules => ({
  ...DEFAULT,
  ...over,
});
const PROVIDER_TODAY = rules({ providerStartDateDefault: "today" });
const ASSIGNMENT_NONE = rules({ assignmentStartDateDefault: "none" });

describe("DEFAULT_PROVIDER_INTAKE_RULES", () => {
  it("is the decided rule: provider start date never defaulted, assignments start today", () => {
    expect(DEFAULT).toEqual({
      providerStartDateDefault: "none",
      assignmentStartDateDefault: "today",
    });
    expect(Object.isFrozen(DEFAULT)).toBe(true);
  });
});

describe("intakeStartDates", () => {
  it("an entered date is both dates, whatever the rules", () => {
    for (const r of [DEFAULT, PROVIDER_TODAY, ASSIGNMENT_NONE]) {
      expect(intakeStartDates(r, "2026-11-15", TODAY)).toEqual({
        providerStartDate: "2026-11-15",
        assignmentStartDate: "2026-11-15",
      });
    }
  });

  it("by default a blank stays null on the provider and the assignments start today", () => {
    expect(intakeStartDates(DEFAULT, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: TODAY,
    });
    expect(intakeStartDates(DEFAULT, "   ", TODAY).providerStartDate).toBeNull();
  });

  it('providerStartDateDefault "today" saves today on the provider, and the assignments take it', () => {
    expect(intakeStartDates(PROVIDER_TODAY, "", TODAY)).toEqual({
      providerStartDate: TODAY,
      assignmentStartDate: TODAY,
    });
    expect(
      intakeStartDates({ ...PROVIDER_TODAY, assignmentStartDateDefault: "none" }, "", TODAY),
    ).toEqual({ providerStartDate: TODAY, assignmentStartDate: TODAY });
  });

  it('assignmentStartDateDefault "none" fills nothing in', () => {
    expect(intakeStartDates(ASSIGNMENT_NONE, "", TODAY)).toEqual({
      providerStartDate: null,
      assignmentStartDate: null,
    });
  });
});

describe("intakeStartDateHint", () => {
  const field = (startDate: string, facilityCount: number) => ({
    startDate,
    facilityCount,
    today: TODAY,
  });

  it("by default names today for the assignments only when a facility is selected", () => {
    expect(intakeStartDateHint(DEFAULT, field("", 1))).toBe(
      "If left blank, facility assignments start today (Oct 30, 2026).",
    );
    expect(intakeStartDateHint(DEFAULT, field("", 0))).toBeUndefined();
    expect(intakeStartDateHint(DEFAULT, field("2026-11-15", 1))).toBeUndefined();
  });

  it('under providerStartDateDefault "today" it says the start date itself is today', () => {
    expect(intakeStartDateHint(PROVIDER_TODAY, field("", 0))).toBe(
      "If left blank, the start date is today (Oct 30, 2026).",
    );
    expect(intakeStartDateHint(PROVIDER_TODAY, field("", 2))).toBe(
      "If left blank, the start date and facility assignments are today (Oct 30, 2026).",
    );
    expect(intakeStartDateHint(PROVIDER_TODAY, field("2026-11-15", 2))).toBeUndefined();
  });

  it('under assignmentStartDateDefault "none" it says the assignments need a date', () => {
    expect(intakeStartDateHint(ASSIGNMENT_NONE, field("", 1))).toBe(
      "Facility assignments need a start date.",
    );
    expect(intakeStartDateHint(ASSIGNMENT_NONE, field("", 0))).toBeUndefined();
  });
});

describe("intakeStartDateError", () => {
  it("never blocks under the default or when the provider date defaults to today", () => {
    for (const r of [
      DEFAULT,
      PROVIDER_TODAY,
      rules({ providerStartDateDefault: "today", assignmentStartDateDefault: "none" }),
    ]) {
      expect(intakeStartDateError(r, { startDate: "", facilityCount: 3 })).toBeUndefined();
    }
  });

  it('requires a date under "none" for both, only while a facility is selected', () => {
    expect(intakeStartDateError(ASSIGNMENT_NONE, { startDate: "", facilityCount: 1 })).toBe(
      "Required while a facility is selected: facility assignments need a start date.",
    );
    expect(
      intakeStartDateError(ASSIGNMENT_NONE, { startDate: "", facilityCount: 0 }),
    ).toBeUndefined();
    expect(
      intakeStartDateError(ASSIGNMENT_NONE, { startDate: "2026-11-15", facilityCount: 1 }),
    ).toBeUndefined();
  });
});

describe("resolveProviderIntakeRules", () => {
  it("is the defaults with nothing stored", () => {
    expect(resolveProviderIntakeRules()).toEqual(DEFAULT);
    expect(resolveProviderIntakeRules(null, null)).toEqual(DEFAULT);
  });

  it("takes the organization's value, else the platform's, else the default, field by field", () => {
    const platform: ProviderIntakeRules = {
      providerStartDateDefault: "today",
      assignmentStartDateDefault: "none",
    };
    expect(resolveProviderIntakeRules(platform)).toEqual(platform);
    expect(resolveProviderIntakeRules(platform, { providerStartDateDefault: "none" })).toEqual({
      providerStartDateDefault: "none",
      assignmentStartDateDefault: "none",
    });
    expect(
      resolveProviderIntakeRules(
        { providerStartDateDefault: "today" },
        { assignmentStartDateDefault: "none" },
      ),
    ).toEqual({ providerStartDateDefault: "today", assignmentStartDateDefault: "none" });
  });

  it("inherits on null or undefined", () => {
    expect(
      resolveProviderIntakeRules(
        { assignmentStartDateDefault: "none" },
        { assignmentStartDateDefault: null, providerStartDateDefault: undefined },
      ),
    ).toEqual({ ...DEFAULT, assignmentStartDateDefault: "none" });
  });

  it("skips a value of the wrong shape like a missing one", () => {
    for (const bad of ["tomorrow", "Today", "", true, 0]) {
      const override = {
        providerStartDateDefault: bad,
        assignmentStartDateDefault: bad,
      } as unknown as ProviderIntakeRules;
      expect(resolveProviderIntakeRules(override)).toEqual(DEFAULT);
      expect(resolveProviderIntakeRules(PROVIDER_TODAY, override)).toEqual(PROVIDER_TODAY);
    }
  });
});

describe("validateProviderIntakeRules", () => {
  it("passes the defaults, each alternative, an empty override and nothing", () => {
    expect(validateProviderIntakeRules(DEFAULT)).toEqual([]);
    expect(
      validateProviderIntakeRules({
        providerStartDateDefault: "today",
        assignmentStartDateDefault: "none",
      }),
    ).toEqual([]);
    expect(validateProviderIntakeRules({})).toEqual([]);
    expect(validateProviderIntakeRules({ providerStartDateDefault: null })).toEqual([]);
    expect(validateProviderIntakeRules(null)).toEqual([]);
  });

  it("rejects unknown values and rules, in plain language", () => {
    expect(
      validateProviderIntakeRules({
        providerStartDateDefault: "tomorrow",
        assignmentStartDateDefault: "blank",
      }),
    ).toEqual([
      'A blank provider start date must stay blank ("none") or be today ("today").',
      'A blank facility assignment start date must be today ("today") or be left for the coordinator to enter ("none").',
    ]);
    expect(validateProviderIntakeRules({ startDateDefault: "today" })).toEqual([
      '"startDateDefault" is not an Add Provider rule.',
    ]);
    expect(validateProviderIntakeRules("none")).toEqual([
      "The Add Provider rules must be a set of named rules.",
    ]);
  });
});
