# Spike: "Work in portal" lands with no context, and Fill stays disabled (2026-10-13)

Investigation only. No code changed. Source: the 48-second screen recording of
case C-1090 (Joseph Knapp · Aetna · KS · Kansas Fitness Physio), Workbench
v0.1.6, production panel (`mintedpanel.vercel.app`).

## TL;DR

| #                    | Symptom in the video                                                                                                                                                     | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                    | Side panel opens on the Aetna tab showing only "Select an organization…". No case, no banner. User has to copy the case number and search.                               | Multi-org account with no org stored in the worker. The handoff IS received and stored. The "A case was handed off in Kansas Fitness Physio · Switch to…" prompt is rendered inside `#case-work`, which is hidden until an org resolves. The user never sees it. Picking the wrong org from the dropdown then wipes the stored handoff.                                                                                                                                 | extension `sidepanel.html` (`#handoff-banner` inside `#case-work`), `renderModeSurfaces`, `loadOrgs`, `maybeApplyHandoff`; worker `SET_ACTIVE_ORG` → `clearOrgScopedState`                            |
| 2                    | On the Aetna form, with provider + case + location selected, "Fill this page" is grey and the hint reads "Open a registered payer portal in the current tab to fill it." | The Aetna portal row is `requires_explicit_selection = true` (MINT-48 independent configuration). `GET /api/portals` deliberately hides every such row from the legacy extension path, so the registry the Workbench matches the tab URL against does not contain Aetna. The only path that can use that row (Exact Work v2, `SET_ACTIVE_WORK`) is behind `VITE_ENABLE_EXACT_WORK_V2`, which is not on in the production build. The row is unreachable from both paths. | panel `src/services/portals.ts` `listPortalsForApi` (`legacyBlockedKeys`), `src/server/extensionRoutes.ts` `filterLegacyPortalRows`, `src/components/portals/PortalStepLink.tsx` (`useExactWorkflow`) |
| 3 (found on the way) | Even once the page is recognized, the fill would write nothing from provider data.                                                                                       | The new key `aetna-direct-enrollment-enrollment-e170b03a3b65` has 3 approved maps, all `hardcoded` with `token = null` (the three "I am interested in / applying for / joining" selects). The 73 approved maps trained for Aetna live under the old key `aetna_direct`, which has no `portals` row at all.                                                                                                                                                              | `portal_field_maps` on production                                                                                                                                                                     |

Bug 1 is an extension UX/state bug. Bug 2 is a panel product gap: the new
"Form setup" registration flow produces configurations the shipped fill path is
designed not to see.

## What the video shows (timeline)

| t         | Event                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:05      | Case page. One task "Fill online Join Provider Network form on Aetna website" (Auto-fill), step portal key `aetna-direct-enrollment-enrollment-e170b03a3b65`, chip "Verified".                                                                                   |
| 0:07      | "Work in portal" clicked. Drawer text afterwards: "Portal tab requested… Extension received the case. Sign-in and access are checked there." This is the LEGACY `WorkInPortalButton` wording, so the panel sent `SET_ACTIVE_CASE`, not the v2 `SET_ACTIVE_WORK`. |
| 0:09      | Aetna tab opens at `https://extaz-oci.aetna.com/pocui/join-the-aetna-network`.                                                                                                                                                                                   |
| 0:13      | Side panel opened. Mode = Work cases. Org select = "Select an organization…". Nothing else.                                                                                                                                                                      |
| 0:17–0:21 | Second "Work in portal" click opens a second Aetna tab. Panel still empty.                                                                                                                                                                                       |
| 0:25      | User picks "BEST Physical Therapy LLC" from the org dropdown (wrong org), then "Kansas Fitness Physio". Queue renders. No handoff banner.                                                                                                                        |
| 0:33–0:37 | User copies C-1090, searches, selects Joseph Knapp. Case "Aetna - KS - Not Started", location "Fitness Physio - West Central".                                                                                                                                   |
| 0:41–0:48 | On the Aetna tab: hint "Open a registered payer portal in the current tab to fill it." Fill button disabled.                                                                                                                                                     |

## Facts pulled from production (`fkvuhfsqcmujywzgczmc`)

- `credential_cases` `74354240-…` created 21:08:51 UTC; the task is `execution_type = extension_fill`, step `stepType = online_form`, `portalKey = aetna-direct-enrollment-enrollment-e170b03a3b65`.
- `portals` row `eacaf46e-…`: `org_id NULL`, `form_url = https://extaz-oci.aetna.com/pocui/join-the-aetna-network` (exact match for the tab), `is_verified = true`, `case_type = enrollment`, **`requires_explicit_selection = true`**, `mapping_generation = 1`, `proven_at NULL`. Last updated 21:00 UTC, before the recording.
- Two other rows carry the same flag: `bcbs-kc-enrollment-f5d8b85e5ce8`, `bcbs-nc-enrollment-28602e81c116`. Every other row (availity, bcbs-ks, caqh_proview, humana-tricare, holista, …) is `false`.
- `portal_field_maps` for the new Aetna key: 3 rows, `approved` / `hardcoded` / `token NULL`, `page_step = join-the-aetna-network`. For `aetna_direct`: 73 approved (32 token, 35 hardcoded, 6 manual) + 8 proposed. No `portals` row exists for `aetna_direct`.
- The account is a member of at least two orgs (BEST Physical Therapy LLC, Kansas Fitness Physio), as the dropdown in the video shows.

