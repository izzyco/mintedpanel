import { describe, expect, it } from "vitest";
import { manualCasePayerOptions } from "./manualCasePayerOptions";
import { manualCasePayers } from "./payerSetup";
import type { Payer, PayerNetworkTarget } from "@/types";

const payer = (id: string, name: string): Payer => ({ id, name, status: "active" }) as Payer;

const catalog = manualCasePayers([
  payer("p-uhc", "UHC"),
  payer("p-aetna", "Aetna"),
  payer("p-cigna", "Cigna"),
  payer("p-bcbs", "BCBS"),
]);

const target = (
  groupId: string,
  payerId: string,
  state: string,
  status: "active" | "archived" = "active",
): PayerNetworkTarget => ({
  id: `${groupId}-${payerId}-${state}-${status}`,
  orgId: "org-1",
  groupId,
  payerId,
  state,
  status,
  createdAt: "2026-01-01T00:00:00Z",
});

const targets = [
  target("g-1", "p-uhc", "NC"),
  target("g-1", "p-aetna", "NC"),
  target("g-1", "p-aetna", "SC"),
  target("g-1", "p-cigna", "NC", "archived"),
  target("g-2", "p-bcbs", "KS"),
  target("g-empty", "p-bcbs", "CO", "archived"),
];

const base = {
  payers: catalog,
  targets,
  groupId: "g-1" as string | null,
  payerId: null as string | null,
  caseType: "enrollment" as const,
  showAll: false,
};

const names = (ps: readonly Payer[]) => ps.map((p) => p.name);

describe("manualCasePayerOptions", () => {
  it("before a group is picked, lists exactly today's catalog", () => {
    const r = manualCasePayerOptions({ ...base, groupId: null });
    expect(r.view).toBe("full");
    expect(r.options).toEqual(catalog);
    expect(r.pickedOutOfNetwork).toBe(false);
  });

  it("after a group is picked, lists only its active network payers, name-sorted", () => {
    const r = manualCasePayerOptions(base);
    expect(r.view).toBe("network");
    // Cigna's target is archived, so it does not count.
    expect(names(r.options)).toEqual(["Aetna", "UHC"]);
  });

  it("Show all lists today's exact catalog", () => {
    const r = manualCasePayerOptions({ ...base, showAll: true });
    expect(r.view).toBe("all");
    expect(r.options).toEqual(catalog);
  });

  it("a group with only archived targets opens on the full list", () => {
    const r = manualCasePayerOptions({ ...base, groupId: "g-empty" });
    expect(r.view).toBe("no_network");
    expect(r.options).toEqual(catalog);
  });

  it("a group with no targets at all opens on the full list", () => {
    const r = manualCasePayerOptions({ ...base, groupId: "g-none" });
    expect(r.view).toBe("no_network");
    expect(r.options).toEqual(catalog);
  });

  it("keeps an out-of-network pick listed and flags it after a group switch", () => {
    const r = manualCasePayerOptions({ ...base, groupId: "g-2", payerId: "p-aetna" });
    expect(r.view).toBe("network");
    expect(names(r.options)).toEqual(["Aetna", "BCBS"]);
    expect(r.pickedOutOfNetwork).toBe(true);
  });

  it("flags an out-of-network pick on the full list too", () => {
    const shown = manualCasePayerOptions({ ...base, payerId: "p-cigna", showAll: true });
    expect(shown.pickedOutOfNetwork).toBe(true);
    const empty = manualCasePayerOptions({ ...base, groupId: "g-empty", payerId: "p-cigna" });
    expect(empty.pickedOutOfNetwork).toBe(true);
  });

  it("does not flag an in-network pick", () => {
    const r = manualCasePayerOptions({ ...base, payerId: "p-uhc" });
    expect(r.pickedOutOfNetwork).toBe(false);
  });

  it("Contract keeps the full catalog unfiltered, with no flag", () => {
    const r = manualCasePayerOptions({ ...base, caseType: "contract", payerId: "p-bcbs" });
    expect(r.view).toBe("full");
    expect(r.options).toEqual(catalog);
    expect(r.pickedOutOfNetwork).toBe(false);
  });

  it("falls back to the full list while the network read is unavailable", () => {
    const r = manualCasePayerOptions({ ...base, targets: undefined, payerId: "p-bcbs" });
    expect(r.view).toBe("full");
    expect(r.options).toEqual(catalog);
    expect(r.pickedOutOfNetwork).toBe(false);
  });
});
