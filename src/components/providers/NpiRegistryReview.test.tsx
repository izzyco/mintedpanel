// MINT-110 (A30b, A35) — the NPI Registry part of a review step, rendered:
// "Checking…" in a polite live region (updated in place), each advisory with
// one-click Go to / Use / Check again / Confirm and no reason to type, the
// values a pick filled marked with their pull date, and never "Found" unless
// the record matched. The lookup is mocked; the registry is not reached.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";

const lookupResult = vi.hoisted(() => ({
  current: {} as { data?: { record: unknown }; isError?: boolean; error?: unknown },
}));

vi.mock("@/hooks/useNpiRegistry", async () => {
  const rules = await import("@/lib/npiRegistry");
  return {
    // The real composition, over the mocked lookup.
    useNpiRegistryCheck: (
      npi: string,
      verify: boolean,
      typed: { firstName: string; lastName: string },
      policy: import("@/lib/npiRegistryPolicy").NpiRegistryPolicy,
    ) => {
      const checkable = rules.npiToCheck(npi, verify);
      const lookup = lookupResult.current;
      const state = rules.npiLookupStateOf(checkable, {
        isError: lookup.isError ?? false,
        error: lookup.error ?? null,
        data: lookup.data as never,
      });
      return {
        checkable,
        state,
        view: rules.npiVerificationView(state, typed, policy),
        retry: () => undefined,
      };
    },
  };
});

import { NpiRegistryReview, type NpiRegistryReviewProps } from "./NpiRegistryReview";
import { DEFAULT_NPI_REGISTRY_POLICY, resolveNpiRegistryPolicy } from "@/lib/npiRegistryPolicy";
import { buildNpiRegistryReview } from "@/lib/npiRegistryReview";

const jane: NpiRegistryRecord = {
  npi: "1234567893",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "DPT",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  practiceCity: "BOULDER",
  practiceState: "CO",
  status: "active",
  enumerationDate: null,
  otherNames: [],
};

function render(props: Partial<NpiRegistryReviewProps> = {}) {
  return renderToStaticMarkup(
    <NpiRegistryReview
      npi="1234567893"
      verify
      firstName="Jane"
      lastName="Doe"
      entered={{ credentials: "DPT", taxonomyCode: "2251X0800X", licenses: [] }}
      policy={DEFAULT_NPI_REGISTRY_POLICY}
      confirmed={new Set()}
      onToggleConfirm={() => undefined}
      onFix={() => undefined}
      onUseRegistryValue={() => undefined}
      sourced={[]}
      {...props}
    />,
  ).replace(/&#x27;/g, "'");
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "|")
    .replace(/\|+/g, "|")
    .trim();

beforeEach(() => {
  lookupResult.current = {};
});

describe("NpiRegistryReview", () => {
  it('says "Checking the NPI Registry…" in a polite live region while the check runs', () => {
    const html = render();
    expect(html).toMatch(
      /<div role="status" aria-live="polite">.*Checking the NPI Registry….*<\/div>/,
    );
    expect(html).not.toContain("Found in the NPI Registry");
    expect(html).not.toContain("To review");
  });

  it("says Found, in the same live region, only when the record matches", () => {
    lookupResult.current = { data: { record: jane } };
    const html = render();
    expect(html).toMatch(/<div role="status" aria-live="polite">.*Found in the NPI Registry/);
    expect(html).not.toContain("To review");
  });

  it("lists each mismatch with Go to, Use and Confirm; nothing to type, and saving works", () => {
    lookupResult.current = { data: { record: jane } };
    const html = render({
      entered: { credentials: "PT", taxonomyCode: "2251X0800X", licenses: [] },
    });
    expect(html).toContain('<ul aria-label="To review"');
    expect(text(html)).toContain(
      "|Credentials PT — the registry has DPT|Go to Credentials|Use DPT|Confirm|",
    );
    expect(html).toContain(
      "Fix it, use the registry's value, or confirm it. Saving works either way.",
    );
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Confirm<\/button>/);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).not.toContain("aria-disabled");
    // A mismatch on a found record still says it was found — the NPI is the
    // registry's — and lists the field.
    expect(html).toContain("Found in the NPI Registry");
  });

  it("shows a confirmed advisory as Confirmed, pressed", () => {
    lookupResult.current = { data: { record: null } };
    const { id } = buildNpiRegistryReview({
      npi: "1234567893",
      verify: true,
      state: { status: "done", record: null },
      typed: { firstName: "Jane", lastName: "Doe" },
      entered: { credentials: "DPT", taxonomyCode: "2251X0800X", licenses: [] },
      policy: DEFAULT_NPI_REGISTRY_POLICY,
      confirmed: new Set(),
    }).advisories[0];
    const html = render({ confirmed: new Set([id]) });
    expect(html).toContain("Not found in the NPI Registry");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Confirmed<\/button>/);
    expect(html).not.toContain("Found in the NPI Registry<");
  });

  it("offers each of several registry numbers in one state as its own Use (A35)", () => {
    lookupResult.current = {
      data: {
        record: {
          ...jane,
          taxonomies: [
            {
              code: "2251X0800X",
              description: null,
              primary: true,
              license: "WY-1",
              licenseState: "WY",
            },
            {
              code: "225100000X",
              description: null,
              primary: false,
              license: "WY-2",
              licenseState: "WY",
            },
          ],
        },
      },
    };
    const used: string[] = [];
    const html = render({
      entered: {
        credentials: "DPT",
        taxonomyCode: "2251X0800X",
        licenses: [{ state: "WY", number: "WY-9" }],
      },
      onUseRegistryValue: (_, value) => used.push(value),
    });
    expect(text(html)).toContain(
      "|WY license WY-9 — the registry has WY-1, WY-2|Go to license|Use WY-1|Use WY-2|Confirm|",
    );
  });

  it("says the name is not checked yet, never Found, while a name is blank", () => {
    lookupResult.current = { data: { record: jane } };
    const html = render({ lastName: "" });
    expect(html).toContain("In the NPI Registry; name not checked yet");
    expect(html).not.toContain("Found in the NPI Registry");
    expect(html).not.toContain("lucide-circle-check");
  });

  it("offers Check again when the registry could not be reached", () => {
    lookupResult.current = { isError: true, error: new Error("NPI Registry is unavailable") };
    const html = render();
    expect(text(html)).toContain("|Not checked: NPI Registry is unavailable|Check again|Confirm|");
  });

  it("lists nothing the policy keeps backend only, and never says Found for it", () => {
    lookupResult.current = { data: { record: null } };
    const quiet = resolveNpiRegistryPolicy(null, { display: { notFound: "backend_only" } });
    expect(render({ policy: quiet })).toBe("");
  });

  it('marks the values a pick filled "From NPI Registry, <date>", which submitting confirms', () => {
    lookupResult.current = { data: { record: jane } };
    const html = render({
      sourced: [
        {
          label: "From NPI Registry, Oct 31, 2026",
          values: ["Credentials DPT", "CO license PT-4471"],
        },
      ],
    });
    expect(text(html)).toContain(
      "|From NPI Registry, Oct 31, 2026:| Credentials DPT; CO license PT-4471. |Submitting confirms them.|",
    );
  });

  it("renders nothing for a save that checks no NPI and filled nothing", () => {
    expect(render({ verify: false })).toBe("");
    expect(render({ npi: "" })).toBe("");
  });
});
