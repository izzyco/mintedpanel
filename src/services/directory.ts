// Workbench directory reads (Nov 4, 2026) behind GET /api/directory/*: search
// and the group, provider and location cards. Read-only, org-scoped on every
// statement (the service-role client bypasses RLS, so `org_id = ctx.orgId` IS
// the isolation), active records only: no terminated providers, inactive
// groups or inactive locations. reference_only rows stay in.
//
// Never selects ssn_last4 (or anything from the SSN vault): the directory
// shows no SSN at all. Explicit column lists everywhere, never `*`.
//
// Server-only surface (no browser-default ctx) — see caseContext.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ProviderGroup } from "@/types";
import { camelizeRow } from "@/lib/case";
import { currentVersions, documentKindLabel } from "@/lib/documents";
import { groupDefaultContact, resolveFacilityContact } from "@/lib/facilityContact";
import { hoursSummary } from "@/lib/facilityHours";
import {
  DIRECTORY_RESULT_LIMIT,
  boardCertificationText,
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

export interface DirectorySearch {
  groups: { id: string; name: string; tin: string | null; states: string[] }[];
  providers: {
    id: string;
    firstName: string;
    lastName: string;
    credentials: string | null;
    npi: string | null;
    groups: { id: string; name: string }[];
  }[];
  locations: {
    id: string;
    name: string;
    city: string | null;
    state: string | null;
    group: { id: string; name: string } | null;
  }[];
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

export interface DirectoryProvider {
  id: string;
  firstName: string;
  middleInitial: string | null;
  lastName: string;
  credentials: string | null;
  npi: string | null;
  caqhId: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  languages: string[];
  licenses: { state: string; licenseNumber: string | null; expirationDate: string | null }[];
  medicareIds: { groupId: string; groupName: string; medicareId: string }[];
  taxonomyCode: string | null;
  specialty: string | null;
  boardCertification: string | null;
  deaNumber: string | null;
  education: { degree: string | null; school: string | null; graduationDate: string | null };
  malpractice: {
    carrier: string | null;
    policyNumber: string | null;
    expirationDate: string | null;
  };
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
const SEARCH_PROVIDER_COLUMNS = "id, first_name, last_name, credentials, npi, caqh_id, email";
const PROVIDER_CARD_COLUMNS =
  "id, first_name, middle_initial, last_name, credentials, npi, caqh_id, email, phone, " +
  "date_of_birth, gender, languages, taxonomy_code, specialty, board_certified, dea_number, " +
  "degree, school_name, graduation_date, malpractice_carrier, malpractice_policy_number, " +
  "malpractice_coverage_end";
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

/** Active (non-terminated) providers of the org among `ids`, A→Z. */
async function activePeople(
  ctx: DirectoryServiceCtx,
  ids: string[],
): Promise<DirectoryPersonRow[]> {
  if (ids.length === 0) return [];
  const res = await ctx.db
    .from("providers")
    .select(PERSON_COLUMNS)
    .eq("org_id", ctx.orgId)
    .neq("status", "terminated")
    .in("id", [...new Set(ids)]);
  return rows(res).map(person).sort(compareDirectoryPeople);
}

/** Medicare payer ids in the catalog. Org rows key payer-issued ids to these. */
async function medicarePayerIds(ctx: DirectoryServiceCtx): Promise<string[]> {
  const res = await ctx.db.from("payers").select("id").eq("payer_kind", "medicare");
  return rows(res).map((r) => r.id as string);
}

// --- search ------------------------------------------------------------------

/** Groups, providers and locations matching every term, each A→Z, at most 10.
 * Reads the org's active records and filters in memory: one org's roster is
 * small, and matching on a state name, a dash-less TIN or a license state is
 * simpler here than in PostgREST filters. */
export async function searchDirectory(
  ctx: DirectoryServiceCtx,
  query: DirectoryQuery,
  today: string,
): Promise<DirectorySearch> {
  const stateCodes = directoryQueryStateCodes(query);
  const [groupRes, providerRes, facilityRes, licenseRes] = await Promise.all([
    ctx.db
      .from("provider_groups")
      .select("id, name, tin, npi_type2, states")
      .eq("org_id", ctx.orgId)
      .eq("is_active", true),
    ctx.db
      .from("providers")
      .select(SEARCH_PROVIDER_COLUMNS)
      .eq("org_id", ctx.orgId)
      .neq("status", "terminated"),
    ctx.db
      .from("facilities")
      .select("id, name, city, state, zip, group_id")
      .eq("org_id", ctx.orgId)
      .eq("is_active", true),
    // Licenses only decide a state match, so read just the states asked for.
    stateCodes.length
      ? ctx.db
          .from("state_licenses")
          .select("provider_id, state")
          .eq("org_id", ctx.orgId)
          .in("state", stateCodes)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const groupRows = rows(groupRes);
  const groupNames = new Map(groupRows.map((g) => [g.id as string, g.name as string]));
  const licenseStates = new Map<string, string[]>();
  for (const l of rows(licenseRes)) {
    const id = l.provider_id as string | null;
    if (id) licenseStates.set(id, [...(licenseStates.get(id) ?? []), l.state as string]);
  }

  const groups = groupRows
    .filter((g) =>
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
    .sort((a, b) => compareDirectoryNames(a.name, b.name))
    .slice(0, DIRECTORY_RESULT_LIMIT);

  const matchedPeople = rows(providerRes)
    .filter((p) => {
      const first = str(p.first_name) ?? "";
      const last = str(p.last_name) ?? "";
      return matchesDirectoryQuery(
        {
          text: [first, last, `${first} ${last}`, str(p.email)],
          ids: [str(p.npi), str(p.caqh_id)],
          states: licenseStates.get(p.id as string) ?? [],
        },
        query,
      );
    })
    .map(person)
    .sort(compareDirectoryPeople)
    .slice(0, DIRECTORY_RESULT_LIMIT);

  // Group labels for the matched providers only: current assignments to
  // active groups, primary first then A→Z.
  const assignmentRows = matchedPeople.length
    ? rows(
        await ctx.db
          .from("provider_group_assignments")
          .select("provider_id, group_id, is_primary, end_date")
          .eq("org_id", ctx.orgId)
          .in(
            "provider_id",
            matchedPeople.map((p) => p.id),
          ),
      )
    : [];
  const providers = matchedPeople.map((p) => ({
    ...p,
    groups: assignmentRows
      .filter(
        (a) =>
          a.provider_id === p.id &&
          groupNames.has(a.group_id as string) &&
          isCurrentAssignment(str(a.end_date), today),
      )
      .sort(
        (a, b) =>
          Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) ||
          compareDirectoryNames(
            groupNames.get(a.group_id as string) ?? "",
            groupNames.get(b.group_id as string) ?? "",
          ),
      )
      .map((a) => ({ id: a.group_id as string, name: groupNames.get(a.group_id as string) ?? "" })),
  }));

  const locations = rows(facilityRes)
    .filter((f) =>
      matchesDirectoryQuery(
        { text: [str(f.name), str(f.city)], ids: [str(f.zip)], states: [str(f.state)] },
        query,
      ),
    )
    .map((f) => {
      const groupId = str(f.group_id);
      const groupName = groupId ? groupNames.get(groupId) : undefined;
      return {
        id: f.id as string,
        name: f.name as string,
        city: str(f.city),
        state: str(f.state),
        group: groupId && groupName != null ? { id: groupId, name: groupName } : null,
      };
    })
    .sort((a, b) => compareDirectoryNames(a.name, b.name))
    .slice(0, DIRECTORY_RESULT_LIMIT);

  return { groups, providers, locations };
}

// --- group card --------------------------------------------------------------

export async function getDirectoryGroup(
  ctx: DirectoryServiceCtx,
  groupId: string,
  today: string,
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
    .filter((a) => isCurrentAssignment(str(a.end_date), today))
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

// --- provider card -------------------------------------------------------------

export async function getDirectoryProvider(
  ctx: DirectoryServiceCtx,
  providerId: string,
  today: string,
): Promise<DirectoryProvider | null> {
  const p = one(
    await ctx.db
      .from("providers")
      .select(PROVIDER_CARD_COLUMNS)
      .eq("id", providerId)
      .eq("org_id", ctx.orgId)
      .neq("status", "terminated")
      .maybeSingle(),
  );
  if (!p) return null;

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
    isCurrentAssignment(str(a.end_date), today),
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

  const medicare: DirectoryProvider["medicareIds"] = [];
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
    id: p.id as string,
    firstName: str(p.first_name) ?? "",
    middleInitial: str(p.middle_initial),
    lastName: str(p.last_name) ?? "",
    credentials: str(p.credentials),
    npi: str(p.npi),
    caqhId: str(p.caqh_id),
    email: str(p.email),
    phone: str(p.phone),
    dateOfBirth: str(p.date_of_birth),
    gender: str(p.gender),
    languages: strArr(p.languages),
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
    taxonomyCode: str(p.taxonomy_code),
    specialty: str(p.specialty),
    boardCertification: boardCertificationText(p.board_certified as boolean | null),
    deaNumber: str(p.dea_number),
    education: {
      degree: str(p.degree),
      school: str(p.school_name),
      graduationDate: str(p.graduation_date),
    },
    malpractice: {
      carrier: str(p.malpractice_carrier),
      policyNumber: str(p.malpractice_policy_number),
      expirationDate: str(p.malpractice_coverage_end),
    },
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
