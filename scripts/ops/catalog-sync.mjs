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

/** A hidden portal (left(name, 9) = '[hidden] ') never binds. */
export function isHiddenPortal(portal) {
  return String(portal?.name ?? "").slice(0, 9) === HIDDEN_PORTAL_PREFIX;
}

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

/** A payer a GLOBAL portal can bind to: active, not archived, not merged. */
export function isBindablePayer(payer) {
  return (
    Boolean(payer) &&
    payer.status === "active" &&
    payer.archived_at == null &&
    payer.merged_into_id == null
  );
}

// ---------- staging's template insert guards, restated ----------

/** The migrations whose function bodies templateRefusal restates. A test
 * fails when a later migration redefines either function. */
/** Everything on public.sop_templates that can refuse an insert, as the repo's
 * migrations leave it: its triggers and its foreign keys. stagingRefusal
 * covers each one (the seed-version trigger only adds a row; the update guard
 * never fires on an insert). A test rebuilds this from supabase/migrations
 * and fails when it changes. */
export const SOP_TEMPLATE_INSERT_SURFACE = Object.freeze({
  triggers: Object.freeze([
    "sop_templates_guard_typed_insert",
    "sop_templates_guard_typed_update",
    "sop_templates_seed_version",
  ]),
  foreignKeys: Object.freeze({
    group_id: "provider_groups",
    org_id: "organizations",
    payer_id: "payers",
  }),
});

export const TEMPLATE_GUARD_MIGRATIONS = Object.freeze({
  guard_typed_sop_template: "20261003120000_mint44_typed_sops.sql",
  validate_sop_template_portal_bindings: "20261006164500_mint44_org_portal_binding_precedence.sql",
});

const STEP_TYPES = new Set(["draft_email", "online_form", "pdf", "fax", "phone", "mail", "custom"]);
const FALLBACK_SOP_ID = "00000000-0000-4000-a000-00000000e17b";

/** jsonb ->> text: NULL for a missing key or JSON null, the text otherwise. */
const jsonText = (value) =>
  value === undefined || value === null
    ? null
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/**
 * Why staging's sop_templates INSERT guards would refuse a template, or null
 * when they would accept it: guard_typed_sop_template, then
 * validate_sop_template_portal_bindings (TEMPLATE_GUARD_MIGRATIONS). An org
 * row shadows the global row with the same key; a "[hidden] " row never
 * binds; the selected row needs the template's case type and payer; a global
 * row also needs an active payer.
 *
 * @param portals     staging's portals plus the rows this run adds
 * @param payersById  staging's payers plus the rows this run adds
 * @returns {{ code: string, key: string | null, message: string } | null}
 */
export function templateRefusal(template, { portals, payersById }) {
  const refuse = (code, message, key = null) => ({ code, key, message });
  if (template.case_type == null) return refuse("sop_case_type_required", "sop_case_type_required");
  if (template.id === FALLBACK_SOP_ID && template.case_type !== "enrollment")
    return refuse("fallback_sop_case_type_invalid", "fallback_sop_case_type_invalid");
  const tasks = template.task_definitions;
  if (!Array.isArray(tasks))
    return refuse("task_definitions_invalid", "task_definitions must be a json array");
  const orgId = template.org_id ?? null;
  const payerId = template.payer_id ?? null;
  for (const task of tasks) {
    const isObject = task !== null && typeof task === "object" && !Array.isArray(task);
    // jsonb `task ? 'steps'`: a key of an object, a string element of an
    // array, or the string itself. Only an object can then carry an array.
    const hasSteps = isObject
      ? Object.hasOwn(task, "steps")
      : Array.isArray(task)
        ? task.includes("steps")
        : task === "steps";
    if (hasSteps && !(isObject && Array.isArray(task.steps)))
      return refuse("sop_task_steps_invalid", "sop_task_steps_invalid");
    const steps = isObject && Array.isArray(task.steps) ? task.steps : [];
    for (const step of steps) {
      const type = jsonText(step?.stepType);
      if (type !== null && type.replace(/^ +| +$/g, "") !== "" && !STEP_TYPES.has(type))
        return refuse("sop_step_type_invalid", "sop_step_type_invalid");
      if ((type === null || type === "" ? "online_form" : type) === "online_form") {
        if (normalizePortalKey(jsonText(step?.portalKey)) === "")
          return refuse(
            "sop_portal_binding_required",
            "sop_portal_binding_required: every online-form step must select a portal configuration",
          );
      }
    }
    const keys = new Set(steps.map((step) => normalizePortalKey(jsonText(step?.portalKey))));
    keys.delete("");
    for (const key of keys) {
      const visible = portals.filter(
        (p) => normalizePortalKey(p.portal_key) === key && !isHiddenPortal(p),
      );
      let selected = null;
      if (orgId !== null) {
        const own = visible.filter((p) => p.org_id === orgId);
        if (own.length > 1)
          return refuse(
            "sop_portal_binding_ambiguous",
            `sop_portal_binding_ambiguous: portal key "${key}" has multiple visible organization configurations`,
            key,
          );
        selected = own[0] ?? null;
      }
      if (selected === null) {
        const global = visible.filter((p) => p.org_id == null);
        if (global.length > 1)
          return refuse(
            "sop_portal_binding_ambiguous",
            `sop_portal_binding_ambiguous: portal key "${key}" has multiple visible global configurations`,
            key,
          );
        selected = global[0] ?? null;
      }
      if (
        selected === null ||
        (selected.case_type ?? null) !== template.case_type ||
        (selected.payer_id ?? null) !== payerId ||
        (selected.org_id == null && !isBindablePayer(payersById.get(selected.payer_id)))
      )
        return refuse(
          "sop_portal_binding_ineligible",
          `sop_portal_binding_ineligible: portal key "${key}" has no compatible case type, payer, or owner scope`,
          key,
        );
    }
  }
  return null;
}

