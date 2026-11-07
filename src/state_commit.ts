// GeneralStaff: commit the dispatcher's own state/ changes (v0.18.1)
//
// The cycle, session-init and session-end paths each commit state/ in the
// GeneralStaff root so PROGRESS.jsonl and friends travel with the repo. Before
// v0.18.1 they ran `git add state/` and then committed the WHOLE index, which
// had two bad results:
//   - anything else the user had staged was swept into a "state: ..." commit;
//   - when the root was not a git repo of its own but sat inside one (every
//     test helper that points getRootDir() at a folder under tests/fixtures/),
//     git walked up and committed the enclosing repo's index.
// Now the commit only ever touches state/, and only when the root is the top
// level of its own repository.

import { $ } from "bun";

/** The environment for these git calls, without variables that would point
 *  git at a different repository, work tree or index than `root`. */
function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[k];
  return env;
}

/** True when `root` is the top-level directory of a git work tree. Asks git
 *  for the root's path prefix inside its work tree (empty at the top level)
 *  rather than comparing path strings, which differ across platforms. */
export async function isOwnRepoTopLevel(root: string): Promise<boolean> {
  return (await rootRepoPrefix(root)) === "";
}

/** The root's path inside its git work tree: "" at the top level, null when
 *  the root is in no repository at all. */
async function rootRepoPrefix(root: string): Promise<string | null> {
  const r = await $`git -C ${root} rev-parse --show-prefix`.env(gitEnv()).quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** Stage and commit changes under `root/state/` and nothing else.
 *  Returns true when a commit was made. Never throws. */
export async function commitRootState(root: string, message: string): Promise<boolean> {
  try {
    const prefix = await rootRepoPrefix(root);
    if (prefix === null) return false; // not under git at all: nothing to do
    if (prefix !== "") {
      console.log(`State commit skipped: ${root} sits inside another git repository, not at its top level.`);
      return false;
    }
    const env = gitEnv();
    await $`git -C ${root} add --ignore-errors -- state/`.env(env).quiet().nothrow();
    const staged = await $`git -C ${root} diff --cached --quiet -- state/`.env(env).quiet().nothrow();
    if (staged.exitCode === 0) return false;
    // A pathspec commit records only state/; other staged paths stay staged
    // and uncommitted.
    await $`git -C ${root} commit -m ${message} -- state/`.env(env).quiet();
    return true;
  } catch {
    return false;
  }
}
