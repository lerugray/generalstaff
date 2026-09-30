// gs-patch-digest/v1 — the identity of an uncommitted change-set.
//
// The digest is `sha256:` over the bytes `D ++ U`:
//
//   D  the pinned `git diff --full-index` of the working tree against a base
//      commit (tracked side, staged and unstaged together);
//   U  one two-line record per untracked, non-ignored file, sorted by the
//      UTF-8 bytes of its path:
//          gs-untracked-file: <path>\n
//          gs-content-sha256:<hex sha256 of the file bytes>\n
//
// The full contract, with its vectors, is docs/contracts/gs-patch-digest-v1.md
// and tests/fixtures/gs-patch-digest-v1/vectors.json. Anything that binds a
// change-set to a check must reproduce the vectors byte for byte.
//
// Everything here is read-only against the checkout: git runs against a
// private copy of the index (a plain `git diff` refreshes and rewrites the
// real one), untracked files are opened without following symlinks, and
// nothing is created, moved or deleted in the checkout.

import { createHash } from "crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { PATCH_DIGEST_ALGORITHM } from "./constants";
import { excludesFilePinArgs } from "./excludes";
import {
  GIT_DIFF_PIN_ARGS,
  pinnedGitEnv,
  runGit,
  type GitResult,
} from "./git";

export { PATCH_DIGEST_ALGORITHM };

export interface DigestLimits {
  /** Largest tracked-side diff kept (bytes). Larger is refused, not cut. */
  maxDiffBytes: number;
  /** Most untracked files folded into one digest. */
  maxUntrackedFiles: number;
  /** Largest single untracked file (bytes). Larger is refused, not cut. */
  maxUntrackedFileBytes: number;
}

export const DEFAULT_DIGEST_LIMITS: DigestLimits = {
  maxDiffBytes: 8 * 1024 * 1024,
  maxUntrackedFiles: 4096,
  maxUntrackedFileBytes: 64 * 1024 * 1024,
};

export type DigestErrorCode =
  | "checkout_invalid"
  | "revision_invalid"
  | "exclude_invalid"
  | "git_missing"
  | "git_failed"
  | "git_timeout"
  | "diff_too_large"
  | "too_many_untracked"
  | "file_too_large"
  | "untracked_symlink"
  | "untracked_unreadable"
  | "untracked_path_invalid"
  | "path_not_utf8"
  | "copy_failed";

export class DigestError extends Error {
  constructor(
    public readonly code: DigestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DigestError";
  }
}

export interface UntrackedEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface ChangesetSnapshot {
  /** `sha256:<64 hex>` over `digestInput`. */
  digest: string;
  /** `D ++ U`: the exact bytes that were hashed. */
  digestInput: Buffer;
  /** D: the tracked-side diff bytes. */
  diff: Buffer;
  /** U: the untracked section text. */
  section: string;
  untracked: UntrackedEntry[];
  /** Normalized, sorted, de-duplicated exclusions that were applied. */
  excluded: string[];
}

export interface CollectChangesetOptions {
  /** Absolute, traversal-free checkout directory (the git top level). */
  cwd: string;
  /** Base commit: 7-64 hex characters. */
  base: string;
  exclude?: readonly string[];
  /**
   * The effective global git excludes file, pinned on every git call that
   * decides the change-set (see excludes.ts). `undefined` or null pins the
   * null device: no global excludes. Entry points (bundle, verify) resolve it
   * once and pass it down; direct callers get a hermetic "none".
   */
  globalExcludesFile?: string | null;
  limits?: Partial<DigestLimits>;
  /** When set, each untracked file is also copied to `<copyFilesTo>/<path>`. */
  copyFilesTo?: string;
  gitTimeoutMs?: number;
}

const BASE_RE = /^[0-9a-fA-F]{7,64}$/;

export function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Absolute, no NUL, no `.`/`..` segments. Returns the path unchanged. */
export function assertPlainAbsolutePath(path: string, what: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    path.split(/[\\/]/).some((seg) => seg === "." || seg === "..")
  ) {
    throw new DigestError(
      "checkout_invalid",
      `${what} is not an absolute, traversal-free path`,
    );
  }
  return path;
}

/**
 * Normalize exclusion paths: repo-relative, forward slashes, no `.`/`..`
 * segments, one trailing slash tolerated. Sorted by UTF-8 bytes, de-duplicated.
 */
export function normalizeExclude(list: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      throw new DigestError("exclude_invalid", "an exclusion path is empty");
    }
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      throw new DigestError(
        "exclude_invalid",
        "an exclusion path contains a control character",
      );
    }
    let p = raw.replace(/\\/g, "/");
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (
      p.length === 0 ||
      p.startsWith("/") ||
      /^[A-Za-z]:/.test(p) ||
      p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      throw new DigestError(
        "exclude_invalid",
        `exclusion "${raw}" is not a clean repo-relative path`,
      );
    }
    out.add(p);
  }
  return [...out].sort(compareBytes);
}

