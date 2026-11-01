// NPI Registry (NPPES) help under a provider's NPI field — MINT-110. Two jobs:
//   1. Verify: once the NPI passes the check digit, say whether the registry
//      has it and whether the name staff typed matches. Under the default
//      policy every outcome is a note, never an error. An organization's
//      policy (src/lib/npiRegistryPolicy) may make an outcome block; the note
//      then reads as an error and the form refuses the save. The registry
//      being down never stops a save.
//   2. Search: look up individuals by the form's first and last name (plus an
//      optional state) and let staff pick one. Picking sets the NPI and, under
//      the default policy, fills the form's blank fields the registry can
//      supply (the form decides, via src/lib/npiRegistryFill.ts); a value of
//      staff's is never replaced, and a second pick replaces the first pick's
//      data. What was filled, cleared and kept, the licenses staff may add,
//      and the registry data no field holds are shown under the search and
//      announced once. The form owns the pick, so it outlives a step change.
// Used by Add Provider (ProviderFormSections) and the roster form; the check
// note alone (NpiRegistryCheckNote) is also on the provider record's inline
// edit. Composition of stock primitives, logged in DESIGN-DEBT.md.
import { Fragment, useId, useRef, useState, type KeyboardEvent } from "react";
import { CircleCheck, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateSelect } from "@/components/StateSelect";
import {
  useNpiRegistryCheck,
  useNpiRegistrySearch,
  usePrimeNpiRegistryLookup,
} from "@/hooks/useNpiRegistry";
import {
  npiFillAnnouncement,
  npiFillClearedText,
  npiFillFilledText,
  npiFillKeptText,
  npiFillOffersText,
  npiFillStaleText,
  type NpiFillSummary,
  type NpiLicenseOffer,
  type NpiPickState,
} from "@/lib/npiRegistryFill";
import {
  npiRegistryErrorMessage,
  npiSearchStatusText,
  registryDisplayName,
  validateNpiRegistrySearch,
  type NpiRegistryRecord,
  type NpiRegistrySearchInput,
  type NpiSearchState,
  type NpiVerificationView,
} from "@/lib/npiRegistry";
import type { NpiRegistryPolicy } from "@/lib/npiRegistryPolicy";
import { cn } from "@/lib/utils";

/** The verification line. Not a live region: the NPI input points at it with
 * aria-describedby, and NpiRegistryAssist announces result changes itself. */
