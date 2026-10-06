# Provider primary location defaults for cases

Status: Ready for implementation planning. Product direction confirmed October 6, 2026. This handoff does not implement or deploy the enhancement.

Cases should start with the provider's primary practice location whenever that location is eligible for the case. A provider with exactly one assigned location should automatically have that location treated as primary. Coordinators can change the case's location later through **Details → Locations**; they should not need to make the same initial selection for every case.

## Case location contract for the extension

For every active case, the case's persisted location relationship is the source of truth for the extension's practice-location cards, handoff, and autofill. Provider assignments supply the initial default that is saved onto the case; the extension must then read the case location. It must never substitute the provider's current primary or a remembered provider location for the active case's location.

When a valid default can be resolved, a case must not remain locationless: persist its primary `case_facilities` row and matching `credential_cases.facility_id` before reporting creation or reconciliation as successful. This applies to new cases and existing unconfigured cases. The case primary becomes the extension's initial selection; any alternate location chosen in the extension must also belong to that case's location set. Switching cases must replace stale location cards and selection with the new case's context.

The requirement cannot create a location where none is eligible or a choice is genuinely ambiguous. Such cases need an explicit unresolved-location explanation and a path to Details → Locations. They must not silently borrow a provider location or appear successfully initialized. Explicitly cleared cases remain unresolved until the coordinator assigns a replacement.

## Problem and current behavior

Apple Bestest's BCBS NC extension screenshot shows every practice-location field as “Not on file,” despite the reported provider location assignment. The diagnosis established a possible mechanism, rather than confirming that case's live database contents: a selected case's profile uses `case_facilities` and does not fall back to provider assignments when that set is empty.

Some of the desired behavior already exists. `resolveCaseFacilityId` selects the sole eligible location or the provider's eligible primary location. Manual case creation and generation previews call it, and `createCase` passes the result as `credential_cases.facility_id`. The extension profile requires the selected location to be present in `case_facilities`. Audit the complete creation and synchronization path before deciding which layer needs repair; a populated mirror alone is insufficient.

## Required behavior

| Situation                                                        | Expected result                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider has exactly one assigned location                       | Treat that assignment as the provider's primary, even if its stored primary flag was previously missing. Default cases to it when eligible. |
| Provider has multiple assigned locations and an eligible primary | Default new cases to that primary.                                                                                                          |
| Case group has exactly one eligible assigned location            | Preserve the existing sole-location default for that group. This does not change the provider's primary across other groups.                |
| Several eligible locations and no eligible primary               | Require a choice; do not select an arbitrary row.                                                                                           |
| No eligible assigned locations                                   | Keep the case unresolved and explain the missing eligible location.                                                                         |
| Case already has an explicit location or location set            | Preserve it. Provider defaults do not replace case choices.                                                                                 |
| Coordinator changes the case location later                      | Use the updated case primary in Details, extension cards, handoff, and autofill.                                                            |
| Provider primary changes later                                   | Use the new primary for future defaults. Preserve existing case locations.                                                                  |

An eligible default must belong to the authenticated organization, be assigned to the provider, be active, and belong to the case's group. Retain the existing group and tenant boundaries. Do not introduce a new state-matching rule: case state still controls license selection. A sole assignment to an inactive or otherwise ineligible location does not authorize defaulting a case to it.

## Implementation requirements

1. **Normalize provider primary assignments.** Enforce the sole-assignment rule across Add Provider, assignment edits, launch assignment, CSV import, and roster commit paths. A provider reduced from several assignments to one should not need a separate primary selection. Persist the sole assignment as primary and preserve the database's at-most-one-primary constraint. When a second assignment is added, retain the existing primary unless the user changes it. Audit repairs to existing sole assignments whose primary flag is false.
2. **Default at the shared case creation boundary.** Resolve against current assignments when no explicit case location was supplied, covering manual and generated cases and other callers of the shared creation path. Validate explicit choices and preserve them. Creation previews and any location-dependent SOP stamping must agree with the persisted default; handle a changed assignment between preview and confirmation consistently.
3. **Persist the complete case relationship.** Create a primary `case_facilities` row and set `credential_cases.facility_id` to the same facility. Perform the writes atomically with case creation, or through the existing transaction boundary after verifying its actual behavior. Retries must not create duplicate links, extra primaries, or partially initialized cases. Do not rely on a display-only fallback in the extension.
4. **Handle existing missing cases.** Plan an idempotent, audited repair for cases lacking a location. Prefer a valid existing `credential_cases.facility_id` when repairing a missing join row; otherwise use the same eligible provider default. Preserve existing case location sets and explicit overrides. Reconcile inconsistent sets or mirrors separately rather than overwriting them with a provider default.
5. **Handle assignments added after case creation.** Cases created before a provider had an eligible location should receive the default when that relationship becomes available, if their location is still unconfigured. Use an explicit mutation or reconciliation path; profile GET requests must remain read-only.
6. **Preserve manual control.** Details → Locations remains the editing surface. Defaults must not overwrite later edits or silently restore a location the coordinator deliberately removed. Distinguish “never configured” from “explicitly cleared” for future writes. Inspect existing audit evidence for historical repairs; report ambiguous cases instead of assuming every empty set was accidental. If durable intent requires a new field, add it through a new migration and document its semantics.
7. **Refresh consumers.** Invalidate case, location, and profile queries after changes. The extension must initially select the persisted case primary and show its stored name/address without an extra location choice when the default is resolved. Pass the active case identity through profile requests, validate selections against that case's location set, and discard stale provider or previous-case selections. Any stored empty address fields remain empty; assigning a location does not manufacture its missing data.

