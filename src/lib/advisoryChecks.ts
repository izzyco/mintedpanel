// Workflow advisory registry (MINT-134): the checks that may be bypassed or
// recorded, shared by the browser (src/services/advisories.ts), the /api and
// extension routes and scheduled jobs (src/server/advisories.ts).
//
// The Oct 31 2026 rule: every workflow completes end to end. Only security,
// access control, tenant isolation, privacy, financial, legal and
// factual-accuracy checks may stop an action. Every other check becomes an
// advisory: the action proceeds, the front end stays quiet, and one
// public.workflow_advisories row records what was bypassed, by whom, on which
// record, and why it matters (supabase/migrations/
// 20261101090000_mint134_workflow_advisories.sql). Mission Control lists them
// as "Bypassed checks" later.
//
// A check is defined once, here. `critical` is true exactly when `protects` is
// in the boundary set, and a critical check records at severity "block" (it
// stopped the action, and someone must know). advisoryChecks.test.ts pins
// both. The database accepts only these keys (the SQL list in
// private.workflow_advisory_check_key_valid), so a new check key is a
// migration; advisoryChecks.contract.test.ts compares the two.
//
// Privacy is a hard boundary. A context holds only keys from CONTEXT_KEYS,
// each of one kind: a count under its own bound, a UUID of an existing org
// record, or a value from a closed vocabulary; a set is sorted with no
// repeats. There are no open tokens and no free check keys, so a name, an
// entered value, a registry value, a date or free text can't be stored as
// text. That stops plain text and accidental leaks, nothing more: one row's
// choices (check key, listed values, org records, counts) add up to well over
// 7 digits and rows are unlimited, so a deliberate direct caller with a
// codebook could encode an identifier, as bounded choices, never as text.
// isAdvisoryContextValid mirrors the SQL validator rule for rule;
// pickDeclared drops every key a check doesn't declare and every value
// outside its key's kind, and sorts sets, before a call is made. A new
// context key or vocabulary value is a migration. Pure: no I/O here except
// the one safe failure log line.
import { CASE_TYPES } from "./caseTypes";
import { PROFILE_ATTRIBUTE_KEYS } from "./profileGating";

/* ------------------------------ Vocabularies ------------------------------ */
// The record tables, sources, severities and roles below are mirrored by the
// migration's CHECKs; advisoryChecks.contract.test.ts reads them from the SQL
// text. The domains are this registry's own structure (every key starts with
// one); the SQL closes the key set itself.

/** check_key domains (the part before the dot). */
export const CHECK_DOMAINS = [
  "npi",
  "npi_registry",
  "import",
  "phone",
  "provider",
  "generation",
  "task",
  "touch",
  "assignment",
  "notification",
  "digest",
  "roster_export",
  "config",
] as const;
export type CheckDomain = (typeof CHECK_DOMAINS)[number];

/** Tables a row may name. Each exists on main and carries org_id; the RPCs
 *  check that the record belongs to the org. */
export const ADVISORY_RECORD_TABLES = [
  "providers",
  "provider_groups",
  "facilities",
  "credential_cases",
  "tasks",
  "touches",
  "import_runs",
  "roster_mappings",
  "sop_templates",
] as const;
export type AdvisoryRecordTable = (typeof ADVISORY_RECORD_TABLES)[number];

export const ADVISORY_SOURCES = ["panel", "extension", "api", "import", "job"] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];
/** Sources the browser may claim (an authenticated session). */
export const BROWSER_ADVISORY_SOURCES = ["panel", "import"] as const;
export type BrowserAdvisorySource = (typeof BROWSER_ADVISORY_SOURCES)[number];
/** Sources the server may claim for a verified user (the service role). */
export const SERVER_ADVISORY_SOURCES = ["api", "extension"] as const;
export type ServerAdvisorySource = (typeof SERVER_ADVISORY_SOURCES)[number];

export const ADVISORY_SEVERITIES = ["advisory", "block"] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

/** actor_role values: memberships_role_check's vocabulary, read by the RPC. */
export const ADVISORY_ACTOR_ROLES = ["admin", "specialist", "billing"] as const;

/** The table's columns, in order. Mission Control's "Bypassed checks" view
 *  reads these names verbatim; there is no record_label column. */
