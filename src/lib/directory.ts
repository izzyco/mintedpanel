// Workbench directory (Nov 4, 2026): the pure half of the read-only lookup of
// groups, providers and locations behind GET /api/groups, /api/locations,
// the extended /api/providers search and card, and the directory card layouts
// on /api/me/view-prefs?card=.
//
// Owns the card field catalogs (keys, labels, sections and defaults match the
// approved mocks), the layout PUT validator, the search query parser (state
// code or full state name), the term matcher, and the small derivations the
// service shapes rows with. No clock reads.
import { US_STATE_NAMES, US_STATES } from "@/lib/usStates";

export const DIRECTORY_CARD_TYPES = ["group", "provider", "location"] as const;
export type DirectoryCardType = (typeof DIRECTORY_CARD_TYPES)[number];

/** One saved layout per card type, in user_table_prefs (no migration). */
export const DIRECTORY_LAYOUT_PAGE_KEYS: Readonly<Record<DirectoryCardType, string>> = {
  group: "extension.directory.group",
  provider: "extension.directory.provider",
  location: "extension.directory.location",
};

export interface DirectoryCatalogField {
  key: string;
  label: string;
  defaultOn: boolean;
}

export interface DirectoryCatalogSection {
  group: string;
  label: string;
  fields: DirectoryCatalogField[];
}

const on = (key: string, label: string): DirectoryCatalogField => ({ key, label, defaultOn: true });
const off = (key: string, label: string): DirectoryCatalogField => ({
  key,
  label,
  defaultOn: false,
});

/** The gear's field checklist per card type. A `list.*` key is a linked list
 * on the card, every other key a copy row. Off by default (spec, Nov 4): group
 * phone and mailing address; provider middle initial, gender and languages;
 * location hours. */
export const DIRECTORY_CATALOGS: Readonly<Record<DirectoryCardType, DirectoryCatalogSection[]>> = {
  group: [
    {
      group: "group",
      label: "Group",
      fields: [
        on("legal", "Legal name"),
        on("tin", "Tax ID (TIN)"),
        on("npi2", "Group NPI"),
        on("ptan", "Medicare PTAN"),
        on("states", "States covered"),
        off("phone", "Group phone"),
        off("mail", "Mailing address"),
      ],
    },
    {
      group: "related",
      label: "Related",
      fields: [
        on("list.locations", "Locations"),
        on("list.providers", "Providers"),
        on("list.docs", "Documents"),
      ],
    },
  ],
  provider: [
    {
      group: "provider",
      label: "Provider",
      fields: [
        on("first", "First name"),
        off("middle", "Middle initial"),
        on("last", "Last name"),
        on("npi", "NPI"),
        on("caqh", "CAQH ID"),
        on("medicare", "Medicare ID"),
        on("email", "Email"),
        on("phone", "Phone"),
        on("dob", "DOB"),
        off("gender", "Gender"),
        off("languages", "Languages"),
      ],
    },
    {
      group: "license",
      label: "License",
      fields: [on("licenses", "License number"), on("licenseExp", "License expiration")],
    },
    {
      group: "credentials",
      label: "Credentials",
      fields: [
        on("taxonomy", "Taxonomy"),
        on("specialty", "Specialty"),
        on("board", "Board certification"),
        on("dea", "DEA"),
        on("education", "Education"),
        on("malCarrier", "Malpractice carrier"),
        on("malPolicy", "Malpractice policy"),
        on("malExp", "Malpractice expiration"),
      ],
    },
    {
      group: "related",
      label: "Related",
      fields: [on("list.groups", "Groups"), on("list.locations", "Locations")],
    },
  ],
  location: [
    {
      group: "location",
      label: "Location",
      fields: [
        on("full", "Full address"),
        on("street", "Street"),
        on("suite", "Suite"),
        on("city", "City"),
        on("state", "State"),
        on("zip", "ZIP"),
        on("phone", "Phone"),
        on("fax", "Fax"),
        on("pos", "Place of service"),
        off("hours", "Hours"),
      ],
    },
    {
      group: "related",
      label: "Related",
      fields: [on("list.group", "Group"), on("list.providers", "Providers here")],
    },
  ],
};

