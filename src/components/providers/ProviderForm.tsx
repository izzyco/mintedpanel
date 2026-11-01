// Multi-step Add Provider form used by /providers/new. Re-exports shared
// types/state for the route. Record edit is inline on /providers/$id.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { maskSsn } from "@/lib/ssnMask";
import { useFacilities, useProviderGroups } from "@/hooks/useLookups";
import { useNpiRegistryPolicy, useRecordNpiAdvisoriesAfterSave } from "@/hooks/useNpiRegistry";
import { useTaxonomyPreset } from "@/hooks/useTaxonomyPreset";
import { NpiRegistryReview } from "@/components/providers/NpiRegistryReview";
import {
  CredentialsSection,
  EmploymentSection,
  LicensesSection,
  PersonalSection,
} from "@/components/providers/ProviderFormSections";
import {
  validateAll,
  validateCredentials,
  validatePersonal,
  type ProviderFormErrors,
  type ProviderFormState,
  type UpdateProviderField,
} from "@/components/providers/providerFormShared";
import {
  npiRegistrySourceLabel,
  npiRegistrySourcedFields,
  touchNpiRowOrigin,
  type NpiPickState,
} from "@/lib/npiRegistryFill";
import type { NpiReviewAdvisory, NpiReviewFixTarget } from "@/lib/npiRegistryReview";
import { taxonomyAfterPresetChange } from "@/lib/providerTaxonomyPreset";

export {
  emptyProviderFormState,
  type LicenseRow,
  type ProviderFormState,
} from "@/components/providers/providerFormShared";

const STEPS = [
  { id: 1, label: "Personal" },
  { id: 2, label: "Credentials" },
  { id: 3, label: "Licenses" },
  { id: 4, label: "Employment" },
  { id: 5, label: "Review" },
] as const;

function validateStep(step: number, f: ProviderFormState): ProviderFormErrors {
  if (step === 1) return validatePersonal(f);
  if (step === 2) return validateCredentials(f);
  return {};
}

// Where a review-step fix goes: the step, and the control's data-review-field.
function fixTarget(target: NpiReviewFixTarget): { step: number; field: string } {
  if (target.field === "licenseNumber") return { step: 3, field: `licenseNumber-${target.row}` };
  if (target.field === "firstName" || target.field === "credentials") {
    return { step: 1, field: target.field };
  }
  return { step: 2, field: target.field };
}

export interface ProviderFormProps {
  initial: ProviderFormState;
  submitLabel: string;
  pendingLabel: string;
  isPending: boolean;
  /** Resolves to the saved provider's id (void when the save failed). */
  onSubmit: (form: ProviderFormState) => Promise<string | void>;
  onCancel?: () => void;
}

