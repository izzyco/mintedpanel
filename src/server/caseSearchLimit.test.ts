import { describe, it, expect, vi } from "vitest";
import {
  CASE_SEARCH_DEFAULT_LIMIT,
  CASE_SEARCH_MAX_LIMIT,
  normalizeCaseSearchLimit,
  parseRequestedCaseSearchLimit,
  resolveCaseSearchLimit,
  validateCaseSearchLimit,
} from "./caseSearchLimit";

const db = {} as Parameters<typeof resolveCaseSearchLimit>[0];

describe("case-search limit seam", () => {
  it("defaults to 5 (Sowmya, Oct 30)", () => {
    expect(CASE_SEARCH_DEFAULT_LIMIT).toBe(5);
  });

  it("resolves the default while no platform setting exists (before Mission Control M6)", async () => {
    expect(await resolveCaseSearchLimit(db)).toBe(5);
  });

  it("uses the platform setting when one is set, reading it with the server's client", async () => {
    const readSetting = vi.fn().mockResolvedValue(12);
    expect(await resolveCaseSearchLimit(db, readSetting)).toBe(12);
    expect(readSetting).toHaveBeenCalledWith(db);
  });

  it("caps a platform setting at 50 (the Platform Settings IA maximum)", async () => {
    expect(CASE_SEARCH_MAX_LIMIT).toBe(50);
    expect(normalizeCaseSearchLimit(50)).toBe(50);
    expect(normalizeCaseSearchLimit(51)).toBe(50);
    expect(await resolveCaseSearchLimit(db, async () => 10_000)).toBe(50);
  });

  it.each([null, undefined, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "10", {}])(
    "falls back to the default for an unset or unusable setting (%j)",
    async (raw) => {
      expect(normalizeCaseSearchLimit(raw)).toBe(5);
      expect(await resolveCaseSearchLimit(db, async () => raw)).toBe(5);
    },
  );
});

describe("no organization override (Sowmya, Oct 31, S2)", () => {
  it("reads only the platform setting: the reader is given the server's client and nothing else", async () => {
    const readSetting = vi.fn().mockResolvedValue(12);
    await resolveCaseSearchLimit(db, readSetting);
    expect(readSetting.mock.calls).toEqual([[db]]);
  });
});

describe("validateCaseSearchLimit (the platform setting, before it is stored)", () => {
  it("accepts a whole number from 1 to 50, or nothing set", () => {
    for (const raw of [null, undefined, 1, 5, 50]) expect(validateCaseSearchLimit(raw)).toEqual([]);
  });

  it("refuses anything else in plain language, naming a non-text value by its kind", () => {
    const message = (shown: string) => [
      `The case search limit must be a whole number from 1 to 50, not ${shown}.`,
    ];
    expect(validateCaseSearchLimit(51)).toEqual(message("51"));
    expect(validateCaseSearchLimit(0)).toEqual(message("0"));
    expect(validateCaseSearchLimit(2.5)).toEqual(message("2.5"));
    expect(validateCaseSearchLimit(Number.NaN)).toEqual(message("NaN"));
    expect(validateCaseSearchLimit("10")).toEqual(message('"10"'));
    expect(validateCaseSearchLimit(true)).toEqual(message("true"));
    expect(validateCaseSearchLimit([5])).toEqual(message("a list"));
    expect(validateCaseSearchLimit({})).toEqual(message("a set of values"));
    expect(validateCaseSearchLimit(10n)).toEqual(message("a bigint value"));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(validateCaseSearchLimit(circular)).toEqual(message("a set of values"));
  });
});

describe("parseRequestedCaseSearchLimit (&limit= on GET /api/cases?q=, S3)", () => {
  it("is null when the request names no limit, so the platform setting applies", () => {
    expect(parseRequestedCaseSearchLimit(null)).toEqual({ ok: true, limit: null });
  });

  it.each([
    ["1", 1],
    ["5", 5],
    ["50", 50],
    ["05", 5],
  ])("honours a whole number from 1 to 50 (%s)", (raw, limit) => {
    expect(parseRequestedCaseSearchLimit(raw)).toEqual({ ok: true, limit });
  });

  it.each([
    "",
    "0",
    "51",
    "1000",
    "2.5",
    "-1",
    "+5",
    " 5",
    "5 ",
    "5e1",
    "abc",
    "0x10",
    "99999999999999999999",
  ])("refuses %j with a plain message, never clamping it", (raw) => {
    expect(parseRequestedCaseSearchLimit(raw)).toEqual({
      ok: false,
      message: "limit must be a whole number from 1 to 50",
    });
  });
});
