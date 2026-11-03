// The organization lifecycle stage objects (Mission Control M3). Returns the
// configured stages once loaded and the seed-mirroring defaults until then
// (and whenever the read fails), so every caller has stages synchronously.
// Not org-scoped; read once and kept, since the stages change rarely.
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/queryKeys";
import { DEFAULT_LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/lifecycle";
import { useAuthStore } from "@/lib/auth-store";
import { listLifecycleStages } from "@/services/lifecycleStages";

const TEN_MINUTES = 10 * 60 * 1000;

export function useLifecycleStages(): readonly LifecycleStage[] {
  const signedIn = useAuthStore((s) => s.session !== null);
  const query = useQuery({
    queryKey: queryKeys.lifecycleStages(),
    queryFn: listLifecycleStages,
    enabled: signedIn,
    staleTime: TEN_MINUTES,
  });
  return query.data ?? DEFAULT_LIFECYCLE_STAGES;
}
