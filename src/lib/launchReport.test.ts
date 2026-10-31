// E6.6 F6.6.2 — Launches report derivation tests (TS-135 shapes): the
// date-only universe, the case_facilities open-case attribution, the
// staffing rule, the at-risk rule (upcoming + overdue), the group ordering,
// and the No go-live date section.
import { describe, expect, it } from "vitest";
import {
  buildLaunchReportRows,
  buildNoGoLiveDateRows,
  daysUntil,
  DEFAULT_LAUNCH_REPORT_RULES,
  groupLaunchRows,
  LAUNCH_REPORT_MAX_WINDOW_DAYS,
  launchAtRiskRuleText,
  launchEmptyStateText,
  launchRiskLabel,
  openCasesByFacility,
  providerCountsByFacility,
  resolveLaunchReportRules,
  validateLaunchReportRules,
  type LaunchFacilityInput,
  type LaunchReportRules,
} from "./launchReport";

const TODAY = "2026-07-19";

const facility = (over: Partial<LaunchFacilityInput> & { id: string }): LaunchFacilityInput => ({
  name: over.id,
  groupId: "g1",
  effectiveDate: "2026-08-01",
  isActive: true,
  referenceOnly: false,
  ...over,
});

describe("daysUntil", () => {
  it("is date-only and sign-correct", () => {
    expect(daysUntil("2026-07-20", TODAY)).toBe(1);
    expect(daysUntil("2026-07-19", TODAY)).toBe(0);
    expect(daysUntil("2026-07-01", TODAY)).toBe(-18);
    expect(daysUntil("not-a-date", TODAY)).toBeNull();
  });
});

describe("openCasesByFacility", () => {
  const providers = [
    { id: "pr1", status: "active" },
    { id: "pr2", status: "active" },
    { id: "test", status: "active", isTestProvider: true },
  ];

  it("attributes a case to its case_facilities locations only — never via the provider's assignments", () => {
    // pr1 is assigned to f1 AND f2, but the case holds only f1: it is pending
    // for f1's go-live, not f2's.
    const counts = openCasesByFacility(
      [{ id: "c1", providerId: "pr1", facilityId: "f1", status: "in_progress" }],
      [{ caseId: "c1", facilityId: "f1" }],
      providers,
    );
    expect(counts.get("f1")).toBe(1);
    expect(counts.has("f2")).toBe(false);
  });

  it("a multi-location case counts once at each location it holds", () => {
    const counts = openCasesByFacility(
      [{ id: "c1", providerId: "pr1", facilityId: "f1", status: "submitted" }],
      [
        { caseId: "c1", facilityId: "f1" },
        { caseId: "c1", facilityId: "f2" },
        { caseId: "c1", facilityId: "f2" },
      ],
      providers,
    );
    expect(counts.get("f1")).toBe(1);
    expect(counts.get("f2")).toBe(1);
  });

  it("the primary mirror never adds a location the case's links leave out", () => {
    const counts = openCasesByFacility(
      [{ id: "c1", providerId: "pr1", facilityId: "f9", status: "submitted" }],
      [{ caseId: "c1", facilityId: "f1" }],
      providers,
    );
    expect(Array.from(counts.keys())).toEqual(["f1"]);
  });

  it("a case with no case_facilities rows falls back to its facility_id mirror", () => {
    // Creation stamps facility_id without writing the child row.
    const counts = openCasesByFacility(
      [
        { id: "c1", providerId: "pr2", facilityId: "f3", status: "not_started" },
        { id: "c2", providerId: "pr2", facilityId: null, status: "not_started" },
      ],
      [],
      providers,
    );
    expect(counts.get("f3")).toBe(1);
    expect(counts.size).toBe(1);
  });

  it("closed cases and the test provider's cases never count", () => {
    const counts = openCasesByFacility(
      [
        { id: "c1", providerId: "pr1", facilityId: "f1", status: "approved" },
        { id: "c2", providerId: "pr2", facilityId: "f1", status: "denied" },
        { id: "c3", providerId: "test", facilityId: "f1", status: "in_progress" },
      ],
      [
        { caseId: "c1", facilityId: "f1" },
        { caseId: "c2", facilityId: "f1" },
        { caseId: "c3", facilityId: "f1" },
      ],
      providers,
    );
    expect(counts.size).toBe(0);
  });
});

