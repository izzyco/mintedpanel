// Organization lifecycle (Mission Control M3). The stages are configuration:
// rows in public.lifecycle_stages, each with a display name, an order, the
// stages it may move to, and its behaviours (which switcher group it sits in,
// whether its organization accepts writes, whether case generation is its
// normal state, whether Mission Control lists it by default). Adding a stage
// such as `paused` is a row there, not a code change.
//
// Pure. Every reader of organizations.lifecycle_state goes through
// normalizeLifecycle() first: the legacy value `inactive` reads as
// `offboarded` (public.normalize_lifecycle_state() is the database's copy of
// the same one-line rule). DEFAULT_LIFECYCLE_STAGES mirrors the migration's
// seed (20261102163100) by hand and is what every reader uses until the
// configured rows have loaded, or when they cannot load.

/** A stage key as stored in organizations.lifecycle_state. */
export type LifecycleStageKey = string;

/** The switcher / Portfolio group a stage sits in; null hides it. */
export type SwitcherGroup = string | null;

export interface LifecycleStage {
  key: LifecycleStageKey;
  displayName: string;
  sortOrder: number;
  /** The stages a platform admin may move an organization to, in one click. */
  allowedNext: LifecycleStageKey[];
  switcherGroup: SwitcherGroup;
  /** false freezes every tenant write (the offboarded write freeze). */
  writable: boolean;
  /** false stops case generation: the UI shows the reason, the server refuses. */
  generationAllowed: boolean;
  /** Mission Control's organization list shows it without "Include offboarded". */
  shownByDefault: boolean;
}

/** The one legacy alias. Keep in step with public.normalize_lifecycle_state(). */
export const LEGACY_LIFECYCLE_ALIASES: Readonly<Record<string, LifecycleStageKey>> = {
  inactive: "offboarded",
};

/** The column default, used for a missing value. */
export const DEFAULT_LIFECYCLE_KEY: LifecycleStageKey = "active";

/** Mirrors the lifecycle_stages seed in 20261102163100 (keep the two in sync). */
export const DEFAULT_LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  {
    key: "prospect",
    displayName: "Prospect",
    sortOrder: 10,
    allowedNext: ["onboarding", "offboarded"],
    switcherGroup: "prospects",
    writable: true,
    generationAllowed: false,
    shownByDefault: true,
  },
  {
    key: "onboarding",
    displayName: "Onboarding",
    sortOrder: 20,
    allowedNext: ["active", "offboarded"],
    switcherGroup: "prospects",
    writable: true,
    generationAllowed: false,
    shownByDefault: true,
  },
  {
    key: "active",
    displayName: "Active",
    sortOrder: 30,
    allowedNext: ["offboarded"],
    switcherGroup: "in_motion",
    writable: true,
    generationAllowed: true,
    shownByDefault: true,
  },
  {
    key: "offboarded",
    displayName: "Offboarded",
    sortOrder: 40,
    allowedNext: ["active"],
    switcherGroup: null,
    writable: false,
    generationAllowed: false,
    shownByDefault: false,
  },
];

/** Labels for the two switcher groups the seed uses. A configured group with
 * another key is labelled by its first stage's display name. */
export const SWITCHER_GROUP_LABELS: Readonly<Record<string, string>> = {
  prospects: "Prospects",
  in_motion: "In motion",
};

/** Switcher group order: In motion first (the organizations being worked),
 * then Prospects, then any other configured group in stage order. */
export const SWITCHER_GROUP_ORDER: readonly string[] = ["in_motion", "prospects"];

export function normalizeLifecycle(raw: string | null | undefined): LifecycleStageKey {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_LIFECYCLE_KEY;
  return LEGACY_LIFECYCLE_ALIASES[value] ?? value;
}

function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The stage object for a stored value. A key with no configured row (a stage
 * added in the database that this reader has not loaded) is treated as a
 * writable, visible stage: the database enforces the freeze, and the UI must
 * never hide or lock an organization because of configuration it lacks.
 */
export function lifecycleStage(
  raw: string | null | undefined,
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): LifecycleStage {
  const key = normalizeLifecycle(raw);
  return (
    stages.find((stage) => stage.key === key) ?? {
      key,
      displayName: titleCase(key),
      sortOrder: Number.MAX_SAFE_INTEGER,
      allowedNext: [],
      switcherGroup: "in_motion",
      writable: true,
      generationAllowed: false,
      shownByDefault: true,
    }
  );
}

export function isLifecycleWritable(
  raw: string | null | undefined,
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): boolean {
  return lifecycleStage(raw, stages).writable;
}

