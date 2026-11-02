// MINT-129 — under a named activity zone, the Add touch form's default date,
// a note's touch_date and the touchlog's follow-up status all use the same
// day. Rendered in a Denver browser at moments when Auckland is a day ahead.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDateRules } from "@/lib/activityDate";
import type { Touch } from "@/types";

const holder = vi.hoisted(() => ({
  inserts: [] as unknown[],
  rules: null as ActivityDateRules | null,
}));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: {
    from: () => {
      const builder: Record<string, unknown> = {};
      builder.insert = (payload: unknown) => {
        holder.inserts.push(payload);
        return builder;
      };
      builder.select = () => builder;
      builder.single = async () => ({
        data: { id: "touch-1", case_id: "case-1", entry_type: "note" },
        error: null,
      });
      return builder;
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  currentUserId: () => "user-1",
  requireActiveOrg: () => "org-1",
  writeAudit: vi.fn(),
}));
// Stands in for a stored override: the reader returns what the test sets.
vi.mock("@/lib/activityDate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activityDate")>();
  return { ...actual, activityDateRules: () => holder.rules ?? actual.activityDateRules() };
});

import { AddTouchForm } from "./AddTouchForm";
import { CaseTouchesPanel } from "./CaseTouchesPanel";
import { logNote } from "@/services/touches";

const priorTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Denver";
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

beforeEach(() => {
  holder.inserts = [];
  holder.rules = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function touchFormDefault(): string | undefined {
  const html = renderToStaticMarkup(
    <AddTouchForm correctionOf={null} saving={false} onCancel={() => {}} onSave={() => {}} />,
  );
  const input = html.match(/<input[^>]*type="date"[^>]*>/)?.[0] ?? "";
  return input.match(/value="(\d{4}-\d{2}-\d{2})"/)?.[1];
}

async function noteDate(): Promise<unknown> {
  await logNote("case-1", { content: "Called the payer back." });
  return (holder.inserts[0] as { touch_date?: unknown } | undefined)?.touch_date;
}

const followUpTouch: Touch = {
  id: "touch-9",
  orgId: "org-1",
  caseId: "case-1",
  touchDate: "2026-10-15",
  entryType: "touchpoint",
  touchType: "call",
  outcome: null,
  nextFollowUpDate: "2026-10-20",
  notes: null,
  coordinatorId: null,
  taskId: null,
  communicationEventId: null,
  source: "manual",
  createdAt: "2026-10-15T15:00:00Z",
  clearsFollowUp: false,
  recipientName: null,
  recipientContact: null,
  correctsTouchId: null,
};

function touchlog(): string {
  return renderToStaticMarkup(
    <CaseTouchesPanel
      touches={[followUpTouch]}
      coordinators={[]}
      canEdit={false}
      savingTouch={false}
      savingNote={false}
      onSaveTouch={() => {}}
      onSaveNote={() => {}}
      onCorrectTouch={() => {}}
    />,
  );
}

describe("the touch form, a note and the touchlog share the activity day", () => {
  it("runs the zone the test pins", () => {
    expect(new Date("2026-10-19T12:00:00Z").getTimezoneOffset()).toBe(360);
  });

  it("by default the touch form and a note both take the viewer's day", async () => {
    vi.setSystemTime(new Date("2026-10-20T05:25:00Z"));
    expect(touchFormDefault()).toBe("2026-10-19");
    expect(await noteDate()).toBe("2026-10-19");
  });

  it("under a named zone the touch form's default and a note agree on that zone's day", async () => {
    vi.setSystemTime(new Date("2026-10-20T05:25:00Z"));
    holder.rules = { zone: "Pacific/Auckland" };
    expect(touchFormDefault()).toBe("2026-10-20");
    expect(await noteDate()).toBe("2026-10-20");
  });

  it("by default a follow-up due on the viewer's today is not overdue", () => {
    vi.setSystemTime(new Date("2026-10-21T05:25:00Z")); // Oct 20, 11:25 PM in Denver
    const html = touchlog();
    expect(html).toContain("Next follow-up: ");
    expect(html).not.toContain("Follow-up overdue: ");
  });

  it("under a named zone the follow-up is judged on that zone's day", () => {
    vi.setSystemTime(new Date("2026-10-21T05:25:00Z")); // already Oct 21 in Auckland
    holder.rules = { zone: "Pacific/Auckland" };
    expect(touchlog()).toContain("Follow-up overdue: ");
  });
});
