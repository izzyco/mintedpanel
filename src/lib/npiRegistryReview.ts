// The NPI Registry part of a provider form's review step — MINT-110 (A30,
// A30b). Pure.
//
// A save never waits for the registry: the review step says what the check
// found, or "Checking…" while it runs (updating in place), and lists every
// advisory — a registry answer about the NPI, or a value staff entered that
// differs from the record the registry found — each with a one-click fix
// (jump to the field) or confirm, and no reason to type. The policy decides
// whether each advisory shows on the review step or is kept for Mission
// Control only; all of them go to the capture seam after the save.
//
// Nothing here says an NPI is verified unless the registry's record matched:
// the "ok" line is only for a found, active, individual NPI whose name
// matches.
import type { Advisory } from "@/lib/advisories";
import {
  npiLookupOutcome,
  npiVerificationView,
  registrySummary,
  type NpiLookupState,
} from "@/lib/npiRegistry";
import type { NpiRegistryCheck, NpiRegistryPolicy } from "@/lib/npiRegistryPolicy";
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";

/** A field a fix jumps to. `row` names the license row for "licenseNumber". */
export type NpiReviewFixTarget =
  | { field: "npi" | "firstName" | "credentials" | "taxonomyCode" }
  | { field: "licenseNumber"; row: number };

/** An advisory as the review step lists it. The title, detail and the
 * registry's value are for the form only; toCapturedAdvisory drops them. */
export interface NpiReviewAdvisory extends Advisory {
  /** Stable within one review: the check, plus the license row. */
  id: string;
  /** The policy check behind it, or null for a check that couldn't run. */
  policyCheck: NpiRegistryCheck | null;
  title: string;
  detail: string | null;
  /** Where Fix goes; "retry" asks the registry again; null: confirm only. */
  fix: NpiReviewFixTarget | "retry" | null;
  /** The registry's value staff can choose instead (A35: choose, edit or
   * add), or null when there is none to choose. */
  registryValue: string | null;
}

export interface NpiReviewLine {
  tone: "neutral" | "ok" | "warn";
  title: string;
  detail: string | null;
}

export interface NpiRegistryReview {
  /** What the check says about the NPI; null when it says nothing here (no
   * NPI, not checked on purpose, or an answer kept for Mission Control). */
  line: NpiReviewLine | null;
  /** The check is still running. */
  checking: boolean;
  /** Every advisory, shown on the review step or not. */
  advisories: NpiReviewAdvisory[];
}

export interface NpiReviewInput {
  /** The NPI, separators stripped. */
  npi: string;
  /** False when this save does not check the NPI (an edit that changed
   * neither the NPI nor the name). */
  verify: boolean;
  state: NpiLookupState;
  typed: { firstName: string; lastName: string };
  entered: {
    credentials: string;
    taxonomyCode: string;
    licenses: { state: string; number: string }[];
  };
  policy: NpiRegistryPolicy;
  /** Advisory ids staff confirmed. */
  confirmed: ReadonlySet<string>;
}

// Case, spaces and punctuation ignored.
function looseKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const OUTCOME_CHECK = {
  organizationNumber: "npi_registry.organization_number",
  notFound: "npi_registry.not_found",
  nameMismatch: "npi_registry.name_mismatch",
  inactive: "npi_registry.inactive",
} as const;

const OUTCOME_WHY = {
  organizationNumber:
    "This NPI belongs to an organization; a provider's NPI should be an individual's (Type 1).",
  notFound: "The NPI Registry has no record of this NPI; it may be mistyped or deactivated.",
  nameMismatch:
    "The name differs from the NPI Registry's record for this NPI; the NPI may be someone else's.",
  inactive: "The NPI Registry lists this NPI as inactive; payers may reject it.",
} as const;

