// MINT-110 — useNpiRegistryCheck and recordNpiAdvisoriesAfterSave against a
// real TanStack Query cache. No registry answer blocks or delays a save (A30):
// the check only reports, and after the save the advisories go, facts only,
// to the capture seam — joining a check still running — and a blank NPI is
// recorded as npi.missing (B3). The registry service, the seam and the
// ledger helper are mocked: nothing is fetched or recorded.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const org = vi.hoisted(() => ({ current: "org-1" as string | null }));
vi.mock("@/lib/auth-store", () => ({ useActiveOrgId: () => org.current }));
vi.mock("@/services/npiRegistry", () => ({
  lookupNpiRegistry: vi.fn(() => new Promise(() => undefined)),
  searchNpiRegistry: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/services/advisoryCapture", async (importActual) => ({
  // The real safe logger; the seam itself is mocked.
  ...(await importActual<typeof import("@/services/advisoryCapture")>()),
  recordAdvisories: vi.fn(async () => undefined),
}));
vi.mock("@/services/advisories", () => ({ recordAdvisory: vi.fn(async () => undefined) }));

import { queryKeys } from "@/hooks/queryKeys";
import * as hooks from "./useNpiRegistry";
import {
  recordNpiAdvisoriesAfterSave,
  useNpiRegistryCheck,
  useNpiRegistryPolicy,
  useRecordNpiAdvisoriesAfterSave,
  type NpiAdvisoriesAfterSave,
} from "./useNpiRegistry";
import { buildNpiRegistryReview } from "@/lib/npiRegistryReview";
import type { NpiRegistryLookupResult, NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  resolveNpiRegistryPolicy,
  type NpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";
import { lookupNpiRegistry } from "@/services/npiRegistry";
import { recordAdvisories } from "@/services/advisoryCapture";
import { recordAdvisory } from "@/services/advisories";

const NPI = "1234567893";
const JANE = { firstName: "Jane", lastName: "Doe" };
const quietNotFound = resolveNpiRegistryPolicy(null, { display: { notFound: "backend_only" } });
const jane: NpiRegistryRecord = {
  npi: NPI,
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "DPT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: null,
  practiceState: null,
  status: "active",
  enumerationDate: null,
  otherNames: [],
};

let client: QueryClient;
beforeEach(() => {
  org.current = "org-1";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(lookupNpiRegistry).mockReset();
  vi.mocked(lookupNpiRegistry).mockImplementation(() => new Promise(() => undefined));
  vi.mocked(recordAdvisories).mockClear();
  vi.mocked(recordAdvisory).mockClear();
});

function Probe({
  npi,
  verify,
  policy,
}: {
  npi: string;
  verify: boolean;
  policy: NpiRegistryPolicy;
}) {
  const check = useNpiRegistryCheck(npi, verify, JANE, policy);
  return (
    <output>
      {JSON.stringify({
        checkable: check.checkable,
        status: check.state.status,
        tone: check.view?.tone ?? null,
      })}
    </output>
  );
}

function render(node: ReactNode) {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  const json = /<output>(.*)<\/output>/.exec(html)?.[1] ?? "{}";
  return JSON.parse(json.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")) as {
    checkable: string | null;
    status: string;
    tone: string | null;
  };
}

function cache(record: NpiRegistryLookupResult["record"]) {
  client.setQueryData(queryKeys.npiRegistryLookup("org-1", NPI), { record });
}

describe("useNpiRegistryCheck", () => {
  it("reports a cached answer as a warning, or nothing when the policy keeps it backend only", () => {
    cache(null);
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />)).toEqual({
      checkable: NPI,
      status: "done",
      tone: "warn",
    });
    expect(render(<Probe npi={NPI} verify policy={quietNotFound} />)).toEqual({
      checkable: NPI,
      status: "done",
      tone: null,
    });
  });

  it("says ok only for a record that matches", () => {
    cache(jane);
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />).tone).toBe("ok");
    cache({ ...jane, status: "inactive" });
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />).tone).toBe(
      "warn",
    );
  });

  it("shows a running check as checking, never as found", () => {
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />)).toEqual({
      checkable: NPI,
      status: "loading",
      tone: "neutral",
    });
  });

  it("does not check with no active organization", () => {
    org.current = null;
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />)).toEqual({
      checkable: NPI,
      status: "idle",
      tone: null,
    });
  });

  it("does not check an unchanged NPI or one that fails the check digit", () => {
    cache(null);
    expect(
      render(<Probe npi={NPI} verify={false} policy={DEFAULT_NPI_REGISTRY_POLICY} />),
    ).toMatchObject({ checkable: null, status: "idle" });
    expect(
      render(<Probe npi="1234567890" verify policy={DEFAULT_NPI_REGISTRY_POLICY} />),
    ).toMatchObject({ checkable: null, status: "idle" });
  });

  it("has no save block left (A30)", () => {
    expect((hooks as Record<string, unknown>).useNpiRegistrySaveBlock).toBeUndefined();
  });
});

