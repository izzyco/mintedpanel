// MINT-75 / MINT-129 — the day an activity is filed under: the viewer's own
// by default, or one named time zone's. Pinned at the ticket's moment, 11:25 PM
// MDT on Oct 19, 2026, when UTC is already Oct 20. This file is byte-identical
// on both MINT-75 branches, like the module it tests.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import {
  DEFAULT_ACTIVITY_DATE_RULES,
  activityDateRules,
  isIanaTimeZone,
  resolveActivityDateRules,
  todayForActivity,
  validateActivityDateRules,
  type ActivityDateRules,
} from "./activityDate";

const TICKET_MOMENT = new Date("2026-10-20T05:25:00Z");
const priorTz = process.env.TZ;

function pinZone(zone: string) {
  beforeAll(() => {
    process.env.TZ = zone;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

const zone = (name: string): ActivityDateRules => ({ zone: name });

describe("DEFAULT_ACTIVITY_DATE_RULES", () => {
  it("is the viewer's own day, the decision of Oct 30", () => {
    expect(DEFAULT_ACTIVITY_DATE_RULES).toEqual({ zone: "viewer" });
    expect(Object.isFrozen(DEFAULT_ACTIVITY_DATE_RULES)).toBe(true);
    expect(activityDateRules()).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
    expect(Object.isFrozen(activityDateRules())).toBe(true);
  });
});

describe("todayForActivity in a Denver browser", () => {
  pinZone("America/Denver");

  it("runs the zone the test pins", () => {
    expect(new Date("2026-10-19T12:00:00Z").getTimezoneOffset()).toBe(360);
  });

  it("by default files the activity under the viewer's day, exactly as date-fns formats it", () => {
    expect(todayForActivity(TICKET_MOMENT)).toBe("2026-10-19");
    expect(todayForActivity(TICKET_MOMENT, DEFAULT_ACTIVITY_DATE_RULES)).toBe("2026-10-19");
    for (const iso of ["2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", "2026-11-01T07:59:00Z"]) {
      expect(todayForActivity(new Date(iso))).toBe(format(new Date(iso), "yyyy-MM-dd"));
    }
  });

  it("defaults to the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(TICKET_MOMENT);
    expect(todayForActivity()).toBe("2026-10-19");
  });

  it("with a named zone, files it under that zone's day instead", () => {
    expect(todayForActivity(TICKET_MOMENT, zone("Pacific/Auckland"))).toBe("2026-10-20");
    expect(todayForActivity(TICKET_MOMENT, zone("UTC"))).toBe("2026-10-20");
    expect(todayForActivity(TICKET_MOMENT, zone("America/Denver"))).toBe("2026-10-19");
  });

  it("falls back to the viewer's day for a zone the runtime does not know", () => {
    expect(todayForActivity(TICKET_MOMENT, zone("Mars/Olympus"))).toBe("2026-10-19");
    expect(todayForActivity(TICKET_MOMENT, zone("+05:00"))).toBe("2026-10-19");
  });
});

describe("todayForActivity in a UTC browser", () => {
  pinZone("UTC");

  it("runs the zone the test pins", () => {
    expect(new Date("2026-10-19T12:00:00Z").getTimezoneOffset()).toBe(0);
  });

  it("a named zone does not follow the viewer: Denver's day stays Oct 19", () => {
    expect(todayForActivity(TICKET_MOMENT)).toBe("2026-10-20");
    expect(todayForActivity(TICKET_MOMENT, zone("America/Denver"))).toBe("2026-10-19");
  });

  it("keeps both edges of a named zone's daylight-saving days", () => {
    const denver = zone("America/Denver");
    expect(todayForActivity(new Date("2026-03-08T06:59:00Z"), denver)).toBe("2026-03-07");
    expect(todayForActivity(new Date("2026-03-08T07:00:00Z"), denver)).toBe("2026-03-08");
    expect(todayForActivity(new Date("2026-11-01T05:59:00Z"), denver)).toBe("2026-10-31");
    expect(todayForActivity(new Date("2026-11-01T06:00:00Z"), denver)).toBe("2026-11-01");
    expect(todayForActivity(new Date("2026-11-02T06:59:00Z"), denver)).toBe("2026-11-01");
    expect(todayForActivity(new Date("2026-11-02T07:00:00Z"), denver)).toBe("2026-11-02");
  });

  it("every real zone's day is within one day of the UTC day, so the database's guard never trips", () => {
    const utcMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
    const extremes = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Etc/GMT+12", "Etc/GMT-14"];
    for (let hour = 0; hour < 48; hour += 1) {
      const at = new Date(Date.UTC(2026, 9, 19, hour, 30));
      const utcDay = at.toISOString().slice(0, 10);
      for (const name of extremes) {
        const gap = Math.abs(utcMs(todayForActivity(at, zone(name))) - utcMs(utcDay));
        expect(gap).toBeLessThanOrEqual(86_400_000);
      }
    }
  });
});

describe("isIanaTimeZone", () => {
  it("accepts zone names and rejects offsets, sentinels and junk", () => {
    for (const name of ["America/Denver", "Pacific/Auckland", "UTC", "Etc/GMT+7"]) {
      expect(isIanaTimeZone(name)).toBe(true);
    }
    for (const value of ["viewer", "+05:00", "-0700", "Mars/Olympus", "", " UTC", null, 5]) {
      expect(isIanaTimeZone(value)).toBe(false);
    }
  });
});

describe("resolveActivityDateRules", () => {
  it("is the default when nothing is stored", () => {
    expect(resolveActivityDateRules()).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
    expect(resolveActivityDateRules(null, null)).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
    expect(resolveActivityDateRules({}, {})).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
  });

  it("takes the organization's zone, else the platform's, else the default", () => {
    expect(resolveActivityDateRules({ zone: "America/Denver" })).toEqual(zone("America/Denver"));
    expect(resolveActivityDateRules(null, { zone: "America/Denver" })).toEqual(
      zone("America/Denver"),
    );
    expect(
      resolveActivityDateRules({ zone: "America/Denver" }, { zone: "Pacific/Auckland" }),
    ).toEqual(zone("Pacific/Auckland"));
    expect(resolveActivityDateRules({ zone: "America/Denver" }, { zone: "viewer" })).toEqual(
      DEFAULT_ACTIVITY_DATE_RULES,
    );
  });

  it("inherits on null or undefined", () => {
    expect(resolveActivityDateRules({ zone: "UTC" }, { zone: null })).toEqual(zone("UTC"));
    expect(resolveActivityDateRules({ zone: "UTC" }, { zone: undefined })).toEqual(zone("UTC"));
  });

  it("skips a value of the wrong shape like a missing one", () => {
    const bad = { zone: "+05:00" };
    expect(resolveActivityDateRules({ zone: "UTC" }, bad)).toEqual(zone("UTC"));
    expect(resolveActivityDateRules({ zone: "Mars/Olympus" })).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
    expect(
      resolveActivityDateRules({ zone: 7 } as unknown as ActivityDateRules, { zone: "" }),
    ).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
  });
});

describe("validateActivityDateRules", () => {
  it("passes the default, a named zone, an empty override and an inherit", () => {
    expect(validateActivityDateRules(null)).toEqual([]);
    expect(validateActivityDateRules(undefined)).toEqual([]);
    expect(validateActivityDateRules({})).toEqual([]);
    expect(validateActivityDateRules(DEFAULT_ACTIVITY_DATE_RULES)).toEqual([]);
    expect(validateActivityDateRules({ zone: "America/Denver" })).toEqual([]);
    expect(validateActivityDateRules({ zone: null })).toEqual([]);
  });

  it("rejects something that is not a set of settings", () => {
    for (const value of ["viewer", 1, true, []]) {
      expect(validateActivityDateRules(value)).toEqual([
        "Activity date rules must be a set of named settings.",
      ]);
    }
  });

  it("rejects a zone that is not a time zone, in plain language", () => {
    for (const value of ["Mars/Olympus", "+05:00", "", 5]) {
      expect(validateActivityDateRules({ zone: value })).toEqual([
        `"${String(value)}" is not a time zone. Use "viewer" (each person's own time zone) or a time zone name such as "America/Denver".`,
      ]);
    }
  });

  it("rejects an unknown setting by name, including the database's date guard", () => {
    expect(validateActivityDateRules({ zone: "UTC", clientDateWindowDays: 30 })).toEqual([
      '"clientDateWindowDays" is not an activity date setting.',
    ]);
  });
});
