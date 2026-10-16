import { beforeEach, describe, expect, it, vi } from "vitest";

// The org-tier decision writers: what each one sends through
// update_org_portal_field_map. A fake client records the RPC patch and serves
// the notes read that the manual path makes.
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  notes: null as string | null,
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/integrations/supabase/externalClient", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { notes: state.notes }, error: null }),
  };
  return { supabase: { rpc: state.rpc, from: () => builder } };
});
vi.mock("@/lib/audit", () => ({
  writeAudit: state.writeAudit,
  requireActiveOrg: () => "org-1",
  currentUserId: () => "user-1",
}));

import { markFieldMapLeaveBlank, reproposeFieldMap, MARKED_MANUAL_NOTE } from "./portalFieldMaps";

const ROW = {
  id: "map-1",
  org_id: "org-1",
  portal_key: "bcbs",
  selector: "#middle",
  status: "approved",
  source: "leave_blank",
  token: null,
  hardcoded_value: null,
  transform: null,
  field_label: "Middle name",
};

function sentPatch(): Record<string, unknown> {
  const call = state.rpc.mock.calls[0];
  expect(call?.[0]).toBe("update_org_portal_field_map");
  return (call?.[1] as { p_patch: Record<string, unknown> }).p_patch;
}

beforeEach(() => {
  state.rpc.mockReset().mockResolvedValue({ data: ROW, error: null });
  state.writeAudit.mockClear();
  state.notes = null;
});

describe("markFieldMapLeaveBlank", () => {
  it("approves the row as leave_blank and clears token, literal and transform", async () => {
    await markFieldMapLeaveBlank("map-1", 2, "Middle name");
    expect(sentPatch()).toEqual({
      status: "approved",
      source: "leave_blank",
      token: null,
      hardcoded_value: null,
      transform: null,
    });
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_org_id: "org-1",
      p_id: "map-1",
      p_expected_mapping_generation: 2,
    });
    // Not under notes_required, so no note is synthesized.
    expect(sentPatch()).not.toHaveProperty("notes");
    expect(state.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ after: { source: "leave_blank", status: "approved" } }),
    );
  });
});

describe("reproposeFieldMap after Leave blank", () => {
  it("normalises Unmap to the canonical undecided shape (proposed, manual) with a note", async () => {
    state.rpc.mockResolvedValue({
      data: { ...ROW, status: "proposed", source: "manual" },
      error: null,
    });
    await reproposeFieldMap("map-1", { token: null, source: "leave_blank" }, 2);
    expect(sentPatch()).toEqual({
      status: "proposed",
      source: "manual",
      token: null,
      transform: null,
      notes: MARKED_MANUAL_NOTE,
    });
    expect(state.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ after: { status: "proposed", source: "manual", token: null } }),
    );
  });

  it("keeps a human's existing note when normalising", async () => {
    state.notes = "Payer says leave empty for solo practices";
    await reproposeFieldMap("map-1", { token: null, source: "leave_blank" }, 2);
    expect(sentPatch()).not.toHaveProperty("notes");
    expect(sentPatch()).toMatchObject({ status: "proposed", source: "manual" });
  });

  it("leaves every other source as it was (single-level undo)", async () => {
    await reproposeFieldMap("map-1", { token: "provider.npi", source: "token" }, 2);
    expect(sentPatch()).toEqual({
      status: "proposed",
      source: "token",
      token: "provider.npi",
      transform: null,
    });
  });
});
