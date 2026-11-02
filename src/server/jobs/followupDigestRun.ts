// The coordinator follow-up digest (MINT-108): the run behind
// GET /api/jobs/followup-digest (./followupDigest.ts), called every hour by
// the GitHub Actions tick, plus a daily Vercel cron as a backup.
//
// Each run:
//   1. Discovery, the one cross-org read: every org whose followup_digest
//      sequence is on, with its own steps, and Minted's default
//      (listEnabledNotificationSequences). resolveNotificationSequence gives
//      each org's effective sequence: its schedule (frequency, weekday, send
//      hour, zone and second hour, A8, A10) and its step.
//   2. The hour gate (digestSlot, src/lib/followUpDigest.ts). An org whose
//      digest Minted has not set up (no schedule; G2, there is no default)
//      is not due. Otherwise it is due while one of its scheduled sends is
//      open: from that send's hour until the next send's hour, or for the
//      day's last send until the catch-up cut-off (local midnight by
//      default, D77). A weekly digest is scheduled only on its weekday, in
//      the org's zone. The local date is
//      the digest's "today"; the scheduled send's slot is that date, or
//      `date:2` for twice a day's second send. Nothing of an org that is not
//      due is read.
//   3. The step's template_key must pass the consumer contract
//      (templateSendProblem) and have a body here. Otherwise the org's
//      coordinators are skipped, with no fallback digest (U6): counted and
//      logged, one line each run.
//   4. Read the org's name, members, open cases and touchpoints
//      (src/services/followUpDigest.ts), each scoped to the org, and plan the
//      digests (planFollowUpDigests): one per coordinator with something due.
//      Unassigned follow-ups go to no one and are counted.
//   5. For each digest, claim (job, slot, org, recipient) in
//      notification_sends, send followup_digest_daily through sendEmail, and
//      record the send sent or failed. A recipient already sent, or claimed
//      by an attempt that may have delivered, is skipped: that unique claim
//      alone keeps anyone from getting a scheduled send twice, however many
//      runs see the org while its send is open.
//
// Failures. One recipient's failed send or one org's failed read never stops
// the rest; each is logged (one line) and counted, and the run still answers
// its counts. The next hourly run, while the send is open, plans the org
// again: a definitely rejected send (a SendGrid 4xx other than 408, invalid
// input, misconfiguration) was marked failed and is claimed and sent again; a
// send that may have been delivered (a network error, a timeout, a SendGrid
// 5xx or 408, an unexplained error) stayed claimed and is never resent.
// Missing configuration (the SendGrid env, or an APP_BASE_URL that is not a
// bare origin) and a failed discovery read throw, so the run fails.
//
// Edges, by design (D78). A day's last send at 23:00 is due in one hourly
// tick only (the next is the next local date), so it gets one attempt. A
// twice-a-day first send still unmade at the second hour is not made: the
// second carries the same list. A zone change can move an org's local date:
// westward across the date line (Honolulu to Tokyo, say) a local date can be
// skipped; eastward the org can get a digest for an earlier date a few hours
// after the last. A frequency change takes effect at the next run, and the day's
// sends made so far keep their slots. A slot the new frequency names that the
// old one didn't is new: switching a twice-a-day org to daily after its 2 pm
// send (slot D:2) can still send slot D that day.
//
// Logging: ctx.log.error only, with closed snake_case events. Nothing here
// logs an address, a name, a case, a date or a count.
//
// Bypassed checks (MINT-134). Server-side only; nothing reaches the front
// end. Four findings are recorded through #568's job helper
// (recordJobAdvisory, src/server/advisories.ts), at the severity the
// registry fixes (src/lib/advisoryChecks.ts):
//   * digest.step_unusable (the organization; the step problem and the
//     sequence) when the org is skipped for its step (U6);
//   * digest.recipient_no_email (the coordinator's membership) when a
//     coordinator with something due has no usable address;
//   * digest.org_failed (the organization) when the org's reads fail;
//   * digest.unassigned_follow_ups (the organization; how many) when
//     follow-ups due went to no one.
// The two critical ones (recipient_no_email, org_failed: factual accuracy)
// record as `block`, a digest that was stopped; the others as `advisory`.
// Each is recorded on every run that finds it, and record_job_advisory keeps
// one open row per (org, check, record): a repeat while the row is open
// writes nothing, so later hourly runs add nothing. Each is resolved here
// (resolve_workflow_advisories), so a later recurrence records a new row:
//   * the step row whenever a due org's step passes the check again (at most
//     one call per due org per run);
//   * a coordinator's no-email row once they are sent a digest;
//   * the org-failed row, and the unassigned row when nothing is unassigned,
//     once the org sends a digest: its reads worked and its count is current,
//     once per scheduled send rather than every hour.
// A record or resolve never throws and never holds a send: none is awaited
// on its own. The run starts them all and awaits them together at the end
// (Promise.allSettled); each gives up after ADVISORY_RPC_TIMEOUT_MS, so
// together they add at most that to the run. A failure is one safe line
// (advisory_record_failed or advisory_resolve_failed), and the run carries on.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  digestSlot,
  planFollowUpDigests,
  resolveFollowUpDigestRules,
  type FollowUpDigestRules,
} from "@/lib/followUpDigest";
import {
  resolveNotificationSequence,
  type EffectiveNotificationSequence,
  type EffectiveStep,
} from "@/lib/notificationSequences";
import { templateSendProblem, type TemplateSendProblem } from "@/lib/notificationTemplates";
import { loadFollowUpDigestOrgData } from "@/services/followUpDigest";
import { listEnabledNotificationSequences } from "@/services/notificationSequences";
import { recordJobAdvisory, resolveAdvisories } from "../advisories";
import { resolveEmailEnv } from "../email/env";
import {
  EmailError,
  isEmailAddress,
  sendEmail,
  type SendEmailInput,
  type SendEmailResult,
} from "../email/sendgrid";
import type { TemplateKey } from "../email/templates";
import { resolveAppBaseUrl } from "../providerIntakeRoutes";
import {
  FOLLOWUP_DIGEST_COUNT_KEYS,
  FOLLOWUP_DIGEST_JOB_NAME,
  type FollowUpDigestCounts,
} from "./followupDigest";
import {
  supabaseNotificationSendLedger,
  type NotificationSendKey,
  type NotificationSendLedger,
} from "./notificationSends";
import type { JobContext, JobLogger } from "./types";

