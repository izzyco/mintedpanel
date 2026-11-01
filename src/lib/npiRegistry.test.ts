// MINT-110 — NPI Registry pure rules: what the route accepts, how a typed
// name is compared with the registry's, the note shown under the NPI, and
// where the policy shows each answer. No answer ever blocks a save (A30).
import { describe, expect, it } from "vitest";
import {
  NPI_REGISTRY_QUERY_REJECTED_MESSAGE,
  NPI_REGISTRY_RATE_LIMIT_MESSAGE,
  NPI_REGISTRY_UNAVAILABLE_MESSAGE,
  compareNpiRegistryName,
  npiLookupOutcome,
  npiLookupStateOf,
  npiToCheck,
  foldNameForRegistry,
  npiVerificationView,
  registrySummary,
  validateNpiRegistryLookup,
  validateNpiRegistrySearch,
  type NpiLookupState,
  type NpiRegistryRecord,
} from "./npiRegistry";
import * as npiRegistry from "./npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  NPI_REGISTRY_OUTCOMES,
  resolveNpiRegistryPolicy,
  type NpiRegistryOutcome,
} from "./npiRegistryPolicy";

const jane: NpiRegistryRecord = {
  npi: "1234567893",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: "A",
  lastName: "DOE",
  organizationName: null,
  credential: "PT, DPT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  practiceState: "CO",
  status: "active",
  enumerationDate: "2015-03-02",
  otherNames: [{ firstName: "JANE", lastName: "SMITH" }],
};

describe("validateNpiRegistrySearch", () => {
  it("requires a first and last name and treats state as optional", () => {
    expect(validateNpiRegistrySearch({ firstName: " Jane ", lastName: "Doe" })).toEqual({
      ok: true,
      value: { firstName: "Jane", lastName: "Doe", state: null },
    });
    expect(validateNpiRegistrySearch({ firstName: "Jane", lastName: "Doe", state: "co" })).toEqual({
      ok: true,
      value: { firstName: "Jane", lastName: "Doe", state: "CO" },
    });
    for (const input of [{}, null, "x", [], { firstName: "Jane" }, { lastName: "Doe" }]) {
      expect(validateNpiRegistrySearch(input).ok).toBe(false);
    }
  });

  it("accepts real-world names and rejects wildcards, digits and long input", () => {
    for (const lastName of ["O'Brien", "Smith-Jones", "St. John", "Núñez", "van der Berg"]) {
      expect(validateNpiRegistrySearch({ firstName: "Ana", lastName }).ok).toBe(true);
    }
    for (const lastName of ["Do*", "D0e", "Doe;", "<b>", "-Doe", "x".repeat(36)]) {
      expect(validateNpiRegistrySearch({ firstName: "Ana", lastName }).ok).toBe(false);
    }
  });

  it("returns the folded names the registry is asked for", () => {
    expect(validateNpiRegistrySearch({ firstName: "J.", lastName: "Strau\u00df, Jr." })).toEqual({
      ok: true,
      value: { firstName: "J", lastName: "Strauss", state: null },
    });
    expect(
      validateNpiRegistrySearch({ firstName: "\u0141ukasz", lastName: "O\u2019Brien" }),
    ).toMatchObject({ ok: true, value: { firstName: "Lukasz", lastName: "O'Brien" } });
  });

  it("asks for a name, not empty quotes, when nothing is left once folded", () => {
    for (const firstName of [", PT", "...", "\u0301"]) {
      const result = validateNpiRegistrySearch({ firstName, lastName: "Doe" });
      expect(result).toEqual({
        ok: false,
        error: "Enter a first and last name to search the NPI Registry",
      });
    }
  });

  it("keeps a period inside a name in the registry query", () => {
    expect(validateNpiRegistrySearch({ firstName: "Ana", lastName: "St. John" })).toMatchObject({
      ok: true,
      value: { lastName: "St. John" },
    });
  });

  it("422s a name with letters the registry cannot take, naming the character", () => {
    const chinese = validateNpiRegistrySearch({ firstName: "Wei", lastName: "\u674e" });
    expect(chinese.ok).toBe(false);
    expect(!chinese.ok && chinese.error).toContain('"\u674e" can\'t be searched');
    const cyrillic = validateNpiRegistrySearch({
      firstName: "\u0418\u0432\u0430\u043d",
      lastName: "Doe",
    });
    expect(cyrillic.ok).toBe(false);
    const mixed = validateNpiRegistrySearch({ firstName: "Ana", lastName: "Do\u00a7e" });
    expect(!mixed.ok && mixed.error).toContain('"\u00a7"');
  });

  it("rejects a state that is not a US code", () => {
    expect(validateNpiRegistrySearch({ firstName: "A", lastName: "B", state: "XX" }).ok).toBe(
      false,
    );
    expect(validateNpiRegistrySearch({ firstName: "A", lastName: "B", state: 7 }).ok).toBe(false);
    expect(validateNpiRegistrySearch({ firstName: "A", lastName: "B", state: "" })).toMatchObject({
      ok: true,
      value: { state: null },
    });
  });
});

