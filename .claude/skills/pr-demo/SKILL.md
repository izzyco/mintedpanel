---
name: pr-demo
description: Write a Minted Panel PR description that says functionally what changed, with a screenshot walkthrough (or short video) of any change a person can see or click. Use whenever opening or updating a PR, writing its body, or when asked for a demo, screenshots or a walkthrough of a change.
---

# PR descriptions and demos — Minted Panel

The PM reads PRs to learn **what we did**, by behavior. A PR body that opens
with file lists and test counts doesn't answer that. Model: #581 (Intake Form
and Email Update), whose body is a walkthrough of the flow.

## Body shape

1. **What changes for you** — first, in plain language: who sees what, where,
   step by step. No file paths, table names or test counts here.
2. **Walkthrough** — for any change a person can see or click: numbered
   screenshots of the flow, before/after when a screen changed. Backend-only
   PRs skip it and say so in one line ("No UI change").
3. Then the technical sections (changes, tests run, notes for review) as usual.

## Capturing the walkthrough

Always local: the Vite dev server with the Supabase mock harness (see
`e2e-harness`). Never hosted Supabase or Vercel. Fixture data only, so no real
patient or provider data can appear in a screenshot.

1. `node scripts/bootstrap-session.mjs` (dummy `.env`).
2. Write `e2e/demo/<slug>.demo.ts` (gitignored, never part of the PR). Copy
   `e2e/demo/login.example.demo.ts`, borrow the mocks from the feature's own
   e2e spec, and call `shot(page, "01-open-new-case")` at each step. Step names
   become the captions, so write them as what the user does or sees.
3. `npx playwright test --config playwright.demo.config.ts e2e/demo/<slug>.demo.ts`
   — PNGs land in `demo-output/`. It boots this checkout's own dev server on
   port 8090 (never reuses 8080, which is often another session's branch).
   Add `DEMO_VIDEO=1` for a `.webm` too (under `demo-output/results/`), only
   when a flow is too long for 3–6 shots; video needs a one-time
   `npx playwright install ffmpeg`.
4. Look at every screenshot before publishing (Read the PNG). Crop or re-shoot
   anything that's mid-transition, blank, or off the point.
5. Open the PR, then `node scripts/pr-demo/publish.mjs <pr-number>` (add the
   `.webm` path as an extra argument if recorded). It pushes the files to
   `pr-media/pr/<number>/` and prints the markdown; paste it under
   **Walkthrough** with `gh pr edit <number> --body-file …`.

## Rules

- `pr-media` is an orphan branch for PR media only: never merge it, never base
  work on it, never delete others' folders. Files over 5 MB are refused.
- 3–6 screenshots per flow at 1280×800. One state per shot.
- Re-publishing after a change overwrites same-named files; rename steps that
  no longer exist rather than leaving stale shots in the body.