/** The one digest body src/server/email/templates.ts registers. */
export const DIGEST_EMAIL_TEMPLATE = "followup_digest_daily" satisfies TemplateKey;

type DigestTemplate = typeof DIGEST_EMAIL_TEMPLATE;

// Thrown or logged values whose class name is the whole log line's explanation.
export class FollowUpDigestNotConfiguredError extends Error {
  override name = "FollowUpDigestNotConfiguredError";
}
export class FollowUpDigestTemplateError extends Error {
  override name = "FollowUpDigestTemplateError";
}
export class FollowUpDigestRecipientError extends Error {
  override name = "FollowUpDigestRecipientError";
}
export class NotificationSendFinishLostError extends Error {
  override name = "NotificationSendFinishLostError";
}

export interface FollowUpDigestConfig {
  /** The bare origin case links point at, or null when unusable. */
  appBaseUrl: string | null;
  /** The reply-to: no person sends the digest. */
  fromEmail: string | null;
  emailReady: boolean;
}

/** APP_BASE_URL through the same check the provider invite links use. */
export function resolveFollowUpDigestConfig(): FollowUpDigestConfig {
  const email = resolveEmailEnv();
  return {
    appBaseUrl: resolveAppBaseUrl(process.env.APP_BASE_URL, Boolean(import.meta.env.DEV)),
    fromEmail: email.fromEmail ?? null,
    emailReady: Boolean(email.apiKey && email.fromEmail),
  };
}

export interface FollowUpDigestDeps {
  config: () => FollowUpDigestConfig;
  send: (input: SendEmailInput<DigestTemplate>) => Promise<SendEmailResult>;
  ledger: (db: SupabaseClient<Database>) => NotificationSendLedger;
  /** One org's resolved digest rules (resolveFollowUpDigestRules). Nothing
   *  stores an override yet, so every org gets the decided default; Mission
   *  Control (MINT-113) carries overrides on the discovery read. */
  rules: (orgId: string) => FollowUpDigestRules;
}

const DEFAULT_DEPS: FollowUpDigestDeps = {
  config: resolveFollowUpDigestConfig,
  send: (input) => sendEmail(input),
  ledger: supabaseNotificationSendLedger,
  rules: () => resolveFollowUpDigestRules(),
};

export type DigestStepProblem =
  TemplateSendProblem | "no_step" | "several_steps" | "not_registered";