export const WORKFLOW_ADVISORY_COLUMNS = [
  "id",
  "org_id",
  "check_key",
  "severity_at_time",
  "record_table",
  "record_id",
  "actor_id",
  "actor_role",
  "source",
  "job",
  "context",
  "bypassed_at",
  "resolved_at",
  "resolved_by",
] as const;

/* -------------------------- What a check protects ------------------------- */

/** Boundary protections: a check that protects one of these stays a hard
 *  block (critical). */
export const BOUNDARY_PROTECTS = [
  "security",
  "access_control",
  "tenant_isolation",
  "privacy",
  "financial",
  "legal_compliance",
  "factual_accuracy",
] as const;
/** Everything else is an advisory (noncritical). */
export const NONCRITICAL_PROTECTS = [
  "completeness",
  "business_policy",
  "formatting",
  "sequencing",
] as const;
export type Protects = (typeof BOUNDARY_PROTECTS)[number] | (typeof NONCRITICAL_PROTECTS)[number];

const BOUNDARY_SET: ReadonlySet<string> = new Set(BOUNDARY_PROTECTS);

export function isBoundaryProtection(protects: Protects): boolean {
  return BOUNDARY_SET.has(protects);
}

/** Server re-checks that may resolve an open advisory (follow-up jobs). */
export const ADVISORY_RECHECKS = ["npi_registry", "profile_email", "provider_npi"] as const;
export type AdvisoryRecheck = (typeof ADVISORY_RECHECKS)[number];

/* --------------------------------- Context -------------------------------- */
// The SQL validator's rules, verbatim (private.workflow_advisory_context_valid
// and _set_valid). A context holds declared keys only; each key has one kind,
// and a closed vocabulary or a bound. advisoryChecks.contract.test.ts compares
// CONTEXT_KEYS with the SQL's VALUES list, row for row.

export const CONTEXT_MAX_KEYS = 16;
export const CONTEXT_MAX_ARRAY = 20;
/** The bounds of every count key in one context multiply to under this, so no
 *  context can carry a number of 7 digits or more (an NPI, a phone, an SSN, a
 *  yyyymmdd date), even split across keys. */
export const CONTEXT_MAX_COUNT_CAPACITY = 10_000_000;
/** Vocabulary hygiene for the closed lists (tested, not a runtime rule): a
 *  snake_case token with no two digits in a row. */
export const CONTEXT_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const CONTEXT_DIGIT_RUN_PATTERN = /[0-9]{2}/;
export const ADVISORY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CHECK_KEY_PATTERN = new RegExp(
  `^(${CHECK_DOMAINS.join("|")})\\.[a-z][a-z0-9_]{0,47}$`,
);
/** job_runs_job_check's pattern. */
export const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export type AdvisoryContextValue = boolean | number | string | string[];
export type AdvisoryContext = Record<string, AdvisoryContextValue>;

/** How a declared context key's value is shaped. Every count has its own
 *  bound and every token key a closed vocabulary: there are no open tokens. */
export type ContextKeyKind =
  | { readonly kind: "flag" }
  | { readonly kind: "count"; readonly max: number }
  | { readonly kind: "id" }
  | { readonly kind: "ids" }
  | { readonly kind: "token"; readonly values: readonly string[] }
  | { readonly kind: "tokens"; readonly values: readonly string[] };

/** Contact-number and NPI columns an import may drop (import template
 *  headers; advisoryChecks.test.ts checks each against importSections). */
export const IMPORT_ADVISORY_COLUMNS = [
  "npi",
  "npi_type2",
  "group_npi",
  "phone",
  "fax",
  "appointment_phone",
  "billing_phone",
  "billing_fax",
  "corr_phone",
  "corr_fax",
  "cred_phone",
  "cred_fax",
] as const;

/** Which form a save came from (the per-form detail `source` doesn't hold). */
export const ADVISORY_SURFACES = ["add_provider", "roster_form", "record_edit", "import"] as const;

/** Configuration layers (policy is configuration: platform, then org). */
export const CONFIG_LAYERS = ["platform", "org"] as const;

