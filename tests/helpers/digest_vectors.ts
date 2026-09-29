// Builder and independent oracle for the gs-patch-digest/v1 vectors.
//
// The vector file (tests/fixtures/gs-patch-digest-v1/vectors.json) is
// language-neutral: each vector describes a base commit, a list of working-tree
// steps, and what any correct implementation must produce. `buildVectorRepo`
// turns one vector into a real repository. `oracleDigest` recomputes the digest
// straight from git and sha256 with a hard-coded argument list, sharing no code
// with src/verify_only, so a bug in the implementation cannot also be in the
// oracle.

import { createHash } from "crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { git } from "./verify_only_fixture";

export interface VectorFile {
  base: { path: string; text?: string; base64?: string }[];
}

export type VectorStep =
  | { op: "write"; path: string; text?: string; base64?: string }
  | { op: "delete"; path: string }
  | { op: "stage"; path: string }
  | { op: "rename"; from: string; to: string }
  | { op: "symlink"; path: string; target: string };

export interface Vector {
  id: string;
  description: string;
  base: { path: string; text?: string; base64?: string }[];
  steps: VectorStep[];
  exclude?: string[];
  limits?: Record<string, number>;
  posixOnly?: boolean;
  expect: {
    digest?: string;
    sameAs?: string;
    differsFrom?: string;
    refuse?: string;
    diffContains?: string;
  };
}

export interface VectorDocument {
  schema: string;
  algorithm: string;
  vectors: Vector[];
}

function bytesOf(f: { text?: string; base64?: string }): Buffer {
  if (f.base64 !== undefined) return Buffer.from(f.base64, "base64");
  return Buffer.from(f.text ?? "", "utf8");
}

function writeFileAt(dir: string, path: string, content: Buffer): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Build the repository a vector describes. Returns its directory and base commit. */
export function buildVectorRepo(parent: string, vector: Vector): { dir: string; base: string } {
  const dir = join(parent, vector.id);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  for (const f of vector.base) writeFileAt(dir, f.path, bytesOf(f));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "--allow-empty", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  for (const step of vector.steps) {
    switch (step.op) {
      case "write":
        writeFileAt(dir, step.path, bytesOf(step));
        break;
      case "delete":
        rmSync(join(dir, step.path), { force: true });
        break;
      case "stage":
        git(dir, ["add", "--", step.path]);
        break;
      case "rename":
        git(dir, ["mv", step.from, step.to]);
        break;
      case "symlink":
        mkdirSync(dirname(join(dir, step.path)), { recursive: true });
        symlinkSync(step.target, join(dir, step.path));
        break;
    }
  }
  return { dir, base };
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Recompute the gs-patch-digest/v1 digest from git and sha256 alone.
 * Deliberately restates the contract in the most literal form.
 */
export function oracleDigest(dir: string, base: string, exclude: string[] = []): {
  digest: string;
  diff: Buffer;
} {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_SYSTEM: nullDevice(),
  };
  const run = (args: string[]): Buffer => {
    const r = spawnSync("git", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`oracle git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const pathspec = exclude.length
    ? [".", ...[...exclude].sort().map((p) => `:(exclude,literal)${p}`)]
    : [];
  const diff = run([
    "--no-pager",
    "-c", `core.hooksPath=${nullDevice()}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${nullDevice()}`,
    "-c", "core.autocrlf=false",
    "-c", "core.quotePath=true",
    "-c", "diff.external=",
    "-c", "diff.noprefix=false",
    "-c", "diff.algorithm=myers",
    "-c", "diff.context=3",
    "-c", "diff.renames=true",
    "-c", "diff.renameLimit=1000",
    "-c", "diff.indentHeuristic=true",
    "-c", "diff.interHunkContext=0",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.suppressBlankEmpty=false",
    "-c", "diff.srcPrefix=a/",
    "-c", "diff.dstPrefix=b/",
    "-c", "diff.ignoreSubmodules=none",
    "-c", "diff.submodule=short",
    "-c", `diff.orderFile=${nullDevice()}`,
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index",
    base, "--", ...pathspec,
  ]);
  const listed = run(["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => !exclude.some((e) => p === e || p.startsWith(`${e}/`)));
  listed.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let section = "";
  for (const p of new Set(listed)) {
    if (lstatSync(join(dir, p)).isSymbolicLink()) throw new Error("oracle: symlink");
    const sha = createHash("sha256").update(readFileSync(join(dir, p))).digest("hex");
    section += `gs-untracked-file: ${p}\ngs-content-sha256:${sha}\n`;
  }
  const input = Buffer.concat([diff, Buffer.from(section, "utf8")]);
  return { digest: `sha256:${createHash("sha256").update(input).digest("hex")}`, diff };
}
