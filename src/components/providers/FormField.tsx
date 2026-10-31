// Shared Field + FieldLabel primitives for provider forms.
// Associates label with child input via generated id + htmlFor for a11y.
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
    >
      {children}
    </label>
  );
}

/** What a field's control needs: the label's id and, while there is an
 * error, aria-invalid plus the error's id. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** A labelled field. A single input child gets the control props cloned onto
 * it (after any aria-describedby it already names, such as the NPI Registry
 * note). Any other control — a Select, whose trigger is the control, or an
 * input inside a wrapper — takes them through a render function:
 * `<Field label="Gender">{(control) => <Select><SelectTrigger {...control} />…}</Field>`. */
export function Field({
  label,
  error,
  helper,
  children,
}: {
  label: string;
  error?: string;
  helper?: string;
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
}) {
  const generatedId = useId();
  const errorId = `${generatedId}-error`;
  let controlId = generatedId;
  let rendered: ReactNode;

  if (typeof children === "function") {
    rendered = children({
      id: generatedId,
      ...(error ? { "aria-describedby": errorId, "aria-invalid": true as const } : {}),
    });
  } else if (isValidElement(children)) {
    const child = children as ReactElement<{
      id?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean;
    }>;
    if (child.props.id) controlId = child.props.id;
    const describedBy = [child.props["aria-describedby"], error ? errorId : null]
      .filter(Boolean)
      .join(" ");
    rendered = cloneElement(child, {
      id: controlId,
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(error ? { "aria-invalid": true } : {}),
    });
  } else {
    rendered = children;
  }

  return (
    <div>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {rendered}
      {helper ? <p className="mt-1 text-xs text-muted-foreground">{helper}</p> : null}
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