describe("providerCountsByFacility", () => {
  it("counts distinct providers", () => {
    const counts = providerCountsByFacility(
      [
        { providerId: "pr1", facilityId: "f1" },
        { providerId: "pr1", facilityId: "f1" },
        { providerId: "pr2", facilityId: "f1" },
      ],
      [
        { id: "pr1", status: "active" },
        { id: "pr2", status: "onboarding" },
      ],
      TODAY,
    );
    expect(counts.get("f1")).toBe(2);
  });

  it("ignores terminated, test, and not-yet-started providers", () => {
    const counts = providerCountsByFacility(
      [
        { providerId: "gone", facilityId: "f1", startDate: "2025-01-01" },
        { providerId: "test", facilityId: "f1", startDate: "2025-01-01" },
        { providerId: "future", facilityId: "f1", startDate: "2026-07-20" },
        { providerId: "today", facilityId: "f2", startDate: TODAY },
        { providerId: "legacy", facilityId: "f2", startDate: null },
      ],
      [
        { id: "gone", status: "terminated" },
        { id: "test", status: "active", isTestProvider: true },
        { id: "future", status: "onboarding" },
        { id: "today", status: "active" },
        { id: "legacy", status: "active" },
      ],
      TODAY,
    );
    expect(counts.has("f1")).toBe(false);
    expect(counts.get("f2")).toBe(2);
  });

  it("a provider the list does not carry still counts", () => {
    const counts = providerCountsByFacility([{ providerId: "pr9", facilityId: "f1" }], [], TODAY);
    expect(counts.get("f1")).toBe(1);
  });
});

