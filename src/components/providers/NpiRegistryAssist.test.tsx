// MINT-110 — the registry help under an NPI field: what it checks, what it
// says (a warning, or nothing when the policy keeps an answer backend only —
// never an error: no answer blocks a save, A30), that the result list is
// announced and keyboard-reachable, the summary a pick leaves (with its "Add
// license row" offers and taxonomy choices, A35), the record page's quiet
// note, and Add Provider's Credentials step. The hooks are mocked (the check
// composes the real pure rules over a mocked lookup); the route and the
// registry are not reached.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NpiRegistryRecord, NpiRegistrySearchResult } from "@/lib/npiRegistry";

const lookupResult = vi.hoisted(() => ({
  current: {} as {
    data?: { record: unknown };
    isError?: boolean;
    error?: unknown;
  },
}));
const policyInForce = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/hooks/useNpiRegistry", async () => {
  const policy = await import("@/lib/npiRegistryPolicy");
  const rules = await import("@/lib/npiRegistry");
  const useNpiRegistryLookup = vi.fn((npi: string | null) => {
    void npi;
    return lookupResult.current;
  });
  return {
    useNpiRegistryLookup,
    // The real composition, over the mocked lookup.
    useNpiRegistryCheck: (
      npi: string,
      verify: boolean,
      typed: { firstName: string; lastName: string },
      inForce: import("@/lib/npiRegistryPolicy").NpiRegistryPolicy,
    ) => {
      const checkable = rules.npiToCheck(npi, verify);
      const lookup = useNpiRegistryLookup(checkable) as Partial<
        Parameters<typeof rules.npiLookupStateOf>[1]
      >;
      const state = rules.npiLookupStateOf(checkable, {
        isError: lookup.isError ?? false,
        error: lookup.error ?? null,
        data: lookup.data,
      });
      return {
        checkable,
        state,
        view: rules.npiVerificationView(state, typed, inForce),
        retry: () => undefined,
      };
    },
    useNpiRegistrySearch: vi.fn(() => ({})),
    usePrimeNpiRegistryLookup: vi.fn(() => () => undefined),
    useNpiRegistryPolicy: () => policyInForce.current ?? policy.DEFAULT_NPI_REGISTRY_POLICY,
  };
});
vi.mock("@/hooks/useLookups", () => ({
  useFacilities: () => ({ data: [] }),
  useProviderGroups: () => ({ data: [] }),
}));

import { useNpiRegistryLookup } from "@/hooks/useNpiRegistry";
import { CredentialsSection, LicensesSection, PersonalSection } from "./ProviderFormSections";
import { emptyProviderFormState } from "./providerFormShared";
import {
  NpiRegistryAssist,
  NpiRegistryCheckNote,
  NpiRegistryPickSummary,
  NpiRegistryQuietNote,
  NpiRegistryResultList,
  NpiVerificationNotice,
} from "./NpiRegistryAssist";
import { npiSearchStatusText } from "@/lib/npiRegistry";
import type { NpiFillSummary, NpiPickState } from "@/lib/npiRegistryFill";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  NPI_REGISTRY_OUTCOMES,
  resolveNpiRegistryPolicy,
  type NpiRegistryOutcome,
} from "@/lib/npiRegistryPolicy";

const NO_FILL: NpiFillSummary = {
  filled: [],
  cleared: [],
  kept: [],
  staleRows: [],
  addedRows: [],
  licenseOffers: [],
  details: [],
  taxonomyChoices: [],
  candidates: [],
};
// What the stepper hands the Credentials step.
const NO_PICK = {
  npiPick: null,
  touched: { credentials: false, taxonomyCode: false },
  applyNpi: () => undefined,
  applyCandidate: () => undefined,
  taxonomyPreset: "225100000X",
  registrySource: null,
};
const PULLED = "2026-10-31T15:00:00.000Z";

const jane: NpiRegistryRecord = {
  npi: "1234567893",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  practiceState: "CO",
  status: "active",
  enumerationDate: "2015-03-02",
  otherNames: [],
};

const lookupMock = vi.mocked(useNpiRegistryLookup);

