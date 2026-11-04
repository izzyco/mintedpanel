import { test, expect } from "@playwright/test";
import { shot } from "./shot";

// Example PR demo and pipeline self-test: the public login page needs no
// mocks. Real demos copy this shape, borrow the mocks from the feature's e2e
// spec, and stay uncommitted (e2e/demo/*.demo.ts is gitignored).
test("demo: sign-in page", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await shot(page, "01-sign-in-page");
  await page.locator("#email").fill("anita.rao@example.test");
  await shot(page, "02-email-typed");
});
