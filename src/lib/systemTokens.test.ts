import { describe, expect, it } from "vitest";
import { applyRegistryTransform } from "@/lib/payerFormFill";
import {
  DEVICE_RESOLVED_TOKEN_COPY,
  SYSTEM_TODAY_TOKEN,
  SYSTEM_TOKENS,
  isCalendarDateString,
  isDeviceResolvedToken,
  isSystemToken,
  localCalendarDate,
  resolveSystemTokenValues,
  withSystemTokenValues,
} from "./systemTokens";

describe("localCalendarDate", () => {
  it("formats the LOCAL calendar date, not the UTC one", () => {
    // 23:30 local on Oct 15. toISOString() would say Oct 16 anywhere west of
    // UTC-0:30; the signature date on a form must be the day the coordinator
    // is sitting in.
    const lateEvening = new Date(2026, 9, 15, 23, 30, 0);
    expect(localCalendarDate(lateEvening)).toBe("2026-10-15");
    const earlyMorning = new Date(2026, 0, 1, 0, 5, 0);
    expect(localCalendarDate(earlyMorning)).toBe("2026-01-01");
  });

  it("zero-pads month and day", () => {
    expect(localCalendarDate(new Date(2026, 2, 7))).toBe("2026-03-07");
  });

  it("yields the canonical ISO form every date transform parses", () => {
    const value = localCalendarDate(new Date(2026, 9, 15));
    expect(applyRegistryTransform(value, "date_mmddyyyy")).toBe("10/15/2026");
    expect(applyRegistryTransform(value, "date_mmddyyyy_dash")).toBe("10-15-2026");
    expect(applyRegistryTransform(value, "date_yyyymmdd")).toBe("2026-10-15");
  });
});

describe("the system family", () => {
  it("is exactly system.today", () => {
    expect(SYSTEM_TOKENS).toEqual(["system.today"]);
    expect(SYSTEM_TODAY_TOKEN).toBe("system.today");
    expect(isSystemToken("system.today")).toBe(true);
    expect(isSystemToken("provider.startDate")).toBe(false);
    expect(isSystemToken(null)).toBe(false);
    expect(isDeviceResolvedToken("system.today")).toBe(true);
    expect(isDeviceResolvedToken("user.name")).toBe(false);
  });

  it("resolves against the clock it is handed, never one it reads", () => {
    expect(resolveSystemTokenValues(new Date(2026, 9, 15, 9))).toEqual({
      "system.today": "2026-10-15",
    });
  });

  it("layers over existing values and always wins", () => {
    const merged = withSystemTokenValues(
      { "provider.npi": "1999999984", "system.today": "1999-12-31" },
      new Date(2026, 9, 15),
    );
    expect(merged).toEqual({ "provider.npi": "1999999984", "system.today": "2026-10-15" });
  });

  it("has UI copy that says when the value appears", () => {
    expect(DEVICE_RESOLVED_TOKEN_COPY).toMatch(/today's date/);
  });
});

describe("isCalendarDateString", () => {
  it("accepts canonical calendar-valid dates only", () => {
    expect(isCalendarDateString("2026-10-15")).toBe(true);
    expect(isCalendarDateString("2024-02-29")).toBe(true);
    expect(isCalendarDateString("2026-02-29")).toBe(false);
    expect(isCalendarDateString("2026-13-01")).toBe(false);
    expect(isCalendarDateString("2026-00-10")).toBe(false);
    expect(isCalendarDateString("10/15/2026")).toBe(false);
    expect(isCalendarDateString("2026-10-15T00:00:00Z")).toBe(false);
    expect(isCalendarDateString("")).toBe(false);
    expect(isCalendarDateString(null)).toBe(false);
    expect(isCalendarDateString(20261015)).toBe(false);
  });
});
