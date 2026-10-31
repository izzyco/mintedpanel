import { describe, it, expect, vi } from "vitest";
import {
  CASE_SEARCH_DEFAULT_LIMIT,
  CASE_SEARCH_MAX_LIMIT,
  normalizeCaseSearchLimit,
  resolveCaseSearchLimit,
  resolveCaseSearchLimitSetting,
  validateCaseSearchLimit,
  type CaseSearchLimitReader,
} from "./caseSearchLimit";

const db = {} as Parameters<typeof resolveCaseSearchLimit>[0];
const ORG = "org-1";

// The reader now gets the request's org id and answers both levels (MINT-112).
const stored =
  (platform?: unknown, organization?: unknown): CaseSearchLimitReader =>
  async () => ({ platform, organization });

const UNUSABLE = [null, undefined, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "10", {}];

describe("case-search limit seam", () => {
  it("defaults to 5 (Sowmya, Oct 30)", () => {
    expect(CASE_SEARCH_DEFAULT_LIMIT).toBe(5);
  });

  it("resolves the default while nothing is stored (before Mission Control M6)", async () => {
    expect(await resolveCaseSearchLimit(db, ORG)).toBe(5);
  });

  it("uses the platform setting when one is set, reading it with the server's client and the request's org", async () => {
    const readSettings = vi.fn().mockResolvedValue({ platform: 12 });
    expect(await resolveCaseSearchLimit(db, ORG, readSettings)).toBe(12);
    expect(readSettings).toHaveBeenCalledWith(db, ORG);
  });

  it("caps a setting at 50 (the Platform Settings IA maximum)", async () => {
    expect(CASE_SEARCH_MAX_LIMIT).toBe(50);
    expect(normalizeCaseSearchLimit(50)).toBe(50);
    expect(normalizeCaseSearchLimit(51)).toBe(50);
    expect(await resolveCaseSearchLimit(db, ORG, stored(10_000))).toBe(50);
    expect(await resolveCaseSearchLimit(db, ORG, stored(undefined, 10_000))).toBe(50);
  });

  it.each(UNUSABLE)(
    "falls back to the default for an unset or unusable setting (%j)",
    async (raw) => {
      expect(normalizeCaseSearchLimit(raw)).toBe(5);
      expect(await resolveCaseSearchLimit(db, ORG, stored(raw))).toBe(5);
      expect(await resolveCaseSearchLimit(db, ORG, stored(undefined, raw))).toBe(5);
      expect(await resolveCaseSearchLimit(db, ORG, stored(raw, raw))).toBe(5);
    },
  );

  it("resolves the default when the reader finds nothing for the org", async () => {
    expect(await resolveCaseSearchLimit(db, ORG, async () => null)).toBe(5);
    expect(await resolveCaseSearchLimit(db, ORG, async () => ({}))).toBe(5);
  });
});

describe("per-organization override (MINT-112)", () => {
  it("organization over platform over default", async () => {
    expect(resolveCaseSearchLimitSetting()).toBe(5);
    expect(resolveCaseSearchLimitSetting(12)).toBe(12);
    expect(resolveCaseSearchLimitSetting(12, 20)).toBe(20);
    expect(resolveCaseSearchLimitSetting(undefined, 20)).toBe(20);
    expect(resolveCaseSearchLimitSetting(20, 3)).toBe(3);
    expect(await resolveCaseSearchLimit(db, ORG, stored(12, 20))).toBe(20);
  });

  it.each(UNUSABLE)(
    "skips an unusable organization value (%j) and inherits the platform's",
    async (raw) => {
      expect(resolveCaseSearchLimitSetting(12, raw)).toBe(12);
      expect(await resolveCaseSearchLimit(db, ORG, stored(12, raw))).toBe(12);
    },
  );

  it("asks the reader for this request's organization only", async () => {
    const readSettings = vi.fn(async (_db: unknown, orgId: string) =>
      orgId === "org-2" ? { platform: 12, organization: 25 } : { platform: 12 },
    );
    expect(await resolveCaseSearchLimit(db, "org-1", readSettings)).toBe(12);
    expect(await resolveCaseSearchLimit(db, "org-2", readSettings)).toBe(25);
    expect(readSettings.mock.calls.map((call) => call[1])).toEqual(["org-1", "org-2"]);
  });

  it("validates a value before it is stored, in plain language", () => {
    expect(validateCaseSearchLimit(null)).toEqual([]);
    expect(validateCaseSearchLimit(undefined)).toEqual([]);
    expect(validateCaseSearchLimit(1)).toEqual([]);
    expect(validateCaseSearchLimit(50)).toEqual([]);
    const message = (shown: string) => [
      `The case search limit must be a whole number from 1 to 50, not ${shown}.`,
    ];
    expect(validateCaseSearchLimit(51)).toEqual(message("51"));
    expect(validateCaseSearchLimit(0)).toEqual(message("0"));
    expect(validateCaseSearchLimit(2.5)).toEqual(message("2.5"));
    expect(validateCaseSearchLimit(Number.NaN)).toEqual(message("NaN"));
    expect(validateCaseSearchLimit("10")).toEqual(message('"10"'));
    expect(validateCaseSearchLimit({})).toEqual(message("{}"));
  });
});
