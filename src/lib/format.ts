// Shared date formatting helpers used across route files.
// Standardizes on 'MMM d, yyyy' (and 'MMM d, yyyy · h:mm a' for timestamps).
// All of it reads the browser's time zone: a timestamp renders as the local
// day it happened on, and a calendar-only `yyyy-MM-dd` value renders as that
// same day in every zone (parseISO reads it as local midnight, not UTC).
import { format, parseISO } from "date-fns";
import { VIEWER_ZONE, todayForActivity } from "@/lib/activityDate";

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return format(parseISO(value), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return format(parseISO(value), "MMM d, yyyy · h:mm a");
  } catch {
    return "—";
  }
}

/** Today as the browser's local calendar date (`yyyy-MM-dd`), whatever the
 * activity rules say. Not `toISOString().slice(0, 10)`, which is UTC's day and
 * is already tomorrow in Denver from 6 pm (5 pm in winter).
 *
 * Viewer-only: never use it for an activity write or an activity's "today"
 * (completed_date, touch_date, a touch form default, follow-up status). Those
 * go through todayForActivity(new Date(), activityDateRules()), which equals
 * this only under the default rules. It is kept for viewer-local "today"
 * reads such as the readiness and expiry helpers' localTodayIso copies. */
export function todayLocal(now: Date = new Date()): string {
  return todayForActivity(now, { zone: VIEWER_ZONE });
}
