import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIFECYCLE_STAGES,
  allowedNextStages,
  groupBySwitcherGroup,
  isLifecycleWritable,
  lifecycleActionLabel,
  lifecycleStage,
  lifecycleValuesHiddenByDefault,
  normalizeLifecycle,
  parseLifecycleStages,
  type LifecycleStage,
} from "./lifecycle";

describe("normalizeLifecycle", () => {
  it("reads the legacy inactive as offboarded and passes every other key through", () => {
    expect(normalizeLifecycle("inactive")).toBe("offboarded");
    expect(normalizeLifecycle("offboarded")).toBe("offboarded");
    expect(normalizeLifecycle("prospect")).toBe("prospect");
    expect(normalizeLifecycle("onboarding")).toBe("onboarding");
    expect(normalizeLifecycle("active")).toBe("active");
    // A configured stage this code has never heard of stays itself.
    expect(normalizeLifecycle("paused")).toBe("paused");
  });

  it("reads a missing value as the column default", () => {
    expect(normalizeLifecycle(null)).toBe("active");
    expect(normalizeLifecycle(undefined)).toBe("active");
    expect(normalizeLifecycle("  ")).toBe("active");
  });
});

describe("DEFAULT_LIFECYCLE_STAGES", () => {
  it("mirrors the migration's seed, row for row", () => {
    const sql = readFileSync("supabase/migrations/20261102163100_mc_lifecycle_stages.sql", "utf8");
    for (const stage of DEFAULT_LIFECYCLE_STAGES) {
      const next = stage.allowedNext.map((key) => `'${key}'`).join(", ");
      const group = stage.switcherGroup ? `'${stage.switcherGroup}'` : "NULL";
      const row = new RegExp(
        `\\('${stage.key}',\\s+'${stage.displayName}',\\s+${stage.sortOrder},\\s+ARRAY\\[${next}\\],\\s+${group},\\s+${stage.writable},\\s+${stage.generationAllowed},\\s+${stage.shownByDefault}\\)`,
      );
      expect(sql, stage.key).toMatch(row);
    }
    expect(DEFAULT_LIFECYCLE_STAGES.map((s) => s.key)).toEqual([
      "prospect",
      "onboarding",
      "active",
      "offboarded",
    ]);
  });

  it("lets any stage move to offboarded, and offboarded reopen to active", () => {
    for (const stage of DEFAULT_LIFECYCLE_STAGES) {
      if (stage.key === "offboarded") expect(stage.allowedNext).toEqual(["active"]);
      else expect(stage.allowedNext).toContain("offboarded");
    }
  });
});

describe("lifecycleStage and behaviours", () => {
  it("freezes writes only for offboarded, and for the legacy inactive with it", () => {
    expect(isLifecycleWritable("prospect")).toBe(true);
    expect(isLifecycleWritable("onboarding")).toBe(true);
    expect(isLifecycleWritable("active")).toBe(true);
    expect(isLifecycleWritable("offboarded")).toBe(false);
    expect(isLifecycleWritable("inactive")).toBe(false);
  });

  it("allows generation for active only", () => {
    const allowed = DEFAULT_LIFECYCLE_STAGES.filter((s) => s.generationAllowed).map((s) => s.key);
    expect(allowed).toEqual(["active"]);
  });

  it("treats an unloaded configured stage as writable and visible", () => {
    const paused = lifecycleStage("paused");
    expect(paused).toMatchObject({ key: "paused", displayName: "Paused", writable: true });
    expect(paused.switcherGroup).not.toBeNull();
  });

  it("reads the configured stages over the defaults", () => {
    const stages: LifecycleStage[] = [
      ...DEFAULT_LIFECYCLE_STAGES,
      {
        key: "paused",
        displayName: "Paused",
        sortOrder: 35,
        allowedNext: ["active", "offboarded"],
        switcherGroup: null,
        writable: false,
        generationAllowed: false,
        shownByDefault: true,
      },
    ];
    expect(isLifecycleWritable("paused", stages)).toBe(false);
    expect(allowedNextStages("paused", stages).map((s) => s.key)).toEqual(["active", "offboarded"]);
  });
});