/**
 * Why staging would refuse to insert a template, or null: the insert guards
 * above, then the three foreign keys in SOP_TEMPLATE_INSERT_SURFACE (an org,
 * a group or a payer that is not on staging). Groups are org-owned rows the
 * sync never copies, so a production group is often missing on staging.
 *
 * @param targetOrgIds    organizations on staging
 * @param targetGroupIds  provider_groups on staging
 * @param payersById      staging's payers plus the rows this run adds
 */
export function stagingRefusal(
  template,
  { portals, payersById, targetOrgIds, targetGroupIds = new Set() },
) {
  const fk = (code, column, table, value) => ({
    code,
    key: null,
    message: `${column.replace(/_id$/, "")} ${value} is not on staging (sop_templates_${column}_fkey -> ${table})`,
  });
  const keyRefusal =
    template.org_id != null && !targetOrgIds.has(template.org_id)
      ? fk("org_not_on_target", "org_id", "organizations", template.org_id)
      : template.group_id != null && !targetGroupIds.has(template.group_id)
        ? fk("group_not_on_target", "group_id", "provider_groups", template.group_id)
        : template.payer_id != null && !payersById.has(template.payer_id)
          ? fk("payer_not_on_target", "payer_id", "payers", template.payer_id)
          : null;
  // The BEFORE INSERT guards fire before the foreign keys are checked, so
  // their refusal is the one staging reports. A missing org, group or payer
  // is added to the message, since fixing only the first would not be enough.
  const guard = templateRefusal(template, { portals, payersById });
  if (guard && keyRefusal)
    return { ...guard, message: `${guard.message}; also ${keyRefusal.message}` };
  return guard ?? keyRefusal;
}

export function splitTemplatesByGuard(templates, context) {
  const ok = [];
  const refused = [];
  for (const t of templates) {
    const refusal = stagingRefusal(t, context);
    if (refusal) refused.push({ row: t, refusal });
    else ok.push(t);
  }
  return { ok, refused };
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
  { templates, targetPortals, targetOrgIds, targetGroupIds = new Set(), payersById },
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
  // A portal is created only if its template would then be accepted: every
  // other key it names must bind too. Otherwise the portal would sit unused,
  // and an insert-only sync could never take it back. Dropping one candidate
  // can strand another, so repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of [...create]) {
      // The same check the templates themselves get (splitTemplatesByGuard).
      const refusal = stagingRefusal(candidate.template, {
        portals: [...targetPortals, ...create.map((c) => c.row)],
        payersById,
        targetOrgIds,
        targetGroupIds,
      });
      if (!refusal) continue;
      create.splice(create.indexOf(candidate), 1);
      skipped.push({
        id: candidate.row.portal_key,
        label: candidate.entry.name,
        reason: `template ${candidate.template.id} would still be refused: ${
          refusal.key ? `key "${refusal.key}" (${refusal.code})` : refusal.message
        }; nothing created`,
      });
      changed = true;
    }
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

/**
 * The field maps to copy for the portals this run adds. A map goes with the
 * portal of its own org and key; an org's override of a NEW global portal
 * (same key, org_id set) goes too when that org is on staging and has no
 * portal of its own with that key there (which keeps its own maps). Every
 * other override of a new global portal is reported with the reason. Maps of
 * portals staging already had are not considered.
 */
export function planFieldMaps(maps, { addedPortals, targetPortals, targetOrgIds }) {
  const scope = (row) => `${row.org_id ?? ""}|${row.portal_key}`;
  const added = new Set(addedPortals.map(scope));
  const newGlobalKeys = new Set(
    addedPortals.filter((p) => p.org_id == null).map((p) => p.portal_key),
  );
  const stagingScopes = new Set(targetPortals.map(scope));
  const ok = [];
  const skipped = [];
  for (const m of maps) {
    if (added.has(scope(m))) ok.push(m);
    else if (m.org_id != null && newGlobalKeys.has(m.portal_key)) {
      if (!targetOrgIds.has(m.org_id))
        skipped.push({
          row: m,
          reason: `org ${m.org_id} is not on staging, so its override of new global portal ${m.portal_key} is not copied`,
        });
      else if (stagingScopes.has(scope(m)))
        skipped.push({
          row: m,
          reason: `org ${m.org_id} already has its own ${m.portal_key} portal on staging, which keeps its own maps`,
        });
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

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
