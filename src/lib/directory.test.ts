import { describe, it, expect } from "vitest";
import {
  DIRECTORY_CATALOGS,
  DIRECTORY_LAYOUT_PAGE_KEYS,
  directoryAddressLine,
  directoryQueryStateCodes,
  isCurrentAssignment,
  matchesDirectoryQuery,
  medicarePtanFrom,
  parseDirectoryQuery,
  storedDirectoryLayout,
  validateDirectoryLayoutBody,
  type DirectoryQuery,
  type DirectorySearchable,
} from "./directory";

function q(raw: string): DirectoryQuery {
  const parsed = parseDirectoryQuery(raw);
  if (!parsed.ok || !parsed.query) throw new Error("expected a query");
  return parsed.query;
}

describe("directory catalogs", () => {
  const keysOf = (type: keyof typeof DIRECTORY_CATALOGS) =>
    DIRECTORY_CATALOGS[type].flatMap((s) => s.fields.map((f) => f.key));
  const offOf = (type: keyof typeof DIRECTORY_CATALOGS) =>
    DIRECTORY_CATALOGS[type].flatMap((s) => s.fields.filter((f) => !f.defaultOn).map((f) => f.key));

  it("uses the mock's keys, in the mock's order", () => {
    expect(keysOf("group")).toEqual([
      "legal",
      "tin",
      "npi2",
      "ptan",
      "states",
      "phone",
      "mail",
      "list.locations",
      "list.providers",
      "list.docs",
    ]);
    expect(keysOf("provider")).toEqual([
      "first",
      "middle",
      "last",
      "npi",
      "caqh",
      "medicare",
      "email",
      "phone",
      "dob",
      "gender",
      "languages",
      "licenses",
      "licenseExp",
      "taxonomy",
      "specialty",
      "board",
      "dea",
      "education",
      "malCarrier",
      "malPolicy",
      "malExp",
      "list.groups",
      "list.locations",
    ]);
    expect(keysOf("location")).toEqual([
      "full",
      "street",
      "suite",
      "city",
      "state",
      "zip",
      "phone",
      "fax",
      "pos",
      "hours",
      "list.group",
      "list.providers",
    ]);
  });

  it("turns off exactly the fields the spec names", () => {
    expect(offOf("group")).toEqual(["phone", "mail"]);
    expect(offOf("provider")).toEqual(["middle", "gender", "languages"]);
    expect(offOf("location")).toEqual(["hours"]);
  });

  it("never offers an SSN field", () => {
    const all = JSON.stringify(DIRECTORY_CATALOGS).toLowerCase();
    expect(all).not.toContain("ssn");
  });

  it("keys a distinct user_table_prefs page per card type", () => {
    const keys = Object.values(DIRECTORY_LAYOUT_PAGE_KEYS);
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain("extension.quickCards");
  });
});

describe("validateDirectoryLayoutBody", () => {
  it.each([
    ["null", "group", null],
    ["a string", "group", "tin"],
    ["an array", "group", []],
    ["missing fields", "group", {}],
    ["non-array fields", "group", { fields: "tin" }],
    ["non-string fields", "group", { fields: ["tin", 3] }],
    ["a key from another card", "group", { fields: ["npi"] }],
    ["an unknown key", "provider", { fields: ["ssnLast4"] }],
    ["a duplicate key", "location", { fields: ["zip", "zip"] }],
  ] as const)("rejects %s", (_name, type, body) => {
    expect(validateDirectoryLayoutBody(type, body).ok).toBe(false);
  });

  it("accepts an ordered layout and keeps its order", () => {
    expect(validateDirectoryLayoutBody("group", { fields: ["list.docs", "tin", "phone"] })).toEqual(
      { ok: true, fields: ["list.docs", "tin", "phone"] },
    );
  });

  it("accepts an empty layout (every field off)", () => {
    expect(validateDirectoryLayoutBody("location", { fields: [] }).ok).toBe(true);
  });
});

describe("storedDirectoryLayout", () => {
  it("reads a string array and degrades anything else to null", () => {
    expect(storedDirectoryLayout({ fields: ["tin"] })).toEqual(["tin"]);
    expect(storedDirectoryLayout({ fields: [1] })).toBeNull();
    expect(storedDirectoryLayout(null)).toBeNull();
    expect(storedDirectoryLayout("x")).toBeNull();
  });
});

