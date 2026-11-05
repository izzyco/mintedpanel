// What "+ Add state" says after a save (GCM-33, MINT-143): every outcome of
// saveAddedState, including a failed refetch and a history or audit failure
// after the records were saved.
import { describe, expect, it, vi } from "vitest";
import type { ContractsMatrixContract, ContractsMatrixInput } from "@/lib/groupContractsMatrix";
import type { Contract } from "@/types";

vi.mock("@/integrations/supabase/externalClient", () => ({ supabase: {} }));

import { ContractFollowUpWriteError } from "@/services/contracts";
import {
  addedColumnsStorageKey,
  loadAddedColumns,
  saveAddedColumns,
  saveAddedState,
} from "./contractsMatrixAddState";

function record(
  id: string,
  groupId: string,
  payerId: string,
  state: string,
  specialtyKey: ContractsMatrixContract["specialtyKey"],
): ContractsMatrixContract {
  return {
    id,
    groupId,
    payerId,
    state,
    specialtyKey,
    contractingStatusId: "s-submitted",
    effectiveDate: null,
    tentativeEffectiveDate: null,
    notes: null,
  };
}

// Group Name 2's Nutrition records put Payers 1 and 2 in the Nutrition table;
// the writer plans Nutrition in LA for Group Name 3.
const INPUT: ContractsMatrixInput<ContractsMatrixContract> = {
  today: "2026-11-01",
  groups: [
    { id: "g2", name: "Group Name 2", tin: null, isActive: true },
    { id: "g3", name: "Group Name 3", tin: null, isActive: true },
  ],
  payers: [
    { id: "p1", name: "Payer 1", states: null },
    { id: "p2", name: "Payer 2", states: null },
  ],
  contracts: [
    record("c1", "g2", "p1", "KS", "nutrition"),
    record("c2", "g2", "p2", "KS", "nutrition"),
  ],
  targets: [],
  statuses: [
    { id: "s-not-started", label: "Not Started" },
    { id: "s-submitted", label: "Application Submitted" },
  ],
  facilities: [],
  facilityAssignments: [],
  licenses: [],
  providers: [],
  groupAssignments: [],
};
const COLUMN = { specialty: "nutrition", groupId: "g3", state: "la" } as const;
const WHERE = "LA for Group Name 3 (Nutrition)";

function fresh(contracts = INPUT.contracts) {
  return vi.fn().mockResolvedValue({ isError: false, data: contracts });
}

describe("saveAddedState", () => {
  it("saves a Not started record per open payer cell and says how many", async () => {
    const create = vi.fn().mockResolvedValue([{}, {}]);
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: fresh(),
      create,
    });
    expect(create).toHaveBeenCalledWith(
      ["p1", "p2"].map((payerId) => ({
        groupId: "g3",
        payerId,
        state: "LA",
        specialtyKey: "nutrition",
        contractingStatusId: "s-not-started",
      })),
    );
    expect(outcome).toEqual({ tone: "success", text: `Added ${WHERE}: 2 Not started records.` });
  });

  it("works from the refetched contracts, not the ones the page loaded", async () => {
    // A colleague saved Payer 1's all-specialties agreement there meanwhile.
    const create = vi.fn().mockResolvedValue([{}]);
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: fresh([...INPUT.contracts, record("c9", "g3", "p1", "LA", "all")]),
      create,
    });
    expect(create.mock.calls[0][0].map((r: { payerId: string }) => r.payerId)).toEqual(["p2"]);
    expect(outcome.text).toBe(`Added ${WHERE}: 1 Not started record.`);
  });

  it("saves nothing, and says so, when the latest contracts cannot be loaded", async () => {
    const create = vi.fn();
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: vi.fn().mockResolvedValue({ isError: true, data: INPUT.contracts }),
      create,
    });
    expect(create).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      tone: "error",
      text: `${WHERE} shows for this visit only. The latest contracts could not be loaded, so no records were saved.`,
    });
  });

  it("says the column is for this visit only when no payer has an open cell", async () => {
    const create = vi.fn();
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: fresh([
        ...INPUT.contracts,
        record("c8", "g3", "p1", "LA", "nutrition"),
        record("c9", "g3", "p2", "LA", "all"),
      ]),
      create,
    });
    expect(create).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      tone: "message",
      text: `Added ${WHERE} for this visit only. No payer in the table has an open cell there, so no records were saved.`,
    });
  });

  it("says the records were saved when only their history or audit failed", async () => {
    const saved = [{ id: "n1" }, { id: "n2" }] as Contract[];
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: fresh(),
      create: vi.fn().mockRejectedValue(new ContractFollowUpWriteError(saved)),
    });
    expect(outcome).toEqual({
      tone: "error",
      text: `Saved 2 Not started records for ${WHERE}; their history or audit could not be written.`,
    });
  });

  it("says nothing was saved when the insert fails", async () => {
    const outcome = await saveAddedState({
      input: INPUT,
      column: COLUMN,
      refetchContracts: fresh(),
      create: vi.fn().mockRejectedValue(new Error("Permission denied.")),
    });
    expect(outcome).toEqual({
      tone: "error",
      text: `${WHERE} shows for this visit only. Its Not started records were not saved. Permission denied.`,
    });
  });
});

