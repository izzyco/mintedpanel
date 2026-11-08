import { test, expect, type Page } from "@playwright/test";

// The Stage 1 onboarding preview (/dev/provider-onboarding): the practice's New
// hires view and the provider flow on sample data, with no session and no
// network. Synthetic canvas names; the preview's code is 123456.

async function openPreview(page: Page, side: "Practice" | "Provider") {
  await page.goto("/dev/provider-onboarding");
  await page.getByRole("button", { name: side, exact: true }).click();
}

async function signInAndConsent(page: Page) {
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByLabel(/Type your full name to sign/).fill("Priya Shah");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();
}

test("a practice invites a new hire and sees the row and its counts", async ({ page }) => {
  await openPreview(page, "Practice");
  await expect(page.getByText("1 waiting on you")).toBeVisible();

  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Sam");
  await dialog.getByLabel("Last name").fill("Lee");
  await dialog.getByLabel("Email", { exact: true }).fill("sam.lee@example.test");
  await dialog.getByLabel("Group").click();
  await page.getByRole("option", { name: "Shelby Sports Rehab · Charlotte" }).click();
  await dialog.getByRole("button", { name: "Send invite" }).click();

  await expect(dialog.getByText("Invitation sent")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("table", { name: "Every new hire" })).toContainText("Sam Lee");
});

test("a re-invited provider sees SSN, NPI and date of birth locked, with a fix request", async ({
  page,
}) => {
  await openPreview(page, "Provider");
  await page.locator("#preview-scenario").selectOption("review");
  await signInAndConsent(page);

  await expect(
    page.getByText("Shelby Sports Rehab asked you to review your details."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Tell us your .* is wrong/ })).toHaveCount(3);
  // Her mobile and both logins: the sample review has no login on file.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("3 things left before you can continue")).toBeVisible();

  await page.getByRole("button", { name: "Tell us your NPI is wrong" }).click();
  await expect(
    page.getByRole("heading", { name: "We've flagged your NPI for a fix" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to your form" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
});