describe("recordNpiAdvisoriesAfterSave", () => {
  const input = (over: Partial<NpiAdvisoriesAfterSave> = {}): NpiAdvisoriesAfterSave => ({
    recordId: "prov-1",
    npi: NPI,
    verify: true,
    surface: "add_provider",
    typed: JANE,
    entered: { credentials: "PT", taxonomyCode: "225100000X", licenses: [] },
    confirmed: new Set(),
    policy: DEFAULT_NPI_REGISTRY_POLICY,
    ...over,
  });

  it("hands the saved record's advisories to the seam, facts only, with the form's surface", async () => {
    cache(jane);
    const { id } = buildNpiRegistryReview({
      ...input(),
      state: { status: "done", record: jane },
    }).advisories[0];
    await recordNpiAdvisoriesAfterSave(client, "org-1", input({ confirmed: new Set([id]) }));
    expect(recordAdvisories).toHaveBeenCalledTimes(1);
    const [sent, origin] = vi.mocked(recordAdvisories).mock.calls[0];
    expect(origin).toEqual({ surface: "add_provider" });
    expect(sent).toEqual([
      {
        check: "npi_registry.credentials_differ",
        record: { table: "providers", id: "prov-1", field: "credentials" },
        display: "review_step",
        whyItMatters: "The credentials differ from the NPI Registry's for this NPI.",
        context: { confirmed: true },
      },
    ]);
    // No registry value, typed value or name reaches the capture (A35).
    const text = JSON.stringify(sent);
    for (const value of ["DPT", '"PT"', "Jane", "JANE", "DOE", NPI]) {
      expect(text).not.toContain(value);
    }
  });

  it("joins a check still running, and captures once it answers", async () => {
    let answer: (value: NpiRegistryLookupResult) => void = () => undefined;
    vi.mocked(lookupNpiRegistry).mockImplementation(
      () => new Promise<NpiRegistryLookupResult>((resolve) => (answer = resolve)),
    );
    // The form's check started the lookup; the save did not wait for it.
    void client.prefetchQuery({
      queryKey: queryKeys.npiRegistryLookup("org-1", NPI),
      queryFn: () => lookupNpiRegistry(NPI),
    });
    const pending = recordNpiAdvisoriesAfterSave(client, "org-1", input());
    await Promise.resolve();
    expect(recordAdvisories).not.toHaveBeenCalled();
    answer({ record: null });
    await pending;
    expect(lookupNpiRegistry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAdvisories).mock.calls[0][0]).toMatchObject([
      { check: "npi_registry.not_found", record: { id: "prov-1", field: "npi" } },
    ]);
  });

  it("captures a check that could not run as not checked", async () => {
    vi.mocked(lookupNpiRegistry).mockRejectedValue(new Error("NPI Registry is unavailable"));
    await recordNpiAdvisoriesAfterSave(client, "org-1", input());
    expect(vi.mocked(recordAdvisories).mock.calls[0][0]).toMatchObject([
      { check: "npi_registry.not_checked", display: "review_step" },
    ]);
  });

  it("captures a backend-only advisory too, marked as such", async () => {
    cache(null);
    await recordNpiAdvisoriesAfterSave(client, "org-1", input({ policy: quietNotFound }));
    expect(vi.mocked(recordAdvisories).mock.calls[0][0]).toMatchObject([
      { check: "npi_registry.not_found", display: "backend_only" },
    ]);
  });

  it("hands nothing over for a full match, an unchecked save or no organization", async () => {
    cache({ ...jane, credential: "PT" });
    await recordNpiAdvisoriesAfterSave(client, "org-1", input());
    await recordNpiAdvisoriesAfterSave(client, "org-1", input({ verify: false }));
    await recordNpiAdvisoriesAfterSave(client, null, input());
    expect(recordAdvisories).not.toHaveBeenCalled();
    expect(recordAdvisory).not.toHaveBeenCalled();
  });

  it("records a provider saved with no NPI as npi.missing, from the form that saved it (B3)", async () => {
    await recordNpiAdvisoriesAfterSave(client, "org-1", input({ npi: "", surface: "record_edit" }));
    expect(recordAdvisory).toHaveBeenCalledTimes(1);
    expect(recordAdvisory).toHaveBeenCalledWith(
      "npi.missing",
      { table: "providers", id: "prov-1" },
      { surface: "record_edit" },
    );
    // No registry check for a blank NPI, and nothing else handed over.
    expect(lookupNpiRegistry).not.toHaveBeenCalled();
    expect(recordAdvisories).not.toHaveBeenCalled();
  });

  it("does not record npi.missing for an untouched blank NPI or with no organization", async () => {
    await recordNpiAdvisoriesAfterSave(client, "org-1", input({ npi: "", verify: false }));
    await recordNpiAdvisoriesAfterSave(client, null, input({ npi: "" }));
    expect(recordAdvisory).not.toHaveBeenCalled();
  });
});

