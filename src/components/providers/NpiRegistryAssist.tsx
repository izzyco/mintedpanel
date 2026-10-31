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
//      supply (the form decides, via src/lib/npiRegistryFill.ts); a field with
//      a value is never replaced.
//      What was filled, what was kept, and the registry data no field holds
//      are shown under the search and announced once.
// Used by Add Provider (ProviderFormSections) and the roster form. Composition
// of stock primitives, logged in DESIGN-DEBT.md.
import { Fragment, useId, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateSelect } from "@/components/StateSelect";
import {
  useNpiRegistryLookup,
  useNpiRegistrySearch,
  usePrimeNpiRegistryLookup,
} from "@/hooks/useNpiRegistry";
import {
  npiFillAnnouncement,
  npiFillFilledText,
  npiFillKeptText,
  type NpiFillSummary,
} from "@/lib/npiRegistryFill";
import {
  npiLookupStateOf,
  npiRegistryErrorMessage,
  npiSearchStatusText,
  npiToCheck,
  npiVerificationView,
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
          ) : view.tone === "block" ? (
            <CircleAlert aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-destructive" />
          ) : null}
          <p>
            <span
              className={cn(
                "font-medium",
                view.tone === "warn"
                  ? "text-[var(--mp-warn-ink)]"
                  : view.tone === "block"
                    ? "text-destructive"
                    : "text-foreground",
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

/** What the last pick did, and the registry data no field on the form holds.
 * Not a live region: NpiRegistryAssist announces a pick once, politely. */
export function NpiRegistryPickSummary({ summary }: { summary: NpiFillSummary }) {
  const titleId = useId();
  const kept = npiFillKeptText(summary);
  return (
    <section
      aria-labelledby={titleId}
      className="space-y-1.5 rounded-md border border-border p-3 text-[12px] text-foreground"
    >
      <p id={titleId} className="font-medium">
        From the NPI Registry
      </p>
      <p>{npiFillFilledText(summary)}</p>
      {kept ? <p>{kept}</p> : null}
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
  /** Apply a picked match: set the NPI, fill what the policy's fillOnPick
   * allows (never a field with a value), and say what was filled and kept. */
  onPick: (record: NpiRegistryRecord) => NpiFillSummary;
  /** The verification note's id; the NPI input names it in aria-describedby. */
  noticeId: string;
  /** The resolved NPI Registry policy (useNpiRegistryPolicy): which answers
   * block, and what a pick fills. */
  policy: NpiRegistryPolicy;
}

export function NpiRegistryAssist({
  npi,
  firstName,
  lastName,
  verify,
  onPick,
  noticeId,
  policy,
}: NpiRegistryAssistProps) {
  const stateId = useId();
  const searchButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState("");
  const [submitted, setSubmitted] = useState<NpiRegistrySearchInput | null>(null);
  // The last pick. `seq` tells a new pick from a re-render.
  const [picked, setPicked] = useState<{
    seq: number;
    npi: string;
    summary: NpiFillSummary;
  } | null>(null);

  const checkable = npiToCheck(npi, verify);
  const lookup = useNpiRegistryLookup(checkable);
  const lookupState = npiLookupStateOf(checkable, lookup);
  const view = npiVerificationView(lookupState, { firstName, lastName }, policy);

  // Announce the check only when its result changes (a new NPI, or loading →
  // found / not found / unavailable) — never on a name keystroke, even though
  // the note itself follows the typed name. A pick is announced once, in the
  // same message as the check it causes, so neither is lost to the other.
  // Updated during render from the previous key, so no effect is needed.
  const announceKey = checkable === null ? "idle" : `${checkable}:${lookupState.status}`;
  const pickSeq = picked?.seq ?? 0;
  const [announced, setAnnounced] = useState({ key: announceKey, pickSeq, text: "" });
  if (announced.key !== announceKey || announced.pickSeq !== pickSeq) {
    const pickText =
      picked && announced.pickSeq !== pickSeq ? npiFillAnnouncement(picked.summary) : null;
    const viewText = view ? [view.title, view.detail].filter(Boolean).join(". ") : null;
    setAnnounced({
      key: announceKey,
      pickSeq,
      text: [pickText, viewText].filter(Boolean).join(" "),
    });
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

  const pick = (record: NpiRegistryRecord) => {
    primeLookup(record);
    const summary = onPick(record);
    setPicked((previous) => ({ seq: (previous?.seq ?? 0) + 1, npi: record.npi, summary }));
    setSubmitted(null);
    searchButton.current?.focus();
  };

  return (
    <div className="mt-2 space-y-2">
      <NpiVerificationNotice id={noticeId} view={view} />
      <p role="status" aria-live="polite" className="sr-only">
        {announced.text}
      </p>
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
        <NpiRegistryResultList results={searchState.result.results} onPick={pick} />
      ) : null}
      {/* Shown while the form still holds the picked NPI. */}
      {picked && picked.npi === npi ? <NpiRegistryPickSummary summary={picked.summary} /> : null}
    </div>
  );
}
