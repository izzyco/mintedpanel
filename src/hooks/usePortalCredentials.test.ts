// A revealed portal login must never sit in the query cache. useMutation keeps
// its result and variables in the mutation cache for the gc window after the
// dialog closes, so the reveal hook is a plain callback. Pinned at the source
// level, as oneDoor.test.ts pins case creation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const read = (path: string) => stripComments(readFileSync(join(process.cwd(), path), "utf8"));

/** The text of one exported hook, from its declaration to the next export. */
function hookBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `${name} is exported`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("a revealed password must never sit in the query cache", () => {
  it("useRevealPortalCredential is a plain callback, not a useMutation or useQuery", () => {
    const source = read("src/hooks/usePortalCredentials.ts");
    expect(source).not.toMatch(/useMutation|useQuery|@tanstack\/react-query/);
  });

  it("useIntakeGateway follows the same rule, beside a hook the check does see as a mutation", () => {
    expect(hookBody(read("src/hooks/useIntake.ts"), "useIntakeGateway")).not.toContain(
      "useMutation",
    );
    expect(hookBody(read("src/hooks/useProviderInvites.ts"), "useCreateProviderInvite")).toContain(
      "useMutation",
    );
  });
});