/** Why an org's effective digest step cannot be sent, or null. */
export function digestStepProblem(
  steps: readonly Pick<EffectiveStep, "templateKey" | "channel">[],
): DigestStepProblem | null {
  if (steps.length === 0) return "no_step";
  if (steps.length > 1) return "several_steps";
  const [step] = steps;
  const problem = templateSendProblem("followup_digest", step.templateKey, step.channel);
  if (problem) return problem;
  return step.templateKey === DIGEST_EMAIL_TEMPLATE ? null : "not_registered";
}

function zeroCounts(): FollowUpDigestCounts {
  return Object.fromEntries(
    FOLLOWUP_DIGEST_COUNT_KEYS.map((key) => [key, 0]),
  ) as FollowUpDigestCounts;
}

/** True only when the mailer's error proves nothing was accepted: it was
 *  misconfigured or the input invalid (both before any request), or SendGrid
 *  answered a 4xx other than 408 (429 included). A network error or timeout,
 *  a 5xx or 408 (SendGrid's edge may have accepted the message) and an error
 *  the mailer did not classify may have been delivered. */
export function isDefiniteRejection(error: unknown): error is EmailError {
  if (!(error instanceof EmailError)) return false;
  if (error.kind === "misconfigured" || error.kind === "invalid_input") return true;
  const status = error.status;
  return (
    error.kind === "provider_rejected" && status !== undefined && status < 500 && status !== 408
  );
}

async function record(
  log: JobLogger,
  ledger: NotificationSendLedger,
  key: NotificationSendKey,
  outcome: "sent" | "failed",
): Promise<void> {
  try {
    if (!(await ledger.finish(key, outcome))) {
      log.error("send_unrecorded", new NotificationSendFinishLostError());
    }
  } catch (error) {
    // The row stays claimed: a sent email is never resent, and a rejected one
    // is not retried for this scheduled send.
    log.error("send_unrecorded", error);
  }
}

/** Claim, send, record. "skipped" when the send is already sent or claimed. */
async function deliver(
  log: JobLogger,
  deps: FollowUpDigestDeps,
  ledger: NotificationSendLedger,
  key: NotificationSendKey,
  input: SendEmailInput<DigestTemplate>,
): Promise<"sent" | "skipped" | "failed"> {
  try {
    if (!(await ledger.claim(key))) return "skipped";
  } catch (error) {
    // No claim, no send: the claim is what keeps a later run from resending.
    log.error("send_claim_failed", error);
    return "failed";
  }

  try {
    await deps.send(input);
  } catch (error) {
    if (!isDefiniteRejection(error)) {
      // It may have been delivered: leave the claim, so it is never resent.
      log.error(`send_uncertain_${error instanceof EmailError ? error.kind : "error"}`, error);
      return "failed";
    }
    log.error(`send_failed_${error.kind}`, error);
    // Nothing was accepted: mark it failed, so a later run may send it.
    await record(log, ledger, key, "failed");
    return "failed";
  }
  await record(log, ledger, key, "sent");
  return "sent";
}

/** A due org: its sequence row and effective sequence, the local date of the
 *  run, and the open scheduled send's slot. */
interface DueOrg {
  orgId: string;
  sequenceId: string;
  sequence: EffectiveNotificationSequence;
  localDate: string;
  slot: string;
}