describe("validateNpiRegistryLookup", () => {
  it("accepts a check-digit-valid NPI, dashes and spaces allowed", () => {
    expect(validateNpiRegistryLookup({ npi: "1234567893" })).toEqual({
      ok: true,
      value: "1234567893",
    });
    expect(validateNpiRegistryLookup({ npi: "123-456-7893" })).toEqual({
      ok: true,
      value: "1234567893",
    });
  });

  it("never sends a number that fails the check digit or the shape", () => {
    for (const npi of ["1234567890", "12345", "12345678x3", 1234567893, null]) {
      expect(validateNpiRegistryLookup({ npi }).ok).toBe(false);
    }
    expect(validateNpiRegistryLookup(null).ok).toBe(false);
  });
});

describe("foldNameForRegistry", () => {
  it("removes accents the registry does not store", () => {
    expect(foldNameForRegistry("José Núñez")).toBe("Jose Nunez");
  });

  it("transliterates letters NFD cannot split", () => {
    const cases: Array<[string, string]> = [
      ["\u0141ukasz", "Lukasz"],
      ["S\u00f8ren", "Soren"],
      ["Strau\u00df", "Strauss"],
      ["\u00c6sa", "AEsa"],
      ["\u0110or\u0111e", "Dorde"],
      ["\u00deora", "THora"],
      ["Ca\u011fr\u0131", "Cagri"],
    ];
    for (const [typed, folded] of cases) expect(foldNameForRegistry(typed)).toBe(folded);
  });

  it("straightens curly apostrophes and drops trailing suffixes", () => {
    expect(foldNameForRegistry("O\u2019Brien")).toBe("O'Brien");
    expect(foldNameForRegistry("Smith, Jr.")).toBe("Smith");
    expect(foldNameForRegistry("Smith Jr.")).toBe("Smith");
    expect(foldNameForRegistry("King III")).toBe("King");
    expect(foldNameForRegistry("Lee MD")).toBe("Lee");
    expect(foldNameForRegistry("Lee M.D.")).toBe("Lee");
    // Never the only word.
    expect(foldNameForRegistry("Jr")).toBe("Jr");
  });

  it("drops only a period after a lone letter and periods ending the name", () => {
    expect(foldNameForRegistry("J.")).toBe("J");
    expect(foldNameForRegistry("J.R.")).toBe("JR");
    expect(foldNameForRegistry("Mary J. Blige")).toBe("Mary J Blige");
    // A period inside a longer word stays: NPPES is asked for "St. John".
    expect(foldNameForRegistry("St. John")).toBe("St. John");
    expect(foldNameForRegistry("St. John.")).toBe("St. John");
  });

  it("drops a credential typed after a comma but keeps a real surname", () => {
    for (const typed of ["Doe, PT", "Doe, OT", "Doe, PTA", "Doe, DO", "Doe , DPT, MBA"]) {
      expect(foldNameForRegistry(typed)).toBe("Doe");
    }
    expect(foldNameForRegistry("Do")).toBe("Do");
    expect(foldNameForRegistry("Van Do")).toBe("Van Do");
    expect(foldNameForRegistry("Pa")).toBe("Pa");
  });

  it("unfolds ligatures and compatibility forms (NFKD)", () => {
    expect(foldNameForRegistry("\ufb01ona")).toBe("fiona");
    expect(foldNameForRegistry("King \u2161")).toBe("King");
    expect(foldNameForRegistry("\uff2a\uff41\uff4e\uff45")).toBe("Jane");
  });
});

