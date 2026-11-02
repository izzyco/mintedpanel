// The practice side of the onboarding preview: board 0 and its dialogs on
// sample data, with a fixed clock so cooldowns read the same on every visit.
// Nothing is sent or saved.
import { useReducer, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { newHiresReducer } from "@/lib/newHires";
import {
  EARLIER_HIRES_IN_CREDENTIALING,
  HIRES,
  KNOWN_PEOPLE,
  PRACTICE,
} from "@/services/providerOnboardingFixtures";
import { NewHiresBoard } from "./NewHiresBoard";

const PREVIEW_NOW = "2026-10-19T14:15:00Z";
// UTC, so the server render and the browser agree on the label.
const PREVIEW_NOW_LABEL = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
}).format(new Date(PREVIEW_NOW));

export function NewHiresPreview() {
  const [state, dispatch] = useReducer(newHiresReducer, { hires: HIRES, people: KNOWN_PEOPLE });
  const [emailFails, setEmailFails] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 text-[12px]">
        <div className="flex items-center gap-2">
          <Checkbox
            id="simulate-email-failure"
            checked={emailFails}
            onCheckedChange={(checked) => setEmailFails(checked === true)}
          />
          <Label htmlFor="simulate-email-failure" className="text-[12px] font-normal">
            Simulate email failure
          </Label>
        </div>
        <span className="text-muted-foreground">
          Sample data. The clock is fixed at {PREVIEW_NOW_LABEL} UTC.
        </span>
      </div>
      <NewHiresBoard
        state={state}
        dispatch={dispatch}
        now={new Date(PREVIEW_NOW)}
        practice={PRACTICE}
        earlierInCredentialing={EARLIER_HIRES_IN_CREDENTIALING}
        emailFails={emailFails}
      />
    </>
  );
}