describe("addedColumns storage", () => {
  function makeMockStorage(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      store,
    };
  }

  it("produces null key for null/empty orgId", () => {
    expect(addedColumnsStorageKey(null)).toBeNull();
    expect(addedColumnsStorageKey(undefined)).toBeNull();
    expect(addedColumnsStorageKey("")).toBeNull();
    expect(addedColumnsStorageKey("org-123")).toBe("minted:contracts-matrix:added-columns:org-123");
  });

  it("returns empty array when orgId is null or storage is missing", () => {
    expect(loadAddedColumns(null)).toEqual([]);
    expect(loadAddedColumns(undefined)).toEqual([]);
    expect(loadAddedColumns("org-123", null)).toEqual([]);
  });

  it("saves and loads added columns for an organization", () => {
    const storage = makeMockStorage();
    const columns = [
      { specialty: "pt" as const, groupId: "g1", state: "MO" },
      { specialty: "nutrition" as const, groupId: "g2", state: "LA" },
    ];
    saveAddedColumns("org-1", columns, storage);
    expect(storage.setItem).toHaveBeenCalledWith(
      "minted:contracts-matrix:added-columns:org-1",
      JSON.stringify(columns),
    );

    const loaded = loadAddedColumns("org-1", storage);
    expect(loaded).toEqual(columns);
  });

  it("isolates columns between different organizations", () => {
    const storage = makeMockStorage();
    const colsA = [{ specialty: "nutrition" as const, groupId: "g1", state: "LA" }];
    const colsB = [{ specialty: "pt" as const, groupId: "g2", state: "CO" }];

    saveAddedColumns("org-a", colsA, storage);
    saveAddedColumns("org-b", colsB, storage);

    expect(loadAddedColumns("org-a", storage)).toEqual(colsA);
    expect(loadAddedColumns("org-b", storage)).toEqual(colsB);
  });

  it("removes storage key when saving empty columns", () => {
    const storage = makeMockStorage();
    saveAddedColumns("org-1", [{ specialty: "nutrition" as const, groupId: "g1", state: "LA" }], storage);
    expect(loadAddedColumns("org-1", storage)).toHaveLength(1);

    saveAddedColumns("org-1", [], storage);
    expect(storage.removeItem).toHaveBeenCalledWith("minted:contracts-matrix:added-columns:org-1");
    expect(loadAddedColumns("org-1", storage)).toEqual([]);
  });

  it("safely handles corrupted or invalid JSON in storage", () => {
    const storage = makeMockStorage({
      "minted:contracts-matrix:added-columns:org-corrupt": "not-json-{{{",
      "minted:contracts-matrix:added-columns:org-invalid-array": JSON.stringify([
        { specialty: "pt" }, // missing groupId, state
        null,
        "string",
        { specialty: "nutrition", groupId: "g1", state: "LA" },
      ]),
    });

    expect(loadAddedColumns("org-corrupt", storage)).toEqual([]);
    expect(loadAddedColumns("org-invalid-array", storage)).toEqual([
      { specialty: "nutrition", groupId: "g1", state: "LA" },
    ]);
  });
});
