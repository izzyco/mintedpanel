# Are we on the right track? Capture, map, auto-fill (Oct 14, 2026)

**For:** PM. **Status:** evaluation only. No product code changed. **Question:** does the work in the Oct 13 architecture-review session and the active 0.1.8 build session lead to one capability that works and is easy to use: capture a payer form's fields, map them, auto-fill the form with its variations, and close the task?

**Method.** Two independent evaluations, one as engineering lead and one as UX lead, each written without seeing the other. Their full reports sit beside this file in `fill-loop-review-2026-10-14/`. This page is the synthesis. Inputs: the old session's transcript and its doc, the active session's summary and its last 15 minutes of transcript (not all 14 hours), extension PR #96 at `bdc8023`, panel `main`, the three spike and review docs, and read-only count queries on production.

---

## 1. Bottom line

1. **Direction right, delivery not yet.** The engine fills forms. Production holds 179 fill records, and bcbs-ks fills average 60 fields. The loop has closed from the extension 4 times ever, all on the old launch path. The new path (Exact Work v2) that 0.1.8 is built on has never recorded a fill in production. At the PR head the close-out still breaks on the most common case, a case that was Not Started at launch, and CI cannot see it.
2. **The confusion is not the side panel. It is two of everything.** Two launch paths, two mapping tiers, two test fills, two close-outs, two trust stamps, three modes. 0.1.8 made the card simpler for the coordinator and the code bigger for the team: `main.ts` grew 639 lines, to 7,275.
3. **The release test cannot pass on the extension alone.** C-1090's Aetna form has 0 token maps under its live key. The 73 trained maps sit under `aetna_direct`, a key no portal row carries. This was flagged Oct 13 and is still true today. That is a one-hour data task.
4. **Nobody has run the whole loop on a real portal.** 0.1.5, 0.1.6, and 0.1.7 each fixed one wall and hit the next. PR #96 still says "Still to do: one end-to-end pass."

---

## 2. What the two sessions did

| Session                      | What it produced                                                                                                                                                                                                                        | What it did not do                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Oct 13, architecture review  | A doc on the fill engine. Verdict: events are right; the real gap is fill order plus no retry after a field appears; capture never writes fallback selectors. Six slices, S1 and S2 safe now.                                           | Nothing was built from it. The doc sits on an unmerged branch. No one picked a fixture portal. |
| Oct 14, 0.1.8 build (active) | UX review, prototype, PM decisions, then PR #96: 20 commits, 34 files, +5,377 / -1,408. Panel PR #516 fixed the server step-id bug. Its own adversarial review found two close-out blockers; two fix agents were running when I looked. | The real-portal pass. The admin setup path. The orphaned Aetna maps. A release gate.           |

The two threads do not reference each other. The engine slices and the UX build are planned as if they were separate products.

---

## 3. Production evidence

Counts only. No names or values were read.

| Fact                                           | Number               | Meaning                                                    |
| ---------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| Organizations / cases / open cases             | 3 / 68 / 62          | Small, real-shaped data                                    |
| Fill records ever saved                        | 179                  | The engine does write forms                                |
| Fill records through Exact Work v2             | 0                    | 0.1.8's path has never filled in production                |
| Case fills since Sept 22                       | 0                    | All 89 fills since then are test-profile fills by one user |
| Submissions logged from the extension, ever    | 4                    | Aug 31 to Sep 21, old path, no fill record attached        |
| Moves to Submitted done by hand in the web app | 36 of 40             | The loop almost always ends by hand                        |
| Auto-fill tasks done / closed by the extension | 21 / 3               | 18 closed by hand                                          |
| Open Auto-fill tasks                           | 11 on 10 portal keys | See below                                                  |

**Can the open tasks fill today?**

| Portal key on the task                                     | Registry row  | Approved token maps            | Fillable                                      |
| ---------------------------------------------------------- | ------------- | ------------------------------ | --------------------------------------------- |
| bcbs-ks                                                    | yes, old path | 33                             | Yes                                           |
| humana-tricare                                             | yes, old path | 33                             | Yes                                           |
| bcbs-nc-enrollment-28602e81c116                            | yes, v2 only  | 18                             | Only by v2 launch                             |
| aetna-direct-enrollment-enrollment-e170b03a3b65 (C-1090)   | yes, v2 only  | 0, plus 3 fixed values         | Writes 3 dropdowns, nothing from the provider |
| aetna_direct                                               | none          | 32, plus 41 fixed              | No. Orphaned                                  |
| aetna-direct-enrollment-enrollment-5da34f03419d            | none          | 0                              | No                                            |
| bcbs-nc-p2-enrollment-form                                 | none          | 0 (31 proposed, never decided) | No                                            |
| caqh-insurance, caqh-location, humana-tricare-status-check | yes           | 4 / 0 / 0                      | Barely or no                                  |

