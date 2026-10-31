// MINT-75 / MINT-129 — the day an activity is filed under: the viewer's own
// by default, or one named time zone's. Pinned at the ticket's moment, 11:25 PM
// MDT on Oct 19, 2026, when UTC is already Oct 20. This file is byte-identical
// on both MINT-75 branches, like the module it tests.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import {
  DEFAULT_ACTIVITY_DATE_RULES,
  activityDateRules,
  canonicalTimeZone,
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

// Zones that ignore daylight saving or are not in tzdata: never accepted.
const REJECTED_ZONES = [
  "+05:00",
  "-0700",
  "Etc/GMT+7",
  "Etc/GMT-14",
  "GMT",
  "Zulu",
  "EST",
  "MST",
  "HST",
  "EST5EDT",
  "CET",
  "PST8PDT",
  "US/Mountain",
  "Universal",
  "AET",
  "SystemV/AST4",
];

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

  it("files it under a named zone's day whatever its spelling", () => {
    expect(todayForActivity(TICKET_MOMENT, zone("pacific/auckland"))).toBe("2026-10-20");
    expect(todayForActivity(TICKET_MOMENT, zone("Etc/UTC"))).toBe("2026-10-20");
  });

  it("falls back to the viewer's day for a zone it does not accept", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const name of ["Mars/Olympus", ...REJECTED_ZONES]) {
        expect(todayForActivity(TICKET_MOMENT, zone(name))).toBe("2026-10-19");
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("says so once per page load, naming no value", async () => {
    vi.resetModules();
    const fresh = await import("./activityDate");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fresh.todayForActivity(TICKET_MOMENT, zone("EST"));
      fresh.todayForActivity(TICKET_MOMENT, zone("Mars/Olympus"));
      fresh.todayForActivity(TICKET_MOMENT, zone("viewer"));
      fresh.todayForActivity(TICKET_MOMENT, zone("America/Denver"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.join(" ")).not.toMatch(/EST|Mars/);
    } finally {
      warn.mockRestore();
    }
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
    // The farthest-ahead and farthest-behind places: UTC+14 and UTC-11.
    const extremes = [
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      "Pacific/Niue",
      "Pacific/Tongatapu",
    ];
    for (const name of extremes) expect(isIanaTimeZone(name)).toBe(true);
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

describe("isIanaTimeZone and canonicalTimeZone", () => {
  it("accepts a place's zone and UTC", () => {
    for (const name of [
      "America/Denver",
      "Pacific/Auckland",
      "America/Argentina/Buenos_Aires",
      "America/Port-au-Prince",
      "UTC",
      "Etc/UTC",
    ]) {
      expect(isIanaTimeZone(name)).toBe(true);
    }
  });

  it("rejects offsets, abbreviations, links outside the place areas, ICU-only names and junk", () => {
    for (const value of [...REJECTED_ZONES, "viewer", "Mars/Olympus", "", " UTC", null, 5]) {
      expect(isIanaTimeZone(value)).toBe(false);
      expect(canonicalTimeZone(value)).toBeNull();
    }
  });

  it("returns the runtime's canonical spelling", () => {
    expect(canonicalTimeZone("america/denver")).toBe("America/Denver");
    expect(canonicalTimeZone("America/Denver")).toBe("America/Denver");
    expect(canonicalTimeZone("utc")).toBe("UTC");
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

  it("stores a zone in its canonical spelling", () => {
    expect(resolveActivityDateRules({ zone: "america/denver" })).toEqual(zone("America/Denver"));
    expect(resolveActivityDateRules(null, { zone: "utc" })).toEqual(zone("UTC"));
  });

  it("skips a value of the wrong shape like a missing one", () => {
    for (const bad of REJECTED_ZONES) {
      expect(resolveActivityDateRules({ zone: "UTC" }, { zone: bad })).toEqual(zone("UTC"));
      expect(resolveActivityDateRules({ zone: bad })).toEqual(DEFAULT_ACTIVITY_DATE_RULES);
    }
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
    expect(validateActivityDateRules({ zone: "UTC" })).toEqual([]);
    expect(validateActivityDateRules({ zone: null })).toEqual([]);
  });

  it("rejects something that is not a set of settings", () => {
    for (const value of ["viewer", 1, true, []]) {
      expect(validateActivityDateRules(value)).toEqual([
        "Activity date rules must be a set of named settings.",
      ]);
    }
  });

  it("rejects a zone it does not take, in plain language", () => {
    for (const value of ["Mars/Olympus", "", 5, ...REJECTED_ZONES]) {
      expect(validateActivityDateRules({ zone: value })).toEqual([
        `"${String(value)}" is not a time zone this setting takes. Use "viewer" (each person's own time zone), "UTC", or a place's time zone such as "America/Denver"; offsets and abbreviations such as "EST" ignore daylight saving.`,
      ]);
    }
  });

  it("rejects an unknown setting by name, including the database's date guard", () => {
    expect(validateActivityDateRules({ zone: "UTC", clientDateWindowDays: 30 })).toEqual([
      '"clientDateWindowDays" is not an activity date setting.',
    ]);
  });
});
