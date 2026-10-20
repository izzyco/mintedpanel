// Audit Log date bounds are LOCAL calendar days. Pinned in a US zone, where
// the old `new Date("YYYY-MM-DD")` (UTC midnight) bounds started From the
// previous evening and dropped the whole To day.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDateBounds } from "./auditDateRange";

const priorTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

describe("auditDateBounds", () => {
  it("runs the zone the test pins", () => {
    // EDT is UTC-4 on this date; if the runtime ignored TZ the rest is moot.
    expect(new Date(2026, 9, 5).getTimezoneOffset()).toBe(240);
  });

  it("From starts at local midnight; To runs through the end of its local day", () => {
    expect(auditDateBounds("2026-10-05", "2026-10-05")).toEqual({
      since: "2026-10-05T04:00:00.000Z",
      until: "2026-10-06T04:00:00.000Z",
    });
  });

  it("keeps a late-evening event on the To day and the next morning out", () => {
    const { since = "", until = "" } = auditDateBounds("2026-10-05", "2026-10-05");
    const lateEvening = new Date(2026, 9, 5, 23, 30).toISOString();
    const nextMidnight = new Date(2026, 9, 6).toISOString();
    expect(lateEvening >= since && lateEvening < until).toBe(true);
    expect(nextMidnight < until).toBe(false);
  });

  it("crosses a DST change by calendar day, not by 24 hours", () => {
    // US DST ends 2026-11-01: that local day is 25 hours long.
    expect(auditDateBounds("2026-11-01", "2026-11-01")).toEqual({
      since: "2026-11-01T04:00:00.000Z",
      until: "2026-11-02T05:00:00.000Z",
    });
  });

  it("each bound is optional, and a malformed or impossible date sets none", () => {
    expect(auditDateBounds("", "")).toEqual({ since: undefined, until: undefined });
    expect(auditDateBounds("2026-10-05", "")).toEqual({
      since: "2026-10-05T04:00:00.000Z",
      until: undefined,
    });
    expect(auditDateBounds("2026-02-31", "10/05/2026")).toEqual({
      since: undefined,
      until: undefined,
    });
  });
});
