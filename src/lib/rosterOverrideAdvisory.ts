// MINT-136 "Export anyway": what a roster override records in the workflow
// advisories ledger (roster_export.override in src/lib/advisoryChecks.ts).
//
// An overrideable roster-validation hard error is overridden with one click
// and no typed reason; the click is recorded with its rule and field. Both
// are closed vocabularies (the SQL list in private.workflow_advisory_context_valid,
// supabase/migrations/20261101150000_mint136_roster_export_anyway.sql), so a
// rule code or a field key can only ever name a check or a column, never a
// value. rosterOverrideAdvisory.test.ts keeps both in step with the
// validator and the seeded payer templates. Adding a value is a migration.

/** The overrideable hard errors of src/lib/rosterValidation.ts, sorted. A
 *  non-overrideable rule can't be overridden, so it is never recorded. */
export const ROSTER_OVERRIDE_RULES = [
  "active_state_license_missing",
  "date_invalid",
  "facility_city_missing",
  "facility_state_missing",
  "facility_street_missing",
  "facility_zip_plus_4_invalid",
  "npi_invalid",
  "phone_invalid",
  "provider_npi_invalid",
  "required_value_missing",
] as const;
export type RosterOverrideRule = (typeof ROSTER_OVERRIDE_RULES)[number];

/** The field keys those rules name, with "." spelled "_" (a context token is
 *  snake_case), sorted: every column key of the seeded payer templates
 *  (roster_engine_seed_templates, 20260925203025) and the source fields the
 *  row checks name (provider.npi, facility.street, facility.city,
 *  facility.state, facility.zip, license.license_number). */
export const ROSTER_OVERRIDE_FIELDS = [
  "address_1",
  "city",
  "dob",
  "facility_city",
  "facility_state",
  "facility_street",
  "facility_zip",
  "first_name",
  "group_name",
  "group_npi",
  "individual_npi",
  "last_name",
  "license_expiration",
  "license_license_number",
  "license_number",
  "location_name",
  "npi",
  "phone",
  "practice_name",
  "provider_npi",
  "state",
  "taxonomy",
  "tin",
  "zip_plus_4",
] as const;
export type RosterOverrideField = (typeof ROSTER_OVERRIDE_FIELDS)[number];

/** A validator field key as its context token: "provider.npi" is
 *  "provider_npi". */
export function rosterFieldToken(fieldKey: string): string {
  return fieldKey.replace(/\./g, "_");
}

/** roster_export.override's context for one override: the rule, the field and
 *  the roster's output row count. A rule or field outside its vocabulary (a
 *  template column added later) is null, so it is left out of the row rather
 *  than sent as text; the count is bounded by the registry. */
export function rosterOverrideContext(
  ruleCode: string,
  fieldKey: string,
  rowCount: number,
): { rule: RosterOverrideRule | null; field: RosterOverrideField | null; count: number } {
  const token = rosterFieldToken(fieldKey);
  return {
    rule: ROSTER_OVERRIDE_RULES.find((rule) => rule === ruleCode) ?? null,
    field: ROSTER_OVERRIDE_FIELDS.find((field) => field === token) ?? null,
    count: rowCount,
  };
}
