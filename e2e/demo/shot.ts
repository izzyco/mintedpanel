import type { Page } from "@playwright/test";

// Saves one walkthrough step as demo-output/<name>.png. Name steps in order
// with a plain-language caption, e.g. "01-open-new-case": publish.mjs turns
// the name into the step heading in the PR body.
export function shot(page: Page, name: string) {
  return page.screenshot({ path: `demo-output/${name}.png` });
}
