// Audit log reads (insertion happens inside other services via writeAudit).
import { supabase } from "@/integrations/supabase/externalClient";
import { camelizeRow } from "@/lib/case";
import { requireActiveOrg } from "@/lib/audit";
import type { AuditActionType, AuditLogEntry } from "@/types";

export interface AuditFilters {
  entityType?: string;
  entityId?: string;
  actionType?: AuditActionType;
  userId?: string;
  /** Inclusive lower bound on `ts` (ISO instant). */
  since?: string;
  /** Exclusive upper bound on `ts` (ISO instant) — see auditDateBounds. */
  until?: string;
  limit?: number;
}

export async function listAuditLog(filters: AuditFilters = {}): Promise<AuditLogEntry[]> {
  const orgId = requireActiveOrg();
  let query = supabase
    .from("audit_log")
    .select("*")
    .eq("org_id", orgId)
    .order("ts", { ascending: false })
    .limit(filters.limit ?? 200);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  if (filters.actionType) query = query.eq("action_type", filters.actionType);
  if (filters.userId) query = query.eq("user_id", filters.userId);
  if (filters.since) query = query.gte("ts", filters.since);
  if (filters.until) query = query.lt("ts", filters.until);
  const { data, error } = await query;
  if (error) throw error;
  return camelizeRow<AuditLogEntry[]>(data ?? []);
}
