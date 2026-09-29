// Patch bundle: a frozen, self-contained snapshot of an uncommitted change-set.
//
//   <bundle>/diff.patch   tracked side, `git diff --binary` against the base
//                         commit (transport form, applied with git apply)
//   <bundle>/files/...    a byte copy of every untracked, non-ignored,
//                         non-excluded file at its repo-relative path
//
// A bundle carries no digest and no identity of its own: whoever asks for a
// check names the expected gs-patch-digest/v1 digest, and the check
// recomputes it from the materialized tree. A bundle that was altered, cut
// short or padded therefore recomputes to a different digest and is refused.
//
// `writeBundle` (the standalone `generalstaff changeset bundle` helper) reads
// the checkout and writes only inside the output directory.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import {
  assertPlainAbsolutePath,
  collectChangeset,
  DEFAULT_DIGEST_LIMITS,
  DigestError,
  normalizeExclude,
  PATCH_DIGEST_ALGORITHM,
  transportDiffArgs,
  withPrivateIndex,
  type DigestErrorCode,
  type DigestLimits,
} from "./digest";
import { runGit } from "./git";

export type BundleErrorCode =
  | DigestErrorCode
  | "out_invalid"
  | "empty_patch"
  | "snapshot_unstable"
  | "bundle_missing"
  | "bundle_empty"
  | "bundle_unreadable"
  | "bundle_escapes";