async function runOrg(
  ctx: JobContext,
  deps: FollowUpDigestDeps,
  ledger: NotificationSendLedger,
  config: { appBaseUrl: string; fromEmail: string },
  org: DueOrg,
  counts: FollowUpDigestCounts,
  advisories: Promise<unknown>[],
): Promise<void> {
  const self = { table: "organizations", id: org.orgId } as const;
  const problem = digestStepProblem(org.sequence.steps);
  if (problem) {
    // U6: no fallback digest.
    counts.orgs_skipped_template += 1;
    ctx.log.error(`org_skipped_${problem}`, new FollowUpDigestTemplateError());
    advisories.push(
      recordJobAdvisory(ctx.db, FOLLOWUP_DIGEST_JOB_NAME, org.orgId, "digest.step_unusable", self, {
        problem,
        sequence_id: org.sequenceId,
      }),
    );
    return;
  }
  advisories.push(resolveAdvisories(ctx.db, org.orgId, "digest.step_unusable", self));

  const data = await loadFollowUpDigestOrgData({ db: ctx.db }, org.orgId);
  const plan = planFollowUpDigests({
    practiceName: data.practiceName,
    today: org.localDate,
    appBaseUrl: config.appBaseUrl,
    cases: data.cases,
    touchpoints: data.touchpoints,
    members: data.members,
  });
  counts.digests_suppressed += plan.suppressed;
  counts.unassigned_follow_ups += plan.unassignedFollowUps;
  if (plan.unassignedFollowUps > 0) {
    advisories.push(
      recordJobAdvisory(
        ctx.db,
        FOLLOWUP_DIGEST_JOB_NAME,
        org.orgId,
        "digest.unassigned_follow_ups",
        self,
        { count: plan.unassignedFollowUps },
      ),
    );
  }

  let sentAny = false;
  for (const digest of plan.digests) {
    const coordinator = { table: "memberships", id: digest.membershipId } as const;
    const to = digest.email?.trim() ?? "";
    if (!isEmailAddress(to)) {
      ctx.log.error("recipient_skipped_no_email", new FollowUpDigestRecipientError());
      advisories.push(
        recordJobAdvisory(
          ctx.db,
          FOLLOWUP_DIGEST_JOB_NAME,
          org.orgId,
          "digest.recipient_no_email",
          coordinator,
          { recipient_id: digest.recipientUserId },
        ),
      );
      continue;
    }
    const outcome = await deliver(
      ctx.log,
      deps,
      ledger,
      {
        job: FOLLOWUP_DIGEST_JOB_NAME,
        orgId: org.orgId,
        slot: org.slot,
        recipientUserId: digest.recipientUserId,
      },
      {
        to,
        template: DIGEST_EMAIL_TEMPLATE,
        data: digest.data,
        practiceName: data.practiceName,
        replyTo: { email: config.fromEmail },
      },
    );
    if (outcome === "sent") {
      counts.digests_sent += 1;
      sentAny = true;
      advisories.push(
        resolveAdvisories(ctx.db, org.orgId, "digest.recipient_no_email", coordinator),
      );
    } else if (outcome === "failed") counts.send_failures += 1;
  }
  // A digest went out: the org's reads worked, and its unassigned count is
  // current. Once per scheduled send, not every hour.
  if (sentAny) {
    advisories.push(resolveAdvisories(ctx.db, org.orgId, "digest.org_failed", self));
    if (plan.unassignedFollowUps === 0) {
      advisories.push(resolveAdvisories(ctx.db, org.orgId, "digest.unassigned_follow_ups", self));
    }
  }
}

export async function runFollowUpDigest(
  ctx: JobContext,
  overrides: Partial<FollowUpDigestDeps> = {},
): Promise<FollowUpDigestCounts> {
  const deps: FollowUpDigestDeps = { ...DEFAULT_DEPS, ...overrides };
  const counts = zeroCounts();

  // Before the MINT-107 migration is applied no org can have the digest on.
  const discovery = await listEnabledNotificationSequences({ db: ctx.db }, "followup_digest");
  if (discovery.status === "unavailable") return counts;

  const due: DueOrg[] = [];
  for (const row of discovery.sequences) {
    const sequence = resolveNotificationSequence("followup_digest", row, discovery.platformDefault);
    if (!sequence.enabled) continue;
    // Null when Minted has not set the digest up (G2); not due before the
    // send hour, on a weekly digest's other days, or past the cut-off.
    const slot = digestSlot(sequence, ctx.now, deps.rules(row.orgId));
    if (!slot?.due) continue;
    due.push({
      orgId: row.orgId,
      sequenceId: row.id,
      sequence,
      localDate: slot.localDate,
      slot: slot.slot,
    });
  }
  counts.orgs_due = due.length;
  if (due.length === 0) return counts;

  const config = deps.config();
  if (!config.emailReady || !config.appBaseUrl || !config.fromEmail) {
    throw new FollowUpDigestNotConfiguredError();
  }
  const ready = { appBaseUrl: config.appBaseUrl, fromEmail: config.fromEmail };
  const ledger = deps.ledger(ctx.db);
  // Every advisory call of the run, in flight together; none throws.
  const advisories: Promise<unknown>[] = [];
  for (const org of due) {
    try {
      await runOrg(ctx, deps, ledger, ready, org, counts, advisories);
    } catch (error) {
      counts.orgs_failed += 1;
      ctx.log.error("org_failed", error);
      advisories.push(
        recordJobAdvisory(ctx.db, FOLLOWUP_DIGEST_JOB_NAME, org.orgId, "digest.org_failed", {
          table: "organizations",
          id: org.orgId,
        }),
      );
    }
  }
  // Each gives up after ADVISORY_RPC_TIMEOUT_MS, so this waits at most that.
  await Promise.allSettled(advisories);
  return counts;
}
