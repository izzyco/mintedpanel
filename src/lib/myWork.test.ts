// My work (sidebar Option B): the assigned-to-me set and the open-case counts.
import { describe, expect, it } from "vitest";
import { isOpenCase, myCaseIds, openCaseCount } from "./myWork";

const DONE = new Set(["status-approved"]);
const ME = "user-me";
const cases = [
  { id: "a", assignedTo: ME, credentialingStatusId: null },
  { id: "b", assignedTo: ME, credentialingStatusId: "status-approved" },
  { id: "c", assignedTo: "someone-else", credentialingStatusId: "status-submitted" },
  { id: "d", assignedTo: null, credentialingStatusId: "status-submitted" },
];

describe("isOpenCase", () => {
  it("treats a status-less case as open and a complete-bucket status as closed", () => {
    expect(isOpenCase(cases[0], DONE)).toBe(true);
    expect(isOpenCase(cases[1], DONE)).toBe(false);
    expect(isOpenCase(cases[2], DONE)).toBe(true);
  });
});

describe("myCaseIds", () => {
  it("returns the cases assigned to the user, open or closed", () => {
    expect([...myCaseIds(cases, ME)].sort()).toEqual(["a", "b"]);
  });
  it("is empty when nobody is signed in", () => {
    expect(myCaseIds(cases, null).size).toBe(0);
  });
});

describe("openCaseCount", () => {
  it("counts every open case without a user", () => {
    expect(openCaseCount(cases, DONE)).toBe(3);
  });
  it("counts only the user's open cases with a user", () => {
    expect(openCaseCount(cases, DONE, ME)).toBe(1);
    expect(openCaseCount(cases, DONE, null)).toBe(0);
  });
});
