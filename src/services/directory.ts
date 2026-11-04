// Workbench directory reads (Nov 4, 2026): the group and location lists and
// cards behind GET /api/groups and /api/locations, the extra matching behind
// GET /api/providers?search=, and the related lists GET /api/providers/:id
// adds to its row. Read-only, org-scoped on every statement (the service-role
// client bypasses RLS, so `org_id = ctx.orgId` IS the isolation), active
// records only: no terminated providers, inactive groups or inactive
// locations. reference_only rows stay in.
//
// Never selects ssn_last4 (or anything from the SSN vault). Explicit column
// lists everywhere, never `*`.
//
// Server-only surface (no browser-default ctx) — see caseContext.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ProviderGroup } from "@/types";
import { camelizeRow } from "@/lib/case";
import { readCompletePages } from "@/lib/completePages";
import { currentVersions, documentKindLabel } from "@/lib/documents";
import { groupDefaultContact, resolveFacilityContact } from "@/lib/facilityContact";
import { hoursSummary } from "@/lib/facilityHours";
import {
  compareDirectoryNames,
  compareDirectoryPeople,
  directoryAddressLine,
  directoryQueryStateCodes,
  isCurrentAssignment,
  matchesDirectoryQuery,
  medicarePtanFrom,
  type DirectoryQuery,
} from "@/lib/directory";

export interface DirectoryServiceCtx {
  db: SupabaseClient<Database>;
  orgId: string;
}

// --- wire shapes (pinned contract; mirrored in the extension) ---------------

export interface DirectoryPage<T> {
  rows: T[];
  total: number;
}

export interface DirectoryGroupRow {
  id: string;
  name: string;
  tin: string | null;
  states: string[];
}

export interface DirectoryLocationRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  group: { id: string; name: string } | null;
}

export interface DirectoryPersonRow {
  id: string;
  firstName: string;
  lastName: string;
  credentials: string | null;
  npi: string | null;
}

export interface DirectoryGroup {
  id: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  npiType2: string | null;
  medicarePtan: string | null;
  states: string[];
  phone: string | null;
  mailingAddress: string | null;
  locations: {
    id: string;
    name: string;
    street: string | null;
    suite: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  }[];
  providers: DirectoryPersonRow[];
  documents: {
    id: string;
    docType: string;
    label: string;
    effectiveDate: string | null;
    expirationDate: string | null;
  }[];
}

/** What GET /api/providers/:id adds to the provider row for the card. */
export interface ProviderDirectoryExtras {
  licenses: { state: string; licenseNumber: string | null; expirationDate: string | null }[];
  medicareIds: { groupId: string; groupName: string; medicareId: string }[];
  groups: { id: string; name: string; tin: string | null; isPrimary: boolean }[];
  locations: { id: string; name: string; city: string | null; state: string | null }[];
}

export interface DirectoryLocation {
  id: string;
  name: string;
  street: string | null;
  suite: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  placeOfService: string | null;
  hours: string | null;
  group: { id: string; name: string; tin: string | null; npiType2: string | null } | null;
  providers: DirectoryPersonRow[];
}

// --- column sets ---------------------------------------------------------------

const PERSON_COLUMNS = "id, first_name, last_name, credentials, npi";
const CONTACT_BLOCK_COLUMNS = ["credentialing", "correspondence", "billing"]
  .map((b) => `${b}_contact_name, ${b}_phone, ${b}_fax, ${b}_email`)
  .join(", ");
const GROUP_CARD_COLUMNS =
  "id, name, tin, npi_type2, states, correspondence_street, correspondence_suite, " +
  `correspondence_city, correspondence_state, correspondence_zip, ${CONTACT_BLOCK_COLUMNS}`;
const LOCATION_CARD_COLUMNS =
  "id, name, street, suite, city, state, zip, phone, fax, email, contact_name, hours, group_id";

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function rows(res: { data: unknown; error: unknown }): Row[] {
  if (res.error) throw res.error;
  return Array.isArray(res.data) ? (res.data as Row[]) : [];
}

function one(res: { data: unknown; error: unknown }): Row | null {
  if (res.error) throw res.error;
  return (res.data as Row | null) ?? null;
}

function person(r: Row): DirectoryPersonRow {
  return {
    id: r.id as string,
    firstName: str(r.first_name) ?? "",
    lastName: str(r.last_name) ?? "",
    credentials: str(r.credentials),
    npi: str(r.npi),
  };
}