## Bug 1 — handoff received but invisible, then destroyed

Chain, with file pointers (extension repo):

1. `handleExternalMessage` (`src/background/activeCase.ts`) accepts the message, stores `minted.activeCase` with `source: "handoff"`, `orgId = Kansas`, sets panel mode to `case`, opens the side panel. The panel's "Extension received the case" receipt is truthful.
2. Side panel boot (`src/sidepanel/main.ts`, `showMain`): `loadOrgs()` sees two memberships and `GET_ACTIVE_ORG = null` (session storage, fresh browser). It renders the placeholder, sets `orgReady = false`, and `renderModeSurfaces()` hides `#case-work`.
3. `refreshActiveCase()` → `maybeApplyHandoff()` → `evaluateHandoffOrg(record, members, resolvedOrg = null)` returns `needs-org-switch`. `renderHandoffBanner()` writes "A case was handed off in Kansas Fitness Physio. [Switch to Kansas Fitness Physio]" into `#handoff-banner`.
4. `#handoff-banner` is the first child of `#case-work` (`sidepanel.html` line 235–236). `#case-work` is hidden. The prompt exists in the DOM and is invisible. The user sees only the org select.
5. The user picks an org by hand. `orgSelect` change → `SET_ACTIVE_ORG` → `clearOrgScopedState(request.orgId)` → `clearActiveCaseForOrgChange(preserveHandoffOrgId)`. The handoff survives only if the chosen org equals the handoff's org. The user chose BEST first, so the record was deleted. Choosing Kansas afterwards had nothing left to apply.

Browser confirmation (built v0.1.6 bundle loaded into Chromium, local mock of the panel API serving two memberships, `minted.activeCase` seeded with the handoff record, active tab faked to the Aetna URL):

| Scenario                                           | `#case-work` hidden | Banner text                                                                       | Visible to user | Stored handoff after |
| -------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- | --------------- | -------------------- |
| Handoff, no org stored (the video)                 | yes                 | "A case was handed off in Kansas Fitness Physio. Switch to Kansas Fitness Physio" | **no**          | present              |
| … then user picks BEST                             | no                  | ""                                                                                | —               | **null (wiped)**     |
| … then user picks Kansas                           | no                  | ""                                                                                | —               | null                 |
| Handoff, no org stored, user picks Kansas directly | no                  | "Working from a Minted Panel handoff. Return to case ↗"                           | yes             | present, applied     |
| Handoff, org already stored (control)              | no                  | "Working from a Minted Panel handoff. Return to case ↗"                           | yes             | present, applied     |

So the designed explicit-switch path works, but only if the user can see it. Any
wrong guess from the dropdown is destructive.

Fix directions (for the PM to pick, not implemented here):

- **A. Move the prompt out of `#case-work`** (above or beside `#org-field`), so `needs-org-switch` is visible whenever an org is unresolved. Smallest change; keeps "explicit, never silent".
- **B. Pre-select the handoff's org in the dropdown** when the user is a member and no org is stored, and route that through `SET_ACTIVE_ORG_FOR_HANDOFF` so the record is preserved. Removes the click entirely for the common case. Changes the "never silent" rule, which was a deliberate decision in `renderHandoffBanner`.
- **C. Stop a plain `SET_ACTIVE_ORG` from destroying a live handoff for another org** (keep the record, re-show the switch prompt). Defensive; worth doing alongside A or B.

## Bug 2 — the Aetna configuration is invisible to the fill path that is actually shipped

Chain, with file pointers (panel repo unless noted):