Aetna appears under four keys across registry, maps, tasks, and fills. Fourteen keys hold maps but no registry row; nine are PDF keys, two of them with 157 and 102 proposed rows nobody has decided. Form training produces orphans by design.

---

## 4. Engineering lead findings

**Engine coverage.** Multi-page, iframes, open shadow DOM, hidden controls, radios, custom checkboxes, PrimeFaces, and date formats all work and are tested in jsdom. Cascading reveals are partial: one fresh probe, 700 ms cap, no retry after a field appears, and the panel serves maps unsorted so a child can run before its parent. Masked inputs and custom comboboxes are not handled. Values are never read back, so every fill said "Verified 0" until 0.1.8 hid the count. Nothing in CI touches a real portal.

**Close-out at `bdc8023`, traced in code.** Launch stores `contextVersion 1`. The first fill auto-starts the case and the database bumps it to 2. The coordinator submits and the URL changes. The panel then drops the fill it just made, logs with no fill id and version 1, and the server returns 409 with no retry. A second attempt hits a local 409 because the no-fill idempotency key is bound until browser restart. The second Fill on page 2 is also refused, because the validate route rejects the bumped version by default and the extension has no code that learns the bump. CI is green because the mock API never bumps the version and never checks the work context. Verified: `src/services/workContext.ts:45` defaults to refusing the bump; no extension file reads `did_auto_start`; the mock touches `contextVersion` once, to echo it.

**Admin path.** One path on paper, three surfaces, four forks: flagged forms are invisible to the old path and nothing tells the trainer; maps live under whatever key the trainer used; web, PDF, and xlsx maps share one table and picker; unflagged portals launch legacy while flagged ones launch v2, with two matching rules and two sets of copy.

**Complexity.** Four fill contexts (work, manual, ad hoc, sandbox), two launch paths, two mapping tiers, three modes, about 60 message types, a 67-state matrix. The user surface shrank. The maintenance surface did not.

---

## 5. UX lead findings

**Specialist path, as 0.1.8 ships.** Fixed: the access ask sits in Fill's spot, the result reads "Filled N" and "N need you", Log it works with or without a fill, and "Logging moves this case to Submitted" is honest. Still open:

| Step        | Problem                                                                                                                | Evidence                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| New tab     | The side panel does not open on a v2 launch. Only the legacy path opens it.                                            | PR96 `activeWork.ts:494`; `activeCase.ts:419`; absent from the build list |
| Panel loads | Six picker rows (org, provider, cases on this page, group, location, case) still sit above the task card               | PR96 `main.ts:2008`, `:4318-4340`, `:6824`                                |
| Ready       | No "can fill N fields" count; coverage is off whenever a launch is active                                              | PR96 `main.ts:2231-2232`                                                  |
| Page 2      | The link survives the same origin only. A Continue to another aetna.com host ends it. Untested on Aetna.               | PR96 `activeWork.ts:746-754`                                              |
| Web app     | The drawer still leads with "Mark complete" on a step the server already closed, and shows the portal key as the title | `TaskDrawer.tsx:231-259`                                                  |

**Admin path.** About 17 steps across two apps, three registries, and six trust labels (Registered, Captured, Trained, Proven, Verified, broken). Only one of them gates the fill. There is no handoff from "Register form" to Train forms; the admin finds the extension, the mode, the payer, and the form by hand. Conditional fields are never captured and nothing says "answer the question, then scan again." Drift repair runs in the extension, the decision runs in the panel, and the panel has no link back.

**Jargon still on screen for coordinators:** "Exact work-tab validation", the portal key as a drawer title, "configuration", "mapping generation", "Proven". Good words to keep: Auto-fill, Needs you, Your turn, Log it, Back to case.

---

## 6. Where the two leads agree, and my calls where they differ