/** Every context key any check may declare. A key ending in _id is an id, one
 *  ending in _ids is ids, and no other key is either. The record RPCs also
 *  check that every id names an existing record of the org. Bounds fit real
 *  use:
 *    line                an import line. Imports have no line cap, only the
 *                        10 MB file cap; 100,000 is the house complete-read
 *                        cap (COMPLETE_READ_MAX_ROWS) and far past any real
 *                        roster. A later line records without it.
 *    count               follow-ups left unassigned for one org on one day.
 *    earlier_open_count  earlier open tasks on a case, or steps on a task.
 *    step_order          an SOP step's position on its task.
 *    step_position       a reminder step (a sequence has at most 10).
 *    removed_count       cc members removed (a cc list holds at most 20).
 *  Adding a key, or a value to a vocabulary, is a migration (the SQL list). */
export const CONTEXT_KEYS = {
  attributes: { kind: "tokens", values: PROFILE_ATTRIBUTE_KEYS },
  case_type: { kind: "token", values: CASE_TYPES },
  column: { kind: "token", values: IMPORT_ADVISORY_COLUMNS },
  count: { kind: "count", max: 9_999 },
  earlier_open_count: { kind: "count", max: 99 },
  facility_ids: { kind: "ids" },
  import_run_id: { kind: "id" },
  layer: { kind: "token", values: CONFIG_LAYERS },
  line: { kind: "count", max: 100_000 },
  payer_id: { kind: "id" },
  recipient_id: { kind: "id" },
  removed_count: { kind: "count", max: 20 },
  step_order: { kind: "count", max: 99 },
  step_position: { kind: "count", max: 10 },
  surface: { kind: "token", values: ADVISORY_SURFACES },
  template_ids: { kind: "ids" },
} as const satisfies Record<string, ContextKeyKind>;
export type ContextKey = keyof typeof CONTEXT_KEYS;

const CONTEXT_KEY_MAP: Readonly<Record<string, ContextKeyKind>> = CONTEXT_KEYS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && ADVISORY_UUID_PATTERN.test(value);
}

/** A set: up to 20 strings, each accepted by `member`, in strictly ascending
 *  order (sorted, no repeats), so the order carries nothing. JavaScript's
 *  string comparison is the SQL's byte order (COLLATE "C") for ASCII. */
function isStringSet(value: unknown, member: (item: string) => boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CONTEXT_MAX_ARRAY &&
    value.every((item) => typeof item === "string" && member(item)) &&
    value.every((item, index) => index === 0 || (value[index - 1] as string) < item)
  );
}

function matchesKind(def: ContextKeyKind, value: unknown): boolean {
  switch (def.kind) {
    case "flag":
      return typeof value === "boolean";
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= def.max;
    case "id":
      return isUuid(value);
    case "ids":
      return isStringSet(value, isUuid);
    case "token":
      return typeof value === "string" && def.values.includes(value);
    case "tokens":
      return isStringSet(value, (item) => def.values.includes(item));
  }
}

function contextKeyKind(key: string): ContextKeyKind | null {
  return Object.prototype.hasOwnProperty.call(CONTEXT_KEY_MAP, key) ? CONTEXT_KEY_MAP[key] : null;
}

/** How many distinct numbers the count keys present could carry together. */
export function countCapacity(keys: Iterable<string>): number {
  let capacity = 1;
  for (const key of keys) {
    const def = contextKeyKind(key);
    if (def?.kind === "count") capacity *= def.max + 1;
  }
  return capacity;
}

/** The SQL validator's rules, applied to the JSON a call would send: declared
 *  keys only, each value of its key's kind, and a bounded count capacity. */
export function isAdvisoryContextValid(context: unknown): context is AdvisoryContext {
  if (!isPlainObject(context)) return false;
  const entries = Object.entries(context);
  if (entries.length > CONTEXT_MAX_KEYS) return false;
  for (const [key, value] of entries) {
    const def = contextKeyKind(key);
    if (!def || !matchesKind(def, value)) return false;
  }
  return countCapacity(Object.keys(context)) < CONTEXT_MAX_COUNT_CAPACITY;
}

/* --------------------------------- Checks --------------------------------- */

