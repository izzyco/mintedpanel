// Portal-to-SOP binding eligibility and validation.
//
// Matches the deterministic owner-scope precedence and compatibility guards
// enforced by PostgreSQL's `validate_sop_template_portal_bindings` (migrations
// 20261003120000_mint44_typed_sops and 20261006164500_mint44_org_portal_binding_precedence).
//
// Rules enforced:
// 1. Unhidden: hidden portals (`[hidden] ` prefix) cannot be bound.
// 2. Owner scope:
//    - Global templates (`isGlobalAuthoring` / `templateOrgId == null`) can
//      ONLY bind global portals (`org_id IS NULL`). Org-scoped portals are
//      ineligible.
//    - Org templates (`templateOrgId != null`) prioritize an own-org portal;
//      if none exists, they fall back to a global portal.
// 3. Unambiguous: a key with multiple configurations at the resolved scope
//    is rejected (`sop_portal_binding_ambiguous`).
// 4. Case type: the portal's `case_type` must match the template's `case_type`.
// 5. Payer: the portal's `payer_id` must match the template's `payer_id`.
// 6. Global payer requirement: a global portal MUST have a non-null `payer_id`.
import type { CaseType } from "@/lib/caseTypes";
import { isPortalHiddenFromPickers } from "@/lib/portalRetirement";
import { normalizePortalKey } from "@/lib/tokenFormat";
import type { Portal } from "@/types";

export interface PortalBindingEligibility {
  isEligible: boolean;
  reason?: string;
  selectedPortal?: Portal;
}

export function checkPortalBindingEligibility({
  portalKey,
  portals,
  templatePayerId,
  templateCaseType,
  isGlobalAuthoring,
  templateOrgId,
}: {
  portalKey: string | null | undefined;
  portals: readonly Portal[];
  templatePayerId?: string | null;
  templateCaseType?: CaseType | null;
  isGlobalAuthoring?: boolean;
  templateOrgId?: string | null;
}): PortalBindingEligibility {
  const normalizedKey = normalizePortalKey(portalKey);
  if (!normalizedKey) {
    return { isEligible: true };
  }

  const unhiddenPortals = portals.filter(
    (p) => !isPortalHiddenFromPickers(p) && normalizePortalKey(p.portalKey) === normalizedKey,
  );

  if (unhiddenPortals.length === 0) {
    return {
      isEligible: false,
      reason: `Form configuration “${portalKey}” is not registered or is hidden.`,
    };
  }

  const isGlobal = isGlobalAuthoring ?? (templateOrgId == null);
  let selected: Portal | undefined;

  // 1. Org template resolves own-org configuration first
  if (!isGlobal && templateOrgId) {
    const orgPortals = unhiddenPortals.filter((p) => p.orgId === templateOrgId);
    if (orgPortals.length > 1) {
      return {
        isEligible: false,
        reason: `Form key “${portalKey}” has multiple organization configurations.`,
      };
    }
    if (orgPortals.length === 1) {
      selected = orgPortals[0];
    }
  }

  // 2. Global template, or org template without an own-org row, resolves global configuration
  if (!selected) {
    const globalPortals = unhiddenPortals.filter((p) => p.orgId == null);
    if (globalPortals.length > 1) {
      return {
        isEligible: false,
        reason: `Form key “${portalKey}” has multiple visible global configurations.`,
      };
    }
    if (globalPortals.length === 1) {
      selected = globalPortals[0];
    }
  }

  // 3. If still not selected:
  if (!selected) {
    const orgPortals = unhiddenPortals.filter((p) => p.orgId != null);
    if (isGlobal && orgPortals.length > 0) {
      return {
        isEligible: false,
        reason: `Form configuration “${portalKey}” belongs to a specific organization and cannot be bound to a global template.`,
      };
    }
    return {
      isEligible: false,
      reason: `Form configuration “${portalKey}” is not available for this template scope.`,
    };
  }

  // 4. Case type compatibility
  if (templateCaseType && selected.caseType !== templateCaseType) {
    return {
      isEligible: false,
      reason: `Form configuration “${portalKey}” is configured for ${selected.caseType ? `“${selected.caseType}”` : "untyped"} cases, but this template is for “${templateCaseType}”.`,
      selectedPortal: selected,
    };
  }

  // 5. Global portal must have a payer
  if (selected.orgId == null && !selected.payerId) {
    return {
      isEligible: false,
      reason: `Form configuration “${portalKey}” is a global configuration with no assigned payer.`,
      selectedPortal: selected,
    };
  }

  // 6. Payer compatibility
  if (templatePayerId && selected.payerId !== templatePayerId) {
    return {
      isEligible: false,
      reason: `Form configuration “${portalKey}” belongs to a different payer.`,
      selectedPortal: selected,
    };
  }

  return { isEligible: true, selectedPortal: selected };
}

/**
 * Filter portals to the set of valid, compatible options for the template's
 * current owner scope, case type, and payer.
 */
export function eligiblePortalsForPicker({
  portals,
  templatePayerId,
  templateCaseType,
  isGlobalAuthoring,
  templateOrgId,
}: {
  portals: readonly Portal[];
  templatePayerId?: string | null;
  templateCaseType?: CaseType | null;
  isGlobalAuthoring?: boolean;
  templateOrgId?: string | null;
}): Portal[] {
  const isGlobal = isGlobalAuthoring ?? (templateOrgId == null);

  const keyCounts = new Map<string, number>();
  for (const portal of portals) {
    if (isPortalHiddenFromPickers(portal)) continue;
    const key = normalizePortalKey(portal.portalKey);
    if (!key) continue;
    // Check owner scope
    if (isGlobal && portal.orgId != null) continue;
    if (!isGlobal && templateOrgId && portal.orgId != null && portal.orgId !== templateOrgId) continue;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  return portals.filter((p) => {
    if (isPortalHiddenFromPickers(p)) return false;
    const key = normalizePortalKey(p.portalKey);
    if (!key) return false;
    // Disallow ambiguous visible configurations
    if ((keyCounts.get(key) ?? 0) > 1) return false;

    // Scope check
    if (isGlobal && p.orgId != null) return false;
    if (!isGlobal && templateOrgId && p.orgId != null && p.orgId !== templateOrgId) return false;

    // Global portals must have a payer
    if (p.orgId == null && !p.payerId) return false;

    // Payer and Case Type
    if (templatePayerId && p.payerId !== templatePayerId) return false;
    if (templateCaseType && p.caseType !== templateCaseType) return false;

    return true;
  });
}