/** The registry part of a review step. */
export function buildNpiRegistryReview(input: NpiReviewInput): NpiRegistryReview {
  const { state, policy, confirmed } = input;
  const advisories: NpiReviewAdvisory[] = [];
  const add = (
    advisory: Omit<NpiReviewAdvisory, "display" | "context" | "record"> & {
      field: string;
    },
  ) => {
    const { field, ...rest } = advisory;
    advisories.push({
      ...rest,
      record: { table: "providers", id: null, field },
      display: rest.policyCheck ? policy.display[rest.policyCheck] : "review_step",
      context: { confirmed: confirmed.has(rest.id) },
    });
  };

  if (!input.verify || !input.npi) return { line: null, checking: false, advisories };
  if (state.status === "idle") return { line: null, checking: false, advisories };
  if (state.status === "loading") {
    return {
      line: { tone: "neutral", title: "Checking the NPI Registry…", detail: null },
      checking: true,
      advisories,
    };
  }
  if (state.status === "error") {
    add({
      id: "npi_registry.not_checked",
      check: "npi_registry.not_checked",
      policyCheck: null,
      field: "npi",
      title: `Not checked: ${state.message}`,
      detail: null,
      whyItMatters:
        "The NPI Registry could not be reached, so this NPI was saved without a registry check.",
      fix: "retry",
      registryValue: null,
    });
    return {
      line: { tone: "warn", title: `Not checked: ${state.message}`, detail: null },
      checking: false,
      advisories,
    };
  }

  const record = state.record;
  const outcome = npiLookupOutcome(state, input.typed);
  if (outcome) {
    const view = npiVerificationView(state, input.typed, policy);
    add({
      id: OUTCOME_CHECK[outcome],
      check: OUTCOME_CHECK[outcome],
      policyCheck: outcome,
      field: outcome === "nameMismatch" ? "firstName" : "npi",
      title: view?.title ?? "",
      detail: view?.detail ?? null,
      whyItMatters: OUTCOME_WHY[outcome],
      fix: { field: outcome === "nameMismatch" ? "firstName" : "npi" },
      registryValue: null,
    });
    // An answer kept for Mission Control says nothing here, and never "ok".
    return {
      line: view ? { tone: view.tone, title: view.title, detail: view.detail } : null,
      checking: false,
      advisories,
    };
  }
  if (!record) return { line: null, checking: false, advisories };

  // Found, active, an individual, and the name matches: the one "ok" line.
  // Then what staff entered that differs from this record.
  const { credentials, taxonomyCode, licenses } = input.entered;
  if (
    record.credential &&
    credentials.trim() &&
    looseKey(credentials) !== looseKey(record.credential)
  ) {
    add({
      id: "npi_registry.credentials_differ",
      check: "npi_registry.credentials_differ",
      policyCheck: "credentialsDiffer",
      field: "credentials",
      title: `Credentials ${credentials.trim()} — the registry has ${record.credential}`,
      detail: null,
      whyItMatters: "The credentials differ from the NPI Registry's for this NPI.",
      fix: { field: "credentials" },
      registryValue: record.credential,
    });
  }
  const primary = record.primaryTaxonomy;
  if (
    primary &&
    taxonomyCode.trim() &&
    normalizeTaxonomyCode(taxonomyCode) !== normalizeTaxonomyCode(primary.code)
  ) {
    const registry = primary.description
      ? `${primary.code} (${primary.description})`
      : primary.code;
    add({
      id: "npi_registry.taxonomy_differs",
      check: "npi_registry.taxonomy_differs",
      policyCheck: "taxonomyDiffers",
      field: "taxonomyCode",
      title: `Taxonomy code ${normalizeTaxonomyCode(taxonomyCode)} — the registry has ${registry}`,
      detail: null,
      whyItMatters: "The taxonomy differs from the NPI Registry's primary taxonomy for this NPI.",
      fix: { field: "taxonomyCode" },
      // Only a code the taxonomy picker offers can be chosen.
      registryValue: isKnownTaxonomyCode(primary.code) ? normalizeTaxonomyCode(primary.code) : null,
    });
  }
  const registryLicenses = (record.taxonomies ?? []).flatMap((taxonomy) =>
    taxonomy.license && taxonomy.licenseState
      ? [{ state: taxonomy.licenseState.trim().toUpperCase(), number: taxonomy.license.trim() }]
      : [],
  );
  licenses.forEach((row, index) => {
    const rowState = row.state.trim().toUpperCase();
    if (!rowState || !row.number.trim()) return;
    const inState = registryLicenses.filter((license) => license.state === rowState);
    if (inState.length === 0) return;
    if (inState.some((license) => looseKey(license.number) === looseKey(row.number))) return;
    const unique = [...new Set(inState.map((license) => license.number))];
    const registryNumbers = unique.join(", ");
    add({
      id: `npi_registry.license_differs:${index}`,
      check: "npi_registry.license_differs",
      policyCheck: "licenseDiffers",
      field: `licenses.${index}.number`,
      title: `${rowState} license ${row.number.trim()} — the registry has ${registryNumbers}`,
      detail: null,
      // No state or number: the field names the row (A35: no registry values).
      whyItMatters: "A license number differs from the NPI Registry's in that state for this NPI.",
      fix: { field: "licenseNumber", row: index },
      // One number in that state is a candidate; several are a choice for the
      // license editor, not a one-click swap.
      registryValue: unique.length === 1 ? unique[0] : null,
    });
  });
  return {
    line: { tone: "ok", title: "Found in the NPI Registry", detail: registrySummary(record) },
    checking: false,
    advisories,
  };
}

/** The advisories the review step lists (the rest are kept for Mission
 * Control). */
export function shownAdvisories(review: NpiRegistryReview): NpiReviewAdvisory[] {
  return review.advisories.filter((advisory) => advisory.display === "review_step");
}