export interface CheckDefinition {
  /** "npi_registry.not_found": a domain, a dot, a snake_case name. */
  readonly key: string;
  readonly domain: CheckDomain;
  readonly protects: Protects;
  /** True exactly when `protects` is a boundary protection. Fixed in code. */
  readonly critical: boolean;
  /** Mission Control's "why it matters", in plain words. */
  readonly help: string;
  /** Tables whose record a row may name. Empty while the record's table is not
   *  in the SQL set yet: the helpers' types then refuse every call. */
  readonly recordTables: readonly AdvisoryRecordTable[];
  readonly contextKeys: readonly ContextKey[];
  /** A server re-check that may resolve it. */
  readonly recheck?: AdvisoryRecheck;
}

const NPI_SAVE_CONTEXT = ["import_run_id", "line", "surface"] as const;
const IMPORT_ROW_CONTEXT = ["import_run_id", "line"] as const;
const IMPORT_COLUMN_CONTEXT = ["import_run_id", "line", "column"] as const;
const IMPORT_ROW_RECORDS = ["providers", "provider_groups", "facilities"] as const;

/** Seeded with the check keys of the hard-block inventory (Nov 1 2026),
 *  section 4, so each conversion PR only imports its keys. */
export const CHECKS = {
  // -- NPI (#545, #564) ------------------------------------------------------
  "npi.stored_check_digit_invalid": {
    key: "npi.stored_check_digit_invalid",
    domain: "npi",
    protects: "completeness",
    critical: false,
    help: "The provider's stored NPI fails the check digit, so it can't be a real NPI. Payer submissions and rosters carry the wrong number until someone fixes it on the provider's record.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "provider_npi",
  },
  "npi.missing": {
    key: "npi.missing",
    domain: "npi",
    protects: "completeness",
    critical: false,
    help: "The provider was saved without an NPI, so they can't be submitted to payers or listed on rosters until one is added.",
    recordTables: ["providers"],
    contextKeys: ["surface"],
    recheck: "provider_npi",
  },
  // -- NPI Registry (#564, #566) --------------------------------------------
  "npi_registry.not_found": {
    key: "npi_registry.not_found",
    domain: "npi_registry",
    protects: "business_policy",
    critical: false,
    help: "The NPI Registry doesn't list this number, so it may be mistyped. Payers reject enrollments and claims under an NPI the registry doesn't know.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "npi_registry",
  },
  "npi_registry.organization_number": {
    key: "npi_registry.organization_number",
    domain: "npi_registry",
    protects: "business_policy",
    critical: false,
    help: "This is an organization (Type 2) NPI saved as the provider's own number. Payers expect an individual (Type 1) NPI for a provider.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "npi_registry",
  },
  "npi_registry.name_mismatch": {
    key: "npi_registry.name_mismatch",
    domain: "npi_registry",
    protects: "business_policy",
    critical: false,
    help: "The name entered differs from the name the NPI Registry holds for this number. It can mean the wrong NPI, or a name payers won't match.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "npi_registry",
  },
  "npi_registry.inactive": {
    key: "npi_registry.inactive",
    domain: "npi_registry",
    protects: "business_policy",
    critical: false,
    help: "The NPI Registry lists this number as deactivated. Claims billed under a deactivated NPI are denied.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "npi_registry",
  },
  "npi_registry.unchecked": {
    key: "npi_registry.unchecked",
    domain: "npi_registry",
    protects: "completeness",
    critical: false,
    help: "The NPI Registry couldn't be reached when this was saved, so the number isn't verified yet. A background re-check verifies it.",
    recordTables: ["providers"],
    contextKeys: NPI_SAVE_CONTEXT,
    recheck: "npi_registry",
  },
  // -- Import (#566, #556) ---------------------------------------------------
  "import.npi_missing": {
    key: "import.npi_missing",
    domain: "import",
    protects: "completeness",
    critical: false,
    help: "This import row had no NPI, so the provider was imported without one and can't be submitted to payers until it's added.",
    recordTables: ["providers", "import_runs"],
    contextKeys: IMPORT_ROW_CONTEXT,
    recheck: "provider_npi",
  },
  "import.npi_unusable": {
    key: "import.npi_unusable",
    domain: "import",
    protects: "completeness",
    critical: false,
    help: "This import row's NPI wasn't a valid NPI, so it was left off. The provider can't be submitted to payers until a correct one is added.",
    recordTables: ["providers", "import_runs"],
    contextKeys: IMPORT_ROW_CONTEXT,
    recheck: "provider_npi",
  },
  "import.group_npi_unusable": {
    key: "import.group_npi_unusable",
    domain: "import",
    protects: "completeness",
    critical: false,
    help: "This import row's group (Type 2) NPI wasn't ten digits, so it was left off. Payer forms that need the group NPI will show it blank.",
    recordTables: IMPORT_ROW_RECORDS,
    contextKeys: IMPORT_COLUMN_CONTEXT,
  },
  "import.phone_dropped": {
    key: "import.phone_dropped",
    domain: "import",
    protects: "formatting",
    critical: false,
    help: "A phone or fax number on this import row wasn't a usable US number, so it wasn't imported. Payer forms and rosters show it blank until someone adds it on the record.",
    recordTables: IMPORT_ROW_RECORDS,
    contextKeys: IMPORT_COLUMN_CONTEXT,
  },
  // -- Facility assignments (#551) ------------------------------------------
  "assignment.start_date_missing": {
    key: "assignment.start_date_missing",
    domain: "assignment",
    protects: "completeness",
    critical: false,
    help: "These facility assignments were saved without a start date. Billing Readiness holds them until a date is entered.",
    recordTables: ["providers"],
    contextKeys: ["facility_ids"],
  },
  // -- Notification sequences (#561) ----------------------------------------
  "notification.cc_member_lapsed": {
    key: "notification.cc_member_lapsed",
    domain: "notification",
    protects: "business_policy",
    critical: false,
    help: "Someone on a reminder step's cc list is no longer a member of the organization, so they were removed. The escalation list is shorter than it was set up.",
    recordTables: [],
    contextKeys: ["step_position", "removed_count"],
  },
  "notification.sms_disabled": {
    key: "notification.sms_disabled",
    domain: "notification",
    protects: "legal_compliance",
    critical: true,
    help: "A text reminder wasn't sent because SMS is switched off. Texting a provider is allowed only while SMS is on and their consent is recorded.",
    recordTables: ["providers"],
    contextKeys: ["step_position"],
  },
  "notification.template_unavailable": {
    key: "notification.template_unavailable",
    domain: "notification",
    protects: "factual_accuracy",
    critical: true,
    help: "A reminder wasn't sent because its template is missing or doesn't fit the step. Sending the wrong message would tell the provider something untrue.",
    recordTables: ["providers"],
    contextKeys: ["step_position"],
  },
  "notification.schedule_invalid": {
    key: "notification.schedule_invalid",
    domain: "notification",
    protects: "business_policy",
    critical: false,
    help: "A reminder sequence's schedule couldn't be used as saved, so Minted's default schedule ran instead of the organization's own.",
    recordTables: [],
    contextKeys: [],
  },
  // -- Daily digest job (#563) ----------------------------------------------
  "digest.recipient_no_email": {
    key: "digest.recipient_no_email",
    domain: "digest",
    protects: "factual_accuracy",
    critical: true,
    help: "A coordinator with follow-ups due has no usable email address, so their daily digest couldn't be sent and nobody was reminded.",
    recordTables: [],
    contextKeys: ["recipient_id"],
    recheck: "profile_email",
  },
  "digest.step_unusable": {
    key: "digest.step_unusable",
    domain: "digest",
    protects: "business_policy",
    critical: false,
    help: "The organization's digest step couldn't be used, so its coordinators got no digest. Nothing else goes out in its place. Only Minted can fix the step.",
    recordTables: [],
    contextKeys: [],
  },
  "digest.rules_fallback": {
    key: "digest.rules_fallback",
    domain: "digest",
    protects: "business_policy",
    critical: false,
    help: "The organization's digest catch-up rule couldn't be used, so the default cut-off at midnight applied instead.",
    recordTables: [],
    contextKeys: [],
  },
  "digest.send_time_fallback": {
    key: "digest.send_time_fallback",
    domain: "digest",
    protects: "business_policy",
    critical: false,
    help: "The organization's digest send time or time zone couldn't be used, so the digest went out at Minted's default time instead.",
    recordTables: [],
    contextKeys: [],
  },
  "digest.org_failed": {
    key: "digest.org_failed",
    domain: "digest",
    protects: "factual_accuracy",
    critical: true,
    help: "The organization's follow-ups couldn't be read completely, so no digest went out this hour rather than one built on a partial list.",
    recordTables: [],
    contextKeys: [],
  },
  "digest.unassigned_follow_ups": {
    key: "digest.unassigned_follow_ups",
    domain: "digest",
    protects: "business_policy",
    critical: false,
    help: "Follow-ups due on cases with no assigned coordinator were left out of every digest, so nobody was reminded about them.",
    recordTables: [],
    contextKeys: ["count"],
  },
  // -- Configuration (#560, Mission Control overrides) ----------------------
  "config.override_ignored": {
    key: "config.override_ignored",
    domain: "config",
    protects: "business_policy",
    critical: false,
    help: "A stored setting couldn't be used, so the default from the layer above applied instead of the value someone chose.",
    recordTables: [],
    contextKeys: ["layer"],
  },
  // -- Pre-existing blocks (follow-up PRs) ----------------------------------
  "touch.other_without_context": {
    key: "touch.other_without_context",
    domain: "touch",
    protects: "completeness",
    critical: false,
    help: "A touch was logged with the outcome Other and no note, so anyone reading the case history can't tell what happened.",
    recordTables: ["touches"],
    contextKeys: [],
  },
  "generation.required_attribute_missing": {
    key: "generation.required_attribute_missing",
    domain: "generation",
    protects: "completeness",
    critical: false,
    help: "The case was created while the provider lacks details its SOP requires, so the steps that need them stall until they're added.",
    recordTables: ["credential_cases"],
    contextKeys: ["attributes"],
  },
  "generation.sop_tie": {
    key: "generation.sop_tie",
    domain: "generation",
    protects: "business_policy",
    critical: false,
    help: "More than one SOP matched this case at the same priority, so one was picked. An admin should set priorities so the right SOP is used.",
    recordTables: ["credential_cases"],
    contextKeys: ["template_ids"],
  },
  "generation.no_sop": {
    key: "generation.no_sop",
    domain: "generation",
    protects: "completeness",
    critical: false,
    help: "No SOP matched this case, not even Minted's generic one, so it was created with no tasks. It waits as a draft until someone assigns a template.",
    recordTables: ["credential_cases"],
    contextKeys: [],
  },
  "task.completed_out_of_order": {
    key: "task.completed_out_of_order",
    domain: "task",
    protects: "sequencing",
    critical: false,
    help: "A task was completed while earlier tasks on the case were still open, so the work may not have followed the order the SOP plans.",
    recordTables: ["tasks"],
    contextKeys: ["earlier_open_count"],
  },
  "task.step_out_of_order": {
    key: "task.step_out_of_order",
    domain: "task",
    protects: "sequencing",
    critical: false,
    help: "An SOP step was ticked while earlier steps were still open, so the work may not have followed the order the SOP sets.",
    recordTables: ["tasks"],
    contextKeys: ["step_order", "earlier_open_count"],
  },
  "roster_export.override": {
    key: "roster_export.override",
    domain: "roster_export",
    protects: "formatting",
    critical: false,
    help: "A roster was exported past a validation error, so the payer may receive a value in a format it rejects.",
    recordTables: ["roster_mappings"],
    contextKeys: [],
  },
} as const satisfies Record<string, CheckDefinition>;

