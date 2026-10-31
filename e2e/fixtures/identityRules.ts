// MINT-129 — stands in for a Mission Control override of the identity
// validation rules, which nothing can store yet. The browser imports
// useIdentityValidationRules from the dev server by its source path, so
// serving that module with a chosen rule set changes the rules for the whole
// page. The server render keeps the defaults; the hook only feeds save-time
// checks, so nothing it renders differs.
import type { BrowserContext } from "@playwright/test";

export interface ServedIdentityValidationRules {
  recheckStoredOnEdit: boolean;
  deaLastNameLetter: "off";
}

export const RECHECK_STORED_RULES: ServedIdentityValidationRules = {
  recheckStoredOnEdit: true,
  deaLastNameLetter: "off",
};

export async function serveIdentityValidationRules(
  context: BrowserContext,
  rules: ServedIdentityValidationRules,
): Promise<void> {
  const body = [
    `const RULES = Object.freeze(${JSON.stringify(rules)});`,
    "export function useIdentityValidationRules() {",
    "  return RULES;",
    "}",
    "",
  ].join("\n");
  await context.route("**/src/hooks/useIdentityValidationRules.ts*", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body }),
  );
}