export function directoryCatalogKeys(type: DirectoryCardType): Set<string> {
  return new Set(DIRECTORY_CATALOGS[type].flatMap((s) => s.fields.map((f) => f.key)));
}

export function isDirectoryCardType(raw: unknown): raw is DirectoryCardType {
  return typeof raw === "string" && (DIRECTORY_CARD_TYPES as readonly string[]).includes(raw);
}

export type DirectoryLayoutValidation =
  { ok: true; fields: string[] } | { ok: false; message: string };

/** PUT /api/me/view-prefs?card= body: { fields }. `fields` is an ordered,
 * deduplicated list of that card type's catalog keys (empty = every field
 * off). Anything else is a 422 message. */
export function validateDirectoryLayoutBody(
  type: DirectoryCardType,
  body: unknown,
): DirectoryLayoutValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const { fields } = body as { fields?: unknown };
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) {
    return { ok: false, message: "fields must be an array of strings" };
  }
  const allowed = directoryCatalogKeys(type);
  const seen = new Set<string>();
  for (const key of fields as string[]) {
    if (!allowed.has(key)) return { ok: false, message: `Unknown ${type} field: ${key}` };
    if (seen.has(key)) return { ok: false, message: `Duplicate field: ${key}` };
    seen.add(key);
  }
  return { ok: true, fields: fields as string[] };
}

/** A stored layout, or null when it is missing or malformed (the client then
 * shows the catalog defaults). */