/** The stages an organization in `raw` may move to, in sort order. */
export function allowedNextStages(
  raw: string | null | undefined,
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): LifecycleStage[] {
  const next = new Set(lifecycleStage(raw, stages).allowedNext);
  return stages.filter((stage) => next.has(stage.key)).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Every stored value Mission Control's list hides by default: the stage keys
 * that are not shown by default, plus the legacy values that read as one of
 * them (so a legacy `inactive` row is hidden with `offboarded`).
 */
export function lifecycleValuesHiddenByDefault(
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): LifecycleStageKey[] {
  const hidden = stages.filter((stage) => !stage.shownByDefault).map((stage) => stage.key);
  const aliases = Object.entries(LEGACY_LIFECYCLE_ALIASES)
    .filter(([, target]) => hidden.includes(target))
    .map(([legacy]) => legacy);
  return [...hidden, ...aliases].sort();
}

export interface SwitcherGroupOf<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Group items by their stage's switcher group, in SWITCHER_GROUP_ORDER and
 * then by each other group's first stage; items whose stage is hidden (no
 * group) are left out.
 */
export function groupBySwitcherGroup<T>(
  items: readonly T[],
  lifecycleOf: (item: T) => string | null | undefined,
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): SwitcherGroupOf<T>[] {
  const groups = new Map<string, { order: number; label: string; items: T[] }>();
  for (const item of items) {
    const stage = lifecycleStage(lifecycleOf(item), stages);
    if (!stage.switcherGroup) continue;
    const existing = groups.get(stage.switcherGroup);
    if (existing) {
      existing.items.push(item);
      existing.order = Math.min(existing.order, stage.sortOrder);
    } else {
      groups.set(stage.switcherGroup, {
        order: stage.sortOrder,
        label: SWITCHER_GROUP_LABELS[stage.switcherGroup] ?? stage.displayName,
        items: [item],
      });
    }
  }
  const rank = (key: string) => {
    const index = SWITCHER_GROUP_ORDER.indexOf(key);
    return index === -1 ? SWITCHER_GROUP_ORDER.length : index;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].order - b[1].order)
    .map(([key, group]) => ({ key, label: group.label, items: group.items }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse lifecycle_stages rows (snake_case, from PostgREST) into stage objects.
 * A malformed row is dropped; an empty or unusable result returns the
 * defaults, so a reader never ends up with no stages at all.
 */
export function parseLifecycleStages(rows: unknown): LifecycleStage[] {
  if (!Array.isArray(rows)) return [...DEFAULT_LIFECYCLE_STAGES];
  const stages: LifecycleStage[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const displayName = typeof row.display_name === "string" ? row.display_name.trim() : "";
    if (!key || !displayName) continue;
    stages.push({
      key,
      displayName,
      sortOrder:
        typeof row.sort_order === "number" && Number.isFinite(row.sort_order)
          ? row.sort_order
          : Number.MAX_SAFE_INTEGER,
      allowedNext: Array.isArray(row.allowed_next)
        ? row.allowed_next.filter((value): value is string => typeof value === "string")
        : [],
      switcherGroup:
        typeof row.switcher_group === "string" && row.switcher_group.trim()
          ? row.switcher_group.trim()
          : null,
      writable: row.writable !== false,
      generationAllowed: row.generation_allowed === true,
      shownByDefault: row.shown_by_default !== false,
    });
  }
  if (stages.length === 0) return [...DEFAULT_LIFECYCLE_STAGES];
  return stages.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

/**
 * The button label for a one-click move: "Offboard" into a non-writable stage,
 * "Reopen" out of one, otherwise "Move to <stage>".
 */
export function lifecycleActionLabel(from: LifecycleStage, to: LifecycleStage): string {
  if (!to.writable) return "Offboard";
  if (!from.writable) return "Reopen";
  return `Move to ${to.displayName}`;
}

/**
 * Why case generation is off for an organization in `stage`, or null when it
 * is on. Sowmya, Nov 2 2026: a hard stop until the organization is in a stage
 * that allows generation (active by default); the database refuses the
 * generation path too (block_generation_when_not_allowed).
 */
export function generationBlockedReason(
  stage: LifecycleStage,
  orgName: string,
  stages: readonly LifecycleStage[] = DEFAULT_LIFECYCLE_STAGES,
): { title: string; detail: string } | null {
  if (stage.generationAllowed) return null;
  const open = stages.filter((s) => s.generationAllowed).map((s) => s.displayName);
  const where = open.length > 0 ? open.join(" or ") : "a stage that allows it";
  return {
    title: `Case generation is off while ${orgName} is ${stage.displayName}`,
    detail: `It opens when Minted moves the organization to ${where}. Ask your Minted contact to make that move.`,
  };
}
