# UX evaluation: capture, map, auto-fill (panel main + extension PR #96)

Oct 14, 2026. Read-only. Evidence is file:line on panel `main`, extension `main` (v0.1.7), or the PR #96 worktree (marked PR96).

## Verdict

**Right direction, not there yet.** 0.1.8 is the first release shaped around the coordinator's loop. It fixes the three real walls (access ask in Fill's spot, honest result card, close-out without a fill record). But four holes stay open on the specialist path, and the admin setup path was never designed as one path: about 17 steps, two apps, three registries, six trust labels, and only one gates the fill.

**Change how the team works:** no Store upload or panel deploy that touches this loop until one person runs the whole loop on a real portal and pastes the result into the PR. PR #96 still says "Still to do: one end-to-end pass". 0.1.5 to 0.1.7 each fixed one wall and hit the next.

## 1. Three personas

### (a) Specialist fills a trained form (as 0.1.8 ships)

| #   | Step        | What she sees                                                                                                                          | Severity                      | Evidence                                                                                                   |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Case page   | Task row "Auto-fill", inline "Work in portal". Good.                                                                                   | OK                            | `CaseTasksPanel.tsx:402-411`                                                                               |
| 2   | Task drawer | "Mark complete" at the top. Box "Aetna Direct Enrollment Enrollment E170b03a3b65 · Verified". "Waiting for exact work-tab validation…" | **Major**                     | `TaskDrawer.tsx:231-259`, `PortalStepLink.tsx:61`, `WorkInPortalV2Button.tsx:30-54`, `StepDetails.tsx:147` |
| 3   | New tab     | Tab opens. **Side panel does not.** The v2 launch never calls `sidePanel.open`; only the legacy path does.                             | **Major, open in 0.1.8**      | PR96 `activeWork.ts:494`; `activeCase.ts:419`. Review rec 7.8; absent from build list 10.4 and the PR body |
| 4   | Panel loads | Organization select, provider bar with "Change", "Cases that use this page" list, Group, Location, Case dropdowns, then the card       | **Major, open**               | PR96 `main.ts:6824`, `:2008`, `:4318-4340`; review section 4 rows 4, 8, 10, 11, 13                         |
| 5   | First visit | "One-time setup for this Aetna site" in Fill's spot. Good.                                                                             | Fixed                         | PR96 `main.ts:3433-3434`                                                                                   |
| 6   | Ready       | "Aetna form found on this tab." No "can fill N fields": coverage is off whenever a launch is active                                    | Major                         | PR96 `main.ts:2231-2232`                                                                                   |
| 7   | Result      | "Filled 3 fields." "N need you." "Your turn 1, 2, 3." Good.                                                                            | Fixed                         | PR96 `main.ts:2566-2605`                                                                                   |
| 8   | Page 2      | Link survives same origin only. A Continue to another aetna.com host ends it: "tab left the payer's site"                              | **Blocker if true, untested** | PR96 `activeWork.ts:736-742`; review reviewer note 4                                                       |
| 9   | Log         | "Submitted on Aetna? Log it", with or without a fill. "Logging moves this case to Submitted." Good.                                    | Fixed                         | PR96 `main.ts:1704-1714`                                                                                   |
| 10  | Web app     | Drawer still leads with "Mark complete" on a step the server already closed                                                            | Major                         | `TaskDrawer.tsx:231`; review Next item 5, unscheduled                                                      |

Decisions: org (multi-org), Allow, Fill per page, Log. Concepts: Work in portal, side panel, allow site, "need you", log. Close to right. Rows 3, 4, 6, 8, 10 keep it from easy.

### (b) Admin sets up a new payer form

| #   | Step                                                   | What she sees                                                                                                                                                                  | Severity  | Evidence                                                                                                               |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Wizard → "Register portal" or "Register global portal" | "creates a new independent configuration with its own key and no field maps. It starts unverified; training and verification remain separate steps." "Form URL (optional)"     | **Major** | `FormStepPanel.tsx:930-944`, `:960`. No URL means no launch button (`PortalStepLink.tsx` "Portal URL not set.")        |
| 2   | Pills                                                  | "Registered · no fields", "Captured", "Trained", "Proven", "Verified/Unverified", "N broken"                                                                                   | **Major** | `FormStepPanel.tsx:282-289`, `:512`. Only `isReady = activeFieldCount > 0` gates the launch (`portalFieldMaps.ts:346`) |
| 3   | Handoff                                                | "Capture fields in the Workbench extension (Send for approval)." "Copy return link." No train handoff exists; she finds the panel, Train forms, payer, and form by hand        | Major     | `FormStepPanel.tsx:788-791`                                                                                            |
| 4   | Train forms                                            | "Select the exact form configuration before continuing. Capture, mock testing, and proof belong to one selected configuration." A second access prompt, different wording      | Major     | PR96 `main.ts:7105-7106`, `:3460-3465`                                                                                 |
| 5   | Capture                                                | Conditional fields are never captured; nothing says "answer the question, then scan again"                                                                                     | Major     | Arch review section 5, slice S5                                                                                        |
| 6   | Decide                                                 | "Needs a decision": token, fixed value, a person fills this. Good. Then "Shared mapping changes need review", "Review and retain override", reset blocked by "shared-fallback" | Major     | `FieldRegistryList.tsx:77-81`; `FormStepPanel.tsx:600-606`, `:651-700`                                                 |
| 7   | Prove                                                  | "Run mock dry run" + "Mark proven", or Test profile → "Run test fill". Neither required. "Mapping generation changed… recapture"                                               | Major     | `sidepanel.html` `#train-dry-run`, `#sandbox-entry`; PR96 `main.ts:5621`                                               |

