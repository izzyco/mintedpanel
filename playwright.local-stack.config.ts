import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Only for scripts/e2e/onboarding-local-stack.sh, which starts the servers and
// sets the env this run reads. One worker, in order: each step builds on the
// database the step before it left.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "onboarding-local-stack.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "test-results/onboarding-local-stack/artifacts",
  use: {
    baseURL: process.env.APP_ORIGIN ?? "http://127.0.0.1:8091",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: base.projects,
});