1. "Form setup" on the template's online-form step registers an **independent configuration** (`createPortal`, `src/services/portals.ts` ~line 316: `requires_explicit_selection: input.caseType != null`). MINT-48 (`2b28d74`, 2026-09-30) added this, and migration `20261005120000_mint48_independent_portal_configurations.sql` enforces the flag by trigger. The Aetna row is one of these.
2. `listPortalsForApi` drops every key that has a flagged row (`legacyBlockedKeys`), and `handleListPortals` filters again (`filterLegacyPortalRows`). Both carry comments saying an older extension must not choose a flagged configuration by URL. Pinned by `src/server/extensionRoutes.test.ts` ("hides an explicit-only exact key…", "hides mixed global-explicit…"). This is by design, not a regression.
3. The Workbench recognizes a page purely by `matchPortalByUrl(tab.url, rows from GET /api/portals)` (extension `src/shared/portals.ts`). With no Aetna row, the match is null, `portal == null`, `isFillReady()` is false, and the hint says "Open a registered payer portal…" even though the URL equals the registered `form_url` character for character.
4. The intended consumer of flagged rows is Exact Work v2: `PortalStepLink` builds a `SET_ACTIVE_WORK` tuple and uses `WorkInPortalV2Button` only when `import.meta.env.VITE_ENABLE_EXACT_WORK_V2 === "true"` **and** the configuration requires explicit selection (`574e353`, 2026-10-09, "default to manual portal launch"). The receipt wording in the video proves the production build took the legacy branch, so the flag is off there. Vercel could not be queried from this session (403 on the `minted` team scope), so this is inferred from the UI text, not read from the env.
5. Net effect: a configuration registered through the current Form setup flow is served to nobody. Legacy fill hides it, v2 is switched off. The "Verified" chip on the step is true (`is_verified`) and misleading in this state.

Browser confirmation (same harness, org stored, active tab faked to the Aetna URL):

| `/api/portals` rows served                                      | `#portal-status`                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| Production registry as the route serves it today (no Aetna row) | "Open a registered payer portal in the current tab to fill it." |
| Same + the Aetna row with the flag cleared                      | "aetna-direct-enrollment form detected in the current tab."     |

Fix directions:

- **A. Turn on `VITE_ENABLE_EXACT_WORK_V2` in production.** This is the path MINT-48/52/56 built for flagged rows. Needs: a Workbench release that handles `SET_ACTIVE_WORK` (v0.1.6 already has `handleExternalSetActiveWork`), the `/api/work-context/validate` route live, and the configuration `isReady` (see bug 3: zero token maps means `effectiveMappingFingerprint`/`mapping_ready` may not pass). Verify on staging first.
- **B. Register Aetna as a legacy (unflagged) portal** for now, so the shipped legacy path recognizes it. Cheapest unblock for this one payer, but MINT-48's trigger refuses to clear the flag on an existing flagged row, so it would be a new row + re-pointing the step key, and it re-opens the URL-twin ambiguity MINT-48 removed.
- **C. Product rule:** while v2 is off, Form setup should either refuse to create flagged configurations or warn that the extension cannot fill them yet. Today it quietly produces a dead end.

## Bug 3 — mapping coverage for the new key

Whichever path is chosen, the fill will do almost nothing until the Aetna maps
exist under the new key. Options: re-train the form under
`aetna-direct-enrollment-enrollment-e170b03a3b65`, or a one-time move/copy of
the 73 `aetna_direct` maps to the new key (data operation via Supabase MCP,
with the `mapping_generation` bump the MINT-52 resolver expects). The 8
`proposed` rows under `aetna_direct` are unreviewed observations and should be
reviewed, not blindly copied.

## Things ruled out

- Host permission for `extaz-oci.aetna.com` is not the blocker: the "Enable form capture & fill" prompt derives its origins from the same registry rows, so with Aetna missing it has nothing to ask for; and in the counterfactual run the page was recognized as soon as the row was present.
- The handoff message itself is well-formed; the worker accepted it (`ok: true`) and stored it with the right org id. No receipt timeout, no CORS, no extension-id mismatch.
- No Exact Work (`SET_ACTIVE_WORK`) record was involved, so the `activeWorkState` gates in `isFillReady()` did not fire.
- The `portals` row's `updated_at` (21:00 UTC) predates the recording (~21:15 UTC), so the state analysed here is the state the user saw.

## Method

- Frames extracted from the recording at 1 fps and read.
- Production rows read through the Supabase MCP (read-only SQL).
- Code traced in both repos at `claude/charming-ptolemy-0dao2g` (= `main` as of 2026-10-13).
- Browser repro: extension built with `VITE_API_BASE_URL` / `VITE_SUPABASE_URL` pointed at a local wrapper around `scripts/mock-panel-api.mjs` (CORS added, `/api/me/orgs` and `/api/portals` overridden with the production rows above), loaded unpacked into Chromium (`--headless=new`) via Playwright, session + worker state seeded through `chrome.storage.session`, `chrome.tabs.query` stubbed in the side-panel page to return the Aetna tab. Real production hosts are not reachable from the sandbox.

## Questions for the PM

1. Exact Work v2 in production: (a) turn it on now for flagged configs, (b) keep it off and add a Form-setup guard, (c) staging soak first?
2. Bug 1 fix shape: (a) move the switch prompt above the org picker, (b) auto-select the handoff's org for members, (c) both plus protect the record from a wrong manual switch?
3. Aetna maps: (a) re-train under the new key, (b) migrate the 73 approved `aetna_direct` maps, (c) leave until v2 lands?