/** An exclusion hides only its own path and paths below it, never an ancestor. */
export function pathExcluded(path: string, exclude: readonly string[]): boolean {
  return exclude.some((item) => path === item || path.startsWith(`${item}/`));
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function buildUntrackedSection(entries: readonly UntrackedEntry[]): string {
  let section = "";
  for (const e of entries) {
    section += `gs-untracked-file: ${e.path}\n`;
    section += `gs-content-sha256:${e.sha256}\n`;
  }
  return section;
}

function gitFailure(what: string, r: GitResult): DigestError {
  if (r.spawnError !== undefined) {
    return new DigestError("git_missing", `git could not be started (${what})`);
  }
  if (r.timedOut) {
    return new DigestError("git_timeout", `git did not finish in time (${what})`);
  }
  return new DigestError(
    "git_failed",
    `git ${what} exited with code ${r.code}${
      r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ""
    }`,
  );
}

/** Pathspec tail for a diff: whole tree minus the exclusions. */
export function diffPathspec(exclude: readonly string[]): string[] {
  if (exclude.length === 0) return [];
  return [".", ...exclude.map((p) => `:(exclude,literal)${p}`)];
}

/** Argv (after the hardening pins) for the digest-form diff, D. */
export function digestDiffArgs(base: string, exclude: readonly string[]): string[] {
  return [
    ...GIT_DIFF_PIN_ARGS,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    base,
    "--",
    ...diffPathspec(exclude),
  ];
}

/** Argv for the transport-form diff: binary-capable, applicable with git apply. */
export function transportDiffArgs(base: string, exclude: readonly string[]): string[] {
  return [
    ...GIT_DIFF_PIN_ARGS,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    base,
    "--",
    ...diffPathspec(exclude),
  ];
}

/**
 * Run `fn` with git pointed at a private copy of the checkout's index, so
 * that git's opportunistic index refresh can never write to the real one.
 */
export async function withPrivateIndex<T>(
  cwd: string,
  timeoutMs: number | undefined,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const located = await runGit(["rev-parse", "--git-path", "index"], {
    cwd,
    timeoutMs,
    maxStdoutBytes: 64 * 1024,
  });
  if (located.code !== 0) throw gitFailure("rev-parse --git-path index", located);
  const indexPath = resolve(cwd, located.stdout.toString("utf8").trim());
  const dir = mkdtempSync(join(tmpdir(), "gs-index-"));
  try {
    const privateIndex = join(dir, "index");
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, privateIndex);
      // Keep the original index timestamps. Git compares an entry by content ("racily clean") only when its
      // mtime is not older than the index file's; a copy with a fresh mtime makes git trust stale stat data
      // and miss a same-size edit made within the same second as the last index write.
      const stamp = statSync(indexPath);
      utimesSync(privateIndex, stamp.atime, stamp.mtime);
    }
    return await fn(pinnedGitEnv({ GIT_INDEX_FILE: privateIndex }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function decodeUtf8Strict(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Split `git ls-files -z` output into raw paths (UTF-8 required). */
function parseLsFilesZ(stdout: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i === stdout.length || stdout[i] === 0) {
      if (i > start) {
        const text = decodeUtf8Strict(stdout.subarray(start, i));
        if (text === null) {
          throw new DigestError(
            "path_not_utf8",
            "an untracked path is not valid UTF-8",
          );
        }
        paths.push(text);
      }
      start = i + 1;
    }
  }
  return paths;
}

function checkUntrackedPath(path: string): void {
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    // A newline in a path would let two files forge each other's records.
    throw new DigestError(
      "untracked_path_invalid",
      "an untracked path contains a control character",
    );
  }
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((seg) => seg === ".." || seg === ".")
  ) {
    throw new DigestError(
      "untracked_path_invalid",
      "an untracked path is not repo-relative",
    );
  }
  if (path.endsWith("/")) {
    throw new DigestError(
      "untracked_unreadable",
      "an untracked entry is a directory (nested repository?)",
    );
  }
}

const READ_CHUNK = 64 * 1024;

/**
 * Hash one untracked file without following a symlink. The symlink refusal is
 * enforced by the open itself (O_NOFOLLOW), so a link swapped in after the
 * lstat is still refused. Optionally copies the bytes it hashed.
 */
