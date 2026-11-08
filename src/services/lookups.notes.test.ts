import { beforeEach, describe, expect, it, vi } from "vitest";

const browserDeps = vi.hoisted(() => ({
  activeOrgId: "11111111-1111-4111-8111-111111111111",
  supabase: { from: vi.fn() },
}));

vi.mock("@/integrations/supabase/externalClient", () => ({ supabase: browserDeps.supabase }));
vi.mock("@/lib/audit", () => ({
  requireActiveOrg: () => browserDeps.activeOrgId,
  currentUserId: () => null,
  writeAudit: vi.fn(),
}));

import { getNotesFor } from "./lookups";

const PROVIDER = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";

function note(id: string, authorId: string | null, content: string) {
  return {
    id,
    org_id: browserDeps.activeOrgId,
    entity_type: "provider",
    entity_id: PROVIDER,
    content,
    author_id: authorId,
    created_at: "2026-11-07T12:00:00+00:00",
  };
}

// notes, then the profiles of their authors.
function tables(notes: Record<string, unknown>[], profiles: Record<string, unknown>[]) {
  browserDeps.supabase.from.mockImplementation((table: string) => {
    const rows = table === "notes" ? notes : profiles;
    const query: Record<string, unknown> = {
      select: () => query,
      eq: () => query,
      in: async () => ({ data: rows, error: null }),
      order: async () => ({ data: rows, error: null }),
    };
    return query;
  });
}

beforeEach(() => vi.clearAllMocks());

describe("getNotesFor", () => {
  it("names a provider note with no author as written from the onboarding form", async () => {
    tables(
      [
        note("n1", null, "Asked for help from the onboarding form."),
        note("n2", STAFF, "Called her about the start date."),
      ],
      [{ id: STAFF, full_name: "Jordan Seed", email: "jordan@minted.example" }],
    );

    const notes = await getNotesFor("provider", PROVIDER);

    expect(notes.map((n) => [n.id, n.authorName])).toEqual([
      ["n1", "Provider (onboarding form)"],
      ["n2", "Jordan Seed"],
    ]);
  });

  it("leaves a staff author with no profile unnamed", async () => {
    tables([note("n3", STAFF, "Left a voicemail.")], []);
    const [only] = await getNotesFor("provider", PROVIDER);
    expect(only.authorName).toBeNull();
  });
});