export function storedDirectoryLayout(prefs: unknown): string[] | null {
  const fields = (prefs as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) return null;
  return fields as string[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const DIRECTORY_QUERY_MAX = 100;

export interface DirectoryStateTerm {
  code: string;
  /** The full name as typed, lower-cased ("new mexico"). */
  phrase: string;
}

export interface DirectoryQuery {
  /** States named in the query (a full name, or a code typed in capitals),
   * matched as one term each. */
  states: DirectoryStateTerm[];
  /** Every other whitespace-separated term, lower-cased. */
  terms: string[];
}

export type DirectoryQueryParse =
  { ok: true; query: DirectoryQuery | null } | { ok: false; message: string };

const STATE_CODE_SET = new Set<string>(US_STATES);
// Longest names first, so "west virginia" is taken before "virginia".
const STATE_NAME_ENTRIES = (Object.entries(US_STATE_NAMES) as [string, string][])
  .map(([code, name]) => ({ code, phrase: name.toLowerCase() }))
  .sort((a, b) => b.phrase.length - a.phrase.length);

/** Parse `?search=`: trimmed; blank is no search (query null), longer than
 * 100 characters is an error. A state is a full name in any case ("New
 * Mexico", "new mexico") or a two-letter code typed in capitals ("NM"); a
 * lower- or mixed-case pair ("nm", "Mi") stays an ordinary term, so typing
 * the start of "Mitchell" never pulls in every Michigan licensee. The rest
 * splits on whitespace. */
export function parseDirectoryQuery(raw: string | null): DirectoryQueryParse {
  const q = (raw ?? "").trim();
  if (!q) return { ok: true, query: null };
  if (q.length > DIRECTORY_QUERY_MAX) {
    return { ok: false, message: `search must be at most ${DIRECTORY_QUERY_MAX} characters` };
  }
  const states: DirectoryStateTerm[] = [];
  const addState = (code: string) => {
    if (states.some((s) => s.code === code)) return;
    const name = (US_STATE_NAMES as Record<string, string>)[code];
    states.push({ code, phrase: name.toLowerCase() });
  };
  const words = q.split(/\s+/).filter((word) => {
    if (/^[A-Z]{2}$/.test(word) && STATE_CODE_SET.has(word)) {
      addState(word);
      return false;
    }
    return true;
  });
  let rest = ` ${words.join(" ").toLowerCase()} `;
  for (const entry of STATE_NAME_ENTRIES) {
    const needle = ` ${entry.phrase} `;
    if (rest.includes(needle)) {
      addState(entry.code);
      rest = rest.split(needle).join(" ");
    }
  }
  const terms = rest.split(" ").filter(Boolean);
  return { ok: true, query: { states, terms } };
}

/** The two-letter state codes a query names. Lets the service read only the
 * license rows that can matter. */
export function directoryQueryStateCodes(query: DirectoryQuery): string[] {
  return query.states.map((s) => s.code);
}

/** What one record can be found by. `text` matches as a case-insensitive
 * substring; `ids` (TIN, NPI, CAQH ID, ZIP) also match with dashes and spaces
 * ignored, so "12-3456789" and "123456789" find the same TIN; `states` are
 * two-letter codes, matched only by a state the query names. */
export interface DirectorySearchable {
  text: ReadonlyArray<string | null | undefined>;
  ids: ReadonlyArray<string | null | undefined>;
  states: ReadonlyArray<string | null | undefined>;
}

const digitsOnly = (value: string) => value.replace(/[\s-]/g, "");

function termMatches(term: string, record: DirectorySearchable): boolean {
  if (record.text.some((t) => t != null && t.toLowerCase().includes(term))) return true;
  const idTerm = digitsOnly(term);
  return (
    idTerm !== "" &&
    record.ids.some((id) => id != null && digitsOnly(id.toLowerCase()).includes(idTerm))
  );
}

function stateMatches(state: DirectoryStateTerm, record: DirectorySearchable): boolean {
  return (
    record.states.some((s) => s?.toUpperCase() === state.code) ||
    record.text.some((t) => t != null && t.toLowerCase().includes(state.phrase))
  );
}

/** Every term must match somewhere in the record. */
export function matchesDirectoryQuery(record: DirectorySearchable, query: DirectoryQuery): boolean {
  return (
    query.states.every((s) => stateMatches(s, record)) &&
    query.terms.every((t) => termMatches(t, record))
  );
}

/** A→Z on a display key, case- and accent-insensitive. */
export function compareDirectoryNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

/** Providers sort A→Z by last name, then first name. */
export function compareDirectoryPeople(
  a: { firstName: string; lastName: string },
  b: { firstName: string; lastName: string },
): number {
  return (
    compareDirectoryNames(a.lastName, b.lastName) || compareDirectoryNames(a.firstName, b.firstName)
  );
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** A provider↔group assignment is current while it has no end date: the same
 * rule as the list row's groups[] (indexProviderGroups), so search, card and
 * list agree on who is on a group. */
export function isCurrentAssignment(endDate: string | null | undefined): boolean {
  return !endDate;
}

/** The group's Medicare PTAN from its active Medicare network targets (one per
 * state). Distinct values in state order; several distinct values are joined
 * with ", " so none is hidden. */
export function medicarePtanFrom(
  rows: ReadonlyArray<{ state: string; payerIssuedId: string | null }>,
): string | null {
  const values: string[] = [];
  for (const row of [...rows].sort((a, b) => a.state.localeCompare(b.state))) {
    const value = row.payerIssuedId?.trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values.length ? values.join(", ") : null;
}

/** One-line address: "street, suite, city, ST zip", skipping blanks. */
export function directoryAddressLine(parts: {
  street?: string | null;
  suite?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string | null {
  const clean = (v: string | null | undefined) => (v ?? "").trim();
  const stateZip = [clean(parts.state), clean(parts.zip)].filter(Boolean).join(" ");
  const line = [clean(parts.street), clean(parts.suite), clean(parts.city), stateZip]
    .filter(Boolean)
    .join(", ");
  return line || null;
}
