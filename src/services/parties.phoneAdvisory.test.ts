// MINT-134: a person saved with no office phone (MINT-91 U8) is recorded once
// as contact.phone_missing, through recordAdvisory's real call, so the suite
// sees exactly what the RPC would be sent. The client, the active org and the
// audit write are mocked. Add person records on a blank phone; edit person
// records only when the save blanks a stored phone; a failed record never
// fails the save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "13400000-0000-4000-a000-00000000000a";
const PARTY = "13400000-0000-4000-a000-0000000b0001";

const db = vi.hoisted(() => ({
  /** The stored row the pre-read returns (null: not found). */
  stored: null as Record<string, unknown> | null,
  readError: null as { code: string } | null,
  writeError: null as { code: string } | null,
  /** Every builder call, in order: [table, method, ...args]. */
  calls: [] as unknown[][],
}));

const respond = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ abortSignal: () => respond() })));
const writeAudit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));

vi.mock("@/integrations/supabase/externalClient", () => {
  function from(table: string) {
    let written: Record<string, unknown> = {};
    const builder = {
      select: (...args: unknown[]) => {
        db.calls.push([table, "select", ...args]);
        return builder;
      },
      eq: (...args: unknown[]) => {
        db.calls.push([table, "eq", ...args]);
        return builder;
      },
      insert: (row: Record<string, unknown>) => {
        db.calls.push([table, "insert", row]);
        written = row;
        return builder;
      },
      update: (row: Record<string, unknown>) => {
        db.calls.push([table, "update", row]);
        written = { ...db.stored, ...row };
        return builder;
      },
      maybeSingle: async () =>
        db.readError ? { data: null, error: db.readError } : { data: db.stored, error: null },
      single: async () =>
        db.writeError
          ? { data: null, error: db.writeError }
          : { data: { id: PARTY, ...written }, error: null },
    };
    return builder;
  }
  return { supabase: { from, rpc: (...args: unknown[]) => rpc(...args) } };
});