export function ProviderForm({
  initial,
  submitLabel,
  pendingLabel,
  isPending,
  onSubmit,
  onCancel,
}: ProviderFormProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<ProviderFormState>(initial);
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  // MINT-110: the registry check never holds up a step or the save; what it
  // finds is listed on the Review step (A30, A30b). Kept here, not in
  // CredentialsSection, so a pick's summary and its trace outlive a step
  // change. `npiTouched` says which fields staff edited (only `update`, which
  // every input calls, sets it); a pick goes through applyNpi and marks
  // nothing.
  const npiPolicy = useNpiRegistryPolicy();
  const recordNpiAdvisories = useRecordNpiAdvisoriesAfterSave();
  const [npiPick, setNpiPick] = useState<NpiPickState | null>(null);
  const [npiTouched, setNpiTouched] = useState({ credentials: false, taxonomyCode: false });
  const [npiConfirmed, setNpiConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusField, setFocusField] = useState<string | null>(null);
  // A32: the preset taxonomy is the chosen group's (then the organization's,
  // then the platform's). While the field still holds the preset nobody
  // chose, a group change gives the new group's preset; a taxonomy staff
  // chose, or one a pick filled, stays.
  const taxonomyPreset = useTaxonomyPreset(form.groupId || null);
  const [appliedPreset, setAppliedPreset] = useState(initial.taxonomyCode);
  if (appliedPreset !== taxonomyPreset) {
    const nextTaxonomy = taxonomyAfterPresetChange({
      current: form.taxonomyCode,
      appliedPreset,
      nextPreset: taxonomyPreset,
      touched: npiTouched.taxonomyCode,
      pickWrote: npiPick?.trace.taxonomyCode?.written ?? null,
    });
    setAppliedPreset(taxonomyPreset);
    if (nextTaxonomy !== null) setForm((f) => ({ ...f, taxonomyCode: nextTaxonomy }));
  }
  // A35: values a pick filled, untouched, say "From NPI Registry, <date>".
  const npiSourced = npiRegistrySourcedFields(npiPick, {
    credentials: form.credentials,
    credentialsTouched: npiTouched.credentials,
    taxonomyCode: form.taxonomyCode,
    taxonomyTouched: npiTouched.taxonomyCode,
    licenses: form.licenses.map((row) => ({
      state: row.state,
      number: row.number,
      origin: row.npiOrigin,
    })),
  });
  const registrySource = npiPick
    ? {
        label: npiRegistrySourceLabel(npiPick.pulledAt),
        credentials: npiSourced.credentials,
        taxonomyCode: npiSourced.taxonomyCode,
      }
    : null;
  // A review-step fix: the field's step, then focus on the field.
  useEffect(() => {
    if (!focusField) return;
    const control = document.querySelector<HTMLElement>(`[data-review-field="${focusField}"]`);
    if (control) {
      control.focus();
      setFocusField(null);
    }
  }, [focusField, step]);

  const update: UpdateProviderField = (key, value) => {
    if (key === "credentials" || key === "taxonomyCode") {
      setNpiTouched((touched) => ({ ...touched, [key]: true }));
    }
    setForm((p) => ({ ...p, [key]: value }));
  };
  const applyNpi = (next: ProviderFormState, pick: NpiPickState | null) => {
    setForm(next);
    // Credentials a pick just wrote are the pick's until staff edit them.
    if (pick && pick !== npiPick && pick.trace.credentials) {
      setNpiTouched((touched) => ({ ...touched, credentials: false }));
    }
    setNpiPick(pick);
  };

  const next = () => {
    const e = validateStep(step, form);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep((s) => Math.min(5, s + 1));
  };
  const back = () => {
    setErrors({});
    setStep((s) => Math.max(1, s - 1));
  };
  const jumpTo = (s: number) => {
    setErrors({});
    setStep(s);
  };

  const submit = async () => {
    setSubmitError(null);
    const allErrors = validateAll(form);
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      // Jump back to the first step with an error so the user sees it.
      if (allErrors.firstName || allErrors.lastName || allErrors.ssnLast4 || allErrors.email) {
        setStep(1);
      } else if (allErrors.npi || allErrors.caqhId) {
        setStep(2);
      }
      return;
    }
    try {
      const savedId = await onSubmit(form);
      // The registry check may still be running: its advisories go to the
      // capture once it ends (A30), with what staff confirmed.
      if (typeof savedId === "string") {
        recordNpiAdvisories({
          recordId: savedId,
          npi: form.npi,
          verify: true,
          typed: { firstName: form.firstName, lastName: form.lastName },
          entered: reviewEntered,
          confirmed: npiConfirmed,
          policy: npiPolicy,
        });
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save provider");
    }
  };

  const handleCancel = onCancel ?? (() => navigate({ to: "/providers" }));

  const reviewEntered = {
    credentials: form.credentials,
    taxonomyCode: form.taxonomyCode,
    licenses: form.licenses.map((row) => ({ state: row.state, number: row.number })),
  };
  const fixOnReview = (target: NpiReviewFixTarget) => {
    const { step: fixStep, field } = fixTarget(target);
    setErrors({});
    setStep(fixStep);
    setFocusField(field);
  };
  // Choose the registry's value (A35: choose, edit or add — never clear and
  // type). Staff chose it, so it is theirs.
  const chooseRegistryValue = (advisory: NpiReviewAdvisory) => {
    const value = advisory.registryValue;
    const fix = advisory.fix;
    if (!value || !fix || fix === "retry") return;
    if (fix.field === "credentials") update("credentials", value);
    else if (fix.field === "taxonomyCode") update("taxonomyCode", value);
    else if (fix.field === "licenseNumber") {
      update(
        "licenses",
        form.licenses.map((row, index) =>
          index === fix.row
            ? {
                ...row,
                number: value,
                npiOrigin: touchNpiRowOrigin(row.npiOrigin, { number: true }),
              }
            : row,
        ),
      );
    }
  };

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
      </div>
      <Stepper current={step} />
      <div className="mt-6 rounded-md border border-border bg-card">
        <div className="p-6">
          {step === 1 ? (
            <PersonalSection
              form={form}
              errors={errors}
              update={update}
              registrySource={registrySource}
            />
          ) : null}
          {step === 2 ? (
            <CredentialsSection
              form={form}
              errors={errors}
              update={update}
              npi={{
                npiPick,
                touched: npiTouched,
                applyNpi,
                taxonomyPreset: appliedPreset,
                registrySource,
              }}
            />
          ) : null}
          {step === 3 ? <LicensesSection form={form} errors={errors} update={update} /> : null}
          {step === 4 ? <EmploymentSection form={form} errors={errors} update={update} /> : null}
          {step === 5 ? <ReviewStep form={form} jumpTo={jumpTo} /> : null}

          {submitError ? <p className="mt-4 text-sm text-destructive">{submitError}</p> : null}
          {step === 5 ? (
            <div className="mt-4">
              <NpiRegistryReview
                npi={form.npi}
                verify
                firstName={form.firstName}
                lastName={form.lastName}
                entered={reviewEntered}
                policy={npiPolicy}
                confirmed={npiConfirmed}
                onToggleConfirm={(id) =>
                  setNpiConfirmed((ids) => {
                    const next = new Set(ids);
                    if (!next.delete(id)) next.add(id);
                    return next;
                  })
                }
                onFix={fixOnReview}
                onUseRegistryValue={chooseRegistryValue}
                sourced={npiSourced.lines}
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-4">
          <Button variant="outline" onClick={back} disabled={step === 1}>
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>
          {step < 5 ? (
            <Button onClick={next}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={isPending}>
              {isPending ? pendingLabel : submitLabel}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = current > s.id;
        const active = current === s.id;
        return (
          <li key={s.id} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium",
                done || active
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {done ? <Check className="h-4 w-4" /> : s.id}
            </div>
            <span
              className={cn(
                "text-xs font-medium uppercase tracking-wider",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 ? <div className="mx-2 h-px flex-1 bg-border" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewStep({ form, jumpTo }: { form: ProviderFormState; jumpTo: (s: number) => void }) {
  const groups = useProviderGroups();
  const facilities = useFacilities(form.groupId || null);
  const groupName = useMemo(
    () => groups.data?.find((g) => g.id === form.groupId)?.name ?? "—",
    [groups.data, form.groupId],
  );
  const facilityNames = useMemo(() => {
    const selected = (facilities.data ?? []).filter((f) => form.facilityIds.includes(f.id));
    if (selected.length === 0) return "—";
    const primaryId = form.facilityIds[0];
    return selected.map((f) => (f.id === primaryId ? `${f.name} (primary)` : f.name)).join(", ");
  }, [facilities.data, form.facilityIds]);

  const Section = ({
    title,
    step,
    children,
  }: {
    title: string;
    step: number;
    children: React.ReactNode;
  }) => (
    <section className="rounded-md border border-border">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        <button
          type="button"
          onClick={() => jumpTo(step)}
          className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
        >
          Edit
        </button>
      </header>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 md:grid-cols-2">{children}</dl>
    </section>
  );

  const Row = ({ label, value }: { label: string; value: string | null }) => (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value && value.length > 0 ? value : "—"}</dd>
    </div>
  );

  const displayName = `${form.firstName} ${form.lastName}`.trim() || "Unnamed provider";

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Review</p>
        <p className="mt-1 text-sm font-medium text-foreground">{displayName}</p>
      </div>
      <Section title="Personal" step={1}>
        <Row label="Name" value={`${form.firstName} ${form.lastName}`.trim()} />
        <Row label="Credentials" value={form.credentials} />
        <Row label="Date of birth" value={form.dateOfBirth} />
        <Row label="SSN" value={form.ssnLast4 ? maskSsn(form.ssnLast4) : null} />
        <Row label="Email" value={form.email} />
        <Row label="Phone" value={form.phone} />
      </Section>
      <Section title="Credentials" step={2}>
        <Row label="NPI" value={form.npi} />
        <Row label="CAQH ID" value={form.isNewGrad ? "New grad" : form.caqhId} />
        <Row
          label="CAQH attested"
          value={form.caqhLastAttestedDate ? fmtDate(form.caqhLastAttestedDate) : ""}
        />
        <Row label="Taxonomy" value={form.taxonomyCode} />
      </Section>
      <Section title="Licenses" step={3}>
        <div className="md:col-span-2 space-y-1">
          {form.licenses.map((l, i) => (
            <div key={i} className="text-sm text-foreground">
              {l.state || "—"} · {l.number || "—"} · {l.type || "—"} · {fmtDate(l.issueDate)} →{" "}
              {fmtDate(l.expirationDate)}
            </div>
          ))}
        </div>
      </Section>
      <Section title="Employment" step={4}>
        <Row label="Group" value={groupName} />
        <Row label="Facilities" value={facilityNames} />
        <Row label="Specialty" value={form.specialty} />
        <Row label="Start date" value={form.startDate ? fmtDate(form.startDate) : ""} />
        <Row label="Degree" value={form.degree} />
        <Row label="School" value={form.schoolName} />
        <Row label="Graduation" value={form.graduationDate} />
      </Section>
    </div>
  );
}
