import { describe, it, expect } from "vitest";
import {
  CASE_SEARCH_DEFAULT_LIMIT,
  CASE_SEARCH_MAX_LIMIT,
  parseRequestedCaseSearchLimit,
} from "./caseSearchLimit";

describe("case-search limit", () => {
  it("defaults to 5 (Sowmya, Oct 30), capped at 50 (the Platform Settings IA maximum)", () => {
    expect(CASE_SEARCH_DEFAULT_LIMIT).toBe(5);
    expect(CASE_SEARCH_MAX_LIMIT).toBe(50);
  });
});

describe("parseRequestedCaseSearchLimit (&limit= on GET /api/cases?q=, S3)", () => {
  it("is null when the request names no limit, so the default applies", () => {
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