The spike shows the cost: a form set up by the book was served to nobody (Bug 2); its 73 maps sat under an old key (Bug 3).

### (c) Admin fixes drift

Sidebar count (`Sidebar.tsx:154`) → "Drift detected" (`PayerSetupPage.tsx:65`) → rows "Not found in the latest fill" (`FieldRegistryList.tsx:80`). The panel can only decide a row. The repair is in the extension: Train forms → "Check page" → "Re-point" (PR96 `main.ts:5942-5975`) → propose → back to the panel; the old row stays until retired by hand. The extension links to the panel (`main.ts:2542`); the panel has no link back. Drift shows only after a real fill failed, so a coordinator hits it first. Major.

**Two ways to do one thing, all shipping:** legacy launch vs Exact Work v2 (`PortalStepLink.tsx:176-178`; new-flow forms are invisible to legacy, spike Bug 2). Org maps vs shared tier. Web vs PDF maps. Search vs Work cases. Two access prompts. Two close-outs (Log submission vs Mark complete + Status + note). Two test fills. Two trust stamps. "Open without extension" as a third launch (`PortalLaunchControls.tsx:118-128`).

## 2. Jargon

| Word                                                  | 0.1.8 extension                                 | Panel                                      | Should                                             |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Exact Work context, receipt, validation               | Admin Details                                   | Drawer and launch copy                     | Go. "Opening Aetna…"                               |
| mapping generation, configuration, proof              | Train forms only                                | Register and reset dialogs                 | Go. "Form", "fields"                               |
| Verified, Proven, Trained, Captured, broken           | "Tested" chip                                   | Four pills and a chip                      | Two states: "Needs decisions (N)", "Ready to fill" |
| selector, token, portal key                           | Admin only                                      | Registry rows; the drawer title is the key | Admin only; drop from the drawer                   |
| sandbox, ad hoc                                       | "Test mode"; "Ad hoc fill" inside the Case list | n/a                                        | Admins only; move ad hoc out of the case list      |
| Search / Work cases / Train forms                     | Always-visible chooser                          | n/a                                        | Hide (section 4)                                   |
| Auto-fill, Needs you, Your turn, Log it, Back to case | Kept                                            | Kept                                       | Good                                               |

## 3. Does 0.1.8 reach "easy"?

Yes on the card, no on the path to it.

- **Layout:** three sections is right, but six picker rows still sit above the card on a launch (1a row 4). Hide them when `taskOrigin` shows (PR96 `main.ts:1871`).
- **States:** 20 states, one pill each (PR96 `closeOut.ts:216-240`). Clear. "Fill by hand" and "No form here" share one grey, so an untrained page 2 looks like a wrong tab.
- **Result and close-out:** right. Still no count before the fill in Work mode.
- **Failures:** right shape. The one untested state, "left the payer's site", is the one most likely to fire on a multi-page form.
- **Panel mismatch:** the extension will say "Logged. Task done." while the drawer still asks her to Mark complete.
- **Size:** the "clean" PR adds 640 lines to `main.ts` (6636 to 7275) and 750 to CSS. It removed concepts for her, not code for the team.

## 4. Cut, hide, or merge

