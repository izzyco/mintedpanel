// The save behind "+ Add state" (GCM-33, MINT-143), apart from React so each
// outcome's message can be tested: read the latest contracts, work out the
// Not started records (notStartedRecordsForAddedState), save them in one
// insert, and say what happened. The component shows the result as a toast.
import { CONTRACT_SPECIALTY_LABELS } from "@/lib/contractSpecialty";
import {
  notStartedRecordsForAddedState,
  type ContractsMatrixAddedColumn,
  type ContractsMatrixContract,
  type ContractsMatrixInput,
  type ContractsMatrixNotStartedRecord,
} from "@/lib/groupContractsMatrix";
import { ContractFollowUpWriteError } from "@/services/contracts";
import { countLabel } from "./contractsMatrixView";

/** A toast: `message` is neutral (nothing saved, nothing wrong). */
export interface AddStateOutcome {
  tone: "success" | "message" | "error";
  text: string;
}

export async function saveAddedState<C extends ContractsMatrixContract>({
  input,
  column,
  refetchContracts,
  create,
}: {
  /** The matrix input as loaded; its contracts are replaced by the refetch. */
  input: ContractsMatrixInput<C>;
  column: ContractsMatrixAddedColumn;
  /** The contracts query's refetch. */
  refetchContracts: () => Promise<{ isError: boolean; data?: readonly C[] }>;
  /** Saves the records (createContractsIfMissing); resolves to those created. */
  create: (records: ContractsMatrixNotStartedRecord[]) => Promise<readonly unknown[]>;
}): Promise<AddStateOutcome> {
  const groupName = input.groups.find((group) => group.id === column.groupId)?.name ?? "";
  const where = `${column.state.toUpperCase()} for ${groupName} (${CONTRACT_SPECIALTY_LABELS[column.specialty]})`;
  // Read the latest records first, so one saved by someone else since the
  // dialog opened (an all-specialties agreement, say) is counted.
  const latest = await refetchContracts();
  if (latest.isError || !latest.data) {
    return {
      tone: "error",
      text: `${where} shows for this visit only. The latest contracts could not be loaded, so no records were saved.`,
    };
  }
  const records = notStartedRecordsForAddedState({ ...input, contracts: latest.data }, column);
  if (records.length === 0) {
    return {
      tone: "message",
      text: `Added ${where} for this visit only. No payer in the table has an open cell there, so no records were saved.`,
    };
  }
  try {
    const created = await create(records);
    return {
      tone: "success",
      text: `Added ${where}: ${countLabel(created.length, "Not started record")}.`,
    };
  } catch (error) {
    if (error instanceof ContractFollowUpWriteError) {
      // The insert committed; only the history or audit rows failed.
      return {
        tone: "error",
        text: `Saved ${countLabel(error.created.length, "Not started record")} for ${where}; their history or audit could not be written.`,
      };
    }
    return {
      tone: "error",
      text: `${where} shows for this visit only. Its Not started records were not saved.${
        error instanceof Error && error.message ? ` ${error.message}` : ""
      }`,
    };
  }
}

export const CONTRACTS_MATRIX_ADDED_COLUMNS_STORAGE_PREFIX =
  "minted:contracts-matrix:added-columns:";

export function addedColumnsStorageKey(orgId: string | null | undefined): string | null {
  if (!orgId) return null;
  return `${CONTRACTS_MATRIX_ADDED_COLUMNS_STORAGE_PREFIX}${orgId}`;
}

export function loadAddedColumns(
  orgId: string | null | undefined,
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): ContractsMatrixAddedColumn[] {
  const key = addedColumnsStorageKey(orgId);
  if (!key || !storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ContractsMatrixAddedColumn =>
        Boolean(c) &&
        typeof c === "object" &&
        typeof c.specialty === "string" &&
        typeof c.groupId === "string" &&
        typeof c.state === "string",
    );
  } catch {
    return [];
  }
}

export function saveAddedColumns(
  orgId: string | null | undefined,
  columns: readonly ContractsMatrixAddedColumn[],
  storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): void {
  const key = addedColumnsStorageKey(orgId);
  if (!key || !storage) return;
  try {
    if (columns.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(columns));
    }
  } catch {
    // ignore quota or availability errors
  }
}
