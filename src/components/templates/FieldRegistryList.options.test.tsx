import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RegistryRow } from "@/lib/fieldRegistry";

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-select-item={value}>{children}</div>
  ),
}));

import { FieldRegistryList } from "./FieldRegistryList";

const row = (over: Partial<RegistryRow>): RegistryRow => ({
  id: "r1",
  selector: "#field",
  status: "proposed",
  source: "manual",
  token: null,
  hardcodedValue: null,
  fieldType: "select",
  ...over,
});

function render(rows: RegistryRow[]): string {
  return renderToStaticMarkup(
    <FieldRegistryList
      rows={rows}
      canEdit
      groupedTokens={[]}
      onDecide={() => {}}
      onRename={() => {}}
      onRenameSection={() => {}}
    />,
  );
}

// BlueKC's specialty list: Physical Therapist is #121 of 146. Before the cap
// moved to 1000 it was cut at 50; now the whole list arrives, so the registry
// must stay usable with it.
const specialties = Array.from({ length: 146 }, (_, i) => ({
  value: String(i + 1),
  label: i === 120 ? "Physical Therapist" : `Specialty ${i + 1}`,
}));

describe("FieldRegistryList — captured option vocabularies", () => {
  it("gives a long list a searchable picker that mounts no options until opened", () => {
    const html = render([
      row({ id: "spec", fieldLabel: "Specialty", controlOptions: specialties }),
    ]);
    expect(html).toContain("146 options this control accepts");
    expect(html).toMatch(/role="combobox"[^>]*aria-label="Fixed value for Specialty"/);
    expect(html).not.toContain("data-select-item");
    // Neither the read-only list nor the picker renders an option while closed.
    expect(html).not.toContain("Physical Therapist");
  });

  it("keeps the plain Select for a short list", () => {
    const html = render([
      row({
        id: "state",
        fieldLabel: "Practice State",
        controlOptions: [
          { value: "KS", label: "Kansas" },
          { value: "MO", label: "Missouri" },
          { value: "NE", label: "Nebraska" },
        ],
      }),
    ]);
    expect(html).toContain('data-select-item="KS"');
    expect(html).toContain("KS — Kansas");
    expect(html).not.toContain('aria-label="Search options"');
  });

  it("shows a stored fixed value from deep in a long list on the picker trigger", () => {
    const html = render([
      row({
        id: "spec",
        fieldLabel: "Specialty",
        source: "hardcoded",
        status: "approved",
        hardcodedValue: "121",
        controlOptions: specialties,
      }),
    ]);
    expect(html).toContain("121 — Physical Therapist");
  });
});
