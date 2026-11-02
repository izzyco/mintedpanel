// The taxonomy Add Provider preselects — A32: a group-level setting, resolved
// platform default → organization → group (src/lib/providerTaxonomyPreset).
// The organization and group values are not stored yet (MINT-128), so every
// group gets the platform default, Physical Therapist, today.
import { resolveTaxonomyPreset } from "@/lib/providerTaxonomyPreset";

/** The preset for the chosen group (null: none chosen yet, so the
 * organization's, then the platform's). */
export function useTaxonomyPreset(groupId: string | null): string {
  void groupId;
  return resolveTaxonomyPreset({});
}
