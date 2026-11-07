// Regression guard (v0.18.1): a test run must never commit to, or change the
// index of, the checkout it runs from.
//
// Loaded by bunfig.toml as a test preload. It snapshots HEAD and the index of
// this checkout when the run starts, and the hook below fails the run if
// either has changed by the end. Subprocess helpers do not load the preload
// themselves; the end-state check catches what they did. It is skipped when
// this directory is not the top level of its own checkout (for example a
// source tarball unpacked inside another repository). Before v0.18.1 a test whose root sat under
// tests/fixtures/ made the state auto-commit sweep a developer's staged work
// into a "state: cycle ..." commit.
//
// Set GENERALSTAFF_SKIP_CHECKOUT_GUARD=1 to turn it off (for example when you
// commit on purpose while a long run is going).

import { afterAll } from "bun:test";
import { createHash } from "crypto";
import { join } from "path";

const REPO = join(import.meta.dir, "..", "..");

function git(args: string[]): string | null {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const r = Bun.spawnSync(["git", "-C", REPO, ...args], { stdout: "pipe", stderr: "ignore", env });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** HEAD sha plus a hash of the staged index entries, or null outside a checkout. */
export function checkoutSnapshot(): { head: string; index: string } | null {
  if (git(["rev-parse", "--show-prefix"])?.trim() !== "") return null;
  const head = git(["rev-parse", "HEAD"]);
  const index = git(["ls-files", "--stage"]);
  if (head === null || index === null) return null;
  return { head: head.trim(), index: createHash("sha256").update(index).digest("hex") };
}

const before = process.env.GENERALSTAFF_SKIP_CHECKOUT_GUARD === "1" ? null : checkoutSnapshot();

if (before) {
  afterAll(() => {
    const after = checkoutSnapshot();
    if (!after) return;
    if (after.head !== before.head) {
      throw new Error(
        `A test committed to the real checkout: HEAD moved ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}. ` +
          "Point the test's root at a temp dir (tests/helpers/temp_dir.ts).",
      );
    }
    if (after.index !== before.index) {
      throw new Error("A test changed the real checkout's git index. Point the test's root at a temp dir.");
    }
  });
}