function hashUntrackedFile(
  root: string,
  rel: string,
  limits: DigestLimits,
  copyRoot: string | undefined,
): { sha256: string; size: number } {
  const full = join(root, ...rel.split("/"));
  let lst;
  try {
    lst = lstatSync(full);
  } catch {
    throw new DigestError(
      "untracked_unreadable",
      `untracked file vanished or is unreadable: ${rel}`,
    );
  }
  if (lst.isSymbolicLink()) {
    throw new DigestError("untracked_symlink", `untracked symlink refused: ${rel}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(full, fsConstants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new DigestError(
        "untracked_symlink",
        `untracked symlink refused: ${rel}`,
      );
    }
    throw new DigestError(
      "untracked_unreadable",
      `untracked file could not be opened: ${rel}`,
    );
  }
  let destFd: number | undefined;
  let destPath: string | undefined;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new DigestError(
        "untracked_unreadable",
        `untracked entry is not a regular file: ${rel}`,
      );
    }
    if (st.size > limits.maxUntrackedFileBytes) {
      throw new DigestError(
        "file_too_large",
        `untracked file exceeds the ${limits.maxUntrackedFileBytes} byte cap: ${rel}`,
      );
    }
    if (copyRoot !== undefined) {
      destPath = join(copyRoot, ...rel.split("/"));
      mkdirSync(dirname(destPath), { recursive: true });
      destFd = openSync(destPath, "wx", st.mode & 0o777);
    }
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n === 0) break;
      total += n;
      if (total > limits.maxUntrackedFileBytes) {
        throw new DigestError(
          "file_too_large",
          `untracked file exceeds the ${limits.maxUntrackedFileBytes} byte cap: ${rel}`,
        );
      }
      hash.update(buf.subarray(0, n));
      if (destFd !== undefined) writeSync(destFd, buf, 0, n);
    }
    return { sha256: hash.digest("hex"), size: total };
  } catch (err) {
    if (destFd !== undefined) {
      try {
        closeSync(destFd);
      } catch {
        /* already closed */
      }
      destFd = undefined;
      if (destPath !== undefined) rmSync(destPath, { force: true });
    }
    if (err instanceof DigestError) throw err;
    throw new DigestError(
      "copy_failed",
      `could not read or copy untracked file ${rel}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    closeSync(fd);
    if (destFd !== undefined) closeSync(destFd);
  }
}

/**
 * Compute D, U and the digest for the change-set in `cwd` against `base`.
 * Read-only against the checkout.
 */
export async function collectChangeset(
  opts: CollectChangesetOptions,
): Promise<ChangesetSnapshot> {
  assertPlainAbsolutePath(opts.cwd, "checkout path");
  let isDir = false;
  try {
    isDir = lstatSync(opts.cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new DigestError("checkout_invalid", "checkout path is not a directory");
  }
  if (!BASE_RE.test(opts.base)) {
    throw new DigestError(
      "revision_invalid",
      "base revision is not a plain hex object name",
    );
  }
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...opts.limits };
  const exclude = normalizeExclude(opts.exclude);
  const excludesPin = excludesFilePinArgs(opts.globalExcludesFile ?? null);

  return withPrivateIndex(opts.cwd, opts.gitTimeoutMs, async (env) => {
    const diffRun = await runGit([...excludesPin, ...digestDiffArgs(opts.base, exclude)], {
      cwd: opts.cwd,
      env,
      timeoutMs: opts.gitTimeoutMs,
      maxStdoutBytes: limits.maxDiffBytes,
    });
    if (diffRun.truncated) {
      throw new DigestError(
        "diff_too_large",
        `tracked diff exceeds the ${limits.maxDiffBytes} byte cap`,
      );
    }
    if (diffRun.code !== 0) throw gitFailure("diff", diffRun);

    const listed = await runGit(
      [...excludesPin, "ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: opts.cwd,
        env,
        timeoutMs: opts.gitTimeoutMs,
        maxStdoutBytes: Math.max(limits.maxDiffBytes, 8 * 1024 * 1024),
      },
    );
    if (listed.truncated) {
      throw new DigestError("too_many_untracked", "untracked file list is too large");
    }
    if (listed.code !== 0) throw gitFailure("ls-files", listed);

    const paths = [...new Set(parseLsFilesZ(listed.stdout))]
      .filter((p) => !pathExcluded(p.replace(/\/$/, ""), exclude))
      .sort(compareBytes);
    if (paths.length > limits.maxUntrackedFiles) {
      throw new DigestError(
        "too_many_untracked",
        `more than ${limits.maxUntrackedFiles} untracked files`,
      );
    }
    const untracked: UntrackedEntry[] = [];
    for (const path of paths) {
      checkUntrackedPath(path);
      const { sha256, size } = hashUntrackedFile(
        opts.cwd,
        path,
        limits,
        opts.copyFilesTo,
      );
      untracked.push({ path, sha256, size });
    }
    const section = buildUntrackedSection(untracked);
    const digestInput = Buffer.concat([diffRun.stdout, Buffer.from(section, "utf8")]);
    return {
      digest: digestOfBytes(digestInput),
      digestInput,
      diff: diffRun.stdout,
      section,
      untracked,
      excluded: exclude,
    };
  });
}
