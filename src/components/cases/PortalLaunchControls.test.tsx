import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortalLaunchControls } from "./PortalLaunchControls";
import { MANUAL_RECOVERY_TEXT } from "./portalLaunchFeedback";

const base = {
  portalName: "Aetna Direct Enrollment",
  portalUrl: "https://portal.example/enroll",
  helperText: "Sends this case to the Minted extension and opens the Aetna portal.",
  onLaunch: () => undefined,
  disabled: false,
};

describe("PortalLaunchControls panel", () => {
  it("leads with Work in portal, explains it, and keeps the fallback quiet", () => {
    const html = renderToStaticMarkup(<PortalLaunchControls presentation="panel" {...base} />);
    expect(html).toContain("Work in portal");
    expect(html).toContain(base.helperText);
    expect(html).toContain("Open without extension");
    expect(html).toContain('href="https://portal.example/enroll"');
    expect(html).not.toContain("Open portal directly");
    expect(html).not.toContain(MANUAL_RECOVERY_TEXT);
  });

  it("shows recovery guidance only after a failed handoff", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls
        presentation="panel"
        {...base}
        feedback={{ tone: "failure", text: "Extension receipt timed out.", recovery: true }}
      />,
    );
    expect(html).toContain("Extension receipt timed out.");
    expect(html).toContain(MANUAL_RECOVERY_TEXT);
  });

  it("confirms success without recovery text", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls
        presentation="panel"
        {...base}
        feedback={{ tone: "success", text: "Extension received the case." }}
      />,
    );
    expect(html).toContain("Extension received the case.");
    expect(html).not.toContain(MANUAL_RECOVERY_TEXT);
  });

  it("disables the launch with its reason but keeps the fallback link", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls
        presentation="panel"
        {...base}
        disabled
        disabledReason="Choose a location before sending this case to the extension."
      />,
    );
    expect(html).toMatch(/\sdisabled=""/);
    expect(html).toContain("Choose a location before sending this case to the extension.");
    expect(html).not.toContain(base.helperText);
    expect(html).toContain("Open without extension");
  });
});

describe("PortalLaunchControls inline", () => {
  it("renders the button alone", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls presentation="inline" {...base} onOpenTask={() => undefined} />,
    );
    expect(html).toContain("Work in portal");
    expect(html).not.toContain(base.helperText);
    expect(html).not.toContain("Open without extension");
  });

  it("stays clickable when blocked, because it opens the task instead", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls
        presentation="inline"
        {...base}
        disabled
        disabledReason="Choose a location before sending this case to the extension."
        onOpenTask={() => undefined}
      />,
    );
    expect(html).toContain("Work in portal");
    expect(html).not.toMatch(/\sdisabled=""/);
  });

  it("renders nothing when blocked with no way to open the task", () => {
    const html = renderToStaticMarkup(
      <PortalLaunchControls presentation="inline" {...base} disabled />,
    );
    expect(html).toBe("");
  });
});
