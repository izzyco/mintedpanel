// Mission Control › Organizations › detail page tabs (M3). Pure. The Settings
// tab is reserved: it joins the list only once the first organization-scope
// setting exists (the later settings shell registers them), so no empty tab
// ships.

export type OrgDetailTabKey = "overview" | "members" | "invites" | "settings";

export interface OrgDetailTab {
  key: OrgDetailTabKey;
  label: string;
}

/** Organization-scope settings registered so far. None yet. */
export const ORG_SCOPE_SETTINGS: readonly string[] = [];

export function orgDetailTabs(orgScopeSettings: readonly string[] = ORG_SCOPE_SETTINGS) {
  const tabs: OrgDetailTab[] = [
    { key: "overview", label: "Overview" },
    { key: "members", label: "Members" },
    { key: "invites", label: "Pending invites" },
  ];
  if (orgScopeSettings.length > 0) tabs.push({ key: "settings", label: "Settings" });
  return tabs;
}
