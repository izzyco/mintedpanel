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

/** The project URL a supabase-js client was made for (SupabaseClient keeps it
 * as `supabaseUrl`). A client that does not say is refused. */
export function clientUrl(client) {
  const url = client?.supabaseUrl;
  if (typeof url !== "string" || url === "")
    throw new Error("cannot tell which project a client points at; refusing to run");
  return url;
}

/** The same direction check, on the clients themselves. */
export function assertClientDirection(src, dst) {
  assertDirection(clientUrl(src), clientUrl(dst));
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

/** The sync copies the global catalog, plus rows of orgs that exist on
 * staging; it never creates an org. */
export function splitByOrg(rows, targetOrgIds) {
  const ok = [];
  const skipped = [];
  for (const r of rows) {
    if (r.org_id == null || targetOrgIds.has(r.org_id)) ok.push(r);
    else skipped.push({ row: r, reason: `org ${r.org_id} is not on staging` });
  }
  return { ok, skipped };
}

/**
 * Forms need their payer and template on staging before their file is
 * uploaded, so a form that cannot go in leaves no file behind. `have` holds
 * the ids on staging (in a dry run, plus the rows the run would add).
 */
export function splitForms(forms, have) {
  const ok = [];
  const skipped = [];
  for (const f of forms) {
    if (f.payer_id && !have.payers.has(f.payer_id))
      skipped.push({ row: f, reason: `payer ${f.payer_id} is not on staging` });
    else if (f.template_id && !have.templates.has(f.template_id))
      skipped.push({ row: f, reason: `template ${f.template_id} is not on staging` });
    else ok.push(f);
  }
  return { ok, skipped };
}

// ---------- portals the sync creates (catalog-sync-created-portals.mjs) ----------

/** The guard's comparison: lower(btrim(portal_key)). btrim with no second
 * argument trims spaces only. */
export function normalizePortalKey(key) {
  return String(key ?? "")
    .replace(/^ +| +$/g, "")
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

/**
 * The portals to create for the named entries, and the entries that need
 * none. An entry makes its portal only when exactly one template with its
 * name and key is missing on staging (so this run adds it), and staging has
 * no portal with that key in the template's scope. The row takes the
 * template's org, payer and case type. Whether staging then accepts the
 * template is staging's call, reported with the template.
 *
 * @param entries        SYNC_CREATED_PORTALS
 * @param templates      the templates missing on staging
 * @param targetPortals  staging's portals plus the ones this run copies
 */
export function planCreatedPortals(entries, { templates, targetPortals }) {
  const create = [];
  const skipped = [];
  for (const entry of entries) {
    const key = normalizePortalKey(entry.portalKey);
    const skip = (reason) => skipped.push({ id: key, label: entry.name, reason });
    const matches = templates.filter(
      (t) => t.name === entry.templateName && templatePortalKeys(t).has(key),
    );
    if (matches.length !== 1) {
      skip(
        matches.length === 0
          ? `not needed: no template named "${entry.templateName}" that uses this key is missing on staging`
          : `${matches.length} templates named "${entry.templateName}" use this key; fix the entry before creating anything`,
      );
      continue;
    }
    const [template] = matches;
    const orgId = template.org_id ?? null;
    if (!template.payer_id || !template.case_type) {
      skip(
        `template ${template.id} has no payer or no case type to give the portal; nothing created`,
      );
      continue;
    }
    const existing = targetPortals.find(
      (p) => normalizePortalKey(p.portal_key) === key && (p.org_id ?? null) === orgId,
    );
    if (existing) {
      skip(`already on staging (portal ${existing.id ?? "?"}); nothing created`);
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

/** One report line: `id "label"`, plus `: reason` for a row not added. */
export function formatRow(id, label, reason) {
  return `${id ?? "?"}${label ? ` "${label}"` : ""}${reason ? `: ${reason}` : ""}`;
}

/**
 * The text the CLI prints: one block per table, its count, then every row.
 * A dry run lists the rows missing on staging (`+`) and the ones the sync
 * holds back (`-`, with the reason). An apply lists the rows it added and
 * the ones it did not, with staging's own error for each refusal.
 */
export function formatReport(report, { apply }) {
  const lines = [apply ? "APPLIED" : "DRY RUN (pass --apply to write)"];
  for (const r of report) {
    lines.push(
      `${r.table}: ${r.added.length} ${apply ? "added" : "missing on staging"}, ${r.skipped.length} ${apply ? "not added" : "held back"}`,
    );
    for (const line of r.added) lines.push(`  + ${line}`);
    for (const line of r.skipped) lines.push(`  - ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The field maps to copy for the portals this run adds. A map goes with the
 * portal of its own org and key. An org's override of a NEW global portal
 * (same key, org_id set) goes too, when that org is on staging, has no portal
 * of its own with that key there (which keeps its own maps), and has none on
 * production either: an org map whose own portal exists on production belongs
 * to that portal, so if this run did not add it, the map is held back rather
 * than turned into an override of the global one. Every other override of a
 * new global portal is reported with the reason. Maps of portals staging
 * already had are not considered.
 *
 * @param addedPortals   the portals this run added (or would add) on staging
 * @param sourcePortals  every portal on production
 * @param targetPortals  staging's portals before this run
 */
export function planFieldMaps(
  maps,
  { addedPortals, sourcePortals = [], targetPortals, targetOrgIds },
) {
  const scope = (row) => `${row.org_id ?? ""}|${row.portal_key}`;
  const added = new Set(addedPortals.map(scope));
  const newGlobalKeys = new Set(
    addedPortals.filter((p) => p.org_id == null).map((p) => p.portal_key),
  );
  const productionScopes = new Set(sourcePortals.map(scope));
  const stagingScopes = new Set(targetPortals.map(scope));
  const ok = [];
  const skipped = [];
  const skip = (row, reason) => skipped.push({ row, reason });
  for (const m of maps) {
    if (added.has(scope(m))) ok.push(m);
    else if (m.org_id != null && newGlobalKeys.has(m.portal_key)) {
      if (!targetOrgIds.has(m.org_id))
        skip(
          m,
          `org ${m.org_id} is not on staging, so its override of new global portal ${m.portal_key} is not copied`,
        );
      else if (stagingScopes.has(scope(m)))
        skip(
          m,
          `org ${m.org_id} already has its own ${m.portal_key} portal on staging, which keeps its own maps`,
        );
      else if (productionScopes.has(scope(m)))
        skip(
          m,
          `the map belongs to org ${m.org_id}'s own ${m.portal_key} portal on production, which this run did not add on staging; not copied as an override of the global one`,
        );
      else ok.push(m);
    }
  }
  return { ok, skipped };
}

/**
 * Parents before children for a self-reference: a payer before the payers
 * merged into it (merged_into_id), a payer form before the form that
 * supersedes it (supersedes_id). Otherwise the input order is kept; a cycle
 * keeps its rows where they are.
 */
export function parentsFirst(rows, parentOf) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const state = new Map();
  const out = [];
  const visit = (row) => {
    if (state.has(row.id)) return;
    state.set(row.id, "visiting");
    const parentId = parentOf(row);
    if (parentId != null && byId.has(parentId)) visit(byId.get(parentId));
    state.set(row.id, "done");
    out.push(row);
  };
  for (const row of rows) visit(row);
  return out;
}

/** Payer forms in insert order: by family and version, each superseded form
 * before the form that supersedes it. */
export function orderForms(forms) {
  const sorted = [...forms].sort(
    (a, b) =>
      String(a.family_id ?? "").localeCompare(String(b.family_id ?? "")) ||
      (Number(a.version) || 0) - (Number(b.version) || 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return parentsFirst(sorted, (f) => f.supersedes_id);
}

/** A Storage upload refused because the object is already there: HTTP 409,
 * which storage-js reports as `status`, or as the body's `statusCode`. */
export function isStorageConflict(error) {
  return Boolean(error) && (Number(error.status) === 409 || String(error.statusCode) === "409");
}
