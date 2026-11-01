import { describe, expect, it } from "vitest";
import {
  PLAN_TIERS,
  isValidSlug,
  joinPath,
  orgErrorMessage,
  planTierLabel,
  slugFromName,
  slugProblem,
} from "./orgProfile";
import { ORG_SCOPE_SETTINGS, orgDetailTabs } from "./orgDetailTabs";

describe("isValidSlug", () => {
  it("accepts a DNS label", () => {
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("rose-city-rehab")).toBe(true);
    expect(isValidSlug("org2")).toBe(true);
    expect(isValidSlug("a".repeat(63))).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Rose")).toBe(false);
    expect(isValidSlug("-rose")).toBe(false);
    expect(isValidSlug("rose-")).toBe(false);
    expect(isValidSlug("rose_city")).toBe(false);
    expect(isValidSlug("rose city")).toBe(false);
    expect(isValidSlug("a".repeat(64))).toBe(false);
  });
});

describe("slugFromName", () => {
  it("lowercases, joins words with one hyphen and trims the ends", () => {
    expect(slugFromName("Rose City Rehab Collective")).toBe("rose-city-rehab-collective");
    expect(slugFromName("  Kansas -- Fitness Physio, P.A. ")).toBe("kansas-fitness-physio-p-a");
  });

  it("drops accents and caps the length at 63 without a trailing hyphen", () => {
    expect(slugFromName("Café Rehab")).toBe("cafe-rehab");
    const long = slugFromName("ab ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-")).toBe(false);
    expect(isValidSlug(long)).toBe(true);
  });

  it("returns empty when nothing usable is left", () => {
    expect(slugFromName("---")).toBe("");
    expect(slugFromName("")).toBe("");
  });
});

describe("slugProblem", () => {
  it("explains each refusal and accepts a valid slug", () => {
    expect(slugProblem("")).toBe("Enter a slug");
    expect(slugProblem("a".repeat(64))).toBe("Use 63 characters or fewer");
    expect(slugProblem("Bad Slug")).toMatch(/lowercase letters/);
    expect(slugProblem("good-slug")).toBeNull();
  });
});

describe("plan tiers and the join link", () => {
  it("lists the three tiers and shows an unlisted stored value as is", () => {
    expect(PLAN_TIERS.map((tier) => tier.value)).toEqual(["pilot", "standard", "enterprise"]);
    expect(planTierLabel("standard")).toBe("Standard");
    expect(planTierLabel("founders")).toBe("founders");
    expect(planTierLabel(null)).toBeNull();
  });

  it("builds /join/<slug>", () => {
    expect(joinPath("rose-city")).toBe("/join/rose-city");
  });
});

describe("orgErrorMessage", () => {
  it("turns the database's machine messages into sentences and keeps the rest", () => {
    expect(orgErrorMessage("slug_taken")).toBe("That slug is already used by another organization");
    expect(orgErrorMessage("org_offboarded")).toMatch(/offboarded/);
    const duplicate = 'An organization named "Rose" already exists. Please use a different name.';
    expect(orgErrorMessage(duplicate)).toBe(duplicate);
  });
});

describe("orgDetailTabs", () => {
  it("ships no empty Settings tab", () => {
    expect(ORG_SCOPE_SETTINGS).toEqual([]);
    expect(orgDetailTabs().map((tab) => tab.key)).toEqual(["overview", "members", "invites"]);
  });

  it("adds Settings once the first organization-scope setting exists", () => {
    expect(orgDetailTabs(["checks.npi_registry.name_mismatch"]).map((tab) => tab.key)).toEqual([
      "overview",
      "members",
      "invites",
      "settings",
    ]);
  });
});