describe("compareNpiRegistryName", () => {
  it("matches ignoring case, accents, spaces and punctuation", () => {
    expect(compareNpiRegistryName({ firstName: "jane", lastName: "Doe" }, jane)).toBe("match");
    const obrien = { ...jane, firstName: "SEAN", lastName: "OBRIEN" };
    expect(compareNpiRegistryName({ firstName: "Seán", lastName: "O'Brien" }, obrien)).toBe(
      "match",
    );
  });

  it("accepts an initial or short form of the first name", () => {
    const chris = { ...jane, firstName: "CHRISTOPHER" };
    expect(compareNpiRegistryName({ firstName: "Chris", lastName: "Doe" }, chris)).toBe("match");
    expect(compareNpiRegistryName({ firstName: "C", lastName: "Doe" }, chris)).toBe("match");
  });

  it("never matches a longer typed first name through a registry middle name", () => {
    const cases: Array<[string, string, string]> = [
      ["Danielle", "DANIEL", "LEE"],
      ["Paula", "PAUL", "A"],
      ["Paula", "PAUL", "ANTHONY"],
      ["Roberta", "ROBERT", "ALAN"],
      ["Erica", "ERIC", "ALLEN"],
      ["Michaela", "MICHAEL", "A"],
      ["Justine", "JUSTIN", "EDWARD"],
      ["Louise", "LOUIS", "E"],
    ];
    for (const [typedFirst, registryFirst, registryMiddle] of cases) {
      const record = { ...jane, firstName: registryFirst, middleName: registryMiddle };
      expect(
        compareNpiRegistryName({ firstName: typedFirst, lastName: "Doe" }, record),
        `${typedFirst} vs ${registryFirst} ${registryMiddle}`,
      ).toBe("mismatch");
    }
  });

  it("matches a typed first + middle name word by word", () => {
    const maryAnn = { ...jane, firstName: "MARY", middleName: "ANN" };
    for (const firstName of ["Mary Ann", "Mary-Ann", "Mary A", "Mary"]) {
      expect(compareNpiRegistryName({ firstName, lastName: "Doe" }, maryAnn), firstName).toBe(
        "match",
      );
    }
    const janeAlice = { ...jane, firstName: "JANE", middleName: "ALICE" };
    expect(compareNpiRegistryName({ firstName: "Jane A", lastName: "Doe" }, janeAlice)).toBe(
      "match",
    );
    // One word written together is a soft mismatch against first + middle.
    expect(compareNpiRegistryName({ firstName: "Maryann", lastName: "Doe" }, maryAnn)).toBe(
      "mismatch",
    );
    // The first word must be the registry first name, not just start it.
    expect(compareNpiRegistryName({ firstName: "Mar Ann", lastName: "Doe" }, maryAnn)).toBe(
      "mismatch",
    );
    // A registry first name holding both words still matches, and one word
    // never reaches into its second word ("Danielle" vs "DANIEL LEE").
    const twoWordFirst = { ...jane, firstName: "MARY ANN", middleName: null };
    expect(compareNpiRegistryName({ firstName: "Mary Ann", lastName: "Doe" }, twoWordFirst)).toBe(
      "match",
    );
    const danielLee = { ...jane, firstName: "DANIEL LEE", middleName: null };
    expect(compareNpiRegistryName({ firstName: "Danielle", lastName: "Doe" }, danielLee)).toBe(
      "mismatch",
    );
  });

  it("matches a last name with a credential typed after a comma", () => {
    for (const lastName of ["Doe, PT", "Doe, OT", "Doe, PTA", "Doe, DO"]) {
      expect(compareNpiRegistryName({ firstName: "Jane", lastName }, jane), lastName).toBe("match");
    }
    const minhDo = { ...jane, firstName: "MINH", lastName: "DO" };
    expect(compareNpiRegistryName({ firstName: "Minh", lastName: "Do" }, minhDo)).toBe("match");
  });

  it("never matches a longer typed first name against a shorter registry one", () => {
    const cases: Array<[string, string]> = [
      ["Danielle", "DANIEL"],
      ["Josephine", "JOSEPH"],
      ["Paula", "PAUL"],
    ];
    for (const [typedFirst, registryFirst] of cases) {
      const record = { ...jane, firstName: registryFirst, middleName: null };
      expect(compareNpiRegistryName({ firstName: typedFirst, lastName: "Doe" }, record)).toBe(
        "mismatch",
      );
    }
  });

  it("matches a registry initial and a first-plus-middle name", () => {
    const initial = { ...jane, firstName: "J", middleName: null };
    expect(compareNpiRegistryName({ firstName: "Jane", lastName: "Doe" }, initial)).toBe("match");
    const maryAnn = { ...jane, firstName: "MARY", middleName: "ANN" };
    expect(compareNpiRegistryName({ firstName: "Mary Ann", lastName: "Doe" }, maryAnn)).toBe(
      "match",
    );
    expect(compareNpiRegistryName({ firstName: "Mary Beth", lastName: "Doe" }, maryAnn)).toBe(
      "mismatch",
    );
  });

  it("folds transliterated letters, suffixes and periods on both sides", () => {
    const lukasz = { ...jane, firstName: "LUKASZ", lastName: "SMITH" };
    expect(
      compareNpiRegistryName({ firstName: "\u0141ukasz", lastName: "Smith Jr." }, lukasz),
    ).toBe("match");
    expect(compareNpiRegistryName({ firstName: "J.", lastName: "Doe" }, jane)).toBe("match");
  });

  it("matches a former name the registry lists", () => {
    expect(compareNpiRegistryName({ firstName: "Jane", lastName: "Smith" }, jane)).toBe("match");
  });

  it("flags a different last name or first name", () => {
    expect(compareNpiRegistryName({ firstName: "Jane", lastName: "Roe" }, jane)).toBe("mismatch");
    expect(compareNpiRegistryName({ firstName: "Mary", lastName: "Doe" }, jane)).toBe("mismatch");
  });

  it("does not compare until both names are typed", () => {
    expect(compareNpiRegistryName({ firstName: "", lastName: "Doe" }, jane)).toBe("unchecked");
    expect(compareNpiRegistryName({ firstName: "Jane", lastName: " " }, jane)).toBe("unchecked");
  });
});

