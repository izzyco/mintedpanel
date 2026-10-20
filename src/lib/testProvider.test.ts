import { describe, expect, it } from "vitest";
import {
  excludeTestProviderRows,
  excludeTestProviders,
  isTestProvider,
  testProviderIds,
} from "./testProvider";

describe("testProvider", () => {
  it("identifies the designated test provider", () => {
    expect(isTestProvider({ isTestProvider: true })).toBe(true);
    expect(isTestProvider({ isTestProvider: false })).toBe(false);
    expect(isTestProvider({ isTestProvider: null })).toBe(false);
    expect(isTestProvider({})).toBe(false);
  });

  it("excludes test providers from a work list, preserving the rest", () => {
    const list = [
      { id: "a", isTestProvider: false },
      { id: "b", isTestProvider: true },
      { id: "c" },
    ];
    expect(excludeTestProviders(list).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("collects the test provider ids from a provider list", () => {
    const ids = testProviderIds([
      { id: "a", isTestProvider: false },
      { id: "b", isTestProvider: true },
      { id: "c" },
    ]);
    expect(Array.from(ids)).toEqual(["b"]);
  });

  it("drops a test provider's rows from a provider-keyed derivation (cases, documents)", () => {
    const rows = [
      { id: "case-1", providerId: "a" },
      { id: "case-2", providerId: "b" },
      { id: "group-doc", providerId: null },
      { id: "case-doc" },
    ];
    expect(excludeTestProviderRows(rows, new Set(["b"])).map((r) => r.id)).toEqual([
      "case-1",
      "group-doc",
      "case-doc",
    ]);
    expect(excludeTestProviderRows(rows, new Set())).toHaveLength(4);
  });
});
