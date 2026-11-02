// Four field-section bodies shared by the Add stepper and single-page Edit.
// Each takes (form, errors, update); Licenses/Employment also mutate arrays via update.
import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/providers/FormField";
import { NpiRegistryAssist } from "@/components/providers/NpiRegistryAssist";
import { useNpiRegistryPolicy } from "@/hooks/useNpiRegistry";
import { addNpiLicenseOffer, applyNpiRegistryPick } from "@/components/providers/providerNpiPick";
import {
  npiCandidatesOnForm,
  npiOffersOnForm,
  npiRegistrySourceLabel,
  touchNpiRowOrigin,
  type NpiFieldCandidate,
  type NpiPickState,
} from "@/lib/npiRegistryFill";

import { useFacilities, useProviderGroups } from "@/hooks/useLookups";
import {
  US_STATES,
  emptyLicenseRow,
  type LicenseRow,
  type ProviderFormErrors,
  type ProviderFormState,
  type UpdateProviderField,
} from "@/components/providers/providerFormShared";
import { stripNpiSeparators } from "@/lib/providerIdentity";
import { taxonomyOptionsForValue } from "@/lib/providerTaxonomy";
import { PROVIDER_GENDER_OPTIONS, PROVIDER_GENDER_UNSET_VALUE } from "@/lib/providerGender";
import { localCalendarDate } from "@/lib/systemTokens";
import {
  DEFAULT_ADD_PROVIDER_RULES,
  addProviderStartDateHint,
  type AddProviderRules,
} from "@/lib/addProviderRules";

interface SectionProps {
  form: ProviderFormState;
  errors: ProviderFormErrors;
  update: UpdateProviderField;
}

/** MINT-110 (A35): whether Credentials and the taxonomy still hold what a
 * pick filled, untouched, and Gender and Phone a registry value staff used
 * (A36), and the "From NPI Registry, <date>" they show until the review step
 * confirms them. Null before any pick. (A license row carries its own pull
 * date on npiOrigin.) */
export type RegistrySource = {
  label: string;
  credentials: boolean;
  taxonomyCode: boolean;
  gender: boolean;
  phone: boolean;
} | null;