function renderAssist(props: Partial<Parameters<typeof NpiRegistryAssist>[0]> = {}) {
  return renderToStaticMarkup(
    <NpiRegistryAssist
      npi="1234567893"
      firstName="Jane"
      lastName="Doe"
      verify
      pick={null}
      onPick={() => undefined}
      onAddLicense={() => "added"}
      onChooseTaxonomy={() => undefined}
      onUseCandidate={() => undefined}
      noticeId="npi-note"
      policy={DEFAULT_NPI_REGISTRY_POLICY}
      {...props}
    />,
  );
}

beforeEach(() => {
  lookupResult.current = {};
  policyInForce.current = null;
  lookupMock.mockClear();
});

describe("NpiRegistryAssist verification", () => {
  it("checks a check-digit-valid NPI and confirms a match", () => {
    lookupResult.current = { data: { record: jane } };
    const html = renderAssist();
    expect(lookupMock).toHaveBeenCalledWith("1234567893");
    expect(html).toContain("Found in the NPI Registry");
    expect(html).toContain("JANE DOE, PT · Physical Therapist · DENVER, CO");
  });

  it("never asks the registry about a blank, malformed or wrong-check-digit NPI", () => {
    for (const npi of ["", "12345", "1234567890", "12345678x3"]) {
      lookupMock.mockClear();
      renderAssist({ npi });
      expect(lookupMock).toHaveBeenCalledWith(null);
    }
  });

  it("does not re-check an unchanged stored NPI", () => {
    renderAssist({ verify: false });
    expect(lookupMock).toHaveBeenCalledWith(null);
  });

  it("warns on a different name, and when the registry is down", () => {
    lookupResult.current = { data: { record: jane } };
    expect(renderAssist({ firstName: "Mary", lastName: "Roe" })).toContain(
      "Found in the NPI Registry, but the name differs",
    );
    lookupResult.current = { isError: true, error: new Error("NPI Registry is unavailable") };
    const down = renderAssist();
    expect(down).toContain("NPI Registry is unavailable");
    expect(down).toContain("text-[var(--mp-warn-ink)]");
    expect(down).not.toContain("text-destructive");
  });

  it("passes the rate-limit and rejected-query messages through; anything else reads as unavailable", () => {
    lookupResult.current = {
      isError: true,
      error: new Error("Too many NPI Registry lookups — wait a minute and try again"),
    };
    expect(renderAssist()).toContain("Too many NPI Registry lookups");
    lookupResult.current = {
      isError: true,
      error: new Error(
        "The NPI Registry would not run that search — check the name for unusual characters",
      ),
    };
    expect(renderAssist()).toContain("The NPI Registry would not run that search");
    lookupResult.current = { isError: true, error: new Error("Invalid or expired token") };
    const expired = renderAssist();
    expect(expired).not.toContain("Invalid or expired token");
    expect(expired).toContain("NPI Registry is unavailable");
  });

  it("renders the note under the id the NPI input describes itself with", () => {
    const idle = renderToStaticMarkup(<NpiVerificationNotice id="npi-note" view={null} />);
    expect(idle).toBe('<div id="npi-note" class="text-[12px]"></div>');
    lookupResult.current = { data: { record: jane } };
    expect(renderAssist()).toMatch(/<div id="npi-note"[^>]*>.*Found in the NPI Registry/);
  });

  it("keeps a separate mounted polite live region for result changes", () => {
    const html = renderAssist({ npi: "" });
    expect(html).toContain('<p role="status" aria-live="polite" class="sr-only"></p>');
  });
});

