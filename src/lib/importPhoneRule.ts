// MINT-91 Addendum 8 (A5): what an import does with a NEW row whose phone fails
// isValidUsPhone. Applied to the dedupe's result, so the dedupe stays
// phone-blind. Only a create writes a phone; a row matched to an existing
// provider, group or facility never writes one.
//
// A record can span several rows of the file: a provider's later rows fold
// into its first row, and a repeated group TIN or facility is skipped as a
// duplicate. When the first row's phone is blank or isn't a US number, the
// record takes the first valid phone among its other rows, so a good phone in
// the file is never thrown away. Only when an invalid first phone has no valid
// one to replace it does PhoneValidationRules.importInvalidPhone decide
// (Mission Control MINT-129):
//   "create_without_phone" (default): the phone is left blank;
//   "block_row": the record's rows are blocked instead.
// An invalid first phone always carries a warning: on screen with the
// column's label and the user's own value, and in the run's stored report with
// the label only. A blank one that is filled carries a note.
import {
  DEFAULT_PHONE_VALIDATION_RULES,
  isValidUsPhone,
  type PhoneValidationRules,
} from "@/lib/phone";
import type {
  ImportRowDisposition,
  ImportRowWarning,
  SectionBlockedEntry,
  SectionCreateEntry,
  SectionDedupeResult,
  StagedImportRow,
} from "@/lib/importDedupe";
import type { ImportRunErrorEntry } from "@/types";

type SectionKind = "provider_group" | "facility";

/** The phone columns each section import writes on a create. */
const SECTION_PHONE_COLUMNS: Record<SectionKind, readonly string[]> = {
  provider_group: ["billing_phone", "corr_phone", "cred_phone"],
  facility: ["phone", "appointment_phone"],
};

const COLUMN_LABELS: Record<string, string> = {
  phone: "Phone",
  appointment_phone: "Appointment phone",
  billing_phone: "Billing phone",
  corr_phone: "Correspondence phone",
  cred_phone: "Credentialing phone",
};

const labelOf = (column: string): string => COLUMN_LABELS[column] ?? column;

/** The warning for one column: `review` quotes the value for the live review;
 * `reason`, for the stored report, names the column only. */
function phoneWarning(
  line: number,
  column: string,
  value: string,
  replacedFromLine: number | null,
): ImportRowWarning {
  const label = labelOf(column);
  const outcome =
    replacedFromLine === null
      ? { review: "it will be left blank", report: "it was left blank" }
      : {
          review: `row ${replacedFromLine}'s ${label.toLowerCase()} is used`,
          report: `row ${replacedFromLine}'s ${label.toLowerCase()} was used`,
        };
  return {
    line,
    column,
    reason: `Warning: ${label} isn't a US number, so ${outcome.report}.`,
    review: `${label} "${value}" isn't a US number, so ${outcome.review}.`,
    leftBlank: replacedFromLine === null,
  };
}

export const importPhoneBlockedReason = (column: string): string =>
  `${column} must be a 10-digit US phone number`;

const cell = (mapped: Record<string, string | null> | null | undefined, column: string) =>
  mapped?.[column]?.trim() ?? "";

const isInvalidPhone = (value: string): boolean => value !== "" && !isValidUsPhone(value);

/** The first of `lines` whose `column` holds a valid phone. */
function firstValidPhone(
  lines: readonly number[],
  column: string,
  mappedByLine: ReadonlyMap<number, Record<string, string | null> | null>,
): { line: number; phone: string } | null {
  for (const line of lines) {
    const phone = cell(mappedByLine.get(line), column);
    if (phone !== "" && isValidUsPhone(phone)) return { line, phone };
  }
  return null;
}

const byLine = (rows: readonly StagedImportRow[]) => new Map(rows.map((r) => [r.line, r.mapped]));

/** The provider preview. `rows` are the run's staged rows (for the folded
 * rows' phones). */
export function applyProviderImportPhoneRule(
  dispositions: ImportRowDisposition[],
  rows: readonly StagedImportRow[],
  rules: PhoneValidationRules = DEFAULT_PHONE_VALIDATION_RULES,
): ImportRowDisposition[] {
  const mappedByLine = byLine(rows);
  return dispositions.flatMap((d): ImportRowDisposition[] => {
    if (d.kind !== "create") return [d];
    const first = d.provider.phone?.trim() ?? "";
    if (first !== "" && isValidUsPhone(first)) return [d];
    const laterLines = d.lines.filter((line) => line !== d.line);
    const replacement = firstValidPhone(laterLines, "phone", mappedByLine);
    if (!replacement && first !== "" && rules.importInvalidPhone === "block_row") {
      return d.lines.map((line) => ({
        kind: "blocked",
        line,
        column: line === d.line ? "phone" : "npi",
        displayName: d.displayName,
        reason:
          line === d.line
            ? importPhoneBlockedReason("phone")
            : `Same provider (NPI ${d.npi}) as row ${d.line}, which is blocked`,
      }));
    }
    // The dedupe's fold note leaves the phone out unless the first row's is
    // valid; note here which phone is used and each other one that isn't.
    const notes = [...d.notes];
    if (first === "" && replacement) {
      notes.push(
        `Row ${d.line} lists no phone for NPI ${d.npi} — row ${replacement.line}'s phone is used`,
      );
    }
    for (const line of laterLines) {
      const phone = cell(mappedByLine.get(line), "phone");
      if (line === replacement?.line || phone === "" || phone === replacement?.phone) continue;
      notes.push(
        replacement
          ? `Row ${line} lists a different phone for NPI ${d.npi} — row ${replacement.line}'s phone is used`
          : `Row ${line}'s phone for NPI ${d.npi} isn't a US number, so it isn't used`,
      );
    }
    if (first === "" && !replacement && notes.length === d.notes.length) return [d];
    return [
      {
        ...d,
        provider: { ...d.provider, phone: replacement?.phone ?? null },
        notes,
        ...(first === ""
          ? {}
          : {
              warnings: [
                ...(d.warnings ?? []),
                phoneWarning(d.line, "phone", first, replacement?.line ?? null),
              ],
            }),
      },
    ];
  });
}

