// The Onboarding card at the top of the provider record while her
// journey is open, and one line of history after Admit. Every value is derived
// in src/lib/onboardingCard.ts; this file only renders it and wires the
// actions.
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusPill, type StatusColor } from "@/components/StatusPill";
import { RecordSectionCard } from "@/components/providers/RecordSectionCard";
import { inviteErrorMessage, notifyDelivery } from "@/components/providers/inviteFeedback";
import { errorMessage } from "@/lib/dbErrors";
import { localTodayIso } from "@/hooks/useEnrollmentReadiness";
import { useProviderDocuments } from "@/hooks/useDocuments";
import { useFacilities, useStateLicensesByProvider } from "@/hooks/useLookups";
import { useProviderGroupAssignments } from "@/hooks/useProviders";
import {
  useAdmitProviderOnboarding,
  useMarkOnboardingContacted,
  useRecordOnboardingCheck,
} from "@/hooks/useProviderOnboardings";
import { useCancelProviderOnboarding, useResendProviderInvite } from "@/hooks/useProviderInvites";
import { fmtDate } from "@/lib/format";
import {
  admitLocations,
  admittedLine,
  cardPhase,
  inviteLine,
  onboardingEvents,
  progressItems,
  verificationChecks,
  waitingOnLine,
} from "@/lib/onboardingCard";
import {
  deriveStage,
  helpAwaitsContact,
  isBeforeSubmit,
  verificationSummary,
} from "@/lib/providerOnboarding";
import { cn } from "@/lib/utils";
import type { Provider, ProviderOnboardingRead } from "@/types";
import type { CheckSection, PersonCheck, VerificationCheck } from "@/types/providerOnboarding";
import { WAITING_ON_INK } from "./hireCopy";
import {
  AdmitDialog,
  CancelOnboardingDialog,
  ProblemNoteDialog,
  TestLoginDialog,
} from "./OnboardingDialogs";
import { ResendButton } from "./ResendButton";
import { StageTracker } from "./StageTracker";

const STATUS_PILL: Record<VerificationCheck["status"], { tone: StatusColor; label: string }> = {
  confirmed: { tone: "green", label: "Confirmed" },
  pending: { tone: "amber", label: "Pending" },
  problem: { tone: "red", label: "Problem" },
};

const SECTION_LABEL: Record<CheckSection, string> = {
  identity: "Provider Info",
  licenses: "Licenses",
  documents: "Documents",
};

type Dialog =
  | { kind: "cancel" }
  | { kind: "admit" }
  | { kind: "test"; check: PersonCheck; portal: NonNullable<PersonCheck["portal"]> }
  | { kind: "problem"; check: PersonCheck };

