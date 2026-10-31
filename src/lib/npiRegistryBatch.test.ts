// MINT-110 PR 2 — the batch check's shared rules: what a request may carry
// (1 to 10 NPIs, the /lookup check on each) and the token bucket both the
// route and the import screen use for the per-user budget.
import { describe, expect, it } from "vitest";
import {
  NPI_REGISTRY_BATCH_BURST,
  NPI_REGISTRY_BATCH_MAX,
  NPI_REGISTRY_BATCH_PER_MINUTE,
  NPI_REGISTRY_BATCH_SIZE_MESSAGE,
  TokenBucket,
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

describe("TokenBucket", () => {
  it("allows a burst, then refills continuously at the budget rate", () => {
    let now = 0;
    const perMs = NPI_REGISTRY_BATCH_PER_MINUTE / 60_000;
    const bucket = new TokenBucket(NPI_REGISTRY_BATCH_BURST, perMs, () => now);
    expect(bucket.take("u1", 10)).toEqual({ allowed: true });
    expect(bucket.take("u1", 10)).toEqual({ allowed: true });
    // 20 spent: the next 10 need 10 s at one a second.
    expect(bucket.take("u1", 10)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(bucket.msUntilAvailable("u1", 10)).toBe(10_000);
    now += 4_000;
    expect(bucket.take("u1", 10)).toEqual({ allowed: false, retryAfterSeconds: 6 });
    now += 6_000;
    expect(bucket.msUntilAvailable("u1", 10)).toBe(0);
    expect(bucket.take("u1", 10)).toEqual({ allowed: true });
  });

  it("keeps one bucket per key and never refills past capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(20, 1 / 1000, () => now);
    expect(bucket.take("u1", 20)).toEqual({ allowed: true });
    expect(bucket.take("u2", 20)).toEqual({ allowed: true });
    now += 10 * 60_000;
    expect(bucket.take("u1", 21)).toMatchObject({ allowed: false });
    expect(bucket.take("u1", 20)).toEqual({ allowed: true });
  });

  it("refunds unspent work up to capacity, and drains on demand", () => {
    let now = 0;
    const bucket = new TokenBucket(20, 1 / 1000, () => now);
    bucket.take("u1", 10);
    bucket.refund("u1", 50);
    expect(bucket.take("u1", 20)).toEqual({ allowed: true });
    bucket.refund("u1", 4);
    expect(bucket.msUntilAvailable("u1", 4)).toBe(0);
    bucket.drain("u1");
    expect(bucket.msUntilAvailable("u1", 4)).toBe(4_000);
    now += 1_000;
    expect(bucket.take("u1", 4)).toEqual({ allowed: false, retryAfterSeconds: 3 });
  });

  it("answers Retry-After of at least one second", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1 / 1000, () => now);
    bucket.take("u1", 2);
    now += 999;
    expect(bucket.take("u1", 1)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