// A filtered list query that can still be ordered and ranged.
interface PageableQuery {
  order(column: string): PageableQuery;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Every row of a list read, paged by id: PostgREST silently caps an unranged
 * read at 1000 rows, which would drop search matches at random. */
function readAll(label: string, query: unknown): Promise<Row[]> {
  return readCompletePages<Row>(
    async (from, to) => {
      const page = await (query as PageableQuery).order("id").range(from, to);
      return { data: page.data as Row[] | null, error: page.error };
    },
    { label },
  );
}

// Ids per `.in()` filter, so a large roster never builds an oversized URL.
const IN_CHUNK = 100;

/** Active (non-terminated) providers of the org among `ids`, A→Z. */
async function activePeople(
  ctx: DirectoryServiceCtx,
  ids: string[],
): Promise<DirectoryPersonRow[]> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) chunks.push(unique.slice(i, i + IN_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      ctx.db
        .from("providers")
        .select(PERSON_COLUMNS)
        .eq("org_id", ctx.orgId)
        .neq("status", "terminated")
        .in("id", chunk),
    ),
  );
  return results.flatMap(rows).map(person).sort(compareDirectoryPeople);
}

/** Medicare payer ids in the catalog. Org rows key payer-issued ids to these. */
async function medicarePayerIds(ctx: DirectoryServiceCtx): Promise<string[]> {
  const res = await ctx.db.from("payers").select("id").eq("payer_kind", "medicare");
  return rows(res).map((r) => r.id as string);
}

// --- lists and search ----------------------------------------------------------

function pageOf<T>(all: T[], page: number, pageSize: number): DirectoryPage<T> {
  const from = (page - 1) * pageSize;
  return { rows: all.slice(from, from + pageSize), total: all.length };
}

/** The org's active groups by id, read in full (search matches on their names). */
async function activeGroups(ctx: DirectoryServiceCtx): Promise<Row[]> {
  return readAll(
    "Directory groups",
    ctx.db
      .from("provider_groups")
      .select("id, name, tin, npi_type2, states")
      .eq("org_id", ctx.orgId)
      .eq("is_active", true),
  );
}

/** GET /api/groups: active groups A→Z, filtered by `query` when there is one.
 * Matches name, TIN and Group NPI (dashes ignored) and state code or name.
 * Reads the org's active groups and filters in memory: one org's roster is
 * small, and a state name or a dash-less TIN is simpler here than in
 * PostgREST filters. */
export async function listDirectoryGroups(
  ctx: DirectoryServiceCtx,
  query: DirectoryQuery | null,
  page: number,
  pageSize: number,
): Promise<DirectoryPage<DirectoryGroupRow>> {
  const all = (await activeGroups(ctx))
    .filter(
      (g) =>
        !query ||
        matchesDirectoryQuery(
          { text: [str(g.name)], ids: [str(g.tin), str(g.npi_type2)], states: strArr(g.states) },
          query,
        ),
    )
    .map((g) => ({
      id: g.id as string,
      name: g.name as string,
      tin: str(g.tin),
      states: strArr(g.states),
    }))
    .sort((a, b) => compareDirectoryNames(a.name, b.name));
  return pageOf(all, page, pageSize);
}

/** GET /api/locations: active facilities A→Z, filtered by `query` when there
 * is one. Matches name, street, city, ZIP, state code or name, and the owning
 * group's name. The group is shown only when it is active. */
export async function listDirectoryLocations(
  ctx: DirectoryServiceCtx,
  query: DirectoryQuery | null,
  page: number,
  pageSize: number,
): Promise<DirectoryPage<DirectoryLocationRow>> {
  const [groupRows, facilityRows] = await Promise.all([
    activeGroups(ctx),
    readAll(
      "Directory locations",
      ctx.db
        .from("facilities")
        .select("id, name, street, city, state, zip, group_id")
        .eq("org_id", ctx.orgId)
        .eq("is_active", true),
    ),
  ]);
  const groupNames = new Map(groupRows.map((g) => [g.id as string, g.name as string]));
  const all = facilityRows
    .map((f) => {
      const groupId = str(f.group_id);
      const groupName = groupId ? groupNames.get(groupId) : undefined;
      return {
        raw: f,
        row: {
          id: f.id as string,
          name: f.name as string,
          city: str(f.city),
          state: str(f.state),
          group: groupId && groupName != null ? { id: groupId, name: groupName } : null,
        },
      };
    })
    .filter(
      ({ raw, row }) =>
        !query ||
        matchesDirectoryQuery(
          {
            text: [row.name, str(raw.street), row.city, row.group?.name],
            ids: [str(raw.zip)],
            states: [row.state],
          },
          query,
        ),
    )
    .map(({ row }) => row)
    .sort((a, b) => compareDirectoryNames(a.name, b.name));
  return pageOf(all, page, pageSize);
}

