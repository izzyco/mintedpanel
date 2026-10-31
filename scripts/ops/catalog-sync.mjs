// Pure planning helpers for the prod -> staging catalog sync. No I/O here so the
// rules ("add what is missing, never overwrite, never delete") are unit-tested.

export const PROD_REF = "fkvuhfsqcmujywzgczmc";
export const STAGING_REF = "vmznysvietfaddakkegt";

/** Columns that point at auth.users; those users do not exist on the target. */
export const USER_COLUMNS = ["created_by", "published_by", "retired_by"];

/** Project ref from a Supabase URL, or null. */
export function projectRef(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(url ?? "").trim());
  return m ? m[1] : null;
}

/** Refuses anything but prod -> staging. Throws with the reason. */
export function assertDirection(sourceUrl, targetUrl) {
  if (projectRef(sourceUrl) !== PROD_REF) throw new Error("source must be the production project");
  if (projectRef(targetUrl) !== STAGING_REF) throw new Error("target must be the staging project");
}

export function stripUserColumns(row) {
  const out = { ...row };
  for (const c of USER_COLUMNS) delete out[c];
  return out;
}

/** Rows present in `source` whose key is absent from `target`. Never returns updates or deletes. */
export function planAdds(source, target, key = (r) => r.id) {
  const have = new Set(target.map(key));
  return source.filter((r) => !have.has(key(r)));
}

/** An org-owned row can only go where the owning org exists. */
export function splitByOrg(rows, targetOrgIds) {
  const ok = [];
  const skipped = [];
  for (const r of rows) {
    if (r.org_id == null || targetOrgIds.has(r.org_id)) ok.push(r);
    else skipped.push({ row: r, reason: "org not on target" });
  }
  return { ok, skipped };
}

/**
 * Forms need their payer and template on the target, and a storage file.
 * `have` carries the ids that exist (or will exist) on the target.
 * `skippedTemplates` (id -> reason) names the templates this run holds back or
 * staging refused, so a form says which template it is waiting for and why.
 */
export function splitForms(forms, have, skippedTemplates = new Map()) {
  const ok = [];
  const skipped = [];
  for (const f of forms) {
    if (f.payer_id && !have.payers.has(f.payer_id))
      skipped.push({ row: f, reason: "payer not on target" });
    else if (f.template_id && skippedTemplates.has(f.template_id))
      skipped.push({ row: f, reason: skippedTemplates.get(f.template_id) });
    else if (f.template_id && !have.templates.has(f.template_id))
      skipped.push({ row: f, reason: "template not on target" });
    else ok.push(f);
  }
  return { ok, skipped };
}

// ---------- precondition 1: a NULL case type is reported, never defaulted ----------

/** Quoted in every skip it causes; the runbook's "Before you run", step 1. */
export const CASE_TYPE_PRECONDITION =
  "case_type is NULL on production. Set its case type on production first (runbook: Before you run, step 1); the sync never supplies one";

/**
 * Templates the sync can insert, and the ones precondition 1 holds back.
 * Staging's insert guard refuses a NULL case type (sop_case_type_required),
 * and choosing a production template's business purpose is a decision, not a
 * copy, so the row is skipped as it is and the reason says what to do.
 */
export function splitTemplatesByCaseType(templates) {
  const ok = [];
  const skipped = [];
  for (const t of templates) {
    if (t.case_type == null) skipped.push({ row: t, reason: CASE_TYPE_PRECONDITION });
    else ok.push(t);
  }
  return { ok, skipped };
}

// ---------- portals the sync creates (catalog-sync-created-portals.mjs) ----------

const HIDDEN_PORTAL_PREFIX = "[hidden] ";

/** The guard's comparison: lower(btrim(portal_key)). */
export function normalizePortalKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase();
}

