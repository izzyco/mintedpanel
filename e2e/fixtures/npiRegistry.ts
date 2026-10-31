// MINT-110 e2e helpers for the NPI Registry. Test-only; the app has no hook
// for either.
//
// - blockNpiRegistryAnswers: serves the browser a copy of the policy module
//   (src/lib/npiRegistryPolicy.ts, a separate ES module under the Vite dev
//   server) whose defaults set the given answers to "block", so a spec runs
//   the forms under a blocking policy without stored overrides. The returned
//   `patched()` must be true, or the spec ran under the defaults.
// - recordAnnouncements / announcements: every distinct text a live region
//   (role="status" or aria-live) takes, in order, so a spec counts what was
//   announced instead of looking at what is on screen now.
import type { BrowserContext, Page } from "@playwright/test";

export type NpiRegistryAnswer = "organizationNumber" | "notFound" | "nameMismatch" | "inactive";

export async function blockNpiRegistryAnswers(
  context: BrowserContext,
  answers: NpiRegistryAnswer[],
): Promise<{ patched: () => boolean }> {
  let patched = false;
  await context.route(/\/src\/lib\/npiRegistryPolicy\.ts(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    for (const answer of answers) {
      const next = body.replace(new RegExp(`${answer}:\\s*"warn"`), `${answer}: "block"`);
      if (next === body) {
        await route.fulfill({ response, body });
        return;
      }
      body = next;
    }
    patched = true;
    await route.fulfill({ response, body });
  });
  return { patched: () => patched };
}

export async function recordAnnouncements(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const said: string[] = [];
    const last = new WeakMap<Element, string>();
    (window as unknown as { __announcements: string[] }).__announcements = said;
    const scan = () => {
      for (const region of document.querySelectorAll('[role="status"], [aria-live]')) {
        const text = (region.textContent ?? "").replace(/\s+/g, " ").trim();
        if (last.get(region) === text) continue;
        last.set(region, text);
        if (text) said.push(text);
      }
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** How many announcements so far contain `text`. */
export async function announcements(page: Page, text: string): Promise<number> {
  return page.evaluate(
    (needle) =>
      ((window as unknown as { __announcements?: string[] }).__announcements ?? []).filter((said) =>
        said.includes(needle),
      ).length,
    text,
  );
}