/** The providers among `providers` that match `query`, order kept. Beyond
 * name, NPI and email (what the plain list search covers) this matches CAQH
 * ID, license state (code or full name) and the name and TIN of each current
 * group, so "Smith Acme" finds Smith on Acme's roster. */
export async function filterProvidersBySearch<
  T extends {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    npi?: string | null;
    email?: string | null;
    caqhId?: string | null;
  },
>(ctx: DirectoryServiceCtx, providers: T[], query: DirectoryQuery): Promise<T[]> {
  if (providers.length === 0) return providers;
  const stateCodes = directoryQueryStateCodes(query);
  const [groupRows, assignmentRows, licenseRows] = await Promise.all([
    activeGroups(ctx),
    readAll(
      "Directory group assignments",
      ctx.db
        .from("provider_group_assignments")
        .select("id, provider_id, group_id, end_date")
        .eq("org_id", ctx.orgId),
    ),
    // Licenses only decide a state match, so read just the states asked for.
    stateCodes.length
      ? readAll(
          "Directory licenses",
          ctx.db
            .from("state_licenses")
            .select("id, provider_id, state")
            .eq("org_id", ctx.orgId)
            .in("state", stateCodes),
        )
      : Promise.resolve([] as Row[]),
  ]);
  const groupById = new Map(groupRows.map((g) => [g.id as string, g]));
  const groupsOf = new Map<string, Row[]>();
  for (const a of assignmentRows) {
    const g = groupById.get(a.group_id as string);
    const providerId = str(a.provider_id);
    if (!g || !providerId || !isCurrentAssignment(str(a.end_date))) continue;
    groupsOf.set(providerId, [...(groupsOf.get(providerId) ?? []), g]);
  }
  const licenseStates = new Map<string, string[]>();
  for (const l of licenseRows) {
    const id = str(l.provider_id);
    if (id) licenseStates.set(id, [...(licenseStates.get(id) ?? []), l.state as string]);
  }
  return providers.filter((p) => {
    const first = p.firstName ?? "";
    const last = p.lastName ?? "";
    const groups = groupsOf.get(p.id) ?? [];
    return matchesDirectoryQuery(
      {
        text: [first, last, `${first} ${last}`, p.email, ...groups.map((g) => str(g.name))],
        ids: [p.npi, p.caqhId, ...groups.map((g) => str(g.tin))],
        states: licenseStates.get(p.id) ?? [],
      },
      query,
    );
  });
}

// --- group card --------------------------------------------------------------

