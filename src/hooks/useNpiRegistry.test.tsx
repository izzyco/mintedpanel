// MINT-110 — useNpiRegistrySaveBlock / useNpiRegistryCheck against a real
// TanStack Query cache: the save is refused only for an answer the policy
// blocks, a running check waits only under a blocking policy, and a lookup
// that can never run (no active organization) is not checked, so it never
// refuses a save. The service is mocked: nothing is fetched.
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

import { queryKeys } from "@/hooks/queryKeys";
import {
  useNpiRegistryCheck,
  useNpiRegistryPolicy,
  useNpiRegistrySaveBlock,
} from "./useNpiRegistry";
import {
  NPI_REGISTRY_BLOCK_REASONS,
  NPI_REGISTRY_CHECK_PENDING_MESSAGE,
  type NpiRegistryLookupResult,
} from "@/lib/npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  resolveNpiRegistryPolicy,
  type NpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";
import { lookupNpiRegistry } from "@/services/npiRegistry";

const NPI = "1234567893";
const JANE = { firstName: "Jane", lastName: "Doe" };
const blockNotFound = resolveNpiRegistryPolicy(null, { severity: { notFound: "block" } });

let client: QueryClient;
beforeEach(() => {
  org.current = "org-1";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(lookupNpiRegistry).mockClear();
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
  const block = useNpiRegistrySaveBlock(npi, verify, JANE, policy);
  const check = useNpiRegistryCheck(npi, verify, JANE, policy);
  return (
    <output>
      {JSON.stringify({ block, status: check.state.status, tone: check.view?.tone ?? null })}
    </output>
  );
}

function render(node: ReactNode) {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  const json = /<output>(.*)<\/output>/.exec(html)?.[1] ?? "{}";
  return JSON.parse(json.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")) as {
    block: string | null;
    status: string;
    tone: string | null;
  };
}

function cache(record: NpiRegistryLookupResult["record"]) {
  client.setQueryData(queryKeys.npiRegistryLookup("org-1", NPI), { record });
}

describe("useNpiRegistrySaveBlock", () => {
  it("refuses a cached answer the policy blocks, and only that", () => {
    cache(null);
    expect(render(<Probe npi={NPI} verify policy={blockNotFound} />)).toEqual({
      block: NPI_REGISTRY_BLOCK_REASONS.notFound,
      status: "done",
      tone: "block",
    });
    expect(render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />)).toEqual({
      block: null,
      status: "done",
      tone: "warn",
    });
  });

  it("never refuses a matching record", () => {
    cache({
      npi: NPI,
      enumerationType: "NPI-1",
      firstName: "JANE",
      middleName: null,
      lastName: "DOE",
      organizationName: null,
      credential: null,
      primaryTaxonomy: null,
      practiceCity: null,
      practiceState: null,
      status: "active",
      enumerationDate: null,
      otherNames: [],
    });
    expect(render(<Probe npi={NPI} verify policy={blockNotFound} />).block).toBeNull();
  });

  it("waits for a running check only under a blocking policy", () => {
    expect(render(<Probe npi={NPI} verify policy={blockNotFound} />)).toMatchObject({
      block: NPI_REGISTRY_CHECK_PENDING_MESSAGE,
      status: "loading",
    });
    expect(
      render(<Probe npi={NPI} verify policy={DEFAULT_NPI_REGISTRY_POLICY} />).block,
    ).toBeNull();
  });

  it("does not check, so never refuses, with no active organization", () => {
    org.current = null;
    expect(render(<Probe npi={NPI} verify policy={blockNotFound} />)).toEqual({
      block: null,
      status: "idle",
      tone: null,
    });
  });

  it("does not check an unchanged NPI or one that fails the check digit", () => {
    cache(null);
    expect(render(<Probe npi={NPI} verify={false} policy={blockNotFound} />).block).toBeNull();
    expect(render(<Probe npi="1234567890" verify policy={blockNotFound} />).block).toBeNull();
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
