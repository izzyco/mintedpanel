# Engineering evaluation: one reliable fill loop (2026-10-14)

Read-only. Panel `main`, extension `main` (0.1.7), extension PR #96 at `bdc8023`. `ext:` = extension repo, `panel:` = panel repo, `pr96:` = the PR worktree.

## Verdict

Not yet on track for "one loop that works". The engine and the capture tooling are real and well tested in jsdom, but the close-out loop at `bdc8023` still breaks on the most common case (a case that was Not Started at launch), and nothing in CI can see it. The direction of PR #96 is right for the coordinator (fewer buttons, plainer words) and wrong for the budget (main.ts grew 639 lines, the panel now has four fill contexts and ~67 states).

## 1. Fill engine coverage

All tests are jsdom (`ext:src/content/fillEngine.test.ts:2`, 46 cases) or the mock harness (`ext:src/harness/workbench.test.ts`, 2946 lines, against `scripts/mock-panel-api.mjs`, 1262 lines). The fixtures declare themselves synthetic (`ext:src/__fixtures__/dom/portalScenarios.test.ts:16`). Nothing in CI touches a real portal.

| Variability                              | State                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-page (pageStep, DYN-PAGE-01)       | Works, tested                                                                                            | `fillEngine.test.ts:112,174,212,243`                                                                                                                                                                                                                                                                     |
| Iframes                                  | Works, tested with stubs                                                                                 | `frameMessaging.ts` (969 lines), `frameMessaging.test.ts:123-710`; per-frame inject `inject.ts`                                                                                                                                                                                                          |
| Open shadow DOM                          | Works, tested (BCBS cf-checkbox)                                                                         | `deepDom.test.ts:83-294`                                                                                                                                                                                                                                                                                 |
| Hidden controls (DYN-PAGE-02)            | Works, tested                                                                                            | `fillEngine.test.ts:277-427`                                                                                                                                                                                                                                                                             |
| Cascading selects / reveals              | Partial, untested on a real portal                                                                       | One fresh probe per later field, 700 ms cap, no retry after a reveal (arch review gaps 2.1 to 2.4). Panel serves maps unsorted, so a child can run before its parent. Only `fillEngine.test.ts:1235` and `frameMessaging.test.ts:382` cover it. R2 recording shows Aetna's 3 cascading selects did fill. |
| PrimeFaces                               | Works, tested synthetic                                                                                  | `primeFaces.ts` (23 lines), `fillEngine.ts:1362`, tests `505-570,916,1123`                                                                                                                                                                                                                               |
| Radios                                   | Works, tested                                                                                            | `fillEngine.test.ts:362-385,795`                                                                                                                                                                                                                                                                         |
| Checkboxes incl. custom                  | Works, tested                                                                                            | `deepDom.test.ts:186-294`                                                                                                                                                                                                                                                                                |
| Date formats                             | ISO write plus one bounded readback for masks                                                            | `fillEngine.test.ts:490,595,624`; `fillEngine.ts:1452-1508`                                                                                                                                                                                                                                              |
| Masked text inputs                       | Not handled (no keyboard events, no `focus()` before write; grep finds no `.focus()` in `fillEngine.ts`) | arch review 1.1, 1.2                                                                                                                                                                                                                                                                                     |
| Custom comboboxes (`div[role=combobox]`) | Not handled, reported `unsupported`                                                                      | `fillEngine.ts:262,645,924`                                                                                                                                                                                                                                                                              |
| Value verification                       | Never reads back, so every fill reports "Verified 0"                                                     | UX review section 6, `fillEngine.ts` ~1447                                                                                                                                                                                                                                                               |

## 2. Capture and mapping

What exists: shape-only capture (`captureScan.ts` 575, `controlScanner.ts` 335, `elementPicker.ts` 318, all tested), propose-only POSTs on two tiers (`ext:src/background/api.ts:215-232` org tier, `:240-290` shared tier), panel decisions in `panel:src/components/templates/FormStepPanel.tsx:319-391` (`trainGlobalMut`, `approveFieldMap` via `useMappingReview.ts:70`), `mapping_generation` pinning, the Selector Workshop, drift re-point. `selector_fallbacks` is read in five places and written nowhere (`fillEngine.ts:758` always `[]`).

The admin path from "new payer form" to "fill works" is one path on paper but crosses three surfaces and forks four times:

1. Register the form from the template's Form setup (`FormStepPanel.tsx:829`). Any form with a case type gets `requires_explicit_selection = true` (`panel:src/services/portals.ts:316`). The extension cannot register a form (`ext:src/shared/trainForms.ts:253`).
2. Switch to the extension's Train forms mode (admin only), capture per page, send proposals to the shared tier.
3. Back in the panel, decide each row, then Finish training bumps the generation.
4. Fork A: a flagged form is hidden from `GET /api/portals` (`panel:src/server/extensionRoutes.ts:549-551`, `portals.ts:189-198`). Manual pick, ad hoc fill, and the coverage card never see it; only a v2 launch does. Nothing in the trainer says so.
5. Fork B: maps live under the key the form was trained with. Production Aetna has 73 approved maps under `aetna_direct` (no portal row) and 3 hardcoded ones under the live key (handoff spike, bug 3). The fill will write almost nothing until this is moved.
6. Fork C: web, pdf, and xlsx maps share one table and one picker (`portalFieldMaps.ts:64,222-227`) with a second panel for PDFs (`PayerFormFieldPanel.tsx`).
7. Fork D: unflagged portals (availity, bcbs-ks and the rest) still launch through legacy `SET_ACTIVE_CASE`; flagged ones through v2 (`PortalStepLink.tsx:177-180`, `vercel.json:9` turns v2 on). Two launch paths, two matching rules, two sets of error copy.

## 3. Close-out at `bdc8023`

