// The taxonomy Add Provider preselects — A32 (Sowmya, Oct 31, 2026): a
// group-level setting, resolved platform default → organization → group;
// Physical Therapist stays the platform default. Business policy is
// configuration: the organization and group values are not stored yet (their
// storage and the Mission Control screen are MINT-128), so today every group
// resolves to the platform default (useTaxonomyPreset).
//
// The preset is a default nobody chose: a registry pick replaces it, and while
// the field still holds it, a change of group gives the new group's preset. A
// taxonomy staff chose, or one a pick filled, is never replaced by a preset.
//
// Pure.
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";
import type { Validation } from "@/lib/npiRegistry";

export const PLATFORM_TAXONOMY_PRESET = "225100000X";

/** The organization's and the group's preset, when they set one. */
export interface TaxonomyPresetLayers {
  org?: string | null;
  group?: string | null;
}

/** The preset in force: the group's, else the organization's, else the
 * platform's. A blank layer inherits. */
export function resolveTaxonomyPreset(layers: TaxonomyPresetLayers = {}): string {
  for (const value of [layers.group, layers.org]) {
    if (value && value.trim()) return normalizeTaxonomyCode(value);
  }
  return PLATFORM_TAXONOMY_PRESET;
}

/** A stored preset must be one the taxonomy picker offers. */
export function validateTaxonomyPreset(input: unknown): Validation<string | null> {
  if (input === null || input === undefined || input === "") return { ok: true, value: null };
  if (typeof input !== "string" || !isKnownTaxonomyCode(input)) {
    return { ok: false, error: "The preset taxonomy must be one the Taxonomy code list offers" };
  }
  return { ok: true, value: normalizeTaxonomyCode(input) };
}

/** What the taxonomy field holds after the preset in force changes (a group
 * was chosen or changed): the new preset while the field still holds the
 * preset that was applied and nobody — staff or a pick — has set it; null
 * means leave the field as it is. */
export function taxonomyAfterPresetChange(input: {
  current: string;
  appliedPreset: string;
  nextPreset: string;
  touched: boolean;
  /** The taxonomy a pick wrote, if it still holds it. */
  pickWrote: string | null;
}): string | null {
  const { current, appliedPreset, nextPreset, touched, pickWrote } = input;
  if (touched) return null;
  if (normalizeTaxonomyCode(current) !== normalizeTaxonomyCode(appliedPreset)) return null;
  if (pickWrote !== null && normalizeTaxonomyCode(pickWrote) === normalizeTaxonomyCode(current)) {
    return null;
  }
  if (normalizeTaxonomyCode(nextPreset) === normalizeTaxonomyCode(current)) return null;
  return nextPreset;
}
