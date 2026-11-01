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
// matches; a name not typed yet is "not checked yet".
import type { Advisory } from "@/lib/advisories";
import { npiLookupOutcome, npiVerificationView, type NpiLookupState } from "@/lib/npiRegistry";
import type { NpiRegistryCheck, NpiRegistryPolicy } from "@/lib/npiRegistryPolicy";
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";

/** A field a fix jumps to. `row` names the license row for "licenseNumber". */
export type NpiReviewFixTarget =
  | { field: "npi" | "firstName" | "credentials" | "taxonomyCode" }
  | { field: "licenseNumber"; row: number };

/** An advisory as the review step lists it. The id, title, detail and the
 * registry's values are for the form only; toCapturedAdvisory drops them. */
export interface NpiReviewAdvisory extends Advisory {
  /** What the advisory is about: the check, the NPI, and the typed or
   * entered value and the registry's value it compares (a license row by its
   * state and number, never its position). A confirmation is kept by this
   * id, so it holds only while the advisory is about the same thing: change
   * the NPI, the name or the value, or the registry's answer, and it is a new
   * advisory, unconfirmed. */
  id: string;
  /** The policy check behind it, or null for a check that couldn't run. */
  policyCheck: NpiRegistryCheck | null;
  title: string;
  detail: string | null;
  /** Where Fix goes; "retry" asks the registry again; null: confirm only. */
  fix: NpiReviewFixTarget | "retry" | null;
  /** The registry's values staff can choose instead, one "Use" each (A35:
   * choose, edit or add — never retype); empty when there is none. */
  registryValues: string[];
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

// An advisory's id from its subject. Values are kept as typed (trimmed), so
// any edit makes a new subject. Form-only: never captured.
function subjectId(check: string, ...parts: (string | null | undefined)[]): string {
  return JSON.stringify([check, ...parts.map((part) => (part ?? "").trim())]);
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
      id: subjectId("npi_registry.not_checked", input.npi),
      check: "npi_registry.not_checked",
      policyCheck: null,
      field: "npi",
      title: `Not checked: ${state.message}`,
      detail: null,
      whyItMatters:
        "The NPI Registry could not be reached, so this NPI was saved without a registry check.",
      fix: "retry",
      registryValues: [],
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
      // A name mismatch is about the name typed, too.
      id:
        outcome === "nameMismatch"
          ? subjectId(
              OUTCOME_CHECK[outcome],
              input.npi,
              input.typed.firstName,
              input.typed.lastName,
            )
          : subjectId(OUTCOME_CHECK[outcome], input.npi),
      check: OUTCOME_CHECK[outcome],
      policyCheck: outcome,
      field: outcome === "nameMismatch" ? "firstName" : "npi",
      title: view?.title ?? "",
      detail: view?.detail ?? null,
      whyItMatters: OUTCOME_WHY[outcome],
      fix: { field: outcome === "nameMismatch" ? "firstName" : "npi" },
      registryValues: [],
    });
    // An answer kept for Mission Control says nothing here, and never "ok".
    return {
      line: view ? { tone: view.tone, title: view.title, detail: view.detail } : null,
      checking: false,
      advisories,
    };
  }
  if (!record) return { line: null, checking: false, advisories };

  // Found, active and an individual: "ok" only when the name matches too (a
  // name not typed yet is "not checked yet", never ok). Then what staff
  // entered that differs from this record.
  const found = npiVerificationView(state, input.typed, policy);
  const { credentials, taxonomyCode, licenses } = input.entered;
  if (
    record.credential &&
    credentials.trim() &&
    looseKey(credentials) !== looseKey(record.credential)
  ) {
    add({
      id: subjectId("npi_registry.credentials_differ", input.npi, credentials, record.credential),
      check: "npi_registry.credentials_differ",
      policyCheck: "credentialsDiffer",
      field: "credentials",
      title: `Credentials ${credentials.trim()} — the registry has ${record.credential}`,
      detail: null,
      whyItMatters: "The credentials differ from the NPI Registry's for this NPI.",
      fix: { field: "credentials" },
      registryValues: [record.credential],
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
      id: subjectId(
        "npi_registry.taxonomy_differs",
        input.npi,
        normalizeTaxonomyCode(taxonomyCode),
        normalizeTaxonomyCode(primary.code),
      ),
      check: "npi_registry.taxonomy_differs",
      policyCheck: "taxonomyDiffers",
      field: "taxonomyCode",
      title: `Taxonomy code ${normalizeTaxonomyCode(taxonomyCode)} — the registry has ${registry}`,
      detail: null,
      whyItMatters: "The taxonomy differs from the NPI Registry's primary taxonomy for this NPI.",
      fix: { field: "taxonomyCode" },
      // Only a code the taxonomy picker offers can be chosen.
      registryValues: isKnownTaxonomyCode(primary.code)
        ? [normalizeTaxonomyCode(primary.code)]
        : [],
    });
  }
  const registryLicenses = (record.taxonomies ?? []).flatMap((taxonomy) =>
    taxonomy.license && taxonomy.licenseState
      ? [{ state: taxonomy.licenseState.trim().toUpperCase(), number: taxonomy.license.trim() }]
      : [],
  );
  // A row is known by its state and number, not its position: removing
  // another row never moves a confirmation. Identical rows are told apart by
  // how many came before.
  const seen = new Map<string, number>();
  licenses.forEach((row, index) => {
    const rowState = row.state.trim().toUpperCase();
    if (!rowState || !row.number.trim()) return;
    const inState = registryLicenses.filter((license) => license.state === rowState);
    if (inState.length === 0) return;
    if (inState.some((license) => looseKey(license.number) === looseKey(row.number))) return;
    const unique = [...new Set(inState.map((license) => license.number))];
    const registryNumbers = unique.join(", ");
    const subject = subjectId(
      "npi_registry.license_differs",
      input.npi,
      rowState,
      row.number,
      registryNumbers,
    );
    const repeat = seen.get(subject) ?? 0;
    seen.set(subject, repeat + 1);
    add({
      id: repeat === 0 ? subject : `${subject}#${repeat + 1}`,
      check: "npi_registry.license_differs",
      policyCheck: "licenseDiffers",
      field: `licenses.${index}.number`,
      title: `${rowState} license ${row.number.trim()} — the registry has ${registryNumbers}`,
      detail: null,
      // No state or number: the field names the row (A35: no registry values).
      whyItMatters: "A license number differs from the NPI Registry's in that state for this NPI.",
      fix: { field: "licenseNumber", row: index },
      // Each number the registry lists in that state is a choice (A35).
      registryValues: unique,
    });
  });
  return { line: found, checking: false, advisories };
}

/** The advisories the review step lists (the rest are kept for Mission
 * Control). */
export function shownAdvisories(review: NpiRegistryReview): NpiReviewAdvisory[] {
  return review.advisories.filter((advisory) => advisory.display === "review_step");
}
