import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// MINT-106: jobs log only through safeLog (ctx.log.error → logServerError).
const root = process.cwd();

describe("jobs code logs only through safeLog", () => {
  it("has no console call outside tests, in any file under src/server/jobs/", () => {
    const dir = join(root, "src/server/jobs");
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/\bconsole\s*\./);
    }
  });
});
