// Isolated-worktree materialization of a bundle.
//
// The check never runs in the caller's working tree. It builds a detached git
// worktree at the base commit under the GeneralStaff state directory, applies
// the bundle's tracked patch, copies the bundled untracked files in, and then
// recomputes the gs-patch-digest/v1 digest inside that tree. The recompute
// compared against the digest the caller bound is the guarantee: what is
// verified is, byte for byte, what was bound.
//
// Writes to the caller's repository are limited to git worktree metadata
// (`worktree prune`, `worktree add`, `worktree remove`), exactly what an
// autonomous cycle's own worktree does. The working tree, the index, HEAD and
// every branch are untouched.

import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
} from "fs";
import { rm } from "fs/promises";
import { isAbsolute, join } from "path";
import {
  BundleError,
  readBundle,
  type BundleContents,
} from "./bundle";
import {
  collectChangeset,
  DEFAULT_DIGEST_LIMITS,
  DigestError,
  type ChangesetSnapshot,
  type DigestLimits,
} from "./digest";
import { excludesFilePinArgs } from "./excludes";
import {
  GIT_DIFF_PIN_ARGS,
  pinnedGitEnv,
  runGit,
  scrubLine,
  withoutGitAbort,
} from "./git";
import { VerifyRefusal, toRefusal } from "./refusal";

export interface MaterializeOptions {
  /** Canonical checkout directory (the git top level). */
  checkout: string;
  /** `<state>/<project>/verify/<cycle-id>`; the worktree lives in `tree/`. */
  verifyDir: string;
  base: string;
  bundleDir: string;
  expectedDigest: string;
  /** Normalized exclusions (see normalizeExclude). */
  exclude: string[];
  /**
   * The effective global git excludes file, pinned on every git call that
   * decides the change-set (see excludes.ts). Must match how the bundle was
   * made, or the digest recompute refuses. Null pins "no global excludes".
   */
  /**
   * The resolved global git excludes file to pin (REAL #1), or null when the
   * user has none. Optional: callers that have not resolved it run under the
   * pinned child env, where global config is already nulled — the same
   * effective ignore set as "none".
   */
  globalExcludesFile?: string | null;
  limits?: Partial<DigestLimits>;
  gitTimeoutMs?: number;
}

export interface Materialized {
  treePath: string;
  verifyDir: string;
  bundle: BundleContents;
  /** The digest input recomputed inside the worktree; equals the bound digest. */
  snapshot: ChangesetSnapshot;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** True when `base` names a commit object in the checkout. */
export async function baseIsCommit(
  checkout: string,
  base: string,
  timeoutMs?: number,
): Promise<boolean> {
  const r = await runGit(["cat-file", "-e", `${base}^{commit}`], {
    cwd: checkout,
    timeoutMs,
    maxStdoutBytes: 1024,
  });
  return r.code === 0;
}

/** True when `checkout` is the top level of a git work tree. */
export async function isGitTopLevel(
  checkout: string,
  realpathOf: (p: string) => string,
  timeoutMs?: number,
): Promise<boolean> {
  const r = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: checkout,
    timeoutMs,
    maxStdoutBytes: 64 * 1024,
  });
  if (r.code !== 0) return false;
  try {
    return realpathOf(r.stdout.toString("utf8").trim()) === realpathOf(checkout);
  } catch {
    return false;
  }
}

/** Paths a patch would touch, from `git apply --numstat -z`. */
export function parseNumstatZ(out: string): string[] {
  const tokens = out.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]!);
    if (!m) continue;
    if (m[3] === "") {
      // Rename or copy: the next two tokens are the old and new path.
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath !== undefined) paths.push(oldPath);
      if (newPath !== undefined) paths.push(newPath);
      i += 2;
    } else {
      paths.push(m[3]!);
    }
  }
  return paths;
}

function assertPatchPathSafe(path: string): void {
  const segments = path.split(/[\\/]/);
  if (
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((s) => s === ".." || s === "." || s.toLowerCase() === ".git")
  ) {
    throw new VerifyRefusal(
      "bundle_escapes",
      `the patch touches a path outside the worktree: ${scrubLine(path, 80)}`,
    );
  }
}

/**
 * Copy the bundle's untracked files into the tree, refusing symlinks,
 * conflicts with existing paths, and any parent component that is not a
 * plain directory.
 */
