// MINT-110 PR 2 — the batch check's shared rules: what a request may carry
// (1 to 10 NPIs, the /lookup check on each), and a request fits the budget.
import { describe, expect, it } from "vitest";
import {
  NPI_REGISTRY_BATCH_MAX,
  NPI_REGISTRY_BATCH_PER_MINUTE,
  NPI_REGISTRY_BATCH_SIZE_MESSAGE,
  validateNpiRegistryBatch,
} from "./npiRegistryBatch";
import { npiCheckDigit } from "./providerIdentity";

/** A synthetic, check-digit-valid NPI: "1" + eight digits + the CMS digit. */
function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

describe("validateNpiRegistryBatch", () => {
  it("takes 1 to 10 NPIs, strips separators, and keeps each once in order", () => {
    const a = fakeNpi(1);
    const b = fakeNpi(2);
    const dashed = `${a.slice(0, 3)}-${a.slice(3, 6)}-${a.slice(6)}`;
    expect(validateNpiRegistryBatch({ npis: [dashed, ` ${b} `, a] })).toEqual({
      ok: true,
      value: [a, b],
    });
  });

  it("rejects an empty, missing, non-array or oversized list", () => {
    const tooMany = Array.from({ length: NPI_REGISTRY_BATCH_MAX + 1 }, (_, i) => fakeNpi(i));
    for (const body of [
      {},
      null,
      { npis: [] },
      { npis: "1234567893" },
      { npis: tooMany },
      [fakeNpi(1)],
    ]) {
      expect(validateNpiRegistryBatch(body)).toEqual({
        ok: false,
        error: NPI_REGISTRY_BATCH_SIZE_MESSAGE,
      });
    }
    expect(NPI_REGISTRY_BATCH_SIZE_MESSAGE).toBe("Send 1 to 10 NPIs to check");
  });

  it("names the first NPI that fails the check digit, so it never goes upstream", () => {
    const good = fakeNpi(7);
    const bad = `${good.slice(0, 9)}${(Number(good[9]) + 1) % 10}`;
    expect(validateNpiRegistryBatch({ npis: [good, bad] })).toEqual({
      ok: false,
      error: "NPI 2 of 2: Enter a 10-digit NPI with a valid check digit",
    });
    expect(validateNpiRegistryBatch({ npis: [good, 1234567893] })).toMatchObject({ ok: false });
    expect(validateNpiRegistryBatch({ npis: ["12345A7893"] })).toMatchObject({ ok: false });
  });
});

describe("the batch budget", () => {
  it("fits a whole request in one minute: the window admits a request's NPIs together, never more than its limit", () => {
    expect(NPI_REGISTRY_BATCH_MAX).toBeLessThanOrEqual(NPI_REGISTRY_BATCH_PER_MINUTE);
  });
});