export class BundleError extends Error {
  constructor(
    public readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/** Largest transport patch a bundle may carry (binary changes included). */
export const MAX_BUNDLE_PATCH_BYTES = 256 * 1024 * 1024;

export interface BundleWriteOptions {
  checkout: string;
  base: string;
  outDir: string;
  exclude?: readonly string[];
  limits?: Partial<DigestLimits>;
  gitTimeoutMs?: number;
}

export interface BundleInfo {
  bundlePath: string;
  digest: string;
  digestAlgorithm: typeof PATCH_DIGEST_ALGORITHM;
  baseRevision: string;
  excludedPaths: string[];
  untrackedFileCount: number;
  patchBytes: number;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function isDirectoryNoFollow(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Snapshot the change-set in `checkout` (against `base`) into `outDir`.
 * Read-only against the checkout. Refuses an empty change-set, a non-empty
 * output directory, and an output directory inside the checkout.
 */
export async function writeBundle(opts: BundleWriteOptions): Promise<BundleInfo> {
  assertPlainAbsolutePath(opts.checkout, "checkout path");
  assertPlainAbsolutePath(opts.outDir, "output path");
  let checkoutReal: string;
  try {
    checkoutReal = realpathSync(opts.checkout);
    if (!statSync(checkoutReal).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new BundleError("checkout_invalid", "checkout path is not a directory");
  }
  const exclude = normalizeExclude(opts.exclude);
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...opts.limits };

  // Resolve the output location without following a symlink at the leaf.
  const outParent = resolve(dirname(opts.outDir));
  let outParentReal: string;
  try {
    outParentReal = realpathSync(outParent);
  } catch {
    outParentReal = outParent;
  }
  const outResolved = join(outParentReal, basename(opts.outDir));
  if (isInside(checkoutReal, outResolved)) {
    throw new BundleError(
      "out_invalid",
      "the output directory must be outside the checkout",
    );
  }

  let createdOut = false;
  if (existsSync(opts.outDir)) {
    if (!isDirectoryNoFollow(opts.outDir)) {
      throw new BundleError("out_invalid", "the output path is not a directory");
    }
    if (readdirSync(opts.outDir).length > 0) {
      throw new BundleError("out_invalid", "the output directory is not empty");
    }
  } else {
    mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
    createdOut = true;
  }

  const filesDir = join(opts.outDir, "files");
  const patchPath = join(opts.outDir, "diff.patch");
  const cleanup = () => {
    if (createdOut) {
      rmSync(opts.outDir, { recursive: true, force: true });
    } else {
      rmSync(filesDir, { recursive: true, force: true });
      rmSync(patchPath, { force: true });
    }
  };

  try {
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    const first = await collectChangeset({
      cwd: checkoutReal,
      base: opts.base,
      exclude,
      limits,
      copyFilesTo: filesDir,
      gitTimeoutMs: opts.gitTimeoutMs,
    });
    if (first.diff.length === 0 && first.untracked.length === 0) {
      throw new BundleError("empty_patch", "this change is empty");
    }

    // Transport form of the tracked side (binary-capable).
    const transport = await withPrivateIndex(
      checkoutReal,
      opts.gitTimeoutMs,
      (env) =>
        runGit(transportDiffArgs(opts.base, exclude), {
          cwd: checkoutReal,
          env,
          timeoutMs: opts.gitTimeoutMs,
          maxStdoutBytes: MAX_BUNDLE_PATCH_BYTES,
        }),
    );
    if (transport.truncated) {
      throw new BundleError("diff_too_large", "the tracked patch is too large to bundle");
    }
    if (transport.code !== 0) {
      throw new BundleError(
        "git_failed",
        `git diff --binary exited with code ${transport.code}`,
      );
    }
    writeFileSync(patchPath, transport.stdout, { mode: 0o600 });

    // The checkout must not have moved while the snapshot was taken.
    const second = await collectChangeset({
      cwd: checkoutReal,
      base: opts.base,
      exclude,
      limits,
      gitTimeoutMs: opts.gitTimeoutMs,
    });
    if (second.digest !== first.digest) {
      throw new BundleError(
        "snapshot_unstable",
        "the checkout changed while the snapshot was being taken",
      );
    }

    return {
      bundlePath: opts.outDir,
      digest: first.digest,
      digestAlgorithm: PATCH_DIGEST_ALGORITHM,
      baseRevision: opts.base,
      excludedPaths: first.excluded,
      untrackedFileCount: first.untracked.length,
      patchBytes: transport.stdout.length,
    };
  } catch (err) {
    cleanup();
    if (err instanceof BundleError) throw err;
    if (err instanceof DigestError) throw new BundleError(err.code, err.message);
    throw err;
  }
}

export interface BundleContents {
  dir: string;
  patchPath: string;
  patchBytes: number;
  /** Absolute path of `files/`, or null when the bundle has none. */
  filesDir: string | null;
  /** Sorted repo-relative paths (forward slashes) of every file under files/. */
  files: string[];
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function walkFiles(root: string, limits: DigestLimits): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      if (entry.name.toLowerCase() === ".git") {
        throw new BundleError(
          "bundle_escapes",
          "the bundle contains a .git entry",
        );
      }
      if (/[\u0000-\u001f\u007f]/.test(entry.name)) {
        throw new BundleError(
          "bundle_unreadable",
          "the bundle contains a file name with a control character",
        );
      }
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        throw new BundleError("bundle_escapes", `the bundle contains a symlink: ${childRel}`);
      }
      if (st.isDirectory()) {
        visit(childAbs, childRel);
      } else if (st.isFile()) {
        if (st.size > limits.maxUntrackedFileBytes) {
          throw new BundleError(
            "file_too_large",
            `a bundled file exceeds the size cap: ${childRel}`,
          );
        }
        out.push(childRel);
        if (out.length > limits.maxUntrackedFiles) {
          throw new BundleError(
            "too_many_untracked",
            `the bundle holds more than ${limits.maxUntrackedFiles} files`,
          );
        }
      } else {
        throw new BundleError(
          "bundle_escapes",
          `the bundle contains a non-regular entry: ${childRel}`,
        );
      }
    }
  };
  visit(root, "");
  return out.sort(compareBytes);
}

/** Read and structurally validate a bundle directory. Never writes. */
export function readBundle(
  bundleDir: string,
  limitOverrides: Partial<DigestLimits> = {},
): BundleContents {
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...limitOverrides };
  let dirStat;
  try {
    dirStat = lstatSync(bundleDir);
  } catch {
    throw new BundleError("bundle_missing", "the bundle directory does not exist");
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new BundleError("bundle_unreadable", "the bundle path is not a directory");
  }
  let names: string[];
  try {
    names = readdirSync(bundleDir);
  } catch {
    throw new BundleError("bundle_unreadable", "the bundle directory cannot be read");
  }
  if (names.length === 0) {
    throw new BundleError("bundle_empty", "the bundle directory is empty");
  }

  const patchPath = join(bundleDir, "diff.patch");
  let patchStat;
  try {
    patchStat = lstatSync(patchPath);
  } catch {
    throw new BundleError("bundle_missing", "the bundle has no diff.patch");
  }
  if (patchStat.isSymbolicLink() || !patchStat.isFile()) {
    throw new BundleError("bundle_unreadable", "diff.patch is not a regular file");
  }
  if (patchStat.size > MAX_BUNDLE_PATCH_BYTES) {
    throw new BundleError("diff_too_large", "diff.patch exceeds the size cap");
  }

  const filesPath = join(bundleDir, "files");
  let filesDir: string | null = null;
  let files: string[] = [];
  if (names.includes("files")) {
    const filesStat = lstatSync(filesPath);
    if (filesStat.isSymbolicLink() || !filesStat.isDirectory()) {
      throw new BundleError("bundle_escapes", "files/ is not a plain directory");
    }
    filesDir = filesPath;
    files = walkFiles(filesPath, limits);
  }
  return {
    dir: bundleDir,
    patchPath,
    patchBytes: patchStat.size,
    filesDir,
    files,
  };
}