describe("npiVerificationView", () => {
  const typed = { firstName: "Jane", lastName: "Doe" };

  it("says nothing until there is a checkable NPI", () => {
    expect(npiVerificationView({ status: "idle" }, typed)).toBeNull();
    expect(npiVerificationView({ status: "loading" }, typed)?.tone).toBe("neutral");
  });

  it("confirms a match with the registry summary", () => {
    expect(npiVerificationView({ status: "done", record: jane }, typed)).toEqual({
      tone: "ok",
      title: "Found in the NPI Registry",
      detail: "JANE A DOE, PT, DPT · Physical Therapist · DENVER, CO",
    });
    expect(registrySummary({ ...jane, credential: null, practiceCity: null })).toBe(
      "JANE A DOE · Physical Therapist · CO",
    );
  });

  it("warns on a name mismatch, a miss, an organization or downtime", () => {
    const mismatch = npiVerificationView(
      { status: "done", record: jane },
      { firstName: "Mary", lastName: "Roe" },
    );
    expect(mismatch).toMatchObject({
      tone: "warn",
      title: "Found in the NPI Registry, but the name differs",
    });
    expect(mismatch?.detail).toContain("JANE A DOE");

    const missing = npiVerificationView({ status: "done", record: null }, typed);
    expect(missing).toEqual({
      tone: "warn",
      title: "Not found in the NPI Registry",
      detail: "Re-check the number; deactivated NPIs are not listed.",
    });

    const org = npiVerificationView(
      {
        status: "done",
        record: {
          ...jane,
          enumerationType: "NPI-2",
          organizationName: "DENVER REHAB LLC",
          firstName: null,
          middleName: null,
          lastName: null,
        },
      },
      typed,
    );
    expect(org).toMatchObject({ tone: "warn", title: "This NPI belongs to an organization" });
    expect(org?.detail).toContain("DENVER REHAB LLC");

    const down = npiVerificationView(
      { status: "error", message: NPI_REGISTRY_UNAVAILABLE_MESSAGE },
      typed,
    );
    expect(down).toEqual({ tone: "warn", title: "NPI Registry is unavailable", detail: null });

    const inactive = npiVerificationView(
      { status: "done", record: { ...jane, status: "inactive" } },
      typed,
    );
    expect(inactive?.title).toBe("The NPI Registry lists this NPI as inactive");
  });

  it("reports a found NPI as found while the form names are still blank", () => {
    expect(
      npiVerificationView({ status: "done", record: jane }, { firstName: "", lastName: "" }),
    ).toMatchObject({ tone: "ok", title: "Found in the NPI Registry" });
  });
});

