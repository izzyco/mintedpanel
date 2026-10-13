import { describe, expect, it, vi } from "vitest";
import { proposeSharedFieldMap } from "./sharedFieldMaps";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

describe("proposeSharedFieldMap service", () => {
  it("passes all 11 arguments to the propose_shared_field_map RPC", async () => {
    let capturedRpcName = "";
    let capturedRpcArgs: Record<string, unknown> = {};

    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          is: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { mapping_generation: 2 },
                error: null,
              }),
            })),
          })),
        })),
      })),
      rpc: vi.fn((name: string, args: Record<string, unknown>) => {
        capturedRpcName = name;
        capturedRpcArgs = args;
        return Promise.resolve({
          data: {
            id: "map-1",
            portal_key: "aetna-direct-enrollment",
            selector: "#field-interest",
            field_label: "I AM INTERESTED IN",
            status: "proposed",
            token: null,
          },
          error: null,
        });
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await proposeSharedFieldMap(mockDb, {
      portal_key: "aetna-direct-enrollment",
      selector: "#field-interest",
      field_label: "* I AM INTERESTED IN",
      form_section: "Personal Info",
      page_step: "1",
      field_type: "select",
      sort_order: 1,
      control_options: [{ value: "1", label: "Option 1" }],
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.map.id).toBe("map-1");
      expect(result.map.portalKey).toBe("aetna-direct-enrollment");
    }

    expect(capturedRpcName).toBe("propose_shared_field_map");
    // Verify all 11 arguments are present
    expect(capturedRpcArgs).toEqual({
      p_portal_key: "aetna-direct-enrollment",
      p_selector: "#field-interest",
      p_field_label: "* i am interested in",
      p_form_section: "Personal Info",
      p_page_step: "1",
      p_field_type: "select",
      p_sort_order: 1,
      p_notes: null,
      p_control_options: [{ value: "1", label: "Option 1" }],
      p_map_type: "web",
      p_expected_mapping_generation: 2,
    });
  });

  it("maps portal_configuration_not_found to 404", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          is: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        })),
      })),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "P0002: portal_configuration_not_found" },
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await proposeSharedFieldMap(mockDb, {
      portal_key: "unknown-portal",
      selector: "#input",
    });

    expect(result).toEqual({
      kind: "rejected",
      status: 404,
      message: "Portal configuration not found for key: unknown-portal",
    });
  });

  it("maps mapping_generation_stale to 409", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          is: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { mapping_generation: 1 }, error: null }),
            })),
          })),
        })),
      })),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "40001: mapping_generation_stale" },
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await proposeSharedFieldMap(mockDb, {
      portal_key: "test-portal",
      selector: "#input",
    });

    expect(result).toEqual({
      kind: "rejected",
      status: 409,
      message: "The form mapping changed. Reload the configuration before capturing fields again.",
    });
  });

  it("rethrows unexpected schema/database errors so they are logged as 500s", async () => {
    const unexpectedError = new Error("PGRST202: signature mismatch");
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          is: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        })),
      })),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: unexpectedError,
      }),
    } as unknown as SupabaseClient<Database>;

    await expect(
      proposeSharedFieldMap(mockDb, {
        portal_key: "test-portal",
        selector: "#input",
      }),
    ).rejects.toThrow(unexpectedError);
  });
});
