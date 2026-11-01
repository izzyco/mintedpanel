// MINT-91 Addendum 8 (A5): what an import does with a NEW row whose phone fails
// isValidUsPhone. Applied to the dedupe's result, so the dedupe stays
// phone-blind. Only a create writes a phone. A row matched to an existing
// provider, group or facility never writes one, and a later row for the same
// new record never does either: provider rows fold into the first row's values,
// and a repeated group TIN or facility is skipped as a duplicate in the file.
//
// PhoneValidationRules.importInvalidPhone (Mission Control MINT-129):
//   "create_without_phone" (default): the phone is left blank and the create
//     carries a warning naming the column, shown on the row in review and
//     written to the run's report at commit;
//   "block_row": the create's rows are blocked instead.
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
} from "@/lib/importDedupe";
import type { ImportRunErrorEntry } from "@/types";

/** The phone columns each section import writes on a create. */
const SECTION_PHONE_COLUMNS: Record<"provider_group" | "facility", readonly string[]> = {
  provider_group: ["billing_phone", "corr_phone", "cred_phone"],
  facility: ["phone", "appointment_phone"],
};

export const importPhoneWarningReason = (column: string): string =>
  `Warning: ${column} is not a 10-digit US phone number, so it is left blank`;

export const importPhoneBlockedReason = (column: string): string =>
  `${column} must be a 10-digit US phone number`;

function isInvalidPhone(value: string | null | undefined): boolean {
  const phone = value?.trim() ?? "";
  return phone !== "" && !isValidUsPhone(phone);
}

/** The provider preview: a create whose phone fails is created without it and
 * warned about, or, under "block_row", turned into one blocked row per source
 * line it folded. */
export function applyProviderImportPhoneRule(
  dispositions: ImportRowDisposition[],
  rules: PhoneValidationRules = DEFAULT_PHONE_VALIDATION_RULES,
): ImportRowDisposition[] {
  return dispositions.flatMap((d): ImportRowDisposition[] => {
    if (d.kind !== "create" || !isInvalidPhone(d.provider.phone)) return [d];
    if (rules.importInvalidPhone === "block_row") {
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
    const warning: ImportRowWarning = {
      line: d.line,
      column: "phone",
      reason: importPhoneWarningReason("phone"),
    };
    return [
      {
        ...d,
        provider: { ...d.provider, phone: null },
        warnings: [...(d.warnings ?? []), warning],
      },
    ];
  });
}

/** The group or facility preview: each phone column that fails is left blank
 * and warned about, or, under "block_row", the row is blocked on the first. */
export function applySectionImportPhoneRule(
  result: SectionDedupeResult,
  entityKind: keyof typeof SECTION_PHONE_COLUMNS,
  rules: PhoneValidationRules = DEFAULT_PHONE_VALIDATION_RULES,
): SectionDedupeResult {
  const creates: SectionCreateEntry[] = [];
  const blocked: SectionBlockedEntry[] = [...result.blocked];
  for (const entry of result.creates) {
    const bad = SECTION_PHONE_COLUMNS[entityKind].filter((c) => isInvalidPhone(entry.mapped[c]));
    if (bad.length === 0) {
      creates.push(entry);
      continue;
    }
    if (rules.importInvalidPhone === "block_row") {
      blocked.push({
        line: entry.line,
        column: bad[0],
        displayName: entry.displayName,
        reason: importPhoneBlockedReason(bad[0]),
      });
      continue;
    }
    // A blank correspondence or credentialing block inherits billing's values,
    // so a copy of billing_phone is left blank under billing's one warning.
    const warned =
      entityKind === "provider_group"
        ? bad.filter((c) => c === "billing_phone" || entry.mapped[c] !== entry.mapped.billing_phone)
        : bad;
    creates.push({
      ...entry,
      mapped: { ...entry.mapped, ...Object.fromEntries(bad.map((c) => [c, null])) },
      warnings: [
        ...(entry.warnings ?? []),
        ...warned.map((column) => ({
          line: entry.line,
          column,
          reason: importPhoneWarningReason(column),
        })),
      ],
    });
  }
  blocked.sort((a, b) => a.line - b.line);
  return { creates, skips: result.skips, blocked };
}

/** The warnings of the rows a commit creates, as run-report entries. */
export function importWarningEntries(
  rows: ReadonlyArray<ImportRowDisposition | SectionCreateEntry>,
): ImportRunErrorEntry[] {
  return rows
    .flatMap((row) => ("warnings" in row ? (row.warnings ?? []) : []))
    .map(({ line, column, reason }) => ({ line, column, reason }));
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