describe("parseDirectoryQuery", () => {
  it.each([[null], [""], ["   "]])("reads %j as no search", (raw) => {
    expect(parseDirectoryQuery(raw)).toEqual({ ok: true, query: null });
  });

  it("rejects more than 100 characters after trimming", () => {
    expect(parseDirectoryQuery("x".repeat(101)).ok).toBe(false);
    expect(parseDirectoryQuery(` ${"x".repeat(100)} `).ok).toBe(true);
  });

  it("accepts a single character as one term", () => {
    expect(q(" a ")).toEqual({ states: [], terms: ["a"] });
  });

  it("takes a full state name as one state term", () => {
    expect(q("New Mexico")).toEqual({ states: [{ code: "NM", phrase: "new mexico" }], terms: [] });
    expect(q("sandia   new   mexico")).toEqual({
      states: [{ code: "NM", phrase: "new mexico" }],
      terms: ["sandia"],
    });
  });

  it("prefers the longest state name", () => {
    expect(q("West Virginia").states.map((s) => s.code)).toEqual(["WV"]);
    expect(q("Virginia").states.map((s) => s.code)).toEqual(["VA"]);
  });

  it("does not take a state name out of the middle of a word", () => {
    expect(q("Kansasville").states).toEqual([]);
  });

  it("lists the state codes a query can match", () => {
    expect(directoryQueryStateCodes(q("New Mexico co smith")).sort()).toEqual(["CO", "NM"]);
    expect(directoryQueryStateCodes(q("smith"))).toEqual([]);
  });
});

describe("matchesDirectoryQuery", () => {
  const group: DirectorySearchable = {
    text: ["Sandia Physical Therapy"],
    ids: ["12-3456789", "1234567890"],
    states: ["NM", "CO"],
  };

  it("matches a name substring, case-insensitively", () => {
    expect(matchesDirectoryQuery(group, q("sandia"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("PHYSICAL"))).toBe(true);
  });

  it("matches a TIN with or without the dash", () => {
    expect(matchesDirectoryQuery(group, q("123456789"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("12-3456789"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("3456"))).toBe(true);
  });

  it("matches a state by code or full name", () => {
    expect(matchesDirectoryQuery(group, q("NM"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("nm"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("New Mexico"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("Colorado"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("Kansas"))).toBe(false);
    expect(matchesDirectoryQuery(group, q("KS"))).toBe(false);
  });

  it("needs every term to match somewhere", () => {
    expect(matchesDirectoryQuery(group, q("sandia New Mexico"))).toBe(true);
    expect(matchesDirectoryQuery(group, q("sandia Kansas"))).toBe(false);
    expect(matchesDirectoryQuery(group, q("sandia acme"))).toBe(false);
  });

  it("matches a state name inside a record's own name", () => {
    const named: DirectorySearchable = { text: ["New Mexico Rehab"], ids: [], states: [] };
    expect(matchesDirectoryQuery(named, q("new mexico"))).toBe(true);
  });

  it("matches email, city and ZIP", () => {
    const rec: DirectorySearchable = {
      text: ["jane@example.com", "Albuquerque"],
      ids: ["87110"],
      states: ["NM"],
    };
    expect(matchesDirectoryQuery(rec, q("jane@ex"))).toBe(true);
    expect(matchesDirectoryQuery(rec, q("albuq"))).toBe(true);
    expect(matchesDirectoryQuery(rec, q("87110"))).toBe(true);
  });

  it("ignores null fields", () => {
    expect(matchesDirectoryQuery({ text: [null], ids: [null], states: [null] }, q("ab"))).toBe(
      false,
    );
  });
});

describe("derivations", () => {
  it("medicarePtanFrom: distinct values in state order, null when none", () => {
    expect(medicarePtanFrom([])).toBeNull();
    expect(medicarePtanFrom([{ state: "NM", payerIssuedId: "  " }])).toBeNull();
    expect(
      medicarePtanFrom([
        { state: "NM", payerIssuedId: "B222" },
        { state: "CO", payerIssuedId: "A111" },
        { state: "TX", payerIssuedId: "A111" },
      ]),
    ).toBe("A111, B222");
  });

  it("isCurrentAssignment: open-ended or ending today or later", () => {
    expect(isCurrentAssignment(null, "2026-11-04")).toBe(true);
    expect(isCurrentAssignment("2026-11-04", "2026-11-04")).toBe(true);
    expect(isCurrentAssignment("2026-11-03", "2026-11-04")).toBe(false);
  });

  it("directoryAddressLine skips blanks", () => {
    expect(
      directoryAddressLine({
        street: "1 Main",
        suite: "",
        city: "Santa Fe",
        state: "NM",
        zip: "87505",
      }),
    ).toBe("1 Main, Santa Fe, NM 87505");
    expect(directoryAddressLine({})).toBeNull();
  });
});
