// Portals the prod -> staging catalog sync CREATES on staging. Each one is a
// reviewed, named entry: a production SOP template names the portal key, and
// neither project has the portal row, so staging's binding guard
// (validate_sop_template_portal_bindings) would refuse the template. This is a
// list, not a rule. A template that names any other missing portal is inserted
// as it is, staging refuses it, and the run reports it as skipped.
//
// What the sync writes for an entry (planCreatedPortals in catalog-sync.mjs),
// and why, from the migrations in supabase/migrations/:
//   org_id      the template's org_id (NULL for a global template). The guard
//               looks for the key in the template's own scope.
//   portal_key  the key, trimmed and lower-cased: the guard compares
//               lower(btrim(portal_key)).
//   name        the entry's name below. Required (NOT NULL); never "[hidden] …",
//               because hidden rows do not bind; it says the sync made it.
//   payer_id    the template's payer. The guard needs the same payer, and a
//               typed portal cannot be inserted without one
//               (portal_configuration_payer_required, MINT-48).
//   case_type   the template's case type. The guard needs the same type
//               (CHECK: contract, enrollment or recredentialing).
//   form_url    NULL. Production has no row, so there is no URL to copy.
// Everything else is the column default or what the insert trigger sets for a
// typed row: a new id, unverified, no proof, explicit selection, mapping
// generation 1. No portal_field_maps are written for it.
//
// The sync creates an entry's portal only when its template is being added in
// the same run and no row with the key is already visible to that template on
// staging. It never updates or deletes a portal.
export const SYNC_CREATED_PORTALS = Object.freeze([
  Object.freeze({
    portalKey: "aetna-direct-contract-contract-1f94bf43c4c0",
    templateName: "Aetna - Direct",
    name: "Aetna - Direct contract (created by catalog sync; not on production)",
    why: "The Oct 27 run skipped template Aetna - Direct (archived, contract): it points at this portal, which exists on neither project. Sowmya, Oct 31: create it on staging.",
  }),
]);
