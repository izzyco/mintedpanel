// MINT-110 — the registry help under an NPI field: what it checks, what it
// says under each policy severity, that the result list is announced and
// keyboard-reachable, the summary a pick leaves (with its "Add license row"
// offers), and Add Provider's Credentials step under a blocking policy. The
// hooks are mocked (the check composes the real pure rules over a mocked
// lookup); the route and the registry are not reached.
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
        block: rules.npiRegistrySaveBlock(state, typed, inForce),
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
import { CredentialsSection } from "./ProviderFormSections";
import { emptyProviderFormState } from "./providerFormShared";
import {
  NpiRegistryAssist,
  NpiRegistryCheckNote,
  NpiRegistryPickSummary,
  NpiRegistryResultList,
  NpiVerificationNotice,
} from "./NpiRegistryAssist";
import { NPI_REGISTRY_BLOCK_REASONS, npiSearchStatusText } from "@/lib/npiRegistry";
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
  licenseOffers: [],
  details: [],
};

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
      onAddLicense={() => undefined}
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

  it("warns on a different name and says saving still works when the registry is down", () => {
    lookupResult.current = { data: { record: jane } };
    expect(renderAssist({ firstName: "Mary", lastName: "Roe" })).toContain(
      "Found in the NPI Registry, but the name differs",
    );
    lookupResult.current = { isError: true, error: new Error("NPI Registry is unavailable") };
    const down = renderAssist();
    expect(down).toContain("NPI Registry is unavailable");
    expect(down).toContain("You can still save this provider.");
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
  const blocking = (outcome: NpiRegistryOutcome) =>
    resolveNpiRegistryPolicy(null, { severity: { [outcome]: "block" } });
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

  it.each(NPI_REGISTRY_OUTCOMES)("%s warns by default and blocks when set to", (outcome) => {
    const { record, names } = answers[outcome];
    lookupResult.current = { data: { record } };
    const warned = unescape(renderAssist(names));
    expect(warned).toContain("text-[var(--mp-warn-ink)]");
    expect(warned).not.toContain("text-destructive");
    expect(warned).not.toContain(NPI_REGISTRY_BLOCK_REASONS[outcome]);

    const blocked = unescape(renderAssist({ ...names, policy: blocking(outcome) }));
    expect(blocked).toContain("text-destructive");
    expect(blocked).not.toContain("text-[var(--mp-warn-ink)]");
    expect(blocked).toContain(NPI_REGISTRY_BLOCK_REASONS[outcome]);
    expect(blocked).not.toContain("You can still save");
  });

  it("only the outcome set to block blocks", () => {
    lookupResult.current = { data: { record: null } };
    const html = unescape(renderAssist({ policy: blocking("nameMismatch") }));
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("You can still save this provider.");
  });

  it("never blocks on an outage, however strict the policy", () => {
    const strict = resolveNpiRegistryPolicy(null, {
      severity: {
        organizationNumber: "block",
        notFound: "block",
        nameMismatch: "block",
        inactive: "block",
      },
    });
    lookupResult.current = { isError: true, error: new Error("NPI Registry is unavailable") };
    const html = renderAssist({ policy: strict });
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("You can still save this provider.");
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
    licenseOffers: [
      { state: "WY", number: "WY-0099", added: false },
      { state: "MT", number: "MT-12", added: true },
    ],
    details: [
      { label: "Middle name", lines: ["M"] },
      { label: "Other identifiers", lines: ["MEDICAID CO-MCD-77 (CO)", "OTHER 55 (WY)"] },
    ],
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
        "|Cleared what the previous pick filled: Taxonomy code." +
        "|Kept yours: Credentials — registry has DPT." +
        "|The registry lists 2 licenses for states with no license row. " +
        "|A license row counts toward the provider's states, and NPPES lists no expiration date — add one only if it applies." +
        "|WY WY-0099|Add license row| for WY WY-0099" +
        "|MT MT-12|Added| for MT MT-12" +
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
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Added/);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
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
      trace: { credentials: null, taxonomyCode: null, licenseNumbers: [] },
      summary: { ...NO_FILL, filled: ["Credentials"] },
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
    const html = renderToStaticMarkup(
      <NpiRegistryCheckNote
        noticeId="identity-npi-registry-note"
        npi="1234567893"
        verify
        firstName="Jane"
        lastName="Doe"
        policy={resolveNpiRegistryPolicy(null, { severity: { notFound: "block" } })}
      />,
    );
    expect(html).toMatch(/<div id="identity-npi-registry-note"[^>]*>.*text-destructive/);
    expect(html.replace(/&#x27;/g, "'")).toContain(NPI_REGISTRY_BLOCK_REASONS.notFound);
    expect(html).toContain('<p role="status" aria-live="polite" class="sr-only"></p>');
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

  it("under a blocking policy, shows the note as an error and links the NPI error", () => {
    policyInForce.current = resolveNpiRegistryPolicy(null, { severity: { notFound: "block" } });
    lookupResult.current = { data: { record: null } };
    const html = renderToStaticMarkup(
      <CredentialsSection
        form={{ ...emptyProviderFormState, firstName: "Jane", lastName: "Doe", npi: "1234567893" }}
        errors={{ npi: NPI_REGISTRY_BLOCK_REASONS.notFound }}
        update={() => undefined}
      />,
    ).replace(/&#x27;/g, "'");
    const input = /<input[^>]*aria-describedby="([^"]+)"[^>]*>/.exec(html);
    expect(input?.[0]).toContain('aria-invalid="true"');
    const [noteId, errorId] = (input?.[1] ?? "").split(" ");
    expect(html).toMatch(new RegExp(`<div id="${noteId}"[^>]*>.*text-destructive`));
    expect(html).toContain(`<p id="${errorId}" class="mt-1 text-xs text-destructive">`);
    expect(html).toContain(NPI_REGISTRY_BLOCK_REASONS.notFound);
    expect(html).not.toContain("You can still save");
  });

  it("under the default policy, the same answer is a warning and no error is linked", () => {
    lookupResult.current = { data: { record: null } };
    const html = renderToStaticMarkup(
      <CredentialsSection
        form={{ ...emptyProviderFormState, firstName: "Jane", lastName: "Doe", npi: "1234567893" }}
        errors={{}}
        update={() => undefined}
      />,
    );
    const input = /<input[^>]*aria-describedby="([^"]+)"[^>]*>/.exec(html);
    expect(input?.[0]).not.toContain("aria-invalid");
    expect(input?.[1].split(" ")).toHaveLength(1);
    expect(html).toContain("You can still save this provider.");
  });
});
