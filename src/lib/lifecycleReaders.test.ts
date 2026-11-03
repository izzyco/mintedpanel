// The Portfolio and the active-org selection read lifecycle_state through the
// stage objects (Mission Control M3): onboarding sits with the prospects,
// offboarded (and the legacy inactive) is suppressed.
import { describe, expect, it } from "vitest";
import { selectActiveOrgId } from "./landing";
import { splitPortfolio, stateBreakdown } from "./portfolio";

const org = (id: string, lifecycleState: string, createdAt = "2026-01-01T00:00:00Z") => ({
  id,
  name: id,
  lifecycleState,
  createdAt,
});

describe("splitPortfolio over the stage objects", () => {
  it("buckets onboarding with prospects and offboarded with the legacy inactive", () => {
    const buckets = splitPortfolio([
      org("a", "active"),
      org("p", "prospect"),
      org("o", "onboarding"),
      org("x", "offboarded"),
      org("i", "inactive"),
    ]);
    expect(buckets.inMotion.map((o) => o.id)).toEqual(["a"]);
    expect(buckets.prospects.map((o) => o.id)).toEqual(["p", "o"]);
    expect(buckets.inactive.map((o) => o.id)).toEqual(["x", "i"]);
  });

  it("falls back to the all-inactive view when every org is offboarded", () => {
    const buckets = splitPortfolio([org("x", "offboarded"), org("i", "inactive")]);
    expect(buckets.isEmpty).toBe(true);
    expect(buckets.allInactive).toBe(true);
  });

  it("leaves offboarded orgs out of the state breakdown", () => {
    expect(
      stateBreakdown([
        { lifecycleState: "onboarding", state: "KS" },
        { lifecycleState: "offboarded", state: "KS" },
        { lifecycleState: "inactive", state: "TX" },
      ]),
    ).toEqual([{ state: "KS", count: 1 }]);
  });
});

describe("selectActiveOrgId over the stage objects", () => {
  it("never picks an offboarded org while a live one exists", () => {
    const orgs = [
      org("gone", "offboarded", "2026-05-01T00:00:00Z"),
      org("new", "onboarding", "2026-03-01T00:00:00Z"),
    ];
    expect(selectActiveOrgId(orgs, "gone")).toBe("new");
    expect(selectActiveOrgId(orgs, null)).toBe("new");
  });

  it("returns null when every org is offboarded", () => {
    expect(selectActiveOrgId([org("gone", "offboarded")], "gone")).toBeNull();
  });
});
