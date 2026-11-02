// MINT-75 (Addendum 11, I1) — the Reports Summary's coordinator table judges
// "overdue" and "touches in the last 30 days" on the activity day, like the
// case pages: the viewer's own day by default, one named zone's day when a
// platform or organization sets one. Rendered in a Denver browser at 7:00 PM
// MDT on Oct 19, 2026, when UTC is already Oct 20.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDateRules } from "@/lib/activityDate";

const holder = vi.hoisted(() => ({ rules: null as ActivityDateRules | null }));
const loaded = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

vi.mock("@/hooks/useCases", () => ({
  useCases: () =>
    loaded([
      {
        id: "case-1",
        assignedTo: "coord-1",
        credentialingStatusId: null,
        groupId: null,
        state: "CO",
        submittedDate: null,
        approvedDate: null,
        payerId: "payer-1",
      },
    ]),
}));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () =>
    loaded([
      // Due today on the Denver clock: not overdue yet, though UTC is Oct 20.
      { id: "task-1", caseId: "case-1", status: "in_progress", dueDate: "2026-10-19" },
      { id: "task-2", caseId: "case-1", status: "in_progress", dueDate: "2026-10-18" },
    ]),
}));
vi.mock("@/hooks/useProviders", () => ({ useProviders: () => loaded([]) }));
vi.mock("@/hooks/useAdmin", () => ({
  usePayers: () => loaded([{ id: "payer-1", name: "Payer One" }]),
  useStatusConfigs: () => loaded([]),
}));
vi.mock("@/hooks/useLookups", () => ({
  useProviderGroups: () => loaded([]),
  useCoordinators: () => loaded([{ id: "coord-1", fullName: "Coord One", email: null }]),
}));
vi.mock("@/hooks/useReports", () => ({
  useTouchSummary: () =>
    loaded([
      { coordinatorId: "coord-1", touchDate: "2026-10-19" },
      // Exactly 30 days before Denver's Oct 19: inside the window.
      { coordinatorId: "coord-1", touchDate: "2026-09-19" },
      { coordinatorId: "coord-1", touchDate: "2026-09-18" },
    ]),
}));
// Stands in for a stored override: the reader returns what the test sets.
vi.mock("@/lib/activityDate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activityDate")>();
  return { ...actual, activityDateRules: () => holder.rules ?? actual.activityDateRules() };
});

import { SummaryTab } from "./SummaryTab";

const priorTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Denver";
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

beforeEach(() => {
  holder.rules = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T01:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function coordinatorRow(): { open: number; overdue: number; touches30: number } | null {
  const html = renderToStaticMarkup(<SummaryTab />);
  const cell = "<td[^>]*>(\\d+)</td>";
  const row = new RegExp(`<td class="px-4">Coord One</td>${cell}${cell}${cell}`).exec(html);
  return row ? { open: +row[1], overdue: +row[2], touches30: +row[3] } : null;
}

describe("SummaryTab coordinator table under ActivityDateRules", () => {
  it("runs the zone and the moment the test pins", () => {
    expect(new Date().getTimezoneOffset()).toBe(360);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-10-20");
  });

  it("by default uses the viewer's day after 6 pm in Denver, not tomorrow's UTC date", () => {
    expect(coordinatorRow()).toEqual({ open: 1, overdue: 1, touches30: 2 });
  });

  it("with a named zone, uses that zone's day instead", () => {
    holder.rules = { zone: "Pacific/Auckland" };
    expect(coordinatorRow()).toEqual({ open: 1, overdue: 2, touches30: 1 });
  });
});