describe("a capture that fails", () => {
  const input = (): NpiAdvisoriesAfterSave => ({
    recordId: "prov-1",
    npi: NPI,
    verify: true,
    surface: "add_provider",
    typed: JANE,
    entered: { credentials: "PT", taxonomyCode: "225100000X", licenses: [] },
    confirmed: new Set(),
    policy: DEFAULT_NPI_REGISTRY_POLICY,
  });

  it("is logged with the event, the check keys and the SQLSTATE, and no values", async () => {
    cache(jane);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(recordAdvisories).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates "x" DETAIL: (DPT)=(Jane)'), {
        code: "23505",
        details: "Key (credential)=(DPT) already exists.",
      }),
    );
    await expect(recordNpiAdvisoriesAfterSave(client, "org-1", input())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("advisory_capture_failed", {
      event: "advisory_capture_failed",
      checks: ["npi_registry.credentials_differ"],
      sqlstate: "23505",
    });
    const logged = JSON.stringify(warn.mock.calls);
    for (const value of ["DPT", "Jane", "JANE", "duplicate", NPI, "prov-1"]) {
      expect(logged).not.toContain(value);
    }
    warn.mockRestore();
  });

  it("never reaches the form from the fire-and-forget hook", async () => {
    cache(jane);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(recordAdvisories).mockRejectedValueOnce(new Error("boom"));
    let record: ((value: NpiAdvisoriesAfterSave) => void) | null = null;
    function Grab() {
      record = useRecordNpiAdvisoriesAfterSave();
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Grab />
      </QueryClientProvider>,
    );
    expect(() => record?.(input())).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][1]).toEqual({
      event: "advisory_capture_failed",
      checks: ["npi_registry.credentials_differ"],
      sqlstate: null,
    });
    warn.mockRestore();
  });
});

describe("useNpiRegistryPolicy", () => {
  it("is the defaults until overrides are stored", () => {
    let seen: NpiRegistryPolicy | null = null;
    function Read() {
      seen = useNpiRegistryPolicy();
      return null;
    }
    renderToStaticMarkup(<Read />);
    expect(seen).toEqual(DEFAULT_NPI_REGISTRY_POLICY);
  });
});