## Code entry points

| Area                              | Starting point                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default selection and eligibility | [`src/lib/caseFacility.ts`](../../src/lib/caseFacility.ts) and its tests                                                                                                     |
| Provider primary rules and writes | [`src/lib/assignmentScope.ts`](../../src/lib/assignmentScope.ts), [`src/services/providerAssignments.ts`](../../src/services/providerAssignments.ts)                         |
| Creation callers                  | [`src/components/cases/ManualCaseModal.tsx`](../../src/components/cases/ManualCaseModal.tsx), [`src/hooks/useGenerationPreview.ts`](../../src/hooks/useGenerationPreview.ts) |
| Creation and case location writes | [`src/services/cases.ts`](../../src/services/cases.ts), the latest `create_case_with_tasks` RPC and applicable triggers                                                      |
| Imports and assignment additions  | [`src/services/importRuns.ts`](../../src/services/importRuns.ts), launch and roster assignment writers                                                                       |
| Case editor                       | [`src/components/cases/CaseLocationsSection.tsx`](../../src/components/cases/CaseLocationsSection.tsx)                                                                       |
| Extension data sources            | [`src/services/providerProfile.ts`](../../src/services/providerProfile.ts), [`src/services/caseContext.ts`](../../src/services/caseContext.ts)                               |
| Extension consumers               | `minted-extension/src/background/index.ts`, `src/sidepanel/main.ts`, and the profile/facility wire types                                                                     |

Table trace: read `providers`, `facilities`, `provider_facility_assignments`, `credential_cases`, and `case_facilities`; write primary assignment normalization, case creation/location relationships, and corresponding `audit_log` records. Preserve tasks and case status history except for normal case creation. Use additive migrations only and update `docs/data-model/table-register.md` for schema changes. Keep extension and server contracts aligned if any response shape changes.

## Acceptance and verification

- A provider with one assigned location and `is_primary=false` becomes primary automatically. A new manual case and a generated case each contain one primary case location and a matching mirror.
- A provider with several locations defaults to its eligible primary, even when it is not first alphabetically. Several locations without an eligible primary remain unresolved.
- Existing cases with missing locations receive eligible defaults; cases with only a valid mirror gain the missing relationship without changing the chosen location. Repeating the repair makes no additional changes.
- A case created before assignment can acquire its default later. An explicitly cleared case stays cleared, and ambiguous historical empty cases are reported.
- Changing the case primary through Details → Locations updates the extension's name, street, city, state, and ZIP from the chosen facility. Changing the provider primary does not overwrite that case choice.
- With provider primary A and case primary B, opening or reopening the extension shows and fills B. Switching to another case with primary C shows and fills C, even if A or B was remembered previously. Alternate fill selections are restricted to the active case's locations.
- Creating or reconciling a case with a resolvable default cannot report success with an empty `case_facilities` set or a mismatched mirror. The extension receives that persisted case relationship on its first case profile read.
- A genuinely unresolved case reports the missing case location and requires resolution before a fill that depends on location. It never falls back to provider A to conceal the missing relationship.
- Inactive, deleted, unassigned, cross-group, and cross-organization locations cannot become defaults. Case license resolution still uses case state.
- Concurrent creation, assignment changes, manual case edits, and retry scenarios cannot produce duplicate relationships, conflicting primaries, or mismatched mirrors. Every automatic repair has actor and before/after audit evidence.
- A real extension read of a case with the persisted default shows its available practice-location data without manually selecting the location again. Verify the installed extension artifact as well as the server behavior.

Extend the existing case-facility, assignment, creation, profile, and context tests. Update the profile test that currently asserts an empty case location set never falls back: it should still describe a genuinely unresolved persisted case, while new tests prove initialization creates the relationship before the profile is read. Add integration coverage for the transaction and repair, and verify manual creation, generation, and later override in the browser.

## Delivery sequence

First inspect the current RPCs, triggers, all assignment writers, and the distinction between unconfigured and manually cleared cases. Then implement primary normalization and atomic case initialization, followed by assignment-driven reconciliation and the historical repair. Review a dry-run repair report showing affected cases, chosen locations, preserved cases, and unresolved reasons before applying it to a live environment. Complete extension verification after the persisted relationships are correct.

The requested outcome is a reliable default that the coordinator can override. Implementation, live data repair, and deployment are separate follow-up work; no live changes are performed by this handoff.