Both say: direction right, delivery not; add a release gate; cut the CAQH strip, the AI review DOM, and the dead step-tick message; turn the coverage count on in Work mode; merge the launch paths; fix the context-version chain before shipping.

| Surface                        | Engineering                           | UX                                                                                     | My call                                                                                                              |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Sandbox / test profile         | Keep, it is the release-gate tool     | Merge with mock dry run into one "Test this form"                                      | Merge. One test fill, admin only, on the real form. It becomes the gate tool.                                        |
| Ad hoc fill                    | Hide                                  | Hide from the case list                                                                | Hide. It is the second exception to "pick a case first" and only works on old-path forms the user cannot tell apart. |
| NBA queue inside the extension | Keep (PM said no regression)          | Cut the landing queue, keep "Up next" after logging                                    | Cut the landing queue in 0.1.9. The web app owns the queue. Keep one "Up next" row.                                  |
| Mode chooser                   | Keep                                  | Merge: Search is the empty state of Work cases; Train forms goes under the avatar menu | Merge in 0.1.9. The worker keeps the mode for the org header.                                                        |
| AI fill                        | Cut after one release behind the flag | Cut from the DOM now                                                                   | Cut from the DOM in 0.1.8, delete the 1,700 lines in 0.1.9.                                                          |

---

## 7. The plan: one loop that works

**Phase 0, before any Store upload (this week).**

| #   | Change                                                                                                                                                                                      | Repo  | Size   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| 1   | Move the 73 `aetna_direct` maps to the live Aetna key, or retrain. One actor, Supabase MCP, same day as any code change.                                                                    | data  | S      |
| 2   | Accept the auto-start bump: the validate route and the submission RPC allow version N+1 when the launch's own receipt has `did_auto_start_case`, with or without a fill id. No wire change. | panel | M      |
| 3   | Keep the fill across same-tab URL changes while the link lives; key the no-fill attempt on the launch receipt; release the digest on any 4xx.                                               | ext   | S      |
| 4   | Make the mock API bump the version after the first fill and check `work_context`; add the harness case "fill, URL change, log".                                                             | ext   | S      |
| 5   | Open the side panel on a v2 launch. Hide the six picker rows when a launch is applied.                                                                                                      | ext   | S      |
| 6   | Run the release gate below on real Aetna with C-1090 and paste the result into PR #96.                                                                                                      | PM    | 30 min |

**Phase 1, 0.1.9 and the matching panel release.**

- Cuts: CAQH gap strip, AI review DOM and then its code, the `COMPLETE_TASK_STEP` message, mock dry run (folded into "Test this form"), the mode chooser, the landing queue, the "Proven" and "Verified" stamps (one derived "Ready to fill" state).
- Drawer: hide "Mark complete" on Auto-fill tasks until the server closes the step; show "Waiting for you to submit on Aetna"; stop using the portal key as the title.
- Coverage count in Work mode (needs a Work-scoped coverage read; a small contract addition, mirrored in `apiTypes.ts`).
- Engine S1 (serve maps in page and reading order) and S2 (focus before write, one read-back pass so "Filled N" is true).
- Page-2 rule: same site, not same origin, verified on Aetna.

**Phase 2, after telemetry from real fills.**

- S3, the content-local executor with retry after a field appears, built against Aetna as the fixture. This is the slice that decides whether cascades work on real portals.
- S4, capture writes fallback selectors and demotes framework ids.
- One launch path: re-register the four unflagged portals as v2 configurations and retire `SET_ACTIVE_CASE` (591 lines).
- A train handoff from "Register form" into Train forms on that form, and guided capture for conditional fields (S5).

**Stop doing.** Adding states and copy to `main.ts`. Adding exactness machinery (new versions, receipts, fingerprints, stamps) before the existing chain closes a loop. Adding registries or trust labels.

**Release gate, every Store upload and every panel deploy that touches this loop.** On production, a Not Started case on a two-page form (C-1090 shape):

1. Open the case, click Work in portal. The side panel opens itself on the new tab.
2. First visit: allow the site from the Fill spot. Fill appears.
3. Fill page 1. Result reads "Filled N" and names what needs you.
4. Click Continue on the portal. The panel keeps the case and offers Fill on page 2.
5. Fill page 2. It must not say "context changed".
6. Submit on the portal. On the confirmation page the panel is still linked.
7. Log the submission with a confirmation number. It must succeed.
8. Change the number and log again. A second touch, not a local 409.
9. In the web app: step done, case Submitted, two touches, one fill record per page with `case_step_key` set.
10. Test this form with the test provider on a regular form, then clear it.