function copyBundleFiles(bundle: BundleContents, tree: string): void {
  if (bundle.filesDir === null) return;
  for (const rel of bundle.files) {
    const segments = rel.split("/");
    let cursor = tree;
    for (const seg of segments.slice(0, -1)) {
      cursor = join(cursor, seg);
      let st;
      try {
        st = lstatSync(cursor);
      } catch {
        mkdirSync(cursor);
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new VerifyRefusal(
          "bundle_escapes",
          `a bundled file would be written through a non-directory: ${scrubLine(rel, 80)}`,
        );
      }
    }
    const dest = join(cursor, segments[segments.length - 1]!);
    if (existsSync(dest) || isDanglingLink(dest)) {
      throw new VerifyRefusal(
        "bundle_escapes",
        `a bundled file collides with an existing path: ${scrubLine(rel, 80)}`,
      );
    }
    const src = join(bundle.filesDir, ...segments);
    copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
    chmodSync(dest, statSync(src).mode & 0o777);
  }
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Each cleanup step (worktree remove, directory removal, prune) gets this long. */
export const CLEANUP_STEP_MS = 10_000;
/** Cleanup runs three steps, so it is bounded by three step budgets. */
export const CLEANUP_CAP_SEC = (3 * CLEANUP_STEP_MS) / 1000;

async function boundedStep(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove the worktree and its directory. Never throws; returns whether it is
 * gone. Bounded: at most three steps of `stepMs` each. Runs outside any git
 * abort context, so it still works after the check's own git was stopped.
 */
export function removeVerifyTree(
  checkout: string,
  verifyDir: string,
  stepMs: number = CLEANUP_STEP_MS,
): Promise<boolean> {
  // git's own timer fires (and kills its group) before the step's race ends.
  const gitStepMs = Math.max(100, stepMs - 500);
  return withoutGitAbort(async () => {
    const tree = join(verifyDir, "tree");
    if (existsSync(tree)) {
      await boundedStep(
        runGit(["worktree", "remove", "--force", tree], {
          cwd: checkout,
          maxStdoutBytes: 64 * 1024,
          timeoutMs: gitStepMs,
        }),
        stepMs,
      );
    }
    await boundedStep(rm(verifyDir, { recursive: true, force: true }), stepMs);
    await boundedStep(
      runGit(["worktree", "prune"], {
        cwd: checkout,
        maxStdoutBytes: 64 * 1024,
        timeoutMs: gitStepMs,
      }),
      stepMs,
    );
    return !existsSync(verifyDir);
  });
}

/**
 * Build the isolated tree and prove it reproduces the bound digest.
 * Throws VerifyRefusal (nothing is left behind) on every failure.
 */
export async function materializeSnapshot(
  opts: MaterializeOptions,
): Promise<Materialized> {
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...opts.limits };
  const excludesPin = excludesFilePinArgs(opts.globalExcludesFile ?? null);
  const tree = join(opts.verifyDir, "tree");
  let created = false;
  try {
    let bundle: BundleContents;
    try {
      bundle = readBundle(opts.bundleDir, limits);
    } catch (err) {
      throw toRefusal(err);
    }

    mkdirSync(opts.verifyDir, { recursive: true, mode: 0o700 });
    created = true;

    await runGit([...excludesPin, "worktree", "prune"], {
      cwd: opts.checkout,
      timeoutMs: opts.gitTimeoutMs,
      maxStdoutBytes: 64 * 1024,
    });
    const add = await runGit(
      [...excludesPin, "worktree", "add", "--detach", tree, opts.base],
      {
      cwd: opts.checkout,
      timeoutMs: opts.gitTimeoutMs,
      maxStdoutBytes: 1024 * 1024,
    });
    if (add.code !== 0) {
      throw new VerifyRefusal(
        "materialize_failed",
        `could not create the isolated worktree: ${scrubLine(add.stderr || `git exited ${add.code}`, 160)}`,
      );
    }

    if (bundle.patchBytes > 0) {
      const gitEnv = pinnedGitEnv();
      const listed = await runGit(
        [...excludesPin, "apply", "--numstat", "-z", "--", bundle.patchPath],
        {
        cwd: tree,
        env: gitEnv,
        timeoutMs: opts.gitTimeoutMs,
        maxStdoutBytes: 16 * 1024 * 1024,
      });
      if (listed.code !== 0) {
        throw new VerifyRefusal(
          "bundle_unreadable",
          `diff.patch is not a valid patch: ${scrubLine(listed.stderr, 160)}`,
        );
      }
      for (const p of parseNumstatZ(listed.stdout.toString("utf8"))) {
        assertPatchPathSafe(p);
      }
      const applied = await runGit(
        [
          ...excludesPin,
          "apply",
          "--index",
          "--whitespace=nowarn",
          "--",
          bundle.patchPath,
        ],
        {
          cwd: tree,
          env: gitEnv,
          timeoutMs: opts.gitTimeoutMs,
          maxStdoutBytes: 1024 * 1024,
        },
      );
      if (applied.code !== 0) {
        throw new VerifyRefusal(
          "materialize_failed",
          `diff.patch does not apply to the base revision: ${scrubLine(applied.stderr, 160)}`,
        );
      }
    }

    copyBundleFiles(bundle, tree);

    let snapshot: ChangesetSnapshot;
    try {
      snapshot = await collectChangeset({
        cwd: tree,
        base: opts.base,
        exclude: opts.exclude,
        globalExcludesFile: opts.globalExcludesFile ?? null,
        limits,
        gitTimeoutMs: opts.gitTimeoutMs,
      });
    } catch (err) {
      throw toRefusal(err);
    }

    if (snapshot.digest !== opts.expectedDigest) {
      throw new VerifyRefusal(
        "digest_mismatch",
        "the bundle does not reproduce the expected digest; the recorded snapshot did not match",
      );
    }
    // Every bundled file must be a real member of the change-set. A file that
    // git ignores would sit in the tree without being bound by the digest.
    const claimed = snapshot.untracked.map((u) => u.path).sort(compareBytes);
    const shipped = [...bundle.files].sort(compareBytes);
    if (
      claimed.length !== shipped.length ||
      claimed.some((p, i) => p !== shipped[i])
    ) {
      throw new VerifyRefusal(
        "bundle_extra_files",
        "the bundle holds files that are not part of the change-set",
      );
    }
    if (snapshot.diff.length === 0 && snapshot.untracked.length === 0) {
      throw new VerifyRefusal("empty_patch", "this change is empty");
    }
    return { treePath: tree, verifyDir: opts.verifyDir, bundle, snapshot };
  } catch (err) {
    if (created) await removeVerifyTree(opts.checkout, opts.verifyDir);
    const mapped = toRefusal(err);
    if (mapped instanceof VerifyRefusal) throw mapped;
    if (err instanceof BundleError || err instanceof DigestError) throw mapped;
    throw new VerifyRefusal(
      "materialize_failed",
      `could not materialize the snapshot: ${scrubLine(
        err instanceof Error ? err.message : String(err),
        160,
      )}`,
    );
  }
}

export interface ReviewDiff {
  /** Human-readable full diff, including untracked files as added files. */
  diff: string;
  stat: string;
  /** `git diff --name-status -z` output. */
  nameStatusZ: string;
}

/**
 * Render the change for the reviewer and the evidence directory, inside the
 * throwaway tree (untracked files are marked intent-to-add so they show as
 * added files). Call AFTER the digest recompute; it changes the tree's index.
 */
export async function renderReviewDiff(
  tree: string,
  base: string,
  timeoutMs?: number,
  globalExcludesFile: string | null = null,
): Promise<ReviewDiff> {
  const env = pinnedGitEnv();
  const excludesPin = excludesFilePinArgs(globalExcludesFile);
  const add = await runGit([...excludesPin, "add", "-A", "-N", "--", "."], {
    cwd: tree,
    env,
    timeoutMs,
    maxStdoutBytes: 1024 * 1024,
  });
  if (add.code !== 0) {
    throw new VerifyRefusal(
      "materialize_failed",
      `could not stage the change for review: ${scrubLine(add.stderr, 160)}`,
    );
  }
  const run = async (extra: string[]): Promise<Buffer> => {
    const r = await runGit(
      [
        ...GIT_DIFF_PIN_ARGS,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...extra,
        base,
        "--",
      ],
      { cwd: tree, env, timeoutMs, maxStdoutBytes: 16 * 1024 * 1024 },
    );
    if (r.code !== 0 || r.truncated) {
      throw new VerifyRefusal(
        "materialize_failed",
        "could not render the change for review",
      );
    }
    return r.stdout;
  };
  const [diff, stat, nameStatus] = await Promise.all([
    run([]),
    run(["--stat"]),
    run(["--name-status", "-z"]),
  ]);
  return {
    diff: diff.toString("utf8"),
    stat: stat.toString("utf8").trim(),
    nameStatusZ: nameStatus.toString("utf8"),
  };
}