describe("NpiRegistryAssist under the NPI Registry policy", () => {
  const unescape = (html: string) => html.replace(/&#x27;/g, "'");
  const backendOnly = (outcome: NpiRegistryOutcome) =>
    resolveNpiRegistryPolicy(null, { display: { [outcome]: "backend_only" } });
  const answers: Record<
    NpiRegistryOutcome,
    { record: NpiRegistryRecord | null; names?: { firstName: string; lastName: string } }
  > = {
    notFound: { record: null },
    organizationNumber: {
      record: { ...jane, enumerationType: "NPI-2", organizationName: "DENVER REHAB LLC" },
    },
    inactive: { record: { ...jane, status: "inactive" } },
    nameMismatch: { record: jane, names: { firstName: "Mary", lastName: "Roe" } },
  };

  it.each(NPI_REGISTRY_OUTCOMES)(
    "%s is a warning by default, says nothing when kept backend only, and is never an error",
    (outcome) => {
      const { record, names } = answers[outcome];
      lookupResult.current = { data: { record } };
      const warned = unescape(renderAssist(names));
      expect(warned).toContain("text-[var(--mp-warn-ink)]");
      expect(warned).not.toContain("text-destructive");

      const quiet = unescape(renderAssist({ ...names, policy: backendOnly(outcome) }));
      expect(quiet).not.toContain("text-[var(--mp-warn-ink)]");
      expect(quiet).not.toContain("text-destructive");
      // Kept off the form is not a pass: nothing says it was found.
      expect(quiet).not.toContain("Found in the NPI Registry<");
      expect(quiet).not.toContain("lucide-circle-check");
    },
  );

  it("still warns about an outage, whatever the policy keeps backend only", () => {
    const quiet = resolveNpiRegistryPolicy(null, {
      display: {
        organizationNumber: "backend_only",
        notFound: "backend_only",
        nameMismatch: "backend_only",
        inactive: "backend_only",
      },
    });
    lookupResult.current = { isError: true, error: new Error("NPI Registry is unavailable") };
    const html = renderAssist({ policy: quiet });
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("NPI Registry is unavailable");
  });

  it("says what a pick fills under each fill mode", () => {
    const done = { status: "done" as const, result: { results: [jane], truncated: false } };
    expect(npiSearchStatusText(done, "blank_fields")).toBe(
      "1 match in the NPI Registry. Pick one to fill the NPI and any blank fields.",
    );
    expect(npiSearchStatusText(done, "npi_only")).toBe(
      "1 match in the NPI Registry. Pick one to fill the NPI.",
    );
  });
});

describe("NpiRegistryAssist search", () => {
  it("disables Search until both names are typed", () => {
    const blank = renderAssist({ firstName: "", lastName: "Doe" });
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*>.*Search NPI Registry/);
    expect(blank).toContain("Enter a first and last name to search the NPI Registry");
    const ready = renderAssist();
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Search NPI Registry/);
  });

  it("shows why a typed name can't be searched, and accepts curly apostrophes and suffixes", () => {
    const html = renderAssist({ firstName: "Wei", lastName: "\u674e" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Search NPI Registry/);
    expect(html).toContain("can&#x27;t be searched");
    for (const lastName of ["O\u2019Brien", "Smith, Jr."]) {
      expect(renderAssist({ lastName })).not.toMatch(
        /<button[^>]*disabled=""[^>]*>.*Search NPI Registry/,
      );
    }
  });

  it("labels the optional state picker", () => {
    expect(renderAssist()).toContain("NPI Registry search state");
  });

  it("announces the result count and when the list was cut short", () => {
    const result = (count: number, truncated = false): NpiRegistrySearchResult => ({
      results: Array.from({ length: count }, () => jane),
      truncated,
    });
    expect(npiSearchStatusText({ status: "idle" })).toBe("");
    expect(npiSearchStatusText({ status: "loading" })).toBe("Searching the NPI Registry…");
    expect(npiSearchStatusText({ status: "done", result: result(0) })).toBe(
      "No individuals in the NPI Registry match that name.",
    );
    expect(npiSearchStatusText({ status: "done", result: result(1) })).toBe(
      "1 match in the NPI Registry. Pick one to fill the NPI and any blank fields.",
    );
    expect(npiSearchStatusText({ status: "done", result: result(10, true) })).toBe(
      "10 matches in the NPI Registry — showing the first 10. Add a state to narrow it.",
    );
    expect(npiSearchStatusText({ status: "error", message: "NPI Registry is unavailable" })).toBe(
      "NPI Registry is unavailable. You can still type the NPI.",
    );
  });

  it("renders each match as a named button in a labelled list", () => {
    const html = renderToStaticMarkup(
      <NpiRegistryResultList results={[jane]} onPick={() => undefined} />,
    );
    expect(html).toContain('<ul aria-label="NPI Registry matches"');
    // The name is the visible text, name first (WCAG 2.5.3), not an aria-label.
    expect(html).not.toMatch(/<button[^>]*aria-label/);
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("JANE DOE, PT NPI 1234567893 Physical Therapist · DENVER, CO, use this NPI");
    expect(html).toContain('type="button"');
    expect(renderToStaticMarkup(<NpiRegistryResultList results={[]} onPick={() => 0} />)).toBe("");
  });
});

