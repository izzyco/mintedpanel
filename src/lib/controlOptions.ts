// E6.10 — captured option vocabulary for structured controls.
// Portal truth: { value, label } pairs from the page's own choices, never the
// selected/checked/typed value. Pure — no I/O.

export interface ControlOption {
  value: string;
  label: string;
}

export const AUTHORABLE_TRANSFORMS = [
  "state_abbrev",
  "date_mmddyyyy",
  "date_mmddyyyy_dash",
  "date_ddmmyyyy",
  "date_ddmmyyyy_dash",
  "date_yyyymmdd_slash",
  "date_yyyymmdd",
  "zip5",
  "phone_digits",
  "phone_dashed",
  "phone_country_dashed",
  "phone_e164",
  "tin_digits",
  "tin_dashed",
] as const;
export type AuthorableTransform = (typeof AUTHORABLE_TRANSFORMS)[number];

export const AUTHORABLE_TRANSFORM_OPTIONS: readonly {
  value: AuthorableTransform;
  label: string;
}[] = [
  { value: "state_abbrev", label: "State name → 2-letter code" },
  { value: "date_mmddyyyy", label: "Date → MM/DD/YYYY" },
  { value: "date_mmddyyyy_dash", label: "Date → MM-DD-YYYY" },
  { value: "date_ddmmyyyy", label: "Date → DD/MM/YYYY" },
  { value: "date_ddmmyyyy_dash", label: "Date → DD-MM-YYYY" },
  { value: "date_yyyymmdd_slash", label: "Date → YYYY/MM/DD" },
  { value: "date_yyyymmdd", label: "Date → YYYY-MM-DD" },
  { value: "zip5", label: "ZIP+4 → 5-digit ZIP" },
  { value: "phone_digits", label: "Phone → 10 digits" },
  { value: "phone_dashed", label: "Phone → XXX-XXX-XXXX" },
  { value: "phone_country_dashed", label: "Phone → (1) XXX-XXX-XXXX" },
  { value: "phone_e164", label: "Phone → +1XXXXXXXXXX" },
  { value: "tin_digits", label: "TIN → 9 digits" },
  { value: "tin_dashed", label: "TIN → XX-XXXXXXX" },
];

export const CONTROL_TYPE_LABELS: Record<string, string> = {
  text: "Text",
  select: "Dropdown",
  radio: "Radio",
  checkbox: "Checkbox",
  date: "Date",
  file: "File",
};

export const STRUCTURED_FIELD_TYPES = new Set(["select", "radio", "checkbox"]);

/**
 * Max options stored per field. Capture and the write boundary share this —
 * the extension's scanner (`CONTROL_OPTIONS_CAP` in `captureScan.ts`) must
 * never send more than this or the proposal 422s. 1000 holds every real
 * vocabulary seen so far: a US-state list (50 states + DC + territories), a
 * 146-entry specialty list, an 856-entry taxonomy menu. A longer list is
 * rejected here, never truncated — a cut list silently drops real choices.
 */
export const CONTROL_OPTIONS_CAP = 1000;

/**
 * Above this many options the fixed-value picker becomes searchable: a plain
 * Select mounts every item and makes the trainer scroll to #121 of 146.
 */
export const SEARCHABLE_OPTIONS_THRESHOLD = 25;

/** Rows a searchable option list renders at once; typing narrows the rest. */
export const OPTION_RENDER_LIMIT = 100;

/** Sample size for skip-reason lines (F6.10.6 / OQ-3). */
export const OPTION_SAMPLE_SIZE = 3;

export function isAuthorableTransform(
  value: string | null | undefined,
): value is AuthorableTransform {
  return AUTHORABLE_TRANSFORMS.some((transform) => transform === value);
}

export function controlTypeLabel(fieldType: string | null | undefined): string {
  if (!fieldType) return "Text";
  return CONTROL_TYPE_LABELS[fieldType] ?? fieldType;
}

function asOption(raw: unknown): ControlOption | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.value !== "string" || typeof rec.label !== "string") return null;
  return { value: rec.value, label: rec.label };
}

/** Parse a stored or inbound list. Invalid shape → null (treat as uncaptured). */
export function parseControlOptions(raw: unknown): ControlOption[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const out: ControlOption[] = [];
  for (const item of raw) {
    const opt = asOption(item);
    if (!opt) return null;
    out.push(opt);
  }
  return out;
}

/**
 * Write-boundary validator. `undefined` means the key was absent (leave stored).
 * `null` clears (not used on re-capture). An empty array is a valid parsed
 * value that re-capture must IGNORE at the caller — this function returns it
 * so the caller can decide.
 */
export function validateControlOptionsInput(
  raw: unknown,
): { kind: "ok"; options: ControlOption[] | null } | { kind: "rejected"; message: string } {
  if (raw == null) return { kind: "ok", options: null };
  if (!Array.isArray(raw)) {
    return { kind: "rejected", message: "control_options must be an array of { value, label }" };
  }
  if (raw.length > CONTROL_OPTIONS_CAP) {
    return {
      kind: "rejected",
      message: `control_options cannot exceed ${CONTROL_OPTIONS_CAP} entries`,
    };
  }
  const parsed = parseControlOptions(raw);
  if (parsed == null) {
    return {
      kind: "rejected",
      message: "control_options must be an array of { value, label } strings",
    };
  }
  return { kind: "ok", options: parsed };
}

/** True when a stored hardcoded value is missing from a refreshed vocabulary. */
export function hardcodedValueMissingFromOptions(
  hardcodedValue: string | null | undefined,
  options: ControlOption[] | null | undefined,
): boolean {
  const literal = hardcodedValue?.trim() ?? "";
  if (!literal) return false;
  if (!options || options.length === 0) return false;
  return !options.some((o) => o.value === literal);
}

/** Bounded sample for a skip-reason line. Never dumps the full list. */
export function optionSample(
  options: readonly ControlOption[],
  limit = OPTION_SAMPLE_SIZE,
): string {
  if (options.length === 0) return "";
  const shown = options.slice(0, limit).map((o) => o.value);
  const extra = options.length - shown.length;
  const body = shown.join(", ");
  return extra > 0 ? `${body}; ${extra} more` : body;
}

/** How a picker or list names one option: "KS — Kansas", or just "KS". */
export function controlOptionText(opt: ControlOption): string {
  return opt.label && opt.label !== opt.value ? `${opt.value} — ${opt.label}` : opt.value;
}

/**
 * Case-insensitive substring match on value or label, in captured order,
 * rendering at most `limit` rows. `matched` counts every hit so the picker
 * can say how many more a narrower query would reveal.
 */
export function filterControlOptions(
  options: readonly ControlOption[],
  query: string,
  limit = OPTION_RENDER_LIMIT,
): { shown: ControlOption[]; matched: number } {
  const q = query.trim().toLowerCase();
  const hits = q
    ? options.filter((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
    : options;
  return { shown: hits.slice(0, limit), matched: hits.length };
}

export function transformEffectCopy(transform: string | null | undefined): string | null {
  return AUTHORABLE_TRANSFORM_OPTIONS.find((option) => option.value === transform)?.label ?? null;
}