type CheckMap = typeof CHECKS;
export type CheckKey = keyof CheckMap;

/** The tables a check's record may live in. `never` while it has none. */
export type AdvisoryRecordTableFor<K extends CheckKey> = CheckMap[K]["recordTables"][number];

export interface AdvisoryRecord<K extends CheckKey> {
  table: AdvisoryRecordTableFor<K>;
  id: string;
}

type ContextValueOf<D> = D extends { kind: "flag" }
  ? boolean
  : D extends { kind: "count" }
    ? number
    : D extends { kind: "id" }
      ? string
      : D extends { kind: "ids" }
        ? readonly string[]
        : D extends { kind: "token"; values: readonly (infer V)[] }
          ? V
          : D extends { kind: "token" }
            ? string
            : D extends { kind: "tokens"; values: readonly (infer V)[] }
              ? readonly V[]
              : D extends { kind: "tokens" }
                ? readonly string[]
                : never;

/** The context a check accepts: its declared keys, each optional. A null or
 *  undefined value means "not known" and is dropped. */
export type AdvisoryContextFor<K extends CheckKey> = {
  readonly [P in CheckMap[K]["contextKeys"][number]]?: ContextValueOf<
    (typeof CONTEXT_KEYS)[P]
  > | null;
};

const CHECK_MAP: Readonly<Record<string, CheckDefinition>> = CHECKS;

