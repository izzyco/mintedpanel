// DYN-TODAY-01 — the `system.*` token family: values no table holds and no
// server resolves. Today there is exactly one, `system.today`, the calendar
// date on the coordinator's own device at the moment a form is filled, for
// signature / attestation / submission-date boxes.
//
// Resolution is DEVICE-SIDE BY CONTRACT (shared with the extension):
//   * the web fill (extension) resolves it in the browser before the
//     field-map → profile-token join, so `GET /api/providers/:id/profile`
//     never emits it — `src/server/profileFieldMapJoin.test.ts` pins that;
//   * the payer-PDF fill (panel) resolves it in `useFillPayerForm` at fill
//     click, so the sample fill and a real case fill agree by construction.
// A server clock would be wrong for a coordinator west of UTC filling a form
// in the evening, and a value baked into a SOP at case creation would be
// stale by the time anyone signs — which is also why the SOP authoring picker
// does not offer this family (`sopResolver.isResolvableToken` is family-based
// and knows nothing of `system`).
//
// Pure: every function takes the clock as an argument. Callers in hooks and
// components pass `new Date()`; nothing here reads one.

export const SYSTEM_TOKEN_FAMILY = "system";
export const SYSTEM_TODAY_TOKEN = "system.today";

/** Every key in the family, in catalog order. */
export const SYSTEM_TOKENS: readonly string[] = [SYSTEM_TODAY_TOKEN];

/** What a picker or registry row says next to a device-resolved token. */
export const DEVICE_RESOLVED_TOKEN_COPY = "Filled with today's date when the form is filled.";

export function isSystemToken(token: string | null | undefined): boolean {
  return token != null && SYSTEM_TOKENS.includes(token);
}

/** A token the device resolves at fill time — never the profile endpoint, never
 * a stored row. Exactly the `system.*` family for now; named separately so UI
 * copy and reach maps do not have to know which families are device-resolved. */
export function isDeviceResolvedToken(token: string | null | undefined): boolean {
  return isSystemToken(token);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The LOCAL calendar date of `now` as canonical ISO `YYYY-MM-DD`. Uses the
 * local getters, not `toISOString()`, which is UTC and would hand a West-Coast
 * coordinator tomorrow's date after 5 pm. The canonical form is what every
 * `date_*` transform in `controlOptions.ts` parses, so a mapped field's
 * transform picks the payer's spelling (MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, …). */
export function localCalendarDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** The family resolved against one clock reading. */
export function resolveSystemTokenValues(now: Date): Record<string, string> {
  return { [SYSTEM_TODAY_TOKEN]: localCalendarDate(now) };
}

/** `values` with the system family layered on top. System keys always win: a
 * stored or mocked value for `system.today` would defeat the point of the
 * token. */
export function withSystemTokenValues(
  values: Readonly<Record<string, string>>,
  now: Date,
): Record<string, string> {
  return { ...values, ...resolveSystemTokenValues(now) };
}

/** Is `value` a canonical, calendar-valid `YYYY-MM-DD`? The shape the
 * fill-events write boundary accepts for the resolved `system.today` value. */
export function isCalendarDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}