Automated stand-in: the harness case from Phase 0 item 4 plus a jsdom cascade fixture. Neither replaces steps 1 to 9.

---

## 8. Decisions for you

**Q1. Ship order.**
(a) Phase 0 first, then release 0.1.8. **Recommended.**
(b) Release 0.1.8 now as a UX step; fix close-out in 0.1.9.
(c) Hold 0.1.8 until the Phase 1 cuts are in too.

**Q2. Aetna maps.**
(a) Migrate the 73 approved maps to the live key with a generation bump; review the 8 proposed rows by hand. **Recommended.**
(b) Retrain the form under the live key.
(c) Leave it and test on bcbs-ks instead.

**Q3. Launch paths.**
(a) Keep both through 0.1.8; in 0.1.9 re-register the four unflagged portals as v2 and retire legacy. **Recommended.**
(b) Keep both indefinitely.
(c) Turn v2 off and go back to legacy.

**Q4. 0.1.9 cut list.**
(a) All of section 7 Phase 1. **Recommended.**
(b) Only the dead code: CAQH strip, AI, step-tick message.
(c) None until after launch.

**Q5. Who runs the release gate.**
(a) You, on production with C-1090, results pasted into the PR. **Recommended.**
(b) An agent through Claude in Chrome on your machine, with you watching.
(c) Staging only.

---

## 8a. Phase 0 status (Oct 14, evening)

PM decisions: Q1 (a), Q2 (a), Q3 (a) adopted. Q4 (the 0.1.9 cut list) is deferred for a later scope review. Q5 is open; the gate below assumes the PM runs it.

| #   | Phase 0 item                                                                   | State                                                                                                                                                                                                                                                                                                                                                                                                         | Where                    |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Aetna maps under the live key                                                  | **Done.** 70 approved + 8 proposed rows copied from `aetna_direct` to `aetna-direct-enrollment-enrollment-e170b03a3b65` (3 selectors already there were skipped). The live config now holds 73 approved maps over 9 pages at generation 1. Copy, not move: the originals stay for the 11 task steps that still name `aetna_direct`. Rollback is one DELETE on the `copied-from:aetna_direct 2026-10-14` note. | production, Supabase MCP |
| 2   | Accept the auto-start bump                                                     | **Done by the 0.1.8 session, extension side** (commits f8732c5 and cd7850f on PR #96): the worker observes the launched case at the tuple's version and advances the tuple to N+1 after a recorded typed fill, so page 2 fills and a no-fill log validates. The server stays strict. No panel change needed.                                                                                                  | ext PR #96               |
| 3   | Keep the fill across page changes; per-launch no-fill keys; release on 4xx     | **Done by the 0.1.8 session** (f8732c5, ad03610, d6bfd18).                                                                                                                                                                                                                                                                                                                                                    | ext PR #96               |
| 4   | Mock API bumps the version; harness case                                       | **Done by the 0.1.8 session** (f8732c5: the mock models context_version, the first-fill auto-start, the fill guard and the typed touch rule).                                                                                                                                                                                                                                                                 | ext PR #96               |
| 5   | Open the side panel on a v2 launch; hide the picker rows above a launched task | **Done.** Commit 5472124 on `claude/keen-edison-bk5lk2`, stacked on PR #96's head 74b4d29, cherry-pickable. tsc, eslint, 1023 tests, 75 release-contract tests, both builds pass.                                                                                                                                                                                                                             | ext                      |
| 6   | Release gate on real Aetna with C-1090                                         | **Open. PM action.** Steps 1 to 10 in section 7, result pasted into PR #96.                                                                                                                                                                                                                                                                                                                                   | PM                       |

Not changed on purpose: the server still refuses a bumped version by default (`workContext.ts`); the extension carries the version forward instead. The page-2 "same origin" link rule and the side-panel open both get their real test in the gate.

## 9. Limits of this review

The close-out defects are traced in code and in the mock, not reproduced on a live portal. The page-2 "left the site" rule and the side-panel-open gap are code reads and match the Oct 13 recording, but one Continue on Aetna settles both. Production numbers are counts as of Oct 14; the sandbox cannot reach payer portals. I read the active session's compaction summary and its last 15 minutes, not the full transcript.