export async function getDirectoryGroup(
  ctx: DirectoryServiceCtx,
  groupId: string,
): Promise<DirectoryGroup | null> {
  const group = one(
    await ctx.db
      .from("provider_groups")
      .select(GROUP_CARD_COLUMNS)
      .eq("id", groupId)
      .eq("org_id", ctx.orgId)
      .eq("is_active", true)
      .maybeSingle(),
  );
  if (!group) return null;

  const [facilityRes, assignmentRes, documentRes, medicareIds] = await Promise.all([
    ctx.db
      .from("facilities")
      .select("id, name, street, suite, city, state, zip")
      .eq("org_id", ctx.orgId)
      .eq("group_id", groupId)
      .eq("is_active", true),
    ctx.db
      .from("provider_group_assignments")
      .select("provider_id, end_date")
      .eq("org_id", ctx.orgId)
      .eq("group_id", groupId),
    // Group-owned documents only (a provider document carries provider_id).
    ctx.db
      .from("provider_documents")
      .select(
        "id, doc_type, document_family_id, supersedes_document_id, version_number, " +
          "effective_date, expiration_date",
      )
      .eq("org_id", ctx.orgId)
      .eq("group_id", groupId)
      .is("provider_id", null),
    medicarePayerIds(ctx),
  ]);

  const ptanRows = medicareIds.length
    ? rows(
        await ctx.db
          .from("payer_network_targets")
          .select("state, payer_issued_id")
          .eq("org_id", ctx.orgId)
          .eq("group_id", groupId)
          .eq("status", "active")
          .in("payer_id", medicareIds),
      )
    : [];

  const providerIds = rows(assignmentRes)
    .filter((a) => isCurrentAssignment(str(a.end_date)))
    .map((a) => a.provider_id as string);

  const documents = currentVersions(
    rows(documentRes).map((d) => ({
      id: d.id as string,
      documentFamilyId: str(d.document_family_id) as string,
      supersedesDocumentId: str(d.supersedes_document_id),
      versionNumber: typeof d.version_number === "number" ? d.version_number : 1,
      docType: d.doc_type as string,
      effectiveDate: str(d.effective_date),
      expirationDate: str(d.expiration_date),
    })),
  )
    .map((d) => ({
      id: d.id,
      docType: d.docType,
      label: documentKindLabel(d.docType),
      effectiveDate: d.effectiveDate,
      expirationDate: d.expirationDate,
    }))
    .sort((a, b) => compareDirectoryNames(a.label, b.label));

  const camel = camelizeRow<ProviderGroup>(group);
  return {
    id: group.id as string,
    name: group.name as string,
    // provider_groups has no separate legal-name column (contract keeps the
    // field; the card falls back to `name`).
    legalName: null,
    tin: str(group.tin),
    npiType2: str(group.npi_type2),
    medicarePtan: medicarePtanFrom(
      ptanRows.map((r) => ({ state: r.state as string, payerIssuedId: str(r.payer_issued_id) })),
    ),
    states: strArr(group.states),
    phone: groupDefaultContact(camel)?.channel.phone ?? null,
    mailingAddress: directoryAddressLine({
      street: str(group.correspondence_street),
      suite: str(group.correspondence_suite),
      city: str(group.correspondence_city),
      state: str(group.correspondence_state),
      zip: str(group.correspondence_zip),
    }),
    locations: rows(facilityRes)
      .map((f) => ({
        id: f.id as string,
        name: f.name as string,
        street: str(f.street),
        suite: str(f.suite),
        city: str(f.city),
        state: str(f.state),
        zip: str(f.zip),
      }))
      .sort((a, b) => compareDirectoryNames(a.name, b.name)),
    providers: await activePeople(ctx, providerIds),
    documents,
  };
}

// --- provider card extras --------------------------------------------------------

/** The related lists GET /api/providers/:id adds to the provider row: licenses
 * by state, Medicare IDs from live enrollment facts on the Medicare payer
 * under active groups, current groups (primary first) and active locations.
 * The caller has already found the provider in this org. */