Trace, single page, case launched at Not Started: launch (`activeWork.ts:444`) stores the tuple with `contextVersion = 1`. Fill runs, the receipt saves (PR #516 fixed the step id), the insert trigger marks `did_auto_start_case` and MINT-51 bumps the case to `context_version = 2` (`panel:supabase/migrations/20261006153000:227`, `20261006144500:34-74`). The coordinator clicks Submit on Aetna. The tab lands on a confirmation page.

**Blocker 1 (open).** The URL change runs `detectPortal` -> `invalidateFillSelection` -> `clearFillResults`, which sets `lastFill = null` unless a log is already done (`pr96:src/sidepanel/main.ts:3345-3368, 2022-2053`). Log submission then sends `fillSessionId: null, isWorkFill: true` (`main.ts:4249-4270`). The worker takes the live launch tuple, still `contextVersion 1` (`pr96:src/background/index.ts:2245-2255`). The RPC requires the exact version unless `p_fill_session_id` names the receipt that auto-started the case (`20261014120100:287-314`). Result: 409 "This task changed in Minted Panel", no Retry (`closeOut.ts:151-157`). This hits every brand-new case, not only the two-page path, because the designed order is submit first, then log.

**Blocker 2 (open).** A no-fill log keys its idempotency id and payload digest on `${caseId}.none` (`index.ts:2299-2300, 2324-2332`). The digest is bound before the POST and released only after success (`:2339-2342`); otherwise it is cleared only by an org change or sign-out (`:344-359`). After the 409 above, any retry with a changed confirmation number, or a re-launch (new `launchReceiptId` in `work_context`), throws the local 409 "This submission may already be recorded" (`:969-1001`).

**Page-2 fill after the bump (open, predates PR #96).** Before every fill the extension revalidates its launch tuple (`activeWork.ts:676-690`). The validate route calls `validateWorkContext` with `allowAutoStartedContextVersion = false` (`panel:src/services/workContext.ts:277-282, 50-56`), and the insert guard demands the exact version (`20261014120000:333`). The extension has no code that learns the bump (grep for `did_auto_start` in `ext:src` returns nothing). So the second Fill on a case that was Not Started at launch is refused with "The Work context or portal mapping changed."

Why CI is green: the mock touches route ignores `work_context` and `context_version` (`mock-panel-api.mjs:883-960`), the mock validate compares tuples for equality only (`:604-633`), and no test drives a URL change followed by `MARK_SUBMITTED`. PR #96 added 4 harness cases for no-fill logging (`workbench.test.ts:520-561`), all against a mock that never bumps.

## 4. Half-built, dead, or duplicate surfaces

| Surface                              | Evidence                                                                                            | Lines                                                                                                                | Verdict                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| AI fill (Nano, review, Good Catch)   | `AI_FILL_ENABLED = false` (`pr96:src/shared/config.ts:19`); 103 refs in `index.ts`, 92 in `fill.ts` | ~1,700 (`nanoAi` 441, `aiFillEngine` 141, `aiReviewController` 125, `nanoMock` 183, `fill.ai.test` 546, plus inline) | Cut in 0.1.9 after one release behind the flag        |
| CAQH exception strip                 | Documented unfinished; `caqhGapRows` has no writer                                                  | `caqh.ts` 112 + 38 refs in `main.ts`                                                                                 | Cut now                                               |
| Mock dry run (Train)                 | `RUN_MOCK_DRY_RUN`, `mockFill.ts`, `mockFillProfile.ts`                                             | ~600                                                                                                                 | Hide; cut if "Mark proven" is dropped                 |
| Ad hoc fill                          | Second exception to the locked rule; adds states B13                                                | `AD_HOC` 16 refs                                                                                                     | Hide for 0.1.8                                        |
| Sandbox test mode                    | Only no-case test path; grew 57 to 179 lines in PR #96                                              | 150 refs in `main.ts`                                                                                                | Keep, it is the release-gate tool                     |
| Legacy `SET_ACTIVE_CASE`             | Still the path for every unflagged portal                                                           | `activeCase.ts` 591                                                                                                  | Keep until every form is a v2 config, then delete (L) |
| `PATCH /api/tasks/:id/steps`         | Extension caller removed; `COMPLETE_TASK_STEP` message stays                                        | `api.ts:201-212`                                                                                                     | Cut the extension message now; keep the panel route   |
| Train forms mode                     | The admin capture path                                                                              | 296 train/capture refs in `main.ts`                                                                                  | Keep; move to its own page later                      |
| Checklist task picker                | Removed in PR #96                                                                                   | 0                                                                                                                    | Done                                                  |
| Coverage card in Work mode           | Off by design (`main.ts:2232`)                                                                      | small                                                                                                                | Keep off                                              |
| `selector_fallbacks`                 | Never written                                                                                       | reader code only                                                                                                     | Leave; S4 later                                       |
| Fill-event v2 telemetry              | It is the receipt that closes out                                                                   | `fillEventV2.ts` 275                                                                                                 | Keep                                                  |
| MINT-64 harness                      | A test, not a surface                                                                               | 459                                                                                                                  | Keep                                                  |
| Quick cards layout editor, NBA queue | PM required no regression                                                                           | ~300                                                                                                                 | Keep                                                  |

## 5. Complexity budget

`main.ts` 6,636 to 7,275 lines (+639), `index.ts` 2,444 to 2,481, `sidepanel.css` 2,617, `sidepanel.html` 668, about 60 message types. For the coordinator 0.1.8 removes concepts: step ticking, the task picker, AI controls, engineer wording, four copies of the case. For maintainers it adds: `closeOut.ts` (262), `workLinkNotice.ts` (70), end reasons, a 67-state matrix, and still keeps two launch paths, two map tiers, three panel modes, and four fill contexts (work, manual, ad hoc, sandbox). The user surface shrank; the maintenance surface did not.

## 6. Recommendation

**(a)** The engine is good enough for one loop today; the loop fails at close-out on new cases and nobody can see it in CI. Fix the context-version chain first, then ship 0.1.8.

**(b) Minimum ordered changes**

1. panel, M: let the validate route and the submission RPC accept the one auto-start bump when a receipt with the same `launch_receipt_id`, task and step has `did_auto_start_case = true`, with or without `p_fill_session_id`. Fixes blocker 1 and the page-2 fill with no wire change.
2. ext, S: in Work mode keep `lastFill` across same-tab URL changes while the link lives, so the log names its fill.
3. ext, S: key the no-fill idempotency on `${caseId}.${launchReceiptId}` and drop the digest on any 4xx.
4. ext, S: mock touches route checks `work_context.contextVersion` and bumps after the first fill; add one harness case "fill, URL change, log".
5. panel, S: order served maps by `page_step, sort_order, created_at` (S1).
6. ext, S: `focus()` before write and one post-pass value readback (S2), then show "Filled N".
7. data, S: move the 73 `aetna_direct` maps to the live key or retrain; verify with the Selector Workshop.
8. ext, S: cut the CAQH strip and the dead step-tick message; hide ad hoc.

**(c) Cut or hide now:** CAQH strip, `COMPLETE_TASK_STEP`, ad hoc fill, mock dry run. Keep AI off and delete it next release.

**(d) S1 to S6:** S1 and S2 are reliability and go now (S each). S3 (content-local executor with reveal retry) is the slice that decides whether cascades work on real portals; build it against Aetna as the fixture, M. S4 (capture fallbacks, demote framework ids) is reliability against redeploys, do after S3 telemetry. S5 and S6 are polish; defer.

**(e) Release gate.** On production, with a case that is Not Started and a form with at least two pages (Aetna C-1090 shape):

1. Open the case, click Work in portal. Side panel opens itself on the new tab.
2. First visit: allow the site from the Fill spot. Fill shows.
3. Fill page 1. Result reads "Filled N", no "Verified".
4. Click Continue on the portal. Panel keeps the case and offers Fill on page 2.
5. Fill page 2. Must not say "context changed".
6. Submit on the portal. Land on the confirmation page. Panel still linked.
7. Log submission with a confirmation number. Must return 200.
8. Change the number and log again. Must create a second touch, not a local 409.
9. In the panel: task step done, case Submitted, two `touches` rows, one `fill_sessions` row per page with `case_step_key` set.
10. Sandbox: fill a regular form with the test provider, clear it.

Automated stand-in: the harness case from (b) 4 plus a jsdom fixture for a state-to-county cascade. Neither replaces step 1 to 9 on a real portal.
