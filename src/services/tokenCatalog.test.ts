import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { rpc: rpcMock },
}));

import { listTokenCatalog } from "./tokenCatalog";

describe("listTokenCatalog", () => {
  beforeEach(() => rpcMock.mockReset().mockResolvedValue({ data: [], error: null }));

  it("includes only the canonical computed, user, and current contact keys once", async () => {
    const catalog = await listTokenCatalog();
    const tokens = catalog.map((entry) => entry.token);

    expect(tokens).toEqual(
      expect.arrayContaining([
        "provider.fullName",
        "provider.fullNameWithCredentials",
        "provider.lastFirst",
        "facility.address",
        "facility.streetAddress",
        "facility.fullAddress",
        "facility.cityStateZip",
        "group.billingCityStateZip",
        "group.billingFullName",
        "facility.hoursMonStatus",
        "facility.hoursSunClose",
        "group.payerIssuedId",
        "user.name",
        "user.fullName",
        "user.firstName",
        "user.lastName",
        "user.title",
        "user.email",
        "billingContact.fullName",
        "billingContact.cityStateZip",
        "credentialingContact.phoneOffice",
        "contractingSigner.email",
        "system.today",
      ]),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  // DYN-TODAY-01 — the one entry marked device-resolved. The picker groups it
  // under "System"; the registry row says it fills with today's date at fill.
  it("marks system.today as device-resolved and nothing else", async () => {
    const catalog = await listTokenCatalog();
    const device = catalog.filter((entry) => entry.resolution === "device");
    expect(device).toEqual([
      { token: "system.today", table: "system", column: "today", resolution: "device" },
    ]);
  });

  it("preserves schema-derived entries and includes the case-bound group PTAN token", async () => {
    rpcMock.mockResolvedValue({
      data: [{ token: "group.tin", table: "provider_groups", column: "tin" }],
      error: null,
    });
    const catalog = await listTokenCatalog();
    expect(catalog).toContainEqual({ token: "group.tin", table: "provider_groups", column: "tin" });
    expect(catalog).toContainEqual({
      token: "group.payerIssuedId",
      table: "payer_network_targets",
      column: "payer_issued_id",
    });
    expect(catalog.some((entry) => entry.token === "group.billingContactName")).toBe(false);
    expect(catalog.some((entry) => entry.token === "group.ptan")).toBe(false);
  });
});