describe("buildLaunchReportRows", () => {
  it("includes future and recently-launched dates, excludes old/dateless/inactive/reference", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "future", effectiveDate: "2026-09-01" }),
        facility({ id: "recent", effectiveDate: "2026-07-01" }), // 18 days ago
        // 79 days ago and fully staffed: past the recent window, not at risk.
        facility({ id: "old", effectiveDate: "2026-05-01" }),
        facility({ id: "dateless", effectiveDate: null }),
        facility({ id: "inactive", isActive: false }),
        facility({ id: "reference", referenceOnly: true }),
      ],
      new Map([["old", 1]]),
      new Map(),
      TODAY,
    );
    expect(rows.map((r) => r.facilityId)).toEqual(["recent", "future"]);
  });

  it("MINT-100: past go-lives show for 30 days unflagged, or 90 days while still at risk", () => {
    const staffed = new Map([
      ["clean-30", 1],
      ["clean-31", 1],
    ]);
    const rows = buildLaunchReportRows(
      [
        facility({ id: "clean-30", effectiveDate: "2026-06-19" }),
        facility({ id: "clean-31", effectiveDate: "2026-06-18" }),
        facility({ id: "risk-31", effectiveDate: "2026-06-18" }),
        facility({ id: "risk-90", effectiveDate: "2026-04-20" }),
        facility({ id: "risk-91", effectiveDate: "2026-04-19" }),
      ],
      staffed,
      new Map(),
      TODAY,
    );
    const byId = new Map(rows.map((r) => [r.facilityId, r]));
    expect(byId.get("clean-30")).toMatchObject({ daysUntil: -30, atRisk: false });
    expect(byId.has("clean-31")).toBe(false);
    expect(byId.get("risk-31")).toMatchObject({ daysUntil: -31, riskKind: "overdue" });
    const risk90 = byId.get("risk-90");
    expect(risk90 && launchRiskLabel(risk90)).toBe("Overdue by 90 days — no providers assigned");
    expect(byId.has("risk-91")).toBe(false);
  });

  it("sorts date ascending with name tiebreak", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "b", name: "Bravo", effectiveDate: "2026-08-01" }),
        facility({ id: "a", name: "Alpha", effectiveDate: "2026-08-01" }),
        facility({ id: "c", name: "Charlie", effectiveDate: "2026-07-25" }),
      ],
      new Map(),
      new Map(),
      TODAY,
    );
    expect(rows.map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("flags at-risk inside the upcoming window or once passed: open cases or zero providers", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "soon-open-cases", effectiveDate: "2026-08-01" }),
        facility({ id: "soon-no-providers", effectiveDate: "2026-08-01" }),
        facility({ id: "soon-fine", effectiveDate: "2026-08-01" }),
        facility({ id: "far-no-providers", effectiveDate: "2026-12-01" }),
        facility({ id: "launched-open-cases", effectiveDate: "2026-07-10" }),
      ],
      new Map([
        ["soon-open-cases", 2],
        ["soon-fine", 1],
        ["launched-open-cases", 1],
      ]),
      new Map([
        ["soon-open-cases", 3],
        ["launched-open-cases", 1],
      ]),
      TODAY,
    );
    const byId = new Map(rows.map((r) => [r.facilityId, r]));
    expect(byId.get("soon-open-cases")).toMatchObject({
      atRisk: true,
      atRiskReasons: ["open cases still pending"],
    });
    expect(byId.get("soon-no-providers")).toMatchObject({
      atRisk: true,
      atRiskReasons: ["no providers assigned"],
    });
    expect(byId.get("soon-fine")?.atRisk).toBe(false);
    // Outside the 30-day window: not "approaching", never at risk.
    expect(byId.get("far-no-providers")?.atRisk).toBe(false);
    // Already launched with a case still open: overdue, not history.
    expect(byId.get("launched-open-cases")).toMatchObject({ atRisk: true, riskKind: "overdue" });
  });

  it("MINT-100: a go-live 19 days past with open cases is Overdue, with the same reasons", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "overdue", effectiveDate: "2026-06-30" }),
        facility({ id: "overdue-1", effectiveDate: "2026-07-18" }),
      ],
      new Map([["overdue", 2]]),
      new Map([["overdue", 1]]),
      TODAY,
    );
    const byId = new Map(rows.map((r) => [r.facilityId, r]));
    const overdue = byId.get("overdue");
    expect(overdue).toMatchObject({
      daysUntil: -19,
      atRisk: true,
      riskKind: "overdue",
      atRiskReasons: ["open cases still pending"],
    });
    expect(overdue && launchRiskLabel(overdue)).toBe(
      "Overdue by 19 days — open cases still pending",
    );
    const oneDay = byId.get("overdue-1");
    expect(oneDay && launchRiskLabel(oneDay)).toBe("Overdue by 1 day — no providers assigned");
  });

  it("MINT-100: a past go-live with nothing outstanding stays unflagged", () => {
    const rows = buildLaunchReportRows(
      [facility({ id: "opened-clean", effectiveDate: "2026-06-30" })],
      new Map([["opened-clean", 3]]),
      new Map(),
      TODAY,
    );
    expect(rows[0]).toMatchObject({ atRisk: false, riskKind: null, atRiskReasons: [] });
    expect(launchRiskLabel(rows[0])).toBeNull();
  });

  it("MINT-100: the 0- and 30-day upcoming boundaries are unchanged", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "day-0", effectiveDate: TODAY }),
        facility({ id: "day-30", effectiveDate: "2026-08-18" }),
        facility({ id: "day-31", effectiveDate: "2026-08-19" }),
      ],
      new Map(),
      new Map(),
      TODAY,
    );
    const byId = new Map(rows.map((r) => [r.facilityId, r]));
    expect(byId.get("day-0")).toMatchObject({ daysUntil: 0, riskKind: "upcoming" });
    expect(byId.get("day-30")).toMatchObject({ daysUntil: 30, riskKind: "upcoming" });
    expect(byId.get("day-31")).toMatchObject({ daysUntil: 31, atRisk: false, riskKind: null });
    const day0 = byId.get("day-0");
    expect(day0 && launchRiskLabel(day0)).toBe("At risk — no providers assigned");
  });

  it("a same-day launch (daysUntil 0) is inside the approaching window", () => {
    const rows = buildLaunchReportRows(
      [facility({ id: "today", effectiveDate: TODAY })],
      new Map(),
      new Map(),
      TODAY,
    );
    expect(rows[0]).toMatchObject({ daysUntil: 0, atRisk: true });
  });

  it("both reasons combine", () => {
    const rows = buildLaunchReportRows(
      [facility({ id: "f1", effectiveDate: "2026-07-25" })],
      new Map(),
      new Map([["f1", 1]]),
      TODAY,
    );
    expect(rows[0].atRiskReasons).toEqual(["open cases still pending", "no providers assigned"]);
  });
});