/** Every portal key a template's steps name (task_definitions[].steps[].portalKey). */
export function templatePortalKeys(template) {
  const keys = new Set();
  const tasks = Array.isArray(template?.task_definitions) ? template.task_definitions : [];
  for (const task of tasks) {
    for (const step of Array.isArray(task?.steps) ? task.steps : []) {
      const key = normalizePortalKey(step?.portalKey);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** A payer a GLOBAL portal can bind to: active, not archived, not merged. */
export function isBindablePayer(payer) {
  return (
    Boolean(payer) &&
    payer.status === "active" &&
    payer.archived_at == null &&
    payer.merged_into_id == null
  );
}

/**
 * The portals to create for the named entries, and the entries that need none
 * or cannot have one. Only an entry's own template, being added in this run,
 * makes a portal; nothing else does.
 *
 * @param entries        SYNC_CREATED_PORTALS
 * @param templates      the templates this run will insert (after precondition 1)
 * @param targetPortals  staging's portals plus the ones this run copies
 * @param targetOrgIds   the organizations on staging
 * @param payersById     staging's payers plus the ones this run copies
 */
export function planCreatedPortals(
  entries,
  { templates, targetPortals, targetOrgIds, payersById },
) {
  const create = [];
  const skipped = [];
  for (const entry of entries) {
    const key = normalizePortalKey(entry.portalKey);
    const skip = (reason) => skipped.push({ id: key, label: entry.name, reason });
    const matches = templates.filter(
      (t) => t.name === entry.templateName && templatePortalKeys(t).has(key),
    );
    if (matches.length === 0) {
      skip(
        `not needed: no template named "${entry.templateName}" that uses this key is being added in this run`,
      );
      continue;
    }
    if (matches.length > 1) {
      skip(
        `${matches.length} templates named "${entry.templateName}" use this key; fix the entry before creating anything`,
      );
      continue;
    }
    const [template] = matches;
    const orgId = template.org_id ?? null;
    if (!template.payer_id) {
      skip(`template ${template.id} has no payer, and a typed portal needs one`);
      continue;
    }
    if (orgId !== null && !targetOrgIds.has(orgId)) {
      skip(`template ${template.id} belongs to org ${orgId}, which is not on staging`);
      continue;
    }
    const sameKey = targetPortals.filter((p) => normalizePortalKey(p.portal_key) === key);
    const sameScope = sameKey.find((p) => (p.org_id ?? null) === orgId);
    const visibleGlobal = sameKey.find(
      (p) => p.org_id == null && !String(p.name ?? "").startsWith(HIDDEN_PORTAL_PREFIX),
    );
    if (sameScope || (orgId !== null && visibleGlobal)) {
      skip(
        `already on staging (portal ${(sameScope ?? visibleGlobal).id ?? "?"}); nothing created`,
      );
      continue;
    }
    if (orgId === null && !isBindablePayer(payersById.get(template.payer_id))) {
      skip(
        `payer ${template.payer_id} is not active on staging, so the global template would still be refused; nothing created`,
      );
      continue;
    }
    create.push({
      entry,
      template,
      row: {
        org_id: orgId,
        portal_key: key,
        name: entry.name,
        payer_id: template.payer_id,
        case_type: template.case_type,
        form_url: null,
      },
    });
  }
  return { create, skipped };
}

/** The report line for a created portal: "would create portal …" in a dry run. */
export function describeCreatedPortal({ template, row }, { apply }) {
  const scope = row.org_id === null ? "global" : `org ${row.org_id}`;
  return `${apply ? "created" : "would create"} portal ${row.portal_key} "${row.name}" for template ${template.id} "${template.name}" (${scope}, payer ${row.payer_id}, case type ${row.case_type}, no form URL, no field maps)`;
}

// ---------- report ----------

export function formatSkip(s) {
  return `${s.id ?? "?"}${s.label ? ` "${s.label}"` : ""}: ${s.reason}`;
}

/** The text the CLI prints: one block per table, every skip with its reason. */
export function formatReport(report, { apply }) {
  const lines = [apply ? "APPLIED" : "DRY RUN (pass --apply to write)"];
  for (const r of report) {
    lines.push(`${r.table}: ${r.added} ${apply ? "added" : "would add"}, ${r.skipped} skipped`);
    for (const line of r.lines ?? []) lines.push(`  + ${line}`);
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