| Surface                         | Verdict                                                                                                                                            | Why                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Mode chooser                    | **Merge.** Search is the empty state of Work cases. Train forms moves under the avatar menu, admin only. Worker keeps the mode for the org header. | One option is a sub-step of another (`panelMode.ts:14-18`)                                |
| Ad hoc fill                     | **Hide** from the Case list; offer "Fill without a case" on a Search row.                                                                          | Contradicts "pick a case"; works only on legacy forms she cannot tell apart (review 10.1) |
| Sandbox / Test profile          | **Merge** with mock dry run into one "Test this form", admin only.                                                                                 | Two test fills, neither gates anything                                                    |
| Quick-card layout editor        | **Keep**, collapsed.                                                                                                                               | PM decision; works                                                                        |
| CAQH strip                      | **Cut** the gap strip (dead, PR96 `main.ts:5724`). Keep "Record attestation" on a CAQH form.                                                       | Unfinished by its own comment                                                             |
| AI review                       | **Cut** from the DOM; code stays flagged.                                                                                                          | Off, yet inside Details                                                                   |
| Selector Workshop               | **Keep**, admin only.                                                                                                                              | Only selector repair tool                                                                 |
| Check page / Re-point           | **Keep**; add "Fix in Workbench" on the panel row.                                                                                                 | Only repair path                                                                          |
| Coverage line                   | **Keep; turn on in Work mode.**                                                                                                                    | Missing from the golden path                                                              |
| NBA queue in the extension      | **Cut** the landing queue; keep one "Up next" row after logging.                                                                                   | Duplicates the web app                                                                    |
| Org prompt A6/A7                | **Keep** above the picker; then pre-select the launch's org for a member (spike option B).                                                         | A launch already answered it                                                              |
| Dual launch buttons             | **Merge.** One button, one copy set; legacy only for unflagged rows. Drop "Open without extension" on Auto-fill steps.                             | Two paths, forms invisible to one                                                         |
| Drawer "Mark complete"          | **Hide** on Auto-fill tasks until the server closes the step; show "Waiting for you to submit on Aetna".                                           | Review Next 5                                                                             |
| Verified / Proven / Mark proven | **Cut.** One derived state.                                                                                                                        | None gates the fill                                                                       |

## 5. Golden path and done

Green = done. Amber = your turn. Red = nothing happened. Grey = information.

**(a) Specialist**

1. Case page: one button **Work in portal**. Green toast: "Aetna is open in a new tab. Use the Minted side panel there." Red: "The Minted extension didn't answer. Check it's installed and you're signed in."
2. Tab **and side panel** open (add `sidePanel.open` to the v2 launch). Card: "Join Aetna network form · Joseph Knapp · Aetna KS · due Oct 13 · Opened from Minted Panel · Back to case". Nothing above it.
3. First visit: "One-time setup for this Aetna site. Chrome will ask. Click Allow." [Allow Minted on this Aetna site]. Done: card flips to Ready.
4. Ready: "Aetna form found. Minted can fill 12 of 18 fields on this page." [Fill this page] "You click Continue and Submit. Minted never submits." (Needs a Work-scoped coverage read; likely a contract change.)
5. Done: green "Filled 12 fields." Amber "3 need you" with "Add in Minted Panel ↗". "Your turn: 1. Fill the 3 fields above. 2. Look over the green fields. 3. Click Continue."
6. Page 2: Ready again, "Page 2 found." Untrained: "Minted hasn't learned this page yet. Fill it by hand." Link survives any aetna.com page (same site, not same origin; verify on Aetna).
7. Confirmation page: "Submitted on Aetna? Log it" → confirmation number, note, "Logging moves this case to Submitted." [Log submission]. Done: green "Logged. Task done. Case is now Submitted." plus one "Up next" row.
8. Web app: task checked, Activity "Submitted from the portal by Sowmya S, Oct 14". No Mark complete.

**(b) Admin**

1. Template Basics. Done: saved.
2. Actions → "Fill online form" → **Register form**: name, **form web address (required)**. Done: pill "Needs fields".
3. Panel: "Next: open the form and capture its fields." [Open form in Workbench] opens the tab and the side panel in Train forms on this form. (Contract change: a train handoff, mirrored in `handoff.ts` and `apiTypes.ts`.)
4. Extension: "Allow Minted on aetna.com" → [Capture this page] → "Answer any question that reveals more fields, then capture again" (S5) → [Capture next page] → [Send to Minted Panel]. Done: "Sent 18 fields. Decide each one in Minted Panel."
5. Registry: token, fixed value, or a person fills this. Done: green "Every field has a decision. This form is ready to fill." One pill, "Ready to fill" (= `isReady`).
6. [Test this form] fills the org's test provider on the real form. Done: "Filled 18 of 18." Amber "3 not found on this page" → [Fix in Workbench].
7. Generate a case. Path (a) runs.

Contract changes: train handoff (b3), launch ack "site not allowed yet" (review Next 6), Work-scoped coverage (a4). The rest is copy, hiding, and one `sidePanel.open` call.

## 6. Verdict

On track in direction, not in delivery: 0.1.8 fixes the card but leaves the panel closed on arrival, six rows of chrome above the task, no coverage count, an untested page-2 rule, and a drawer that contradicts the extension; the admin path was never designed as one path. Change one thing: a release gate where a human runs the whole loop on a real portal (Aetna, C-1090) and records it in the PR before any Store upload or panel deploy that touches this loop.