describe("groupLaunchRows", () => {
  it("groups A→Z by group name, ungrouped last, row order preserved", () => {
    const rows = buildLaunchReportRows(
      [
        facility({ id: "z1", groupId: "gz", effectiveDate: "2026-07-25" }),
        facility({ id: "a1", groupId: "ga", effectiveDate: "2026-08-05" }),
        facility({ id: "none", groupId: null, effectiveDate: "2026-08-01" }),
        facility({ id: "a2", groupId: "ga", effectiveDate: "2026-07-30" }),
      ],
      new Map(),
      new Map(),
      TODAY,
    );
    const groups = groupLaunchRows(
      rows,
      new Map([
        ["ga", "Alpha Group"],
        ["gz", "Zulu Group"],
      ]),
    );
    expect(groups.map((g) => g.groupName)).toEqual(["Alpha Group", "Zulu Group", "No group"]);
    expect(groups[0].rows.map((r) => r.facilityId)).toEqual(["a2", "a1"]);
  });

  it("a groupId missing from the name map folds into No group (deleted group tolerance)", () => {
    const rows = buildLaunchReportRows(
      [facility({ id: "f1", groupId: "gone" })],
      new Map(),
      new Map(),
      TODAY,
    );
    const groups = groupLaunchRows(rows, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ groupId: null, groupName: "No group" });
  });
});

describe("buildNoGoLiveDateRows", () => {
  it("MINT-100: dateless locations land in the No go-live date group, unflagged, group A→Z then name", () => {
    const facilities = [
      facility({ id: "z-b", name: "Bravo", groupId: "gz", effectiveDate: null }),
      facility({ id: "none", name: "Alpha", groupId: null, effectiveDate: null }),
      facility({ id: "a-c", name: "Charlie", groupId: "ga", effectiveDate: null }),
      facility({ id: "a-a", name: "Alpha", groupId: "ga", effectiveDate: null }),
      facility({ id: "gone", name: "Delta", groupId: "deleted", effectiveDate: null }),
      facility({ id: "dated", effectiveDate: "2026-08-01" }),
      facility({ id: "inactive", isActive: false, effectiveDate: null }),
      facility({ id: "reference", referenceOnly: true, effectiveDate: null }),
    ];
    const noDate = buildNoGoLiveDateRows(
      facilities,
      new Map([["a-a", 2]]),
      new Map([["a-a", 1]]),
      new Map([
        ["ga", "Alpha Group"],
        ["gz", "Zulu Group"],
      ]),
    );
    expect(noDate.map((r) => r.facilityId)).toEqual(["a-a", "a-c", "z-b", "none", "gone"]);
    expect(noDate[0]).toEqual({
      facilityId: "a-a",
      name: "Alpha",
      groupId: "ga",
      groupName: "Alpha Group",
      city: null,
      state: null,
      providerCount: 2,
      openCaseCount: 1,
    });
    expect(noDate.at(-1)?.groupName).toBe("No group");
    // The dated report still leaves them out: one list, never both.
    const dated = buildLaunchReportRows(facilities, new Map(), new Map(), TODAY);
    expect(dated.map((r) => r.facilityId)).toEqual(["dated"]);
  });
});