export function isCheckKey(value: unknown): value is CheckKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHECK_MAP, value);
}

export function checkDefinition(key: unknown): CheckDefinition | null {
  return isCheckKey(key) ? CHECK_MAP[key] : null;
}

/** advisory when the action proceeded; block when a critical check stopped
 *  it. Fixed by the registry, never chosen by a caller. */
export function severityFor(def: CheckDefinition): AdvisorySeverity {
  return def.critical ? "block" : "advisory";
}

/** The declared part of a context: keys the check declares whose values fit
 *  their kind. Everything else is dropped, so the result always passes
 *  isAdvisoryContextValid. */
export function pickDeclared(def: CheckDefinition, context: unknown): AdvisoryContext {
  const picked: AdvisoryContext = {};
  if (!isPlainObject(context)) return picked;
  for (const key of def.contextKeys) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
    const value = context[key];
    if (value === null || value === undefined) continue;
    // A set: its order and repeats carry nothing, so it is sorted and
    // deduplicated rather than refused.
    const candidate = Array.isArray(value) ? [...new Set(value)].sort() : value;
    if (!matchesKind(CONTEXT_KEYS[key], candidate)) continue;
    picked[key] = candidate as AdvisoryContextValue;
  }
  return picked;
}

export interface AdvisoryRpcFields {
  p_check_key: string;
  p_severity: AdvisorySeverity;
  p_record_table: AdvisoryRecordTable;
  p_record_id: string;
  p_context: AdvisoryContext;
}