export function NpiVerificationNotice({
  id,
  view,
}: {
  id: string;
  view: NpiVerificationView | null;
}) {
  return (
    <div id={id} className="text-[12px]">
      {view ? (
        <div className="flex items-start gap-1.5">
          {view.tone === "ok" ? (
            <CircleCheck
              aria-hidden="true"
              className="mt-px h-4 w-4 shrink-0 text-[var(--mp-ok-ink)]"
            />
          ) : view.tone === "warn" ? (
            <TriangleAlert
              aria-hidden="true"
              className="mt-px h-4 w-4 shrink-0 text-[var(--mp-warn-ink)]"
            />
          ) : null}
          <p>
            <span
              className={cn(
                "font-medium",
                view.tone === "warn" ? "text-[var(--mp-warn-ink)]" : "text-foreground",
              )}
            >
              {view.title}
            </span>
            {view.detail ? <span className="text-muted-foreground"> {view.detail}</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Up/Down/Home/End move between the result buttons; Enter or Space picks.
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
  if (buttons.length === 0) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next = 0;
  if (event.key === "End") next = buttons.length - 1;
  else if (event.key === "ArrowDown")
    next = current < 0 ? 0 : Math.min(buttons.length - 1, current + 1);
  else if (event.key === "ArrowUp") next = current <= 0 ? 0 : current - 1;
  buttons[next]?.focus();
}

/** The picked-from list: one button per individual. Each button's name is
 * its visible text (name first, so it matches what sighted users read and say
 * — WCAG 2.5.3), plus hidden context for screen readers. */
export function NpiRegistryResultList({
  results,
  onPick,
}: {
  results: NpiRegistryRecord[];
  onPick: (record: NpiRegistryRecord) => void;
}) {
  if (results.length === 0) return null;
  return (
    <ul
      aria-label="NPI Registry matches"
      onKeyDown={moveFocus}
      className="divide-y divide-border rounded-md border border-border"
    >
      {results.map((record) => (
        <li key={record.npi}>
          <button
            type="button"
            onClick={() => onPick(record)}
            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          >
            <span className="flex w-full items-baseline justify-between gap-2">
              <span className="font-medium text-foreground">
                {registryDisplayName(record)}
                {record.credential ? `, ${record.credential}` : ""}
              </span>{" "}
              <span className="font-mono text-[12px] text-muted-foreground">
                <span className="sr-only">NPI </span>
                {record.npi}
              </span>
            </span>{" "}
            <span className="text-[12px] text-muted-foreground">
              {[
                record.primaryTaxonomy?.description,
                [record.practiceCity, record.practiceState].filter(Boolean).join(", "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="sr-only">, use this NPI</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Something said once through the check note's polite live region: a pick
 * (with the check it causes) or a license staff added. A new `key` is a new
 * thing to say. */
export interface NpiAnnouncement {
  key: string;
  text: string;
  /** Say the check's note after it (a pick changes the NPI). */
  withCheck: boolean;
}

export interface NpiRegistryCheckNoteProps {
  /** The note's id; the NPI input names it in aria-describedby. */
  noticeId: string;
  /** The NPI with separators stripped. */
  npi: string;
  /** False while an edit form still holds the stored NPI: an unchanged NPI is
   * not re-checked (the same rule as the MINT-7 check digit). */
  verify: boolean;
  firstName: string;
  lastName: string;
  /** The resolved NPI Registry policy (useNpiRegistryPolicy). */
  policy: NpiRegistryPolicy;
  announcement?: NpiAnnouncement | null;
}

/** The registry check of an NPI field: the note under it, and a polite live
 * region that speaks when the result changes and when `announcement` is new —
 * never on a name keystroke. Updated during render from the previous key, so
 * no effect is needed. Never a block: a save never waits for the check. */
export function NpiRegistryCheckNote({
  noticeId,
  npi,
  verify,
  firstName,
  lastName,
  policy,
  announcement = null,
}: NpiRegistryCheckNoteProps) {
  const { checkable, state, view } = useNpiRegistryCheck(
    npi,
    verify,
    { firstName, lastName },
    policy,
  );
  const checkKey = checkable === null ? "idle" : `${checkable}:${state.status}`;
  const eventKey = announcement?.key ?? null;
  const [announced, setAnnounced] = useState({ checkKey, eventKey, text: "" });
  if (announced.checkKey !== checkKey || announced.eventKey !== eventKey) {
    const checkChanged = announced.checkKey !== checkKey;
    const isNew = announcement !== null && announced.eventKey !== announcement.key;
    const viewText = view ? [view.title, view.detail].filter(Boolean).join(". ") : null;
    const text = isNew
      ? [announcement.text, announcement.withCheck || checkChanged ? viewText : null]
      : checkChanged
        ? [viewText]
        : [announced.text];
    setAnnounced({ checkKey, eventKey, text: text.filter(Boolean).join(" ") });
  }
  return (
    <>
      <NpiVerificationNotice id={noticeId} view={view} />
      <p role="status" aria-live="polite" className="sr-only">
        {announced.text}
      </p>
    </>
  );
}

/** After a save, in view mode: the saved NPI's registry check, finishing in
 * the background (A30). Quiet: it says nothing while the check runs or when
 * the record matches, and shows a mismatch or an unreachable registry as a
 * short note in a polite live region. */
export function NpiRegistryQuietNote({
  npi,
  firstName,
  lastName,
  policy,
}: {
  npi: string;
  firstName: string;
  lastName: string;
  policy: NpiRegistryPolicy;
}) {
  const noteId = useId();
  const { view } = useNpiRegistryCheck(npi, true, { firstName, lastName }, policy);
  return (
    <div role="status" aria-live="polite">
      {view && view.tone === "warn" ? <NpiVerificationNotice id={noteId} view={view} /> : null}
    </div>
  );
}

/** What the last pick did, the licenses staff may add, and the registry data
 * no field on the form holds. Not a live region: the check note announces a
 * pick and an added license once, politely. */
export function NpiRegistryPickSummary({
  summary,
  onAddLicense,
  onChooseTaxonomy,
}: {
  summary: NpiFillSummary;
  /** Staff add an offered license; without it the offers are listed only. */
  onAddLicense?: (offer: NpiLicenseOffer) => void;
  /** Staff choose one of several taxonomies (A35); without it they are
   * listed only. */
  onChooseTaxonomy?: (code: string) => void;
}) {
  const titleId = useId();
  const cleared = npiFillClearedText(summary);
  const kept = npiFillKeptText(summary);
  const stale = npiFillStaleText(summary);
  const offers = npiFillOffersText(summary);
  return (
    <section
      aria-labelledby={titleId}
      className="space-y-1.5 rounded-md border border-border p-3 text-[12px] text-foreground"
    >
      <p id={titleId} className="font-medium">
        From the NPI Registry
      </p>
      <p>{npiFillFilledText(summary)}</p>
      {cleared ? <p>{cleared}</p> : null}
      {kept ? <p>{kept}</p> : null}
      {stale ? <p>{stale}</p> : null}
      {offers ? (
        <>
          <p>
            {offers}{" "}
            <span className="text-muted-foreground">
              A license row counts toward the provider&apos;s states, and NPPES lists no expiration
              date — add one only if it applies.
            </span>
          </p>
          <ul className="space-y-1">
            {summary.licenseOffers.map((offer) => (
              <li key={`${offer.state}|${offer.number}`} className="flex items-center gap-2">
                <span className="font-mono">
                  {offer.state} {offer.number}
                </span>
                {onAddLicense ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-7 px-2 text-[12px]", offer.added && "opacity-60")}
                    // aria-disabled, not disabled: focus stays on the button,
                    // and a click says the row is already there.
                    aria-disabled={offer.added || undefined}
                    onClick={() => onAddLicense(offer)}
                  >
                    {offer.added ? "On the form" : "Add license row"}
                    <span className="sr-only">
                      {" "}
                      for {offer.state} {offer.number}
                    </span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {summary.taxonomyChoices.length > 0 ? (
        <>
          <p>
            The registry lists several taxonomies and none as primary. Choose the one that applies:
          </p>
          <ul className="space-y-1">
            {summary.taxonomyChoices.map((choice) => (
              <li key={choice.code} className="flex items-center gap-2">
                <span>
                  <span className="font-mono">{choice.code}</span>
                  {choice.description ? ` (${choice.description})` : ""}
                </span>
                {onChooseTaxonomy ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[12px]"
                    onClick={() => onChooseTaxonomy(choice.code)}
                  >
                    Use this taxonomy
                    <span className="sr-only"> {choice.code}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {summary.details.length > 0 ? (
        <>
          <p className="text-muted-foreground">Shown for reference; not saved:</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            {summary.details.map((detail) => (
              <Fragment key={detail.label}>
                <dt className="text-muted-foreground">{detail.label}</dt>
                <dd>
                  {detail.lines.map((line, index) => (
                    <span key={index} className="block">
                      {line}
                    </span>
                  ))}
                </dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}

export interface NpiRegistryAssistProps {
  /** The NPI field's value with dashes and spaces already stripped. */
  npi: string;
  firstName: string;
  lastName: string;
  /** False while an edit form still holds the stored NPI: an unchanged NPI is
   * not re-checked (the same rule as the MINT-7 check digit). */
  verify: boolean;
  /** The form's last pick, or null. The form keeps it so it outlives a step
   * change and so the next pick can replace what this one wrote. */
  pick: NpiPickState | null;
  /** Apply a picked match (set the NPI, fill what the policy's fillOnPick
   * allows, never a value of staff's) and remember it as the form's pick,
   * with when the registry data was pulled (ISO timestamp). */
  onPick: (record: NpiRegistryRecord, pulledAt: string) => void;
  /** Staff add a license the pick offered: "exists" when a row already holds
   * it, and nothing was added. */
  onAddLicense: (offer: NpiLicenseOffer) => "added" | "exists";
  /** Staff choose one of several taxonomies the pick listed (A35). */
  onChooseTaxonomy: (code: string) => void;
  /** The verification note's id; the NPI input names it in aria-describedby. */
  noticeId: string;
  /** The resolved NPI Registry policy (useNpiRegistryPolicy): where each
   * advisory shows, and what a pick fills. */
  policy: NpiRegistryPolicy;
}

export function NpiRegistryAssist({
  npi,
  firstName,
  lastName,
  verify,
  pick,
  onPick,
  onAddLicense,
  onChooseTaxonomy,
  noticeId,
  policy,
}: NpiRegistryAssistProps) {
  const stateId = useId();
  const searchButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState("");
  const [submitted, setSubmitted] = useState<NpiRegistrySearchInput | null>(null);

  // What to say once: a new pick (seen as a new `seq`), or a license staff
  // added. Mounting with an earlier pick says nothing.
  const pickSeq = pick?.seq ?? 0;
  const [seenPickSeq, setSeenPickSeq] = useState(pickSeq);
  const [announcement, setAnnouncement] = useState<NpiAnnouncement | null>(null);
  const [addCount, setAddCount] = useState(0);
  if (seenPickSeq !== pickSeq) {
    setSeenPickSeq(pickSeq);
    if (pick) {
      setAnnouncement({
        key: `pick:${pickSeq}`,
        text: npiFillAnnouncement(pick.summary),
        withCheck: true,
      });
    }
  }

  const search = useNpiRegistrySearch(submitted);
  const primeLookup = usePrimeNpiRegistryLookup();
  const searchState: NpiSearchState =
    submitted === null
      ? { status: "idle" }
      : search.isError
        ? { status: "error", message: npiRegistryErrorMessage(search.error) }
        : search.data
          ? { status: "done", result: search.data }
          : { status: "loading" };

  const searchCheck = validateNpiRegistrySearch({ firstName, lastName, state });

  const runSearch = () => {
    if (!searchCheck.ok) return;
    // The folded names (accents, suffixes and periods removed) are what the
    // registry is asked for.
    const next = searchCheck.value;
    // The same search after a failure is a retry: the key does not change,
    // so ask again explicitly.
    const same =
      submitted !== null &&
      submitted.firstName === next.firstName &&
      submitted.lastName === next.lastName &&
      (submitted.state ?? null) === next.state;
    if (same && search.isError) {
      void search.refetch();
      return;
    }
    setSubmitted(next);
  };

  const pickRecord = (record: NpiRegistryRecord) => {
    primeLookup(record);
    // A35's pull date: when the registry answered, which a cached answer
    // keeps; else when this browser got the answer.
    onPick(
      record,
      search.data?.pulledAt ?? new Date(search.dataUpdatedAt || Date.now()).toISOString(),
    );
    setSubmitted(null);
    searchButton.current?.focus();
  };

  const chooseTaxonomy = (code: string) => {
    onChooseTaxonomy(code);
    const next = addCount + 1;
    setAddCount(next);
    setAnnouncement({
      key: `add:${next}`,
      text: `Taxonomy code set to ${code}.`,
      withCheck: false,
    });
  };

  const addLicense = (offer: NpiLicenseOffer) => {
    const result = offer.added ? "exists" : onAddLicense(offer);
    const next = addCount + 1;
    setAddCount(next);
    setAnnouncement({
      key: `add:${next}`,
      text:
        result === "added"
          ? `Added a ${offer.state} license row with number ${offer.number}.`
          : `A ${offer.state} license row with number ${offer.number} is already on the form.`,
      withCheck: false,
    });
  };

  return (
    <div className="mt-2 space-y-2">
      <NpiRegistryCheckNote
        noticeId={noticeId}
        npi={npi}
        verify={verify}
        firstName={firstName}
        lastName={lastName}
        policy={policy}
        announcement={announcement}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={stateId} className="sr-only">
          NPI Registry search state
        </label>
        <StateSelect
          id={stateId}
          value={state}
          onChange={setState}
          placeholder="Any state"
          className="h-8 w-28 text-[13px]"
        />
        <Button
          ref={searchButton}
          type="button"
          variant="outline"
          size="sm"
          disabled={!searchCheck.ok}
          onClick={runSearch}
        >
          <Search aria-hidden="true" className="h-4 w-4" />
          Search NPI Registry
        </Button>
        {!searchCheck.ok ? (
          <span className="text-[12px] text-muted-foreground">{searchCheck.error}</span>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-[12px] text-muted-foreground">
        {npiSearchStatusText(searchState, policy.fillOnPick)}
      </p>
      {searchState.status === "done" ? (
        <NpiRegistryResultList results={searchState.result.results} onPick={pickRecord} />
      ) : null}
      {/* Shown while the form still holds the picked NPI. */}
      {pick && pick.npi === npi ? (
        <NpiRegistryPickSummary
          summary={pick.summary}
          onAddLicense={addLicense}
          onChooseTaxonomy={chooseTaxonomy}
        />
      ) : null}
    </div>
  );
}