describe("LaunchReportRules (MINT-116)", () => {
  const DEFAULT = DEFAULT_LAUNCH_REPORT_RULES;
  const rulesWith = (over: Partial<LaunchReportRules>): LaunchReportRules => ({
    ...DEFAULT,
    ...over,
  });
  // Go-lives N days past (negative) or ahead of TODAY.
  const at = (id: string, days: number) => {
    const d = new Date(Date.UTC(2026, 6, 19 + days));
    return facility({ id, effectiveDate: d.toISOString().slice(0, 10) });
  };
  const ids = (rules?: LaunchReportRules, staffed: string[] = []) =>
    buildLaunchReportRows(
      [
        at("risk-past-45", -45),
        at("risk-past-46", -46),
        at("risk-past-90", -90),
        at("risk-past-91", -91),
        at("clean-past-7", -7),
        at("clean-past-8", -8),
        at("clean-past-30", -30),
        at("clean-past-31", -31),
        at("ahead-14", 14),
        at("ahead-15", 15),
        at("ahead-30", 30),
        at("ahead-31", 31),
      ],
      new Map(staffed.map((id) => [id, 1])),
      new Map(),
      TODAY,
      rules,
    );
  const CLEAN = ["clean-past-7", "clean-past-8", "clean-past-30", "clean-past-31"];
  const STAFFED_AHEAD = ["ahead-14", "ahead-15", "ahead-30", "ahead-31"];

  it("defaults to the decided windows: 90 overdue, 30 recent, 30 upcoming", () => {
    expect(DEFAULT).toEqual({
      overdueWindowDays: 90,
      recentWindowDays: 30,
      upcomingWindowDays: 30,
    });
    expect(Object.isFrozen(DEFAULT)).toBe(true);
    // Passing the defaults is the same as passing nothing.
    expect(ids(DEFAULT, CLEAN)).toEqual(ids(undefined, CLEAN));
    expect(ids(DEFAULT, CLEAN).map((r) => r.facilityId)).toEqual([
      "risk-past-90",
      "risk-past-46",
      "risk-past-45",
      "clean-past-30",
      "clean-past-8",
      "clean-past-7",
      "ahead-14",
      "ahead-15",
      "ahead-30",
      "ahead-31",
    ]);
  });

  it("a shorter overdue window drops an at-risk location sooner", () => {
    const rows = ids(rulesWith({ overdueWindowDays: 45 }), CLEAN);
    const shown = rows.map((r) => r.facilityId);
    expect(shown).toContain("risk-past-45");
    expect(shown).not.toContain("risk-past-46");
    expect(shown).not.toContain("risk-past-90");
    expect(rows.find((r) => r.facilityId === "risk-past-45")?.riskKind).toBe("overdue");
  });

  it("a longer overdue window keeps an at-risk location longer", () => {
    const shown = ids(rulesWith({ overdueWindowDays: 120 }), CLEAN).map((r) => r.facilityId);
    expect(shown).toContain("risk-past-91");
  });

  it("the recent window bounds how long an opened location with nothing outstanding shows", () => {
    const short = ids(rulesWith({ recentWindowDays: 7 }), CLEAN).map((r) => r.facilityId);
    expect(short).toContain("clean-past-7");
    expect(short).not.toContain("clean-past-8");
    expect(short).not.toContain("clean-past-30");
    const long = ids(rulesWith({ recentWindowDays: 31 }), CLEAN).map((r) => r.facilityId);
    expect(long).toContain("clean-past-31");
    // The at-risk ones still follow the overdue window, not the recent one.
    expect(short).toContain("risk-past-90");
  });

  it("the upcoming window bounds when an approaching go-live is checked", () => {
    const byDefault = new Map(ids(DEFAULT).map((r) => [r.facilityId, r]));
    expect(byDefault.get("ahead-15")?.riskKind).toBe("upcoming");
    expect(byDefault.get("ahead-30")?.riskKind).toBe("upcoming");
    expect(byDefault.get("ahead-31")?.atRisk).toBe(false);
    const narrow = new Map(
      ids(rulesWith({ upcomingWindowDays: 14 }), [...CLEAN]).map((r) => [r.facilityId, r]),
    );
    expect(narrow.get("ahead-14")?.riskKind).toBe("upcoming");
    expect(narrow.get("ahead-15")).toMatchObject({ atRisk: false, riskKind: null });
    expect(narrow.get("ahead-30")?.atRisk).toBe(false);
    // Every future go-live still lists; the window only decides the flag.
    expect(ids(rulesWith({ upcomingWindowDays: 14 }), STAFFED_AHEAD)).toHaveLength(
      ids(DEFAULT, STAFFED_AHEAD).length,
    );
  });

  it("states the rule it applies, today's text with the defaults", () => {
    expect(launchAtRiskRuleText(DEFAULT)).toBe(
      "At risk = go-live within 30 days with open cases still pending or no providers assigned. Overdue = go-live passed within the last 90 days and either is still true. Opened locations with neither show for 30 days.",
    );
    expect(launchAtRiskRuleText()).toBe(launchAtRiskRuleText(DEFAULT));
    expect(
      launchAtRiskRuleText({ overdueWindowDays: 60, recentWindowDays: 1, upcomingWindowDays: 14 }),
    ).toBe(
      "At risk = go-live within 14 days with open cases still pending or no providers assigned. Overdue = go-live passed within the last 60 days and either is still true. Opened locations with neither show for 1 day.",
    );
  });

  it("names the same windows in the empty state", () => {
    expect(launchEmptyStateText(DEFAULT)).toBe(
      "No locations opening soon, opened in the last 30 days, overdue within the last 90 days, or waiting for a go-live date.",
    );
    expect(launchEmptyStateText(rulesWith({ overdueWindowDays: 180, recentWindowDays: 14 }))).toBe(
      "No locations opening soon, opened in the last 14 days, overdue within the last 180 days, or waiting for a go-live date.",
    );
  });

  describe("resolveLaunchReportRules", () => {
    it("is the defaults with nothing stored", () => {
      expect(resolveLaunchReportRules()).toEqual(DEFAULT);
      expect(resolveLaunchReportRules(null, null)).toEqual(DEFAULT);
    });

    it("takes the organization's value, else the platform's, else the default, field by field", () => {
      const platform = { overdueWindowDays: 120, recentWindowDays: 14 };
      expect(resolveLaunchReportRules(platform)).toEqual({ ...DEFAULT, ...platform });
      expect(resolveLaunchReportRules(platform, { overdueWindowDays: 60 })).toEqual({
        overdueWindowDays: 60,
        recentWindowDays: 14,
        upcomingWindowDays: 30,
      });
      expect(resolveLaunchReportRules(null, { upcomingWindowDays: 45 })).toEqual({
        ...DEFAULT,
        upcomingWindowDays: 45,
      });
    });

    it("inherits on null or undefined", () => {
      expect(
        resolveLaunchReportRules(
          { overdueWindowDays: 120 },
          { overdueWindowDays: null, recentWindowDays: undefined },
        ),
      ).toEqual({ ...DEFAULT, overdueWindowDays: 120 });
    });

    it("skips a value of the wrong shape like a missing one", () => {
      for (const bad of [
        0,
        -5,
        1.5,
        Number.NaN,
        Infinity,
        LAUNCH_REPORT_MAX_WINDOW_DAYS + 1,
        "60",
      ]) {
        expect(
          resolveLaunchReportRules(
            { overdueWindowDays: 120 },
            { overdueWindowDays: bad as unknown as number },
          ).overdueWindowDays,
        ).toBe(120);
        expect(
          resolveLaunchReportRules({ recentWindowDays: bad as unknown as number }).recentWindowDays,
        ).toBe(30);
      }
      expect(
        resolveLaunchReportRules(null, { overdueWindowDays: LAUNCH_REPORT_MAX_WINDOW_DAYS })
          .overdueWindowDays,
      ).toBe(LAUNCH_REPORT_MAX_WINDOW_DAYS);
    });
  });

  describe("validateLaunchReportRules", () => {
    it("passes the defaults, an empty override and whole-day windows", () => {
      expect(validateLaunchReportRules(DEFAULT)).toEqual([]);
      expect(validateLaunchReportRules({})).toEqual([]);
      expect(validateLaunchReportRules(null)).toEqual([]);
      expect(
        validateLaunchReportRules({
          overdueWindowDays: 365,
          recentWindowDays: 1,
          upcomingWindowDays: null,
        }),
      ).toEqual([]);
    });

    it("rejects windows that are not whole days from 1 to the maximum, in plain language", () => {
      expect(validateLaunchReportRules({ overdueWindowDays: 0 })).toEqual([
        "The overdue window must be a whole number of days from 1 to 365.",
      ]);
      expect(validateLaunchReportRules({ recentWindowDays: 7.5, upcomingWindowDays: 400 })).toEqual(
        [
          "The recently launched window must be a whole number of days from 1 to 365.",
          "The approaching window must be a whole number of days from 1 to 365.",
        ],
      );
      expect(validateLaunchReportRules({ upcomingWindowDays: "30" })).toEqual([
        "The approaching window must be a whole number of days from 1 to 365.",
      ]);
    });

    it("rejects unknown rules and a value that is not a set of rules", () => {
      expect(validateLaunchReportRules({ overdueDays: 90 })).toEqual([
        '"overdueDays" is not a Launches report rule.',
      ]);
      expect(validateLaunchReportRules(90)).toEqual([
        "The Launches report rules must be a set of named windows.",
      ]);
      expect(validateLaunchReportRules([90])).toEqual([
        "The Launches report rules must be a set of named windows.",
      ]);
    });

    it("rejects an overdue window shorter than the recent window, against what it sits on", () => {
      const tooShort = [
        "The overdue window must be at least as long as the recently launched window, or a location still at risk would leave the report before one with nothing outstanding.",
      ];
      expect(validateLaunchReportRules({ overdueWindowDays: 20 })).toEqual(tooShort);
      expect(validateLaunchReportRules({ recentWindowDays: 91 })).toEqual(tooShort);
      expect(validateLaunchReportRules({ overdueWindowDays: 30 })).toEqual([]);
      // An organization override over a platform that already shortened the
      // recent window.
      expect(
        validateLaunchReportRules(
          { overdueWindowDays: 20 },
          resolveLaunchReportRules({ recentWindowDays: 14 }),
        ),
      ).toEqual([]);
    });
  });
});