export function OnboardingCard({
  provider,
  read,
  canWrite,
  isAdmin,
}: {
  provider: Provider;
  read: ProviderOnboardingRead;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const facilitiesQ = useFacilities();
  if (cardPhase(read) === "admitted") {
    const location = (facilitiesQ.data ?? []).find((f) => f.id === read.journey.admittedFacilityId);
    return (
      <section
        id="onboarding"
        aria-label="Onboarding"
        className="flex flex-wrap items-center gap-2 rounded-md border border-[#E8E5E0] bg-white px-5 py-3 text-[13px]"
      >
        <span className="font-semibold">Onboarding</span>
        <span className="text-muted-foreground">{admittedLine(read, location?.name ?? null)}</span>
      </section>
    );
  }
  return (
    <OpenOnboardingCard provider={provider} read={read} canWrite={canWrite} isAdmin={isAdmin} />
  );
}

function OpenOnboardingCard({
  provider,
  read,
  canWrite,
  isAdmin,
}: {
  provider: Provider;
  read: ProviderOnboardingRead;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const licensesQ = useStateLicensesByProvider(provider.id);
  const documentsQ = useProviderDocuments(provider.id);
  const facilitiesQ = useFacilities();
  const groupAssignQ = useProviderGroupAssignments();
  const resend = useResendProviderInvite();
  const cancel = useCancelProviderOnboarding();
  const contacted = useMarkOnboardingContacted();
  const recordCheck = useRecordOnboardingCheck();
  const admit = useAdmitProviderOnboarding();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const name = provider.firstName;
  const journey = read.journey;
  const events = onboardingEvents(read);
  const stage = deriveStage(events);
  const waiting = waitingOnLine(journey, events, name);
  const beforeSubmit = isBeforeSubmit(stage);
  const licenses = licensesQ.data ?? [];
  const checks = verificationChecks({
    read,
    provider,
    licenses,
    documents: documentsQ.data ?? [],
    today: localTodayIso(),
  });
  const summary = verificationSummary(checks);
  const attention = checks.filter((c) => c.status !== "confirmed");
  const confirmed = checks.filter((c) => c.status === "confirmed");

  async function onResend() {
    try {
      const { delivery, email } = await resend.mutateAsync(provider.id);
      notifyDelivery(delivery, `Invitation sent to ${email}`);
    } catch (err) {
      toast.error(inviteErrorMessage(err, "The invitation couldn't be resent."));
    }
  }

  async function onContacted() {
    try {
      await contacted.mutateAsync(journey.id);
      toast.success(`Marked ${name} contacted`);
    } catch (err) {
      toast.error(errorMessage(err, "That couldn't be saved. Try again."));
    }
  }

  async function record(check: PersonCheck, outcome: "confirmed" | "problem", note: string | null) {
    await recordCheck.mutateAsync({
      onboardingId: journey.id,
      checkKey: check.key,
      outcome,
      note,
    });
    setDialog(null);
    toast.success(
      outcome === "confirmed" ? `${check.label}: confirmed` : `${check.label}: problem noted`,
    );
  }

  async function onConfirmCheck(check: PersonCheck) {
    try {
      await record(check, "confirmed", null);
    } catch (err) {
      toast.error(errorMessage(err, "That couldn't be saved. Try again."));
    }
  }

  const renderActions = (check: VerificationCheck) => (
    <CheckActions
      check={check}
      providerId={provider.id}
      canWrite={canWrite}
      isAdmin={isAdmin}
      onConfirm={onConfirmCheck}
      onDialog={setDialog}
    />
  );

  const actions = canWrite ? (
    <div className="flex flex-wrap items-center gap-2">
      {beforeSubmit ? (
        <ResendButton
          events={events}
          now={new Date()}
          label="Resend invitation"
          pending={resend.isPending}
          size="sm"
          className="h-8"
          onResend={onResend}
        />
      ) : null}
      {helpAwaitsContact(events) ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onContacted}
          disabled={contacted.isPending}
        >
          Mark contacted
        </Button>
      ) : null}
      {beforeSubmit ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-[var(--mp-danger-ink)]"
          onClick={() => setDialog({ kind: "cancel" })}
        >
          Cancel invitation
        </Button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <RecordSectionCard id="onboarding" title="Onboarding" action={actions}>
      <div className="space-y-4">
        <StageTracker stage={stage} waitingOn={waiting.who} showLabels />

        <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Waiting on</dt>
          <dd>
            <span className={cn("font-semibold", WAITING_ON_INK[waiting.who])}>
              {waiting.label}
            </span>
            {` · ${waiting.detail}`}
          </dd>
          <dt className="text-muted-foreground">Invited</dt>
          <dd>
            {inviteLine(read)}
            {read.invite?.delivery === "failed" ? (
              <span className="text-[var(--mp-danger-ink)]"> · the last email didn't send</span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Record</dt>
          <dd>
            {journey.createdRecord
              ? "Created by this invitation"
              : "Existing record, invited to fill gaps"}
          </dd>
          {beforeSubmit ? (
            <>
              <dt className="text-muted-foreground">Saved so far</dt>
              <dd>{progressItems(read).join(" · ")}</dd>
            </>
          ) : null}
        </dl>

        {beforeSubmit ? null : (
          <div className="space-y-2 border-t border-[var(--mp-border-subtle)] pt-4">
            <h3 className="text-[13px] font-semibold">
              Verification{" "}
              <span className="font-normal text-muted-foreground">
                {summary.confirmed} of {summary.total} confirmed
                {summary.problem > 0
                  ? ` · ${summary.problem} ${summary.problem === 1 ? "problem" : "problems"}`
                  : ""}
                {summary.pending > 0 ? ` · ${summary.pending} pending` : ""}
              </span>
            </h3>
            {attention.length > 0 ? (
              <CheckTable checks={attention} renderActions={renderActions} />
            ) : null}
            {confirmed.length > 0 ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer text-muted-foreground">
                  {confirmed.length} confirmed
                </summary>
                <div className="mt-2">
                  <CheckTable checks={confirmed} renderActions={renderActions} />
                </div>
              </details>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--mp-border-subtle)] pt-4">
          <p className="max-w-[640px] text-[13px] text-muted-foreground">
            {beforeSubmit
              ? `Admit & assign opens once ${name} submits.`
              : `Admit confirms the record, assigns a location, and marks ${name} ready for credentialing.`}
          </p>
          {canWrite ? (
            <Button
              size="sm"
              className="h-8"
              disabled={beforeSubmit}
              onClick={() => setDialog({ kind: "admit" })}
            >
              Admit & assign
            </Button>
          ) : null}
        </div>
      </div>

      {dialog?.kind === "cancel" ? (
        <CancelOnboardingDialog
          firstName={name}
          createdRecord={journey.createdRecord}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const { outcome } = await cancel.mutateAsync(provider.id);
            setDialog(null);
            if (outcome === "deleted") {
              toast.success(`Invitation cancelled. ${name}'s record was removed.`);
              navigate({ to: "/providers" });
            } else {
              toast.success(
                `Invitation cancelled. ${name}'s record was kept; what ${name} entered was removed.`,
              );
            }
          }}
        />
      ) : null}
      {dialog?.kind === "admit" ? (
        <AdmitDialog
          firstName={name}
          locations={
            facilitiesQ.isPending || groupAssignQ.isPending
              ? null
              : admitLocations(facilitiesQ.data ?? [], groupAssignQ.data ?? [], provider.id)
          }
          licenseStates={licenses.map((l) => l.state)}
          openChecks={attention.map((c) => c.label)}
          onClose={() => setDialog(null)}
          onAdmit={async (location) => {
            await admit.mutateAsync({ onboardingId: journey.id, facilityId: location.id });
            setDialog(null);
            toast.success(`${name} was admitted and assigned to ${location.name}.`);
          }}
        />
      ) : null}
      {dialog?.kind === "test" ? (
        <TestLoginDialog
          providerId={provider.id}
          portal={dialog.portal.key}
          portalName={dialog.portal.name}
          onClose={() => setDialog(null)}
          onRecord={(outcome, note) => record(dialog.check, outcome, note)}
        />
      ) : null}
      {dialog?.kind === "problem" ? (
        <ProblemNoteDialog
          checkLabel={dialog.check.label}
          onClose={() => setDialog(null)}
          onSave={(note) => record(dialog.check, "problem", note)}
        />
      ) : null}
    </RecordSectionCard>
  );
}

function CheckTable({
  checks,
  renderActions,
}: {
  checks: VerificationCheck[];
  renderActions: (check: VerificationCheck) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-[#E8E5E0]">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-[#F0EEE9] bg-[#FAFAF9] text-[12px] text-muted-foreground">
            <th className="px-3 py-2 font-medium">Check</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">By</th>
            <th className="px-3 py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.key} className="border-b border-[#F0EEE9] last:border-0">
              <td className="px-3 py-2">
                <div>{c.label}</div>
                {c.detail ? (
                  <div className="text-[12px] text-muted-foreground">{c.detail}</div>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <StatusPill
                  status={STATUS_PILL[c.status].tone}
                  label={STATUS_PILL[c.status].label}
                />
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {c.method === "auto"
                  ? "Auto"
                  : c.confirmedBy
                    ? `${c.confirmedBy} · ${fmtDate(c.checkedAt)}`
                    : "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap justify-end gap-1.5">{renderActions(c)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckActions({
  check,
  providerId,
  canWrite,
  isAdmin,
  onConfirm,
  onDialog,
}: {
  check: VerificationCheck;
  providerId: string;
  canWrite: boolean;
  isAdmin: boolean;
  onConfirm: (check: PersonCheck) => Promise<void>;
  onDialog: (dialog: Dialog) => void;
}) {
  const small = "h-7 px-2.5 text-[12px] font-normal";
  // Held from the click itself, so a second click before the write lands
  // finds the button disabled. The mutation's own pending flag arrives a tick
  // later, after a double click's second click.
  const [confirming, setConfirming] = useState(false);
  async function confirm(person: PersonCheck) {
    setConfirming(true);
    try {
      await onConfirm(person);
    } finally {
      setConfirming(false);
    }
  }
  if (check.method === "auto") {
    if (check.status === "confirmed" || !check.section) return null;
    return (
      <Link
        to="/providers/$id"
        params={{ id: providerId }}
        hash={check.section}
        className="whitespace-nowrap text-[12px] text-primary underline underline-offset-2"
      >
        Open {SECTION_LABEL[check.section]}
      </Link>
    );
  }
  if (!canWrite) return null;
  const { portal } = check;
  return (
    <>
      {check.action === "test_login" && portal && isAdmin ? (
        <Button
          variant="outline"
          className={small}
          aria-label={`Test ${portal.name} login`}
          onClick={() => onDialog({ kind: "test", check, portal })}
        >
          Test…
        </Button>
      ) : null}
      {check.status !== "confirmed" ? (
        <Button
          variant="outline"
          className={small}
          disabled={confirming}
          onClick={() => void confirm(check)}
        >
          Confirm
        </Button>
      ) : null}
      {check.status !== "problem" ? (
        <Button
          variant="outline"
          className={small}
          onClick={() => onDialog({ kind: "problem", check })}
        >
          Mark problem
        </Button>
      ) : null}
    </>
  );
}