describe("allowedNextStages", () => {
  it("lists the configured next stages in sort order", () => {
    expect(allowedNextStages("prospect").map((s) => s.key)).toEqual(["onboarding", "offboarded"]);
    expect(allowedNextStages("onboarding").map((s) => s.key)).toEqual(["active", "offboarded"]);
    expect(allowedNextStages("active").map((s) => s.key)).toEqual(["offboarded"]);
    expect(allowedNextStages("offboarded").map((s) => s.key)).toEqual(["active"]);
    expect(allowedNextStages("inactive").map((s) => s.key)).toEqual(["active"]);
  });
});

describe("lifecycleActionLabel", () => {
  const stage = (key: string) => lifecycleStage(key);
  it("names offboarding, reopening and ordinary moves", () => {
    expect(lifecycleActionLabel(stage("active"), stage("offboarded"))).toBe("Offboard");
    expect(lifecycleActionLabel(stage("offboarded"), stage("active"))).toBe("Reopen");
    expect(lifecycleActionLabel(stage("prospect"), stage("onboarding"))).toBe("Move to Onboarding");
  });
});

describe("lifecycleValuesHiddenByDefault", () => {
  it("hides offboarded and its legacy alias", () => {
    expect(lifecycleValuesHiddenByDefault()).toEqual(["inactive", "offboarded"]);
  });
});

describe("groupBySwitcherGroup", () => {
  const orgs = [
    { name: "A", lifecycle: "active" },
    { name: "P", lifecycle: "prospect" },
    { name: "O", lifecycle: "onboarding" },
    { name: "X", lifecycle: "offboarded" },
    { name: "I", lifecycle: "inactive" },
  ];

  it("puts prospect and onboarding under Prospects, active under In motion, and hides offboarded", () => {
    const groups = groupBySwitcherGroup(orgs, (o) => o.lifecycle);
    expect(groups.map((g) => [g.label, g.items.map((o) => o.name)])).toEqual([
      ["In motion", ["A"]],
      ["Prospects", ["P", "O"]],
    ]);
  });

  it("labels a configured group by its first stage", () => {
    const stages: LifecycleStage[] = [
      ...DEFAULT_LIFECYCLE_STAGES,
      {
        key: "paused",
        displayName: "Paused",
        sortOrder: 35,
        allowedNext: [],
        switcherGroup: "on_hold",
        writable: true,
        generationAllowed: false,
        shownByDefault: true,
      },
    ];
    const groups = groupBySwitcherGroup(
      [...orgs, { name: "Z", lifecycle: "paused" }],
      (o) => o.lifecycle,
      stages,
    );
    expect(groups.map((g) => g.label)).toEqual(["In motion", "Prospects", "Paused"]);
  });
});

describe("parseLifecycleStages", () => {
  it("reads PostgREST rows into stage objects in sort order", () => {
    const parsed = parseLifecycleStages([
      {
        key: "active",
        display_name: "Active",
        sort_order: 30,
        allowed_next: ["offboarded"],
        switcher_group: "in_motion",
        writable: true,
        generation_allowed: true,
        shown_by_default: true,
      },
      {
        key: "offboarded",
        display_name: "Offboarded",
        sort_order: 40,
        allowed_next: ["active"],
        switcher_group: null,
        writable: false,
        generation_allowed: false,
        shown_by_default: false,
      },
      {
        key: "prospect",
        display_name: "Prospect",
        sort_order: 10,
        allowed_next: ["onboarding", 7],
        switcher_group: "prospects",
        writable: true,
        generation_allowed: false,
        shown_by_default: true,
      },
    ]);
    expect(parsed.map((s) => s.key)).toEqual(["prospect", "active", "offboarded"]);
    expect(parsed[0].allowedNext).toEqual(["onboarding"]);
    expect(parsed[2]).toMatchObject({
      writable: false,
      switcherGroup: null,
      shownByDefault: false,
    });
  });

  it("drops malformed rows and falls back to the defaults when nothing is usable", () => {
    expect(parseLifecycleStages([{ key: "", display_name: "X" }, null, "row"])).toEqual(
      DEFAULT_LIFECYCLE_STAGES,
    );
    expect(parseLifecycleStages(null)).toEqual(DEFAULT_LIFECYCLE_STAGES);
    expect(parseLifecycleStages([])).toEqual(DEFAULT_LIFECYCLE_STAGES);
  });
});
