import { beforeEach, describe, expect, it, vi } from "vitest";

// MINT-91 U8: the office phone is optional. A blank one is stored as NULL, the
// way create_organization and submit_capture store "no phone", never as "".

const { fromMock, writes } = vi.hoisted(() => {
  const writes: { op: "insert" | "update"; row: Record<string, unknown> }[] = [];
  const chain = (row: Record<string, unknown>) => ({
    eq: () => chain(row),
    select: () => chain(row),
    single: async () => ({ data: { id: "party-1", ...row }, error: null }),
  });
  const fromMock = vi.fn(() => ({
    insert: (row: Record<string, unknown>) => {
      writes.push({ op: "insert", row });
      return chain(row);
    },
    update: (row: Record<string, unknown>) => {
      writes.push({ op: "update", row });
      return chain(row);
    },
  }));
  return { fromMock, writes };
});

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { from: fromMock },
}));

vi.mock("@/lib/audit", () => ({
  requireActiveOrg: () => "org-1",
  currentUserId: () => "user-1",
  writeAudit: vi.fn(),
}));

import { createParty, updateParty } from "./parties";
import { EMPTY_CONTACT } from "@/lib/contacts";

const CONTACT = {
  ...EMPTY_CONTACT,
  firstName: "Dana",
  lastName: "Reyes",
  email: "dana.reyes@example.test",
  addressLine1: "101 S Tryon St",
  city: "Charlotte",
  state: "NC",
  postalCode: "28280",
};

beforeEach(() => {
  writes.length = 0;
  fromMock.mockClear();
});

describe("createParty — office phone (MINT-91 U8)", () => {
  it("stores a blank or whitespace phone as NULL", async () => {
    await createParty({ ...CONTACT, phoneOffice: "" });
    await createParty({ ...CONTACT, phoneOffice: "   " });
    expect(writes.map((w) => w.row.phone_office)).toEqual([null, null]);
  });

  it("stores an entered phone as typed", async () => {
    await createParty({ ...CONTACT, phoneOffice: "704-555-0100" });
    expect(writes[0].row.phone_office).toBe("704-555-0100");
  });
});

describe("updateParty — office phone (MINT-91 U8)", () => {
  it("stores a cleared phone as NULL", async () => {
    await updateParty("party-1", { email: CONTACT.email, phoneOffice: "" });
    await updateParty("party-1", { email: CONTACT.email, phoneOffice: "  " });
    expect(writes.map((w) => w.row.phone_office)).toEqual([null, null]);
  });

  it("stores an entered phone as typed, and leaves an omitted phone out of the patch", async () => {
    await updateParty("party-1", { phoneOffice: "704-555-0199" });
    await updateParty("party-1", { email: CONTACT.email });
    expect(writes[0].row.phone_office).toBe("704-555-0199");
    expect(writes[1].row).not.toHaveProperty("phone_office");
  });
});