vi.mock("@/lib/audit", () => ({
  requireActiveOrg: () => ORG,
  currentUserId: () => "13400000-0000-4000-a000-0000000d0001",
  writeAudit: (...args: unknown[]) => writeAudit(...args),
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

const STORED = {
  first_name: "Dana",
  last_name: "Reyes",
  phone_office: "704-555-0100",
};

const RECORDED = {
  p_org_id: ORG,
  p_check_key: "contact.phone_missing",
  p_severity: "advisory",
  p_record_table: "parties",
  p_record_id: PARTY,
  p_context: {},
  p_source: "panel",
};

let warn: ReturnType<typeof vi.spyOn>;

function loggedLines(): unknown[] {
  return warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

function writes(method: "insert" | "update"): unknown[][] {
  return db.calls.filter((call) => call[1] === method);
}

/** Let a fire-and-forget record settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  db.stored = { ...STORED };
  db.readError = null;
  db.writeError = null;
  db.calls.length = 0;
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  writeAudit.mockReset();
  writeAudit.mockResolvedValue(undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createParty (Add person) records contact.phone_missing", () => {
  it("records once when the phone is blank, against the new party", async () => {
    const party = await createParty({ ...CONTACT, phoneOffice: "" });
    expect(party.id).toBe(PARTY);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", RECORDED);
  });

  it("treats a whitespace phone as blank", async () => {
    await createParty({ ...CONTACT, phoneOffice: "   " });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", RECORDED);
  });

  it("records nothing when a phone is entered", async () => {
    await createParty({ ...CONTACT, phoneOffice: "704-555-0100" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records nothing when the insert fails", async () => {
    db.writeError = { code: "42501" };
    await expect(createParty({ ...CONTACT, phoneOffice: "" })).rejects.toMatchObject({
      code: "42501",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still saves when the record is refused, with one safe log line", async () => {
    respond.mockResolvedValue({ data: null, error: { code: "42501", message: "nope" } });
    const party = await createParty({ ...CONTACT, phoneOffice: "" });
    expect(party.id).toBe(PARTY);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    await settle();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "42501" },
    ]);
  });

  it("still saves when the record call throws", async () => {
    respond.mockRejectedValue(new Error("network down"));
    const party = await createParty({ ...CONTACT, phoneOffice: "" });
    expect(party.id).toBe(PARTY);
    await settle();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "unknown" },
    ]);
  });

  it("records before the audit write, so a failed audit can't drop it", async () => {
    writeAudit.mockRejectedValue(new Error("audit down"));
    await expect(createParty({ ...CONTACT, phoneOffice: "" })).rejects.toThrow("audit down");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("updateParty (Edit person) records contact.phone_missing", () => {
  it("records once when the save clears a stored phone", async () => {
    await updateParty(PARTY, { ...CONTACT, phoneOffice: "" });
    expect(writes("update")[0][2]).toMatchObject({ phone_office: null });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", RECORDED);
  });

  it("reads the stored phone in the same read as the name halves", async () => {
    await updateParty(PARTY, { ...CONTACT, phoneOffice: "" });
    const reads = db.calls.filter((call) => call[0] === "parties" && call[1] === "select");
    expect(reads[0]).toEqual(["parties", "select", "first_name, last_name, phone_office"]);
    // One pre-read, then the update's own returning select.
    expect(reads).toHaveLength(2);
  });

  it("records when only the phone is sent, cleared", async () => {
    await updateParty(PARTY, { phoneOffice: "  " });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("records nothing on an unrelated edit of a contact that already had no phone", async () => {
    // The edit dialog sends every field, the blank phone included.
    db.stored = { ...STORED, phone_office: null };
    await updateParty(PARTY, { ...CONTACT, title: "Office Manager", phoneOffice: "" });
    db.stored = { ...STORED, phone_office: "  " };
    await updateParty(PARTY, { ...CONTACT, title: "Office Manager", phoneOffice: "" });
    expect(writes("update")).toHaveLength(2);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records nothing when the phone is kept, changed or not sent", async () => {
    await updateParty(PARTY, { ...CONTACT, phoneOffice: "704-555-0100" });
    await updateParty(PARTY, { ...CONTACT, phoneOffice: "704-555-0199" });
    await updateParty(PARTY, { email: CONTACT.email });
    expect(writes("update")).toHaveLength(3);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records nothing when the update fails", async () => {
    db.writeError = { code: "42501" };
    await expect(updateParty(PARTY, { ...CONTACT, phoneOffice: "" })).rejects.toMatchObject({
      code: "42501",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still saves when the phone-only pre-read fails, unrecorded, with one safe log line", async () => {
    db.readError = { code: "PGRST301" };
    const party = await updateParty(PARTY, { phoneOffice: "" });
    expect(party.id).toBe(PARTY);
    expect(writes("update")).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "PGRST301" },
    ]);
  });

  it("still refuses a rename whose pre-read fails, as before", async () => {
    db.readError = { code: "PGRST301" };
    await expect(updateParty(PARTY, { ...CONTACT, phoneOffice: "" })).rejects.toMatchObject({
      code: "PGRST301",
    });
    expect(writes("update")).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still saves when the record is refused or throws", async () => {
    respond.mockResolvedValueOnce({ data: null, error: { code: "22023" } });
    respond.mockRejectedValueOnce(new Error("network down"));
    await expect(updateParty(PARTY, { ...CONTACT, phoneOffice: "" })).resolves.toMatchObject({
      id: PARTY,
    });
    db.stored = { ...STORED };
    await expect(updateParty(PARTY, { ...CONTACT, phoneOffice: "" })).resolves.toMatchObject({
      id: PARTY,
    });
    expect(writeAudit).toHaveBeenCalledTimes(2);
    await settle();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "22023" },
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "unknown" },
    ]);
  });

  it("records before the audit write, so a failed audit can't drop it", async () => {
    writeAudit.mockRejectedValue(new Error("audit down"));
    await expect(updateParty(PARTY, { ...CONTACT, phoneOffice: "" })).rejects.toThrow("audit down");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
