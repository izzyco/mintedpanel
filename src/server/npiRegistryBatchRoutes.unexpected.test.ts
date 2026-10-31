// MINT-110 PR 2 — an unexpected (non-registry) error inside the batch route:
// no worker starts another registry call after it, the call already in flight
// is waited for (nothing left running), what was never sent is refunded, and
// the error is rethrown for the dispatcher's 500. The shared lookup is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "./guard";

vi.mock("./npiRegistryRoutes", () => ({ lookupNpiRegistryCached: vi.fn() }));

import { lookupNpiRegistryCached } from "./npiRegistryRoutes";
import {
  handleNpiRegistryVerifyBatch,
  resetNpiRegistryBatchBudget,
} from "./npiRegistryBatchRoutes";
import { npiCheckDigit } from "@/lib/providerIdentity";

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}
const npis = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => fakeNpi(from + i));

const ctx = { userId: "u1", orgId: "org-1", role: "admin" } as AuthContext;
const lookup = vi.mocked(lookupNpiRegistryCached);

beforeEach(() => {
  resetNpiRegistryBatchBudget(() => 0);
  lookup.mockReset();
});

describe("verify-batch on an unexpected error", () => {
  it("starts nothing more, waits for the call in flight, refunds the rest and rethrows", async () => {
    let finishedSlow = false;
    lookup.mockImplementation(async (npi) => {
      if (npi === fakeNpi(1)) throw new RangeError("synthetic bug");
      await new Promise((resolve) => setTimeout(resolve, 10));
      finishedSlow = true;
      return { record: null };
    });
    await expect(handleNpiRegistryVerifyBatch({ npis: npis(10) }, ctx)).rejects.toThrow(
      "synthetic bug",
    );
    // Two started (the failing one and the one beside it); none after.
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(finishedSlow).toBe(true);

    // 8 never sent were refunded: 18 of the 20 are still there.
    lookup.mockImplementation(async () => ({ record: null }));
    expect((await handleNpiRegistryVerifyBatch({ npis: npis(10, 20) }, ctx)).status).toBe(200);
    expect((await handleNpiRegistryVerifyBatch({ npis: npis(8, 40) }, ctx)).status).toBe(200);
    expect((await handleNpiRegistryVerifyBatch({ npis: npis(1, 60) }, ctx)).status).toBe(429);
  });
});
