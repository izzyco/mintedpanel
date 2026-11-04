#!/usr/bin/env node
// Publishes PR demo screenshots (and optional videos) to the `pr-media` branch
// and prints the markdown to paste under "What changes for you" in the PR
// body. See .claude/skills/pr-demo/SKILL.md.
//
// GitHub has no API for the inline user-attachments a browser drag-drop makes,
// so media lives on the orphan `pr-media` branch under pr/<number>/ and the PR
// body references it with ?raw=true links (they render for anyone with repo
// access). The branch shares no history with main and is never merged.
//
// Usage: node scripts/pr-demo/publish.mjs <pr-number> [files...]
//   files default to every .png/.jpg/.gif/.webm/.mp4 in demo-output/,
//   sorted by name. Name steps "01-open-new-case.png" → "1. Open new case".
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BRANCH = "pr-media";
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const VIDEO = new Set([".webm", ".mp4", ".mov"]);

const fail = (message) => {
  console.error(`[pr-demo] ${message}`);
  process.exit(1);
};

function git(args, cwd, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    fail(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result;
}

const [prArg, ...fileArgs] = process.argv.slice(2);
const pr = Number(prArg);
if (!Number.isInteger(pr) || pr <= 0) {
  fail("usage: node scripts/pr-demo/publish.mjs <pr-number> [files...]");
}

const files = (
  fileArgs.length
    ? fileArgs
    : existsSync("demo-output")
      ? readdirSync("demo-output")
          .sort()
          .map((name) => join("demo-output", name))
      : []
)
  .map((file) => resolve(file))
  .filter(
    (file) => IMAGE.has(extname(file).toLowerCase()) || VIDEO.has(extname(file).toLowerCase()),
  );
if (!files.length) fail("no screenshots or videos found (looked in demo-output/)");
for (const file of files) {
  if (statSync(file).size > MAX_BYTES) {
    fail(`${basename(file)} is over 5 MB: shorten the recording or crop the screenshot`);
  }
}

const remote = git(["remote", "get-url", "origin"], ".").stdout.trim();
const slug = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
if (!slug) fail(`origin is not a GitHub remote: ${remote}`);

// Check the media branch out in a throwaway worktree so the caller's checkout
// is never touched.
const work = mkdtempSync(join(tmpdir(), "pr-media-"));
const fetched = git(["fetch", "origin", `${BRANCH}:refs/remotes/origin/${BRANCH}`], ".", {
  allowFail: true,
});
if (fetched.status === 0) {
  git(["worktree", "add", "--detach", work, `origin/${BRANCH}`], ".");
} else {
  git(["worktree", "add", "--detach", work, "HEAD"], ".");
  git(["checkout", "--orphan", `${BRANCH}-new`], work);
  git(["rm", "-rfq", "."], work);
}

try {
  const dir = join(work, "pr", String(pr));
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(file, join(dir, basename(file)));
  git(["add", "."], work);
  if (git(["diff", "--cached", "--quiet"], work, { allowFail: true }).status !== 0) {
    git(["commit", "-qm", `pr-demo: media for #${pr}`], work);
  }
  // Parallel agents publish to the same branch; their files never overlap,
  // so a rebase onto the newer tip always applies cleanly.
  let pushed = false;
  for (let attempt = 0; attempt < 3 && !pushed; attempt += 1) {
    pushed =
      git(["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`], work, { allowFail: true })
        .status === 0;
    if (!pushed) {
      git(["fetch", "origin", `${BRANCH}:refs/remotes/origin/${BRANCH}`], work);
      git(["rebase", "-q", `origin/${BRANCH}`], work);
    }
  }
  if (!pushed) fail(`could not push to ${BRANCH} after 3 attempts`);
} finally {
  git(["worktree", "remove", "--force", work], ".", { allowFail: true });
}

const caption = (file) => {
  const stem = basename(file, extname(file));
  const match = stem.match(/^(\d+)[-_ ]+(.*)$/);
  const words = (match ? match[2] : stem).replace(/[-_]+/g, " ");
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return match ? `${Number(match[1])}. ${text}` : text;
};
const url = (file) =>
  `https://github.com/${slug}/blob/${BRANCH}/pr/${pr}/${encodeURIComponent(basename(file))}?raw=true`;

console.log(
  files
    .map((file) =>
      VIDEO.has(extname(file).toLowerCase())
        ? `▶️ [Walkthrough video: ${caption(file)}](${url(file)})`
        : `**${caption(file)}**\n\n![${caption(file)}](${url(file)})`,
    )
    .join("\n\n"),
);