describe("the NPI Registry policy's display setting", () => {
  const typed = { firstName: "Jane", lastName: "Doe" };
  const organization: NpiRegistryRecord = {
    ...jane,
    enumerationType: "NPI-2",
    organizationName: "DENVER REHAB LLC",
    firstName: null,
    middleName: null,
    lastName: null,
  };
  // Each outcome with the lookup state and typed name that produce it.
  const answers: Record<NpiRegistryOutcome, [NpiLookupState, typeof typed]> = {
    organizationNumber: [{ status: "done", record: organization }, typed],
    notFound: [{ status: "done", record: null }, typed],
    nameMismatch: [
      { status: "done", record: jane },
      { firstName: "Mary", lastName: "Roe" },
    ],
    inactive: [{ status: "done", record: { ...jane, status: "inactive" } }, typed],
  };
  const backendOnly = (outcome: NpiRegistryOutcome) =>
    resolveNpiRegistryPolicy(null, { display: { [outcome]: "backend_only" } });

  it("names the outcome a policy acts on", () => {
    for (const outcome of NPI_REGISTRY_OUTCOMES) {
      const [state, names] = answers[outcome];
      expect(npiLookupOutcome(state, names)).toBe(outcome);
    }
    expect(npiLookupOutcome({ status: "done", record: jane }, typed)).toBeNull();
    expect(npiLookupOutcome({ status: "idle" }, typed)).toBeNull();
    expect(npiLookupOutcome({ status: "loading" }, typed)).toBeNull();
    expect(npiLookupOutcome({ status: "error", message: "x" }, typed)).toBeNull();
  });

  it.each(NPI_REGISTRY_OUTCOMES)(
    "%s: a warning by default; backend_only keeps it off the form, and never says ok",
    (outcome) => {
      const [state, names] = answers[outcome];
      expect(npiVerificationView(state, names, DEFAULT_NPI_REGISTRY_POLICY)?.tone).toBe("warn");
      expect(npiVerificationView(state, names, backendOnly(outcome))).toBeNull();
      // Another outcome's setting leaves this one a warning.
      const other = NPI_REGISTRY_OUTCOMES.find((candidate) => candidate !== outcome) ?? outcome;
      expect(npiVerificationView(state, names, backendOnly(other))?.tone).toBe("warn");
    },
  );

  it("still warns when the registry could not answer, whatever the policy", () => {
    const quiet = resolveNpiRegistryPolicy(null, {
      display: {
        organizationNumber: "backend_only",
        notFound: "backend_only",
        nameMismatch: "backend_only",
        inactive: "backend_only",
      },
    });
    for (const message of [
      NPI_REGISTRY_UNAVAILABLE_MESSAGE,
      NPI_REGISTRY_RATE_LIMIT_MESSAGE,
      NPI_REGISTRY_QUERY_REJECTED_MESSAGE,
    ]) {
      expect(npiVerificationView({ status: "error", message }, typed, quiet)?.tone).toBe("warn");
    }
  });

  it("has no save block left to consult (A30)", () => {
    const exports = npiRegistry as Record<string, unknown>;
    expect(exports.npiRegistrySaveBlock).toBeUndefined();
    expect(exports.NPI_REGISTRY_BLOCK_REASONS).toBeUndefined();
    expect(exports.NPI_REGISTRY_CHECK_PENDING_MESSAGE).toBeUndefined();
  });

  it("reads a lookup query as a state, and checks only a check-digit-valid NPI on request", () => {
    expect(npiToCheck("1234567893", true)).toBe("1234567893");
    expect(npiToCheck("1234567893", false)).toBeNull();
    expect(npiToCheck("1234567890", true)).toBeNull();
    expect(npiLookupStateOf(null, { isError: false, error: null })).toEqual({ status: "idle" });
    expect(npiLookupStateOf("1234567893", { isError: false, error: null })).toEqual({
      status: "loading",
    });
    expect(
      npiLookupStateOf("1234567893", { isError: false, error: null, data: { record: null } }),
    ).toEqual({ status: "done", record: null });
    expect(
      npiLookupStateOf("1234567893", {
        isError: true,
        error: new Error("Invalid or expired token"),
      }),
    ).toEqual({ status: "error", message: NPI_REGISTRY_UNAVAILABLE_MESSAGE });
  });

  it("reads a disabled or paused lookup as not checked", () => {
    // No active organization (the query is disabled) or offline (paused):
    // no answer is coming, so the check is idle, not loading forever.
    for (const fetchStatus of ["idle", "paused"] as const) {
      const state = npiLookupStateOf("1234567893", { isError: false, error: null, fetchStatus });
      expect(state).toEqual({ status: "idle" });
      expect(npiVerificationView(state, typed)).toBeNull();
    }
    expect(
      npiLookupStateOf("1234567893", { isError: false, error: null, fetchStatus: "fetching" }),
    ).toEqual({ status: "loading" });
  });
});

describe("compareNpiRegistryName with other names", () => {
  it("counts a former name's middle name", () => {
    const record: NpiRegistryRecord = {
      ...jane,
      otherNames: [{ firstName: "JANE", middleName: "QUINN", lastName: "SMITH", type: "Former" }],
    };
    expect(compareNpiRegistryName({ firstName: "Jane Q", lastName: "Smith" }, record)).toBe(
      "match",
    );
    expect(compareNpiRegistryName({ firstName: "Jane R", lastName: "Smith" }, record)).toBe(
      "mismatch",
    );
  });
});
