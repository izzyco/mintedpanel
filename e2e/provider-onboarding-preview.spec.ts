import { test, expect, type Page } from "@playwright/test";
import { NPI_CHECK_DIGIT_MESSAGE } from "../src/lib/providerIdentity";

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

test("an NPI with a wrong check digit holds the invite until it is fixed", async ({ page }) => {
  await openPreview(page, "Practice");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Sam");
  await dialog.getByLabel("Last name").fill("Lee");
  await dialog.getByLabel("Email", { exact: true }).fill("sam.lee@example.test");
  await dialog.getByLabel("Group").click();
  await page.getByRole("option", { name: "Shelby Sports Rehab · Charlotte" }).click();
  const send = dialog.getByRole("button", { name: "Send invite" });
  await expect(send).toBeEnabled();

  await dialog.getByText("NPI and start date (optional)").click();
  const npi = dialog.getByLabel("NPI", { exact: true });
  await npi.fill("1234567890");
  await expect(dialog.getByText(NPI_CHECK_DIGIT_MESSAGE)).toBeVisible();
  await expect(npi).toHaveAttribute("aria-invalid", "true");
  await expect(send).toBeDisabled();

  await npi.fill("1234567893");
  await expect(dialog.getByText(NPI_CHECK_DIGIT_MESSAGE)).toHaveCount(0);
  await expect(send).toBeEnabled();
});

test("inviting someone already in another group adds the group and sends nothing", async ({
  page,
}) => {
  await openPreview(page, "Practice");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Dev");
  await dialog.getByLabel("Last name").fill("Patel");
  await dialog.getByLabel("Email", { exact: true }).fill("dev.patel@example.test");
  await dialog.getByLabel("Group").click();
  await page.getByRole("option", { name: "Shelby Sports Rehab · Charlotte" }).click();
  await dialog.getByRole("button", { name: "Send invite" }).click();

  await expect(dialog).toContainText("No email went out");
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
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("2 things left before you can continue")).toBeVisible();

  await page.getByRole("button", { name: "Tell us your NPI is wrong" }).click();
  await expect(
    page.getByRole("heading", { name: "We've flagged your NPI for a fix" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to your form" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
});

test("five wrong codes lock the code until she asks for a new one", async ({ page }) => {
  await openPreview(page, "Provider");
  await page.getByRole("button", { name: "Send me a code" }).click();
  const code = page.getByLabel("6-digit code");
  for (let i = 0; i < 4; i++) {
    await code.fill("000000");
    await expect(code).toHaveAttribute("aria-invalid", "true");
    await code.fill("");
  }
  await code.fill("000000");
  await expect(page.getByRole("heading", { name: "Too many tries" })).toBeVisible();
  await page.getByRole("button", { name: /Send me a new code/ }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
});

test("cancelling an invitation removes the record, so a re-invite is a new invite", async ({
  page,
}) => {
  await openPreview(page, "Practice");
  await page.getByRole("button", { name: "More for Anita Rao, PT" }).click();
  await page.getByRole("menuitem", { name: "Cancel invitation…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel invitation" }).click();
  await expect(page.getByRole("table", { name: "Every new hire" })).not.toContainText("Anita Rao");

  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Anita");
  await dialog.getByLabel("Last name").fill("Rao");
  await dialog.getByLabel("Email", { exact: true }).fill("anita.rao@example.test");
  await dialog.getByLabel("Group").click();
  await page.getByRole("option", { name: "Shelby Sports Rehab · Charlotte" }).click();
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(dialog.getByText("Invitation sent")).toBeVisible();
});

test("the SSN stays in its field while she is on the form, and Show reveals it", async ({
  page,
}) => {
  await openPreview(page, "Provider");
  await signInAndConsent(page);
  const ssn = page.getByLabel(/^Social Security number/);
  await ssn.click();
  await page.keyboard.type("1231231231");
  await expect(ssn).toHaveValue("123-12-3123");
  await page.getByLabel(/^CAQH ID/).click();
  await expect(ssn).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(ssn).toHaveAttribute("type", "text");
  await expect(ssn).toHaveValue("123-12-3123");
});
