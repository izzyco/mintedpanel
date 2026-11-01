// The organization lifecycle stage objects (public.lifecycle_stages, Mission
// Control M3): the reader. Readable by every signed-in user (the switcher,
// the Portfolio and the write gate read them); written only by a later
// settings page. Not org-scoped: the stages are one platform vocabulary.
// Fails soft: an error (an environment without the migration) returns the
// defaults that mirror the seed, so no screen depends on this read.
import { supabase } from "@/integrations/supabase/externalClient";
import {
  DEFAULT_LIFECYCLE_STAGES,
  parseLifecycleStages,
  type LifecycleStage,
} from "@/lib/lifecycle";

const STAGE_COLUMNS =
  "key, display_name, sort_order, allowed_next, switcher_group, writable, generation_allowed, shown_by_default";

export async function listLifecycleStages(): Promise<LifecycleStage[]> {
  try {
    const { data, error } = await supabase
      .from("lifecycle_stages")
      .select(STAGE_COLUMNS)
      .order("sort_order");
    if (error) return [...DEFAULT_LIFECYCLE_STAGES];
    return parseLifecycleStages(data);
  } catch {
    return [...DEFAULT_LIFECYCLE_STAGES];
  }
}
