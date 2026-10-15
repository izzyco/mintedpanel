// Searchable fixed-value picker for a long captured vocabulary.
//
// A Radix Select mounts every item even while closed (it renders them into a
// fragment so the trigger can show the chosen label), and it owns keydown for
// typeahead, so a search box inside it never receives characters — the same
// trap TokenPicker documents. Specialty and taxonomy lists run to hundreds of
// entries, so past SEARCHABLE_OPTIONS_THRESHOLD the registry swaps its Select
// for this Popover + Input + capped option rows. Nothing mounts until opened.

import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { controlOptionText, filterControlOptions, type ControlOption } from "@/lib/controlOptions";
import { cn } from "@/lib/utils";

interface ControlOptionPickerProps {
  /** Accessible name for the trigger (e.g. "Fixed value for Specialty"). */
  "aria-label": string;
  value: string | null;
  options: readonly ControlOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function ControlOptionPicker({
  "aria-label": ariaLabel,
  value,
  options,
  onValueChange,
  placeholder = "Fixed value…",
  className,
}: ControlOptionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { shown, matched } = useMemo(() => filterControlOptions(options, query), [options, query]);
  const current = value ? options.find((o) => o.value === value) : undefined;
  const shownText = current ? controlOptionText(current) : (value ?? "");

  function pick(next: string) {
    onValueChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className={cn(
            "flex h-7 w-56 items-center gap-1.5 rounded-[4px] border border-[#E8E5E0] bg-white px-2.5 text-left text-[12px]",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              shownText ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {shownText || placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 border-[#E8E5E0] p-0 shadow-none"
        // Keep focus in the search field; selecting an option closes via setOpen.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-[#F0EEEA] p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${options.length} options…`}
            aria-label="Search options"
            className="h-8 text-[12px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = shown[0];
                if (!first) return;
                e.preventDefault();
                pick(first.value);
              }
            }}
          />
        </div>
        <div
          role="listbox"
          aria-label="Captured options"
          className="max-h-[240px] overflow-y-auto py-1"
        >
          {shown.length === 0 ? (
            <p className="px-3 py-3.5 text-center text-[12px] text-muted-foreground">
              No options match
            </p>
          ) : (
            shown.map((opt, i) => {
              const selected = opt.value === value;
              return (
                <button
                  key={`${i}:${opt.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(opt.value)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[#F5F4F1]",
                    selected && "bg-[#F7FAF8]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{controlOptionText(opt)}</span>
                  {selected ? <Check className="h-3.5 w-3.5 flex-none text-[#1B4D3E]" /> : null}
                </button>
              );
            })
          )}
          {matched > shown.length ? (
            <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing {shown.length} of {matched}. Type to narrow.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