/** The group or facility preview. `rows` are the run's staged rows (for the
 * record's duplicate rows). */
export function applySectionImportPhoneRule(
  result: SectionDedupeResult,
  entityKind: SectionKind,
  rows: readonly StagedImportRow[],
  rules: PhoneValidationRules = DEFAULT_PHONE_VALIDATION_RULES,
): SectionDedupeResult {
  const mappedByLine = byLine(rows);
  const creates: SectionCreateEntry[] = [];
  const blocked: SectionBlockedEntry[] = [...result.blocked];
  // A duplicate line → the blocked first row of its record (block_row only).
  const blockedFirst = new Map<number, SectionCreateEntry>();
  for (const entry of result.creates) {
    const columns = SECTION_PHONE_COLUMNS[entityKind];
    const duplicateLines = entry.duplicateLines ?? [];
    const mapped = { ...entry.mapped };
    const notes = [...entry.notes];
    // A blank phone takes the first valid one among the record's duplicate rows.
    for (const column of columns) {
      if (cell(entry.mapped, column) !== "") continue;
      const replacement = firstValidPhone(duplicateLines, column, mappedByLine);
      if (!replacement) continue;
      mapped[column] = replacement.phone;
      notes.push(
        `Row ${entry.line} lists no ${labelOf(column).toLowerCase()} — row ${replacement.line}'s is used`,
      );
    }
    const bad = columns.filter((c) => isInvalidPhone(cell(entry.mapped, c)));
    if (bad.length === 0) {
      creates.push(notes.length === entry.notes.length ? entry : { ...entry, mapped, notes });
      continue;
    }
    const outcomes = bad.map((column) => {
      const replacement = firstValidPhone(duplicateLines, column, mappedByLine);
      mapped[column] = replacement?.phone ?? null;
      return { column, value: cell(entry.mapped, column), from: replacement?.line ?? null };
    });
    const leftBlank = outcomes.filter((o) => o.from === null);
    if (leftBlank.length > 0 && rules.importInvalidPhone === "block_row") {
      blocked.push({
        line: entry.line,
        column: leftBlank[0].column,
        displayName: entry.displayName,
        reason: importPhoneBlockedReason(leftBlank[0].column),
      });
      for (const line of duplicateLines) blockedFirst.set(line, entry);
      continue;
    }
    // A blank correspondence or credentialing block inherits billing's values;
    // a copy that ends up like billing's phone shares billing's one warning.
    const warned = outcomes.filter(
      (o) =>
        entityKind !== "provider_group" ||
        o.column === "billing_phone" ||
        o.value !== cell(entry.mapped, "billing_phone") ||
        mapped[o.column] !== mapped.billing_phone,
    );
    creates.push({
      ...entry,
      mapped,
      notes,
      warnings: [
        ...(entry.warnings ?? []),
        ...warned.map((o) => phoneWarning(entry.line, o.column, o.value, o.from)),
      ],
    });
  }
  // Under block_row, a repeat of a blocked record creates nothing either: it
  // is blocked too, naming the row that blocked it.
  const skips = result.skips.filter((skip) => {
    const first = blockedFirst.get(skip.line);
    if (!first) return true;
    const tin = cell(first.mapped, "tin").replace(/\D/g, "");
    blocked.push({
      line: skip.line,
      column: entityKind === "provider_group" ? "group_tin" : "facility_name",
      displayName: skip.displayName,
      reason:
        entityKind === "provider_group"
          ? `Duplicate TIN ${tin} in this file — row ${first.line} is blocked`
          : `Duplicate facility (same group, name and address) in this file — row ${first.line} is blocked`,
    });
    return false;
  });
  blocked.sort((a, b) => a.line - b.line);
  return { creates, skips, blocked };
}

type WithWarnings = ImportRowDisposition | SectionCreateEntry;

const warningsOf = (rows: ReadonlyArray<WithWarnings>): ImportRowWarning[] =>
  rows.flatMap((row) => ("warnings" in row ? (row.warnings ?? []) : []));

/** How many phones a commit leaves blank (for the commit confirmation). */
export function phonesLeftBlank(rows: ReadonlyArray<WithWarnings>): number {
  return warningsOf(rows).filter((w) => w.leftBlank).length;
}

/** The warnings of the rows a commit creates, as run-report entries: the
 * column and the label-only reason, never the value. */
export function importWarningEntries(rows: ReadonlyArray<WithWarnings>): ImportRunErrorEntry[] {
  return warningsOf(rows).map(({ line, column, reason }) => ({
    line,
    column,
    reason,
    severity: "warning",
  }));
}

/** `existing` plus each entry of `extra` it doesn't already hold, so a
 * retried commit never writes a warning twice. */
export function withReportEntries(
  existing: readonly ImportRunErrorEntry[],
  extra: readonly ImportRunErrorEntry[],
): ImportRunErrorEntry[] {
  const key = (e: ImportRunErrorEntry) => `${e.line}|${e.column ?? ""}|${e.reason}`;
  const seen = new Set(existing.map(key));
  const added = extra.filter((e) => {
    if (seen.has(key(e))) return false;
    seen.add(key(e));
    return true;
  });
  return [...existing, ...added];
}