export async function getProviderDirectoryExtras(
  ctx: DirectoryServiceCtx,
  providerId: string,
): Promise<ProviderDirectoryExtras> {
  const [licenseRes, groupAssignRes, facilityAssignRes, medicareIds] = await Promise.all([
    ctx.db
      .from("state_licenses")
      .select("state, license_number, expiration_date")
      .eq("org_id", ctx.orgId)
      .eq("provider_id", providerId),
    ctx.db
      .from("provider_group_assignments")
      .select("group_id, is_primary, end_date")
      .eq("org_id", ctx.orgId)
      .eq("provider_id", providerId),
    ctx.db
      .from("provider_facility_assignments")
      .select("facility_id")
      .eq("org_id", ctx.orgId)
      .eq("provider_id", providerId),
    medicarePayerIds(ctx),
  ]);

  const currentAssignments = rows(groupAssignRes).filter((a) =>
    isCurrentAssignment(str(a.end_date)),
  );
  const facilityIds = rows(facilityAssignRes)
    .map((a) => str(a.facility_id))
    .filter((id): id is string => id != null);

  const [factRes, facilityRes] = await Promise.all([
    medicareIds.length
      ? ctx.db
          .from("enrollment_facts")
          .select("group_id, payer_issued_id")
          .eq("org_id", ctx.orgId)
          .eq("provider_id", providerId)
          .is("expired_at", null)
          .in("payer_id", medicareIds)
      : Promise.resolve({ data: [], error: null }),
    facilityIds.length
      ? ctx.db
          .from("facilities")
          .select("id, name, city, state")
          .eq("org_id", ctx.orgId)
          .eq("is_active", true)
          .in("id", facilityIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const facts = rows(factRes).filter((f) => str(f.payer_issued_id)?.trim());

  const groupIds = [
    ...new Set([
      ...currentAssignments.map((a) => a.group_id as string),
      ...facts.map((f) => f.group_id as string),
    ]),
  ];
  const groupRows = groupIds.length
    ? rows(
        await ctx.db
          .from("provider_groups")
          .select("id, name, tin")
          .eq("org_id", ctx.orgId)
          .eq("is_active", true)
          .in("id", groupIds),
      )
    : [];
  const groupById = new Map(groupRows.map((g) => [g.id as string, g]));

  const medicare: ProviderDirectoryExtras["medicareIds"] = [];
  for (const f of facts) {
    const g = groupById.get(f.group_id as string);
    const medicareId = (f.payer_issued_id as string).trim();
    if (!g) continue;
    if (medicare.some((m) => m.groupId === g.id && m.medicareId === medicareId)) continue;
    medicare.push({ groupId: g.id as string, groupName: g.name as string, medicareId });
  }
  medicare.sort(
    (a, b) =>
      compareDirectoryNames(a.groupName, b.groupName) || a.medicareId.localeCompare(b.medicareId),
  );

  return {
    licenses: rows(licenseRes)
      .map((l) => ({
        state: l.state as string,
        licenseNumber: str(l.license_number),
        expirationDate: str(l.expiration_date),
      }))
      .sort(
        (a, b) =>
          a.state.localeCompare(b.state) ||
          (a.licenseNumber ?? "").localeCompare(b.licenseNumber ?? ""),
      ),
    medicareIds: medicare,
    groups: currentAssignments
      .filter((a) => groupById.has(a.group_id as string))
      .map((a) => {
        const g = groupById.get(a.group_id as string) as Row;
        return {
          id: g.id as string,
          name: g.name as string,
          tin: str(g.tin),
          isPrimary: Boolean(a.is_primary),
        };
      })
      .filter((g, i, all) => all.findIndex((x) => x.id === g.id) === i)
      .sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) || compareDirectoryNames(a.name, b.name),
      ),
    locations: rows(facilityRes)
      .map((f) => ({
        id: f.id as string,
        name: f.name as string,
        city: str(f.city),
        state: str(f.state),
      }))
      .sort((a, b) => compareDirectoryNames(a.name, b.name)),
  };
}

// --- location card -------------------------------------------------------------

export async function getDirectoryLocation(
  ctx: DirectoryServiceCtx,
  locationId: string,
): Promise<DirectoryLocation | null> {
  const f = one(
    await ctx.db
      .from("facilities")
      .select(LOCATION_CARD_COLUMNS)
      .eq("id", locationId)
      .eq("org_id", ctx.orgId)
      .eq("is_active", true)
      .maybeSingle(),
  );
  if (!f) return null;

  const groupId = str(f.group_id);
  const [groupRes, assignmentRes] = await Promise.all([
    groupId
      ? ctx.db
          .from("provider_groups")
          .select(`id, name, tin, npi_type2, ${CONTACT_BLOCK_COLUMNS}`)
          .eq("id", groupId)
          .eq("org_id", ctx.orgId)
          .eq("is_active", true)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    ctx.db
      .from("provider_facility_assignments")
      .select("provider_id")
      .eq("org_id", ctx.orgId)
      .eq("facility_id", locationId),
  ]);
  const group = one(groupRes);

  // Phone and fax follow the locked facility contact inheritance (the owning
  // group's block when the location has none of its own), so the card shows
  // what the facility page shows.
  const contact = resolveFacilityContact(
    {
      contactName: str(f.contact_name),
      phone: str(f.phone),
      fax: str(f.fax),
      email: str(f.email),
    },
    group ? camelizeRow<ProviderGroup>(group) : null,
  );

  return {
    id: f.id as string,
    name: f.name as string,
    street: str(f.street),
    suite: str(f.suite),
    city: str(f.city),
    state: str(f.state),
    zip: str(f.zip),
    phone: contact.phone,
    fax: contact.fax,
    // facilities has no place-of-service column (contract keeps the field).
    placeOfService: null,
    hours: hoursSummary(f.hours),
    group: group
      ? {
          id: group.id as string,
          name: group.name as string,
          tin: str(group.tin),
          npiType2: str(group.npi_type2),
        }
      : null,
    providers: await activePeople(
      ctx,
      rows(assignmentRes)
        .map((a) => str(a.provider_id))
        .filter((id): id is string => id != null),
    ),
  };
}