export function PersonalSection({
  form,
  errors,
  update,
  registrySource,
}: SectionProps & { registrySource: RegistrySource }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="First name" error={errors.firstName}>
        <Input
          data-review-field="firstName"
          value={form.firstName}
          onChange={(e) => update("firstName", e.target.value)}
        />
      </Field>
      <Field label="Last name" error={errors.lastName}>
        <Input value={form.lastName} onChange={(e) => update("lastName", e.target.value)} />
      </Field>
      <Field
        label="Credentials"
        helper={registrySource?.credentials ? registrySource.label : undefined}
      >
        <Input
          data-review-field="credentials"
          placeholder="PT, DPT"
          value={form.credentials}
          onChange={(e) => update("credentials", e.target.value)}
        />
      </Field>
      <Field label="Gender" helper={registrySource?.gender ? registrySource.label : undefined}>
        {(control) => (
          <Select
            value={form.gender || PROVIDER_GENDER_UNSET_VALUE}
            onValueChange={(value) =>
              update("gender", value === PROVIDER_GENDER_UNSET_VALUE ? "" : value)
            }
          >
            <SelectTrigger aria-label="Gender" {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PROVIDER_GENDER_UNSET_VALUE}>Not set</SelectItem>
              {PROVIDER_GENDER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field label="Date of birth">
        <Input
          type="date"
          value={form.dateOfBirth}
          onChange={(e) => update("dateOfBirth", e.target.value)}
        />
      </Field>
      <Field
        label="SSN last 4"
        error={errors.ssnLast4}
        helper="Last 4 only — Minted Panel never stores full SSNs"
      >
        {(control) => (
          <div className="flex items-center gap-2">
            <span className="select-none font-mono text-sm text-muted-foreground">xxx-xx-</span>
            <Input
              {...control}
              inputMode="numeric"
              maxLength={4}
              className="w-24 font-mono"
              value={form.ssnLast4}
              onChange={(e) => update("ssnLast4", e.target.value.replace(/\D/g, "").slice(0, 4))}
            />
          </div>
        )}
      </Field>
      <Field label="Email" error={errors.email}>
        <Input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} />
      </Field>
      <Field label="Phone" helper={registrySource?.phone ? registrySource.label : undefined}>
        <Input value={form.phone} onChange={(e) => update("phone", e.target.value)} />
      </Field>
    </div>
  );
}

/** What the stepper keeps for the NPI Registry across steps (CredentialsSection
 * unmounts on every step change). Required, so the stepper cannot leave it
 * out. */
export interface CredentialsNpiProps {
  npiPick: NpiPickState | null;
  /** Staff edited Credentials / chose the taxonomy (from user input only). */
  touched: { credentials: boolean; taxonomyCode: boolean; gender: boolean; phone: boolean };
  /** Set the form and the pick together, marking nothing as staff's. */
  applyNpi: (form: ProviderFormState, pick: NpiPickState | null) => void;
  /** Put a registry candidate into Gender or Phone (A36), as the registry's
   * until staff edit the field. */
  applyCandidate: (candidate: NpiFieldCandidate) => void;
  /** The preset taxonomy applied for the group (A32). */
  taxonomyPreset: string;
  registrySource: RegistrySource;
}

export function CredentialsSection({
  form,
  errors,
  update,
  npi,
}: SectionProps & { npi: CredentialsNpiProps }) {
  const npiNoticeId = useId();
  const npiPolicy = useNpiRegistryPolicy();
  const { npiPick, touched, applyNpi, applyCandidate, taxonomyPreset, registrySource } = npi;
  // Whether each offer and candidate is on the form is read from the form, so
  // a removed row can be added again.
  const shownPick = npiPick
    ? {
        ...npiPick,
        summary: npiCandidatesOnForm(npiOffersOnForm(npiPick.summary, form.licenses), {
          gender: form.gender,
          phone: form.phone,
        }),
      }
    : null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="NPI" error={errors.npi}>
        <Input
          data-review-field="npi"
          inputMode="numeric"
          maxLength={20}
          aria-describedby={npiNoticeId}
          value={form.npi}
          onChange={(e) => update("npi", stripNpiSeparators(e.target.value))}
        />
      </Field>
      <div className="md:col-span-2">
        <NpiRegistryAssist
          npi={form.npi}
          firstName={form.firstName}
          lastName={form.lastName}
          verify
          pick={shownPick}
          onPick={(record, pulledAt) => {
            // Credentials (Personal) and licenses (Licenses) live on other
            // steps; the summary under the search names what changed.
            const next = applyNpiRegistryPick(form, record, npiPolicy.fillOnPick, {
              touched,
              lastPick: npiPick?.trace ?? null,
              taxonomyPreset,
              pulledAt,
            });
            applyNpi(next.form, {
              seq: (npiPick?.seq ?? 0) + 1,
              npi: record.npi,
              trace: next.trace,
              summary: next.summary,
              pulledAt,
            });
          }}
          // One of several taxonomies (A35): staff chose it, so it is theirs.
          onChooseTaxonomy={(code) => update("taxonomyCode", code)}
          onUseCandidate={applyCandidate}
          onAddLicense={(offer) => {
            const next = addNpiLicenseOffer(
              form.licenses,
              offer,
              npiPick?.pulledAt ?? new Date().toISOString(),
            );
            if (next.existing !== null) return "exists";
            applyNpi({ ...form, licenses: next.licenses }, npiPick);
            return "added";
          }}
          noticeId={npiNoticeId}
          policy={npiPolicy}
        />
      </div>
      <Field label="CAQH ID" error={errors.caqhId}>
        {(control) => (
          <>
            <Input
              {...control}
              inputMode="numeric"
              maxLength={8}
              disabled={form.isNewGrad}
              value={form.caqhId}
              onChange={(e) => update("caqhId", e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
            <label className="mt-2 flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.isNewGrad}
                onCheckedChange={(c) => {
                  const v = c === true;
                  update("isNewGrad", v);
                  if (v) update("caqhId", "");
                }}
              />
              New grad — no CAQH yet
            </label>
          </>
        )}
      </Field>
      <Field label="CAQH last attested date">
        <Input
          type="date"
          disabled={form.isNewGrad}
          value={form.caqhLastAttestedDate}
          onChange={(e) => update("caqhLastAttestedDate", e.target.value)}
        />
      </Field>
      <Field
        label="Taxonomy code"
        error={errors.taxonomyCode}
        helper={
          registrySource?.taxonomyCode
            ? registrySource.label
            : "NUCC taxonomy for this provider's specialty"
        }
      >
        {(control) => (
          <Select
            value={form.taxonomyCode || undefined}
            // The stepper's update marks the taxonomy as chosen by staff.
            onValueChange={(v) => update("taxonomyCode", v)}
          >
            <SelectTrigger aria-label="Taxonomy code" data-review-field="taxonomyCode" {...control}>
              <SelectValue placeholder="Select taxonomy" />
            </SelectTrigger>
            <SelectContent>
              {taxonomyOptionsForValue(form.taxonomyCode).map(({ code, label }) => (
                <SelectItem key={code} value={code}>
                  <span className="font-mono text-[13px]">{code}</span>
                  <span className="text-muted-foreground"> — {label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </div>
  );
}

export function LicensesSection({ form, errors, update }: SectionProps) {
  // A staff edit marks registry data on the row as theirs (MINT-110).
  const updateRow = (i: number, patch: Partial<LicenseRow>) => {
    update(
      "licenses",
      form.licenses.map((l, idx) =>
        idx === i
          ? {
              ...l,
              ...patch,
              npiOrigin: touchNpiRowOrigin(l.npiOrigin, { number: "number" in patch }),
            }
          : l,
      ),
    );
  };
  const addRow = () => {
    update("licenses", [...form.licenses, emptyLicenseRow()]);
  };
  const removeRow = (i: number) => {
    update(
      "licenses",
      form.licenses.filter((_, idx) => idx !== i),
    );
  };

  return (
    <div className="space-y-4">
      {errors.licenses ? <p className="text-xs text-destructive">{errors.licenses}</p> : null}
      {form.licenses.map((row, i) => (
        <div key={i} className="rounded-md border border-border p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-2">
              <FieldLabel>State</FieldLabel>
              <Select value={row.state} onValueChange={(v) => updateRow(i, { state: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-3">
              <FieldLabel>License number</FieldLabel>
              <Input
                data-review-field={`licenseNumber-${i}`}
                value={row.number}
                onChange={(e) => updateRow(i, { number: e.target.value })}
              />
              {/* MINT-110 (A35): a number or row an NPI Registry pick filled or
                  added says so until staff edit it. */}
              {row.npiOrigin && !row.npiOrigin.touched && row.npiOrigin.pulledAt ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {npiRegistrySourceLabel(row.npiOrigin.pulledAt)}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Type</FieldLabel>
              <Select
                value={row.type}
                onValueChange={(v) => updateRow(i, { type: v as LicenseRow["type"] })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Issue date</FieldLabel>
              <Input
                type="date"
                value={row.issueDate}
                onChange={(e) => updateRow(i, { issueDate: e.target.value })}
              />
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Expires</FieldLabel>
              <Input
                type="date"
                value={row.expirationDate}
                onChange={(e) => updateRow(i, { expirationDate: e.target.value })}
              />
            </div>
            <div className="flex items-end md:col-span-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeRow(i)}
                aria-label="Remove license"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button variant="outline" onClick={addRow}>
        <Plus className="h-4 w-4" />
        Add license
      </Button>
    </div>
  );
}

export function EmploymentSection({
  form,
  errors,
  update,
  addProviderRules = DEFAULT_ADD_PROVIDER_RULES,
}: SectionProps & { addProviderRules?: AddProviderRules }) {
  const groups = useProviderGroups();
  const facilities = useFacilities(form.groupId || null);

  const toggleFacility = (id: string) => {
    const next = form.facilityIds.includes(id)
      ? form.facilityIds.filter((f) => f !== id)
      : [...form.facilityIds, id];
    update("facilityIds", next);
  };

  const facilityList = facilities.data ?? [];
  // MINT-96: say what a blank Start date saves before save, from the rule
  // the save reads (AddProviderRules, MINT-116), instead of letting a date
  // appear on the record after. The provider's stays null; by default the
  // facility assignments start local today.
  const startDateHint = addProviderStartDateHint(addProviderRules, {
    startDate: form.startDate,
    facilityCount: form.facilityIds.length,
    today: localCalendarDate(new Date()),
  });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Group" error={errors.groupId}>
        {(control) => (
          <Select
            value={form.groupId}
            onValueChange={(v) => {
              update("groupId", v);
              update("facilityIds", []);
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder="Select group" />
            </SelectTrigger>
            <SelectContent>
              {(groups.data ?? []).map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field label="Specialty">
        <Input value={form.specialty} onChange={(e) => update("specialty", e.target.value)} />
      </Field>
      <div className="md:col-span-2">
        <FieldLabel>Facilities</FieldLabel>
        {!form.groupId ? (
          <p className="text-xs text-muted-foreground">Select a group to choose facilities.</p>
        ) : facilityList.length === 0 ? (
          <p className="text-xs text-muted-foreground">No facilities for this group.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {facilityList.map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={form.facilityIds.includes(f.id)}
                  onCheckedChange={() => toggleFacility(f.id)}
                />
                <span>{f.name}</span>
                {form.facilityIds[0] === f.id ? (
                  <span className="ml-auto text-[11px] uppercase tracking-wide text-muted-foreground">
                    Primary
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        )}
      </div>
      <Field label="Start date" error={errors.startDate} helper={startDateHint}>
        <Input
          type="date"
          value={form.startDate}
          onChange={(e) => update("startDate", e.target.value)}
        />
      </Field>
      <Field label="Degree">
        <Input value={form.degree} onChange={(e) => update("degree", e.target.value)} />
      </Field>
      <Field label="School">
        <Input value={form.schoolName} onChange={(e) => update("schoolName", e.target.value)} />
      </Field>
      <Field label="Graduation date">
        <Input
          type="date"
          value={form.graduationDate}
          onChange={(e) => update("graduationDate", e.target.value)}
        />
      </Field>
    </div>
  );
}
