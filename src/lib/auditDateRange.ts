// Audit Log date filters. The From / To inputs are LOCAL calendar days
// ("YYYY-MM-DD"); audit_log.ts is an instant. `new Date("2026-10-05")`
// parses as UTC midnight, which in every US zone is the previous local
// evening, so both bounds are built from the date's parts in local time.
// Both go to the server: `since` is inclusive (the local midnight that starts
// From), `until` is exclusive (the local midnight after To), so the whole To
// day is in and the read's row limit can never cut an older range to empty.
// Pure: the zone is the runtime's, no clock read.

export interface AuditDateBounds {
  /** Inclusive lower bound (ISO instant), or undefined for no From. */
  since?: string;
  /** Exclusive upper bound (ISO instant), or undefined for no To. */
  until?: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight starting `date` plus `addDays`; null for a malformed or
 * impossible date (2026-02-31). */
function localMidnight(date: string, addDays = 0): Date | null {
  const m = DATE_ONLY.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const start = new Date(year, month, day);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== day) {
    return null;
  }
  // Day arithmetic on the parts, not +24h, so a DST change cannot shift it.
  return addDays === 0 ? start : new Date(year, month, day + addDays);
}

export function auditDateBounds(dateFrom: string, dateTo: string): AuditDateBounds {
  const from = dateFrom ? localMidnight(dateFrom) : null;
  const toExclusive = dateTo ? localMidnight(dateTo, 1) : null;
  return {
    since: from ? from.toISOString() : undefined,
    until: toExclusive ? toExclusive.toISOString() : undefined,
  };
}