describe("NpiRegistryPickSummary", () => {
  const summary: NpiFillSummary = {
    filled: ["NPI", "CO license number"],
    cleared: ["Taxonomy code"],
    kept: [{ field: "Credentials", registryValue: "DPT" }],
    staleRows: ["NM NM-7"],
    addedRows: [],
    licenseOffers: [
      { state: "WY", number: "WY-0099", added: false },
      { state: "MT", number: "MT-12", added: true },
    ],
    details: [
      { label: "Middle name", lines: ["M"] },
      { label: "Other identifiers", lines: ["MEDICAID CO-MCD-77 (CO)", "OTHER 55 (WY)"] },
    ],
    taxonomyChoices: [],
    candidates: [],
  };
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, "|")
      .replace(/\|+/g, "|")
      .replace(/&#x27;/g, "'");

  it("says what was filled, cleared and kept, offers licenses, then lists the rest", () => {
    const html = renderToStaticMarkup(
      <NpiRegistryPickSummary summary={summary} onAddLicense={() => undefined} />,
    );
    expect(text(html)).toBe(
      "|From the NPI Registry" +
        "|Filled from the NPI Registry: NPI, CO license number." +
        "|Cleared from the previous pick: Taxonomy code." +
        "|Kept yours: Credentials — registry has DPT." +
        "|From the previous pick — remove if it doesn't apply: NM NM-7." +
        "|The registry lists 2 licenses that are not on the form. " +
        "|A license row counts toward the provider's states, and NPPES lists no expiration date — add one only if it applies." +
        "|WY WY-0099|Add license row| for WY WY-0099" +
        "|MT MT-12|On the form| for MT MT-12" +
        "|Shown for reference; not saved:" +
        "|Middle name|M|Other identifiers|MEDICAID CO-MCD-77 (CO)|OTHER 55 (WY)|",
    );
    // A labelled region with a description list; never a live region, so the
    // pick is announced once (by the check note), and focus is not moved to it.
    expect(html).toMatch(/^<section aria-labelledby="([^"]+)"[^>]*><p id="\1"/);
    expect(html).toContain("<dl");
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("tabindex");
    // An added offer keeps its focusable button, marked aria-disabled.
    expect(html.match(/<button[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>On the form/);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("says which rows the pick added, after what it filled (A37)", () => {
    const one = renderToStaticMarkup(
      <NpiRegistryPickSummary
        summary={{ ...NO_FILL, filled: ["NPI"], addedRows: ["WY WY-0099"] }}
      />,
    );
    expect(text(one)).toContain(
      "|Filled from the NPI Registry: NPI.|Added a license row from the NPI Registry: WY WY-0099, with no expiration date.|",
    );
    const two = renderToStaticMarkup(
      <NpiRegistryPickSummary summary={{ ...NO_FILL, addedRows: ["CO PT-4471", "WY WY-0099"] }} />,
    );
    expect(text(two)).toContain(
      "Added license rows from the NPI Registry: CO PT-4471, WY WY-0099, with no expiration dates.",
    );
  });

  it("lists offers without buttons when the form cannot add them", () => {
    const html = renderToStaticMarkup(<NpiRegistryPickSummary summary={summary} />);
    expect(html).toContain("WY WY-0099");
    expect(html).not.toContain("<button");
  });

  it("leaves out the cleared, kept, offer and detail parts when there is nothing for them", () => {
    const html = renderToStaticMarkup(<NpiRegistryPickSummary summary={NO_FILL} />);
    expect(html).toContain("Nothing blank to fill from the NPI Registry.");
    expect(html).not.toContain("Kept yours");
    expect(html).not.toContain("Cleared");
    expect(html).not.toContain("license row");
    expect(html).not.toContain("<dl");
  });

  it("is shown from the form's pick while the form holds the picked NPI", () => {
    lookupResult.current = { data: { record: jane } };
    expect(renderAssist()).not.toContain("From the NPI Registry");
    const pick: NpiPickState = {
      seq: 3,
      npi: "1234567893",
      trace: { credentials: null, taxonomyCode: null },
      summary: { ...NO_FILL, filled: ["Credentials"] },
      pulledAt: PULLED,
    };
    const shown = renderAssist({ pick });
    expect(shown).toContain("From the NPI Registry");
    expect(shown).toContain("Filled from the NPI Registry: Credentials.");
    // Mounting with an earlier pick (a step change) says nothing again.
    expect(shown).toContain('<p role="status" aria-live="polite" class="sr-only"></p>');
    expect(renderAssist({ pick, npi: "1902833742" })).not.toContain("From the NPI Registry");
  });
});

describe("NpiRegistryCheckNote", () => {
  it("renders the note and an empty polite region on mount, under the given policy", () => {
    lookupResult.current = { data: { record: null } };
    const note = (policy = DEFAULT_NPI_REGISTRY_POLICY) =>
      renderToStaticMarkup(
        <NpiRegistryCheckNote
          noticeId="identity-npi-registry-note"
          npi="1234567893"
          verify
          firstName="Jane"
          lastName="Doe"
          policy={policy}
        />,
      );
    const html = note();
    expect(html).toMatch(
      /<div id="identity-npi-registry-note"[^>]*>.*text-\[var\(--mp-warn-ink\)\].*Not found in the NPI Registry/,
    );
    expect(html).not.toContain("text-destructive");
    expect(html).toContain('<p role="status" aria-live="polite" class="sr-only"></p>');
    const quiet = note(resolveNpiRegistryPolicy(null, { display: { notFound: "backend_only" } }));
    expect(quiet).not.toContain("Not found");
  });

  it("says nothing for an NPI it is not asked to check", () => {
    const html = renderToStaticMarkup(
      <NpiRegistryCheckNote
        noticeId="n"
        npi="1234567893"
        verify={false}
        firstName="Jane"
        lastName="Doe"
        policy={DEFAULT_NPI_REGISTRY_POLICY}
      />,
    );
    expect(html).toBe(
      '<div id="n" class="text-[12px]"></div><p role="status" aria-live="polite" class="sr-only"></p>',
    );
    expect(lookupMock).toHaveBeenCalledWith(null);
  });
});

describe("Add Provider credentials step", () => {
  it("shows the registry help under the NPI and accepts a pasted dashed NPI", () => {
    const html = renderToStaticMarkup(
      <CredentialsSection
        form={{ ...emptyProviderFormState, firstName: "Jane", lastName: "Doe", npi: "" }}
        errors={{}}
        update={() => undefined}
        npi={NO_PICK}
      />,
    );
    expect(html).toContain("Search NPI Registry");
    // The NPI input names the verification note.
    const describedBy = /<input[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<div id="${describedBy}" class="text-[12px]">`);
    // A 10-character cap would cut "123-456-7893" to "123-456-78" before the
    // dashes are stripped.
    expect(html).not.toContain('maxLength="10"');
    expect(html).toContain('maxLength="20"');
  });

  it("never marks the NPI invalid for a registry answer, and links no error", () => {
    lookupResult.current = { data: { record: null } };
    for (const policy of [
      DEFAULT_NPI_REGISTRY_POLICY,
      resolveNpiRegistryPolicy(null, { display: { notFound: "backend_only" } }),
    ]) {
      policyInForce.current = policy;
      const html = renderToStaticMarkup(
        <CredentialsSection
          form={{
            ...emptyProviderFormState,
            firstName: "Jane",
            lastName: "Doe",
            npi: "1234567893",
          }}
          errors={{}}
          update={() => undefined}
          npi={NO_PICK}
        />,
      );
      const input = /<input[^>]*aria-describedby="([^"]+)"[^>]*>/.exec(html);
      expect(input?.[0]).not.toContain("aria-invalid");
      expect(input?.[1].split(" ")).toHaveLength(1);
      expect(html).not.toContain("text-destructive");
    }
  });

  it('marks credentials and the taxonomy a pick filled "From NPI Registry, <date>" (A35)', () => {
    const marked = renderToStaticMarkup(
      <CredentialsSection
        form={{ ...emptyProviderFormState, credentials: "DPT", taxonomyCode: "2251X0800X" }}
        errors={{}}
        update={() => undefined}
        npi={{
          ...NO_PICK,
          registrySource: {
            label: "From NPI Registry, Oct 31, 2026",
            credentials: false,
            taxonomyCode: true,
            gender: false,
            phone: false,
          },
        }}
      />,
    );
    expect(marked.match(/From NPI Registry, Oct 31, 2026/g)).toHaveLength(1);
    const personal = renderToStaticMarkup(
      <PersonalSection
        form={{ ...emptyProviderFormState, credentials: "DPT" }}
        errors={{}}
        update={() => undefined}
        registrySource={{
          label: "From NPI Registry, Oct 31, 2026",
          credentials: true,
          taxonomyCode: false,
          gender: false,
          phone: false,
        }}
      />,
    );
    expect(personal).toContain("From NPI Registry, Oct 31, 2026");
    // A36: a Gender and Phone staff took from the registry are marked too.
    const both = renderToStaticMarkup(
      <PersonalSection
        form={{ ...emptyProviderFormState, gender: "female", phone: "303-555-0199" }}
        errors={{}}
        update={() => undefined}
        registrySource={{
          label: "From NPI Registry, Oct 31, 2026",
          credentials: false,
          taxonomyCode: false,
          gender: true,
          phone: true,
        }}
      />,
    );
    expect(both.match(/From NPI Registry, Oct 31, 2026/g)).toHaveLength(2);
    expect(
      renderToStaticMarkup(
        <PersonalSection
          form={{ ...emptyProviderFormState, credentials: "DPT" }}
          errors={{}}
          update={() => undefined}
          registrySource={null}
        />,
      ),
    ).not.toContain("From NPI Registry");
  });

  it("marks a license row a pick filled or added until staff edit it (A35)", () => {
    const row = (touched: boolean) => ({
      state: "CO",
      number: "PT-4471",
      type: "" as const,
      issueDate: "",
      expirationDate: "",
      npiOrigin: { kind: "number" as const, touched, pulledAt: PULLED },
    });
    const licenses = (touched: boolean) =>
      renderToStaticMarkup(
        <LicensesSection
          form={{ ...emptyProviderFormState, licenses: [row(touched)] }}
          errors={{}}
          update={() => undefined}
        />,
      );
    expect(licenses(false)).toContain("From NPI Registry, Oct 31, 2026");
    expect(licenses(true)).not.toContain("From NPI Registry");
  });
});

describe("Field puts the error on the control itself", () => {
  it("names the error from the Taxonomy code trigger, not the Select root", () => {
    const html = renderToStaticMarkup(
      <CredentialsSection
        form={{ ...emptyProviderFormState, taxonomyCode: "BOGUS" }}
        errors={{ taxonomyCode: "Select a taxonomy from the list" }}
        update={() => undefined}
        npi={NO_PICK}
      />,
    );
    const trigger = /<button[^>]*aria-label="Taxonomy code"[^>]*>/.exec(html)?.[0] ?? "";
    expect(trigger).toContain('role="combobox"');
    expect(trigger).toContain('aria-invalid="true"');
    const errorId = /aria-describedby="([^"]+)"/.exec(trigger)?.[1];
    expect(html).toContain(`<p id="${errorId}" class="mt-1 text-xs text-destructive">`);
    // The label points at the trigger.
    const triggerId = /\bid="([^"]+)"/.exec(trigger)?.[1];
    expect(html).toContain(`for="${triggerId}"`);
  });

  it("names the error from the SSN input inside its wrapper", () => {
    const html = renderToStaticMarkup(
      <PersonalSection
        form={{ ...emptyProviderFormState, ssnLast4: "12" }}
        errors={{ ssnLast4: "Enter exactly 4 digits" }}
        update={() => undefined}
        registrySource={null}
      />,
    );
    const input = /<input[^>]*maxLength="4"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('aria-invalid="true"');
    expect(input).toMatch(/aria-describedby="[^"]+-error"/);
    expect(html).not.toMatch(/<div[^>]*aria-invalid/);
    const genderTrigger = /<button[^>]*aria-label="Gender"[^>]*>/.exec(html)?.[0] ?? "";
    // No error on Gender: nothing is marked invalid there.
    expect(genderTrigger).not.toContain("aria-invalid");
  });
});

describe("NpiRegistryPickSummary Gender and Phone candidates (A36)", () => {
  const summary: NpiFillSummary = {
    ...NO_FILL,
    candidates: [
      {
        field: "gender",
        label: "Gender",
        value: "female",
        registryText: "sex: Female",
        inUse: false,
      },
      {
        field: "phone",
        label: "Phone",
        value: "303-555-0199",
        registryText: "practice phone: 303-555-0199",
        inUse: true,
      },
    ],
  };

  it("offers each with one Use button, nothing chosen; a used one stays focusable", () => {
    const html = renderToStaticMarkup(
      <NpiRegistryPickSummary summary={summary} onUseCandidate={() => undefined} />,
    );
    expect(html).toContain("NPI Registry lists sex: Female");
    expect(html).toContain("NPI Registry lists practice phone: 303-555-0199");
    expect(html).toMatch(/<button[^>]*>Use for Gender<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>On the form/);
    expect(html).toContain('<span class="sr-only"> for Phone</span>');
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("lists them without buttons when the form cannot use them", () => {
    const html = renderToStaticMarkup(<NpiRegistryPickSummary summary={summary} />);
    expect(html).toContain("NPI Registry lists sex: Female");
    expect(html).not.toContain("<button");
  });
});

describe("NpiRegistryPickSummary taxonomy choices (A35)", () => {
  const choices: NpiFillSummary = {
    ...NO_FILL,
    taxonomyChoices: [
      { code: "225100000X", description: "Physical Therapist" },
      { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
    ],
  };

  it("lists each candidate with its own button, none chosen", () => {
    const html = renderToStaticMarkup(
      <NpiRegistryPickSummary summary={choices} onChooseTaxonomy={() => undefined} />,
    );
    expect(html).toContain("The registry lists several taxonomies and none as primary.");
    expect(html.match(/Use this taxonomy/g)).toHaveLength(2);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("aria-checked");
    expect(html).toContain("225100000X");
    expect(html).toContain("2251X0800X");
  });

  it("lists them without buttons when the form cannot choose", () => {
    const html = renderToStaticMarkup(<NpiRegistryPickSummary summary={choices} />);
    expect(html).toContain("2251X0800X");
    expect(html).not.toContain("<button");
  });
});

describe("NpiRegistryQuietNote (record page, after a save)", () => {
  const note = () =>
    renderToStaticMarkup(
      <NpiRegistryQuietNote
        npi="1234567893"
        firstName="Jane"
        lastName="Doe"
        policy={DEFAULT_NPI_REGISTRY_POLICY}
      />,
    );

  it("says nothing while the check runs or when the record matches", () => {
    expect(note()).toBe('<div role="status" aria-live="polite"></div>');
    lookupResult.current = { data: { record: jane } };
    expect(note()).toBe('<div role="status" aria-live="polite"></div>');
  });

  it("shows a mismatch as a short warning in the polite region", () => {
    lookupResult.current = { data: { record: null } };
    const html = note();
    expect(html).toMatch(/^<div role="status" aria-live="polite">.*Not found in the NPI Registry/);
    expect(html).not.toContain("text-destructive");
  });
});
