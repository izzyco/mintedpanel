// MINT-107 — the read-only view of one purpose's notification sequence, for
// members who are not admins. Specialists and billing members are the people
// these messages go to or cc, so they can see the schedule; only admins can
// change it (RLS enforces the same split). It shows the effective sequence:
// the org's own values, and Minted's default, marked as such, wherever the
// org left one unset.
import {
  COORDINATORS_ONLY_NOTE,
  PLATFORM_DEFAULT_LABEL,
  PURPOSE_RULES,
  STOP_CONDITION_LABELS,
  describeCcList,
  describeDigestSchedule,
  describeStep,
  resolveNotificationSequence,
  type CcMemberOption,
  type NotificationSequenceConfig,
  type NotificationSequenceDefaultConfig,
} from "@/lib/notificationSequences";

const DEFAULT_SUFFIX = ` (${PLATFORM_DEFAULT_LABEL})`;

export function NotificationSequenceSummary({
  config,
  platformDefault,
  members,
  membersLoaded = true,
}: {
  config: NotificationSequenceConfig;
  platformDefault: NotificationSequenceDefaultConfig;
  members: ReadonlyMap<string, CcMemberOption>;
  /** False while the member list is loading or failed: no "Former member" yet. */
  membersLoaded?: boolean;
}) {
  const rules = PURPOSE_RULES[config.purpose];
  const effective = resolveNotificationSequence(config.purpose, config, platformDefault);
  const mark = (inherited: boolean) => (inherited ? DEFAULT_SUFFIX : "");
  const schedule = describeDigestSchedule(effective);
  return (
    <div className="space-y-3 text-[13px] text-foreground">
      {effective.inherited.steps ? (
        <div className="text-[12px] text-muted-foreground">{`${PLATFORM_DEFAULT_LABEL} steps`}</div>
      ) : null}
      <ol className="space-y-2">
        {effective.steps.map((step) => (
          <li key={step.position} className="rounded-md border border-[var(--mp-border)] px-3 py-2">
            <div className="font-medium">
              {describeStep(config.purpose, step, effective.digestFrequency ?? undefined)}
            </div>
            {effective.ccAllowed ? (
              <div className="text-[12px] text-muted-foreground">
                Cc: {describeCcList(step.ccRecipients, members, membersLoaded)}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {rules.hasIntakeSettings ? (
        <dl className="space-y-1 text-[13px]">
          <div>
            <dt className="inline text-muted-foreground">Target: </dt>
            <dd className="inline">
              {`${effective.targetDaysToReady} days from invite to ready${mark(effective.inherited.targetDaysToReady)}`}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Stops when: </dt>
            <dd className="inline">
              {`${effective.stopConditions
                .map((c) => STOP_CONDITION_LABELS[c].toLowerCase())
                .join("; ")}${mark(effective.inherited.stopConditions)}`}
            </dd>
          </div>
        </dl>
      ) : null}
      {rules.hasSendTime && schedule ? <p>{schedule}</p> : null}
      {!effective.ccAllowed ? (
        <p className="text-[12px] text-muted-foreground">{COORDINATORS_ONLY_NOTE}</p>
      ) : null}
    </div>
  );
}
