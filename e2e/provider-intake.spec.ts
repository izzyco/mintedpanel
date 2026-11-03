import { test, expect, type Page, type Route } from "@playwright/test";

// Provider onboarding — the PUBLIC intake route (/intake/:token). No Supabase
// session. /api/intake/* is mocked: a live link, a code request that always
// answers sent, a session that opens only for code 123456, /me that reads only
// while that session exists, and a sign-out that ends it. Synthetic canvas names.

function intakeApi({
  failMeOnce = false,
  practiceName = "Shelby Sports Rehab",
  email = "anita.rao@example.test",
} = {}) {
  let signedIn = false;
  let meFailuresLeft = failMeOnce ? 1 : 0;
  return async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() as Record<string, string> | null;
    const json = (status: number, data: unknown, error: string | null = null) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ data, error, meta: null }),
      });
    if (path.endsWith("/link")) {
      return body?.t === "live-token"
        ? json(200, { practiceName, email })
        : json(404, null, "invalid_link");
    }
    if (path.endsWith("/code")) return json(200, { sent: true });
    if (path.endsWith("/signout")) {
      signedIn = false;
      return json(200, { signedOut: true });
    }
    if (path.endsWith("/session")) {
      if (body?.code !== "123456") return json(400, null, "code_invalid");
      signedIn = true;
      return json(200, { signedIn: true });
    }
    if (path.endsWith("/me")) {
      if (signedIn && meFailuresLeft > 0) {
        meFailuresLeft -= 1;
        return json(500, null, "Internal server error");
      }
      return signedIn
        ? json(200, { practiceName, firstName: "Anita", lastName: "Rao", email })
        : json(401, null, "signed_out");
    }
    return json(404, null, "Not found");
  };
}

test("a provider signs in with the emailed code and reaches consent, then the form", async ({
  context,
  page,
}) => {
  await context.route("**/api/intake/**", intakeApi());
  await page.goto("/intake/live-token");

  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(page.getByText("Shelby Sports Rehab").first()).toBeVisible();
  await expect(page.getByText("anita.rao@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Send me a code" }).click();

  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const code = page.getByLabel("6-digit code");
  await code.fill("999999");
  await expect(page.getByText("That code didn't work")).toContainText("4 tries left");
  await code.fill("123456");

  await expect(page.getByRole("heading", { name: "Your consent" })).toBeVisible();
  await expect(page.getByText("We at Shelby Sports Rehab recognize")).toBeVisible();
  const sign = page.getByRole("button", { name: "Sign and continue" });
  await expect(sign).toBeDisabled();
  await page.getByLabel(/Type your full name to sign/).fill("Anita Rao");
  await expect(sign).toBeDisabled();
  await page.getByRole("checkbox").check();
  await sign.click();

  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(page.getByText("Signed in as anita.rao@example.test")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("This form isn't connected yet");
});

test("answers stay on the page through Sign out, and signing back in resumes the form", async ({
  context,
  page,
}) => {
  await context.route("**/api/intake/**", intakeApi());
  await page.goto("/intake/live-token");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByLabel(/Type your full name to sign/).fill("Anita Rao");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();
  await page.getByLabel("Mobile phone").fill("(704) 555-0100");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in again" }).click();
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");

  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expect(page.getByLabel("Mobile phone")).toHaveValue("(704) 555-0100");
});

test("a failed details read after sign-in offers Try again instead of an endless spinner", async ({
  context,
  page,
}) => {
  await context.route("**/api/intake/**", intakeApi({ failMeOnce: true }));
  await page.goto("/intake/live-token");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("6-digit code").fill("123456");

  // Consent needs only the practice name from the link, so it still opens.
  await page.getByLabel(/Type your full name to sign/).fill("Anita Rao");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();

  await expect(page.getByText("We couldn't open your form just now.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
});

test("an unknown, expired or revoked link shows one invalid-link screen", async ({
  context,
  page,
}) => {
  await context.route("**/api/intake/**", intakeApi());
  await page.goto("/intake/dead-token");
  await expect(
    page.getByRole("heading", { name: "This invitation is no longer valid" }),
  ).toBeVisible();
});

// Text that doesn't fit must wrap. Anything clipped (scrollWidth past its box)
// or past the right edge of the screen is a cut-off a provider would see.
async function expectNothingCutOff(page: Page, step: string) {
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
      .filter(
        (el) =>
          el.scrollWidth > el.clientWidth + 1 ||
          el.getBoundingClientRect().right > window.innerWidth + 1,
      )
      .map((el) => el.textContent?.trim().slice(0, 60)),
  );
  expect(cut, `cut off on ${step}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(
    0,
  );
}

test("long practice names and emails wrap on a small phone instead of being cut off", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await context.route(
    "**/api/intake/**",
    intakeApi({
      practiceName: "Shelby Sports Rehabilitation and Physical Therapy of North Carolina",
      email: "ivan.zhang.credentialing.coordinator@shelbysportsrehabilitation.example.com",
    }),
  );
  await page.goto("/intake/live-token");
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expectNothingCutOff(page, "confirm");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expectNothingCutOff(page, "code");
  await page.getByLabel("6-digit code").fill("123456");
  await expect(page.getByRole("heading", { name: "Your consent" })).toBeVisible();
  await expectNothingCutOff(page, "consent");
  await page.getByLabel(/Type your full name to sign/).fill("Anita Rao");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign and continue" }).click();
  await expect(page.getByRole("heading", { name: "Your credentialing details" })).toBeVisible();
  await expectNothingCutOff(page, "form");
});
