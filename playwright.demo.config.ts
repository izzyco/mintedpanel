import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// PR demo capture (see the `pr-demo` skill). Runs only `e2e/demo/*.demo.ts`
// with the e2e suite's dummy env and mock harness, so the normal
// `playwright test` run never picks these up. Its own dev server on port 8090,
// never reused: parallel sessions often hold 8080 from another checkout, and a
// demo must show this branch. Screenshots land in demo-output/ (gitignored);
// DEMO_VIDEO=1 also records a .webm per demo.
const DEMO_URL = "http://localhost:8090";

export default defineConfig({
  ...base,
  testMatch: "**/*.demo.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "demo-output/results",
  use: { ...base.use, baseURL: DEMO_URL },
  webServer: {
    ...base.webServer,
    command: "npm run dev -- --port 8090 --strictPort",
    url: DEMO_URL,
    reuseExistingServer: false,
  },
  projects: base.projects?.map((project) => ({
    ...project,
    use: {
      ...project.use,
      viewport: { width: 1280, height: 800 },
      video: process.env.DEMO_VIDEO ? "on" : "off",
    },
  })),
});