/** The RPC fields every helper sends, or null when the record isn't one the
 *  check declares (or its id isn't a UUID): such a call is never sent. */
export function advisoryRpcFields(
  def: CheckDefinition,
  record: unknown,
  context: unknown,
): AdvisoryRpcFields | null {
  if (!isPlainObject(record)) return null;
  const { table, id } = record;
  if (typeof table !== "string" || !isUuid(id)) return null;
  const recordTable = def.recordTables.find((declared) => declared === table);
  if (!recordTable) return null;
  return {
    p_check_key: def.key,
    p_severity: severityFor(def),
    p_record_table: recordTable,
    p_record_id: id,
    p_context: pickDeclared(def, context),
  };
}

/** How long a helper waits for its RPC before abandoning it. Nothing that
 *  awaits a helper is held longer than this; a timed-out call is one
 *  advisory_record_failed line, like any other failure. */
export const ADVISORY_RPC_TIMEOUT_MS = 3_000;

/* ------------------------------ Safe failure log -------------------------- */

export const ADVISORY_RECORD_FAILED = "advisory_record_failed";
export const ADVISORY_RESOLVE_FAILED = "advisory_resolve_failed";
/** Refused before any call: an unknown key, an undeclared record or source. */
export const ADVISORY_LOCAL_REFUSAL = "22023";

// A Postgres SQLSTATE or a PostgREST PGRSTnnn code (@/lib/errorIdentifiers on
// the MINT-30 branch uses the same pattern).
const ERROR_CODE_PATTERN = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/;

function sqlstateOf(error: unknown): string {
  const code =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : "unknown";
}

/** The one log line a helper writes when recording fails (MINT-30 safe
 *  logging): an event name, the registered check key and the SQLSTATE. Never
 *  a message, details, the record, the context or the actor. The workflow
 *  carries on: the action already happened. */
export function reportAdvisoryFailure(
  event: typeof ADVISORY_RECORD_FAILED | typeof ADVISORY_RESOLVE_FAILED,
  key: unknown,
  error: unknown,
): void {
  const line = JSON.stringify({
    event,
    check_key: isCheckKey(key) ? key : "unknown",
    sqlstate: sqlstateOf(error),
  });
  try {
    console.warn(line);
  } catch {
    // A broken console must not reach the workflow either.
  }
}
