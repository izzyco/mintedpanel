import { describe, expect, it } from "vitest";
import type { Portal } from "@/types";
import {
  checkPortalBindingEligibility,
  eligiblePortalsForPicker,
} from "./portalBinding";

function portal(overrides: Partial<Portal>): Portal {
  return {
    id: overrides.id ?? "portal-1",
    orgId: "orgId" in overrides ? (overrides.orgId ?? null) : null,
    portalKey: overrides.portalKey ?? "test_portal",
    name: overrides.name ?? "Test Portal",
    payerId: "payerId" in overrides ? (overrides.payerId ?? null) : "payer-1",
    caseType: overrides.caseType ?? "enrollment",
    formUrl: "https://example.com/form",
    isVerified: true,
    lastVerifiedAt: null,
    urlChangedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("checkPortalBindingEligibility", () => {
  it("treats empty or null portal keys as eligible (unbound)", () => {
    expect(
      checkPortalBindingEligibility({
        portalKey: null,
        portals: [],
        templatePayerId: "payer-1",
        templateCaseType: "enrollment",
      }),
    ).toEqual({ isEligible: true });

    expect(
      checkPortalBindingEligibility({
        portalKey: "   ",
        portals: [],
        templatePayerId: "payer-1",
        templateCaseType: "enrollment",
      }),
    ).toEqual({ isEligible: true });
  });

  it("rejects unknown or unregistered portal keys", () => {
    const res = checkPortalBindingEligibility({
      portalKey: "unknown_portal",
      portals: [],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("is not registered or is hidden");
  });

  it("rejects hidden portals", () => {
    const p = portal({ portalKey: "retired_portal", name: "[hidden] Retired Portal" });
    const res = checkPortalBindingEligibility({
      portalKey: "retired_portal",
      portals: [p],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("is not registered or is hidden");
  });

  it("rejects org-only portals when authoring a global template", () => {
    const orgPortal = portal({
      portalKey: "trinity_portal",
      orgId: "org-1",
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "trinity_portal",
      portals: [orgPortal],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("belongs to a specific organization and cannot be bound to a global template");
  });

  it("rejects global portals with no assigned payer", () => {
    const globalPayerless = portal({
      portalKey: "generic_portal",
      orgId: null,
      payerId: null,
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "generic_portal",
      portals: [globalPayerless],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("no assigned payer");
  });

  it("rejects portals configured for a different payer", () => {
    const p = portal({
      portalKey: "aetna_portal",
      orgId: null,
      payerId: "payer-aetna",
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "aetna_portal",
      portals: [p],
      templatePayerId: "payer-cigna",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("belongs to a different payer");
  });

  it("rejects portals configured for a different case type", () => {
    const p = portal({
      portalKey: "enrollment_portal",
      orgId: null,
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "enrollment_portal",
      portals: [p],
      templatePayerId: "payer-1",
      templateCaseType: "contract",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("configured for “enrollment” cases, but this template is for “contract”");
  });

  it("rejects ambiguous global portal keys", () => {
    const p1 = portal({ id: "1", portalKey: "dup_portal", orgId: null });
    const p2 = portal({ id: "2", portalKey: "dup_portal", orgId: null });
    const res = checkPortalBindingEligibility({
      portalKey: "dup_portal",
      portals: [p1, p2],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(false);
    expect(res.reason).toContain("multiple visible global configurations");
  });

  it("accepts a fully compatible global portal for a global template", () => {
    const p = portal({
      portalKey: "bcbs_enrollment",
      orgId: null,
      payerId: "payer-bcbs",
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "bcbs_enrollment",
      portals: [p],
      templatePayerId: "payer-bcbs",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });
    expect(res.isEligible).toBe(true);
    expect(res.selectedPortal?.id).toBe(p.id);
  });

  it("prioritizes an own-org portal over a global portal when authoring an org template", () => {
    const globalP = portal({
      id: "global-1",
      portalKey: "shared_key",
      orgId: null,
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const orgP = portal({
      id: "org-1",
      portalKey: "shared_key",
      orgId: "my-org",
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const res = checkPortalBindingEligibility({
      portalKey: "shared_key",
      portals: [globalP, orgP],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
      templateOrgId: "my-org",
      isGlobalAuthoring: false,
    });
    expect(res.isEligible).toBe(true);
    expect(res.selectedPortal?.id).toBe("org-1");
  });
});

describe("eligiblePortalsForPicker", () => {
  it("filters out incompatible case types, payers, hidden portals, and org portals for global templates", () => {
    const validGlobal = portal({
      id: "valid",
      portalKey: "valid_key",
      orgId: null,
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const wrongPayer = portal({
      id: "wrong-payer",
      portalKey: "wrong_payer",
      orgId: null,
      payerId: "payer-2",
      caseType: "enrollment",
    });
    const wrongCase = portal({
      id: "wrong-case",
      portalKey: "wrong_case",
      orgId: null,
      payerId: "payer-1",
      caseType: "contract",
    });
    const orgScoped = portal({
      id: "org-scoped",
      portalKey: "org_key",
      orgId: "org-1",
      payerId: "payer-1",
      caseType: "enrollment",
    });
    const hidden = portal({
      id: "hidden",
      name: "[hidden] Hidden",
      portalKey: "hidden_key",
      orgId: null,
      payerId: "payer-1",
      caseType: "enrollment",
    });

    const result = eligiblePortalsForPicker({
      portals: [validGlobal, wrongPayer, wrongCase, orgScoped, hidden],
      templatePayerId: "payer-1",
      templateCaseType: "enrollment",
      isGlobalAuthoring: true,
    });

    expect(result.map((p) => p.id)).toEqual(["valid"]);
  });
});
