// MINT-134: after create_organization, each contact saved with no office phone
// (MINT-91 U8) is recorded once as contact.phone_missing. The RPC returns only
// the org id, so the party is read back by its default role in the new org.
// recordAdvisory's real call runs against a mocked client and active org, so
// the suite sees exactly what would be sent. Nothing here can throw into the
// create-org flow.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NEW_ORG = "13400000-0000-4000-a000-00000000000b";
const OTHER_ORG = "13400000-0000-4000-a000-00000000000a";
const CUSTOMER = "13400000-0000-4000-a000-0000000b0001";
const SALES_REP = "13400000-0000-4000-a000-0000000b0002";

const db = vi.hoisted(() => ({
  rows: [] as { party_id: string }[],
  error: null as { code: string } | null,
  /** Every builder call, in order: [table, method, ...args]. */
  calls: [] as unknown[][],
}));
const respond = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ abortSignal: () => respond() })));
const activeOrg = vi.hoisted(() => vi.fn((): string => ""));

vi.mock("@/integrations/supabase/externalClient", () => {
  function from(table: string) {
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        db.calls.push([table, method, ...args]);
        return builder;
      };
    const builder = {
      select: record("select"),
      eq: record("eq"),
      in: record("in"),
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ): Promise<unknown> =>
        Promise.resolve(
          db.error ? { data: null, error: db.error } : { data: db.rows, error: null },
        ).then(resolve, reject),
    };
    return builder;
  }
  return { supabase: { from, rpc: (...args: unknown[]) => rpc(...args) } };
});
vi.mock("@/lib/audit", () => ({ requireActiveOrg: () => activeOrg() }));

import { EMPTY_CONTACT } from "@/lib/contacts";
import {
  isPhoneBlank,
  recordContactPhoneMissing,
  recordNewOrgContactsPhoneMissing,
} from "./contactPhoneAdvisory";

const CONTACT = {
  ...EMPTY_CONTACT,
  firstName: "Kitty",
  lastName: "Forman",
  email: "contact.point-place@example.test",
  addressLine1: "416 Marie Dr",
  city: "Point Place",
  state: "WI",
  postalCode: "53511",
};
const BLANK = { ...CONTACT, phoneOffice: "" };
const ENTERED = { ...CONTACT, phoneOffice: "608-555-0100" };

function recorded(partyId: string) {
  return {
    p_org_id: NEW_ORG,
    p_check_key: "contact.phone_missing",
    p_severity: "advisory",
    p_record_table: "parties",
    p_record_id: partyId,
    p_context: {},
    p_source: "panel",
  };
}

let warn: ReturnType<typeof vi.spyOn>;

function loggedLines(): unknown[] {
  return warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

beforeEach(() => {
  db.rows = [{ party_id: CUSTOMER }];
  db.error = null;
  db.calls.length = 0;
  rpc.mockClear();
  respond.mockReset();
  respond.mockResolvedValue({ data: "13400000-0000-4000-a000-0000000c0001", error: null });
  activeOrg.mockReset();
  activeOrg.mockReturnValue(NEW_ORG);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPhoneBlank", () => {
  it("is true for empty, whitespace, null and undefined, false for any entry", () => {
    expect([undefined, null, "", "  ", "\t"].map(isPhoneBlank)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["704-555-0100", "abc-def-ghij", "0"].map(isPhoneBlank)).toEqual([false, false, false]);
  });
});

describe("recordContactPhoneMissing", () => {
  it("sends contact.phone_missing on the party, source panel, no context", async () => {
    activeOrg.mockReturnValue(NEW_ORG);
    await recordContactPhoneMissing(CUSTOMER);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", recorded(CUSTOMER));
  });
});

describe("recordNewOrgContactsPhoneMissing (Create organization)", () => {
  it("records once for the organization contact saved with a blank phone", async () => {
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", recorded(CUSTOMER));
  });

  it("reads the party back by its default role in the new org", async () => {
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK });
    expect(db.calls).toEqual([
      ["party_role_assignments", "select", "party_id"],
      ["party_role_assignments", "eq", "org_id", NEW_ORG],
      ["party_role_assignments", "eq", "scope_type", "org"],
      ["party_role_assignments", "eq", "is_default", true],
      ["party_role_assignments", "in", "role_key", ["customer_escalation_contact"]],
    ]);
  });

  it("treats a whitespace phone as blank", async () => {
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: { ...CONTACT, phoneOffice: " " } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("reads and records nothing when the contact's phone is entered", async () => {
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: ENTERED });
    expect(db.calls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("records a sales rep saved with a blank phone too, each party once", async () => {
    db.rows = [{ party_id: CUSTOMER }, { party_id: SALES_REP }, { party_id: SALES_REP }];
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK, salesRep: BLANK });
    expect(db.calls.at(-1)).toEqual([
      "party_role_assignments",
      "in",
      "role_key",
      ["customer_escalation_contact", "sales_rep"],
    ]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", recorded(CUSTOMER));
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", recorded(SALES_REP));
  });

  it("asks only for the sales rep when only the sales rep's phone is blank", async () => {
    db.rows = [{ party_id: SALES_REP }];
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: ENTERED, salesRep: BLANK });
    expect(db.calls.at(-1)).toEqual(["party_role_assignments", "in", "role_key", ["sales_rep"]]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", recorded(SALES_REP));
  });

  it("records nothing, with one safe log line, when the new org isn't the active org", async () => {
    activeOrg.mockReturnValue(OTHER_ORG);
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK });
    expect(db.calls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "22023" },
    ]);
  });

  it("resolves, with one safe log line, when there is no active org", async () => {
    activeOrg.mockImplementation(() => {
      throw new Error("No active organization");
    });
    await expect(
      recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "unknown" },
    ]);
  });

  it("resolves, with one safe log line, when the read-back fails", async () => {
    db.error = { code: "42501" };
    await expect(
      recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "42501" },
    ]);
  });

  it("records nothing when the read-back finds no party", async () => {
    db.rows = [];
    await recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("resolves when the record is refused or the call throws", async () => {
    respond.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(
      recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK }),
    ).resolves.toBeUndefined();
    respond.mockRejectedValueOnce(new Error("network down"));
    await expect(
      recordNewOrgContactsPhoneMissing(NEW_ORG, { customer: BLANK }),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "42501" },
      { event: "advisory_record_failed", check_key: "contact.phone_missing", sqlstate: "unknown" },
    ]);
  });
});
