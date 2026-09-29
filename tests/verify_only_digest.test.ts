import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectChangeset,
  DigestError,
  digestOfBytes,
  normalizeExclude,
  pathExcluded,
  PATCH_DIGEST_ALGORITHM,
} from "../src/verify_only/digest";
import {
  buildVectorRepo,
  oracleDigest,
  type VectorDocument,
} from "./helpers/digest_vectors";
import { git, makeRepo } from "./helpers/verify_only_fixture";

const VECTORS_PATH = join(
  import.meta.dir,
  "fixtures",
  "gs-patch-digest-v1",
  "vectors.json",
);
const doc = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorDocument;
const byId = new Map(doc.vectors.map((v) => [v.id, v]));

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-digest-test-")));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("gs-patch-digest/v1 vector file", () => {
  it("names the algorithm and carries every case the contract requires", () => {
    expect(doc.algorithm).toBe(PATCH_DIGEST_ALGORITHM);
    for (const id of [
      "empty",
      "tracked-edit",
      "untracked-added",
      "untracked-edited",
      "untracked-deleted",
      "ignored-changed",
      "binary-tracked",
      "binary-tracked-same-length",
      "file-too-large",
      "untracked-symlink",
      "exclude-ancestor-replaced",
      "rename-detected",
    ]) {
      expect(byId.has(id)).toBe(true);
    }
  });

  it("holds the empty-patch digest: sha256 of zero bytes", () => {
    expect(byId.get("empty")!.expect.digest).toBe(digestOfBytes(new Uint8Array(0)));
  });

  for (const v of doc.vectors) {
    it(`vector ${v.id}: ${v.description}`, async () => {
      if (v.posixOnly && process.platform === "win32") return;
      const { dir, base } = buildVectorRepo(scratch, v);
      const run = () =>
        collectChangeset({
          cwd: dir,
          base,
          exclude: v.exclude,
          limits: v.limits,
        });

      if (v.expect.refuse) {
        let caught: unknown;
        try {
          await run();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DigestError);
        expect((caught as DigestError).code).toBe(v.expect.refuse as never);
        return;
      }

      const snap = await run();
      expect(snap.digest).toBe(v.expect.digest!);
      // An independent restatement of the contract must agree.
      const oracle = oracleDigest(dir, base, v.exclude ?? []);
      expect(oracle.digest).toBe(snap.digest);
      expect(snap.digestInput.equals(
        Buffer.concat([oracle.diff, Buffer.from(snap.section, "utf8")]),
      )).toBe(true);

      if (v.expect.sameAs) {
        expect(snap.digest).toBe(byId.get(v.expect.sameAs)!.expect.digest!);
      }
      if (v.expect.differsFrom) {
        expect(snap.digest).not.toBe(byId.get(v.expect.differsFrom)!.expect.digest!);
      }
      if (v.expect.diffContains) {
        expect(snap.diff.toString("utf8")).toContain(v.expect.diffContains);
      }
    });
  }
});

describe("collectChangeset is read-only and hermetic", () => {
  it("never rewrites the checkout's index, HEAD or refs (stale stat cache included)", async () => {
    const { dir, base } = makeRepo(scratch, "readonly");
    // Make git's stat cache stale so a plain `git diff` would refresh and rewrite the index.
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "a.txt"), future, future);
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    const indexPath = join(dir, ".git", "index");
    const staleIndex = readFileSync(indexPath);
    const restoreStaleIndex = () => {
      writeFileSync(indexPath, staleIndex);
      const t = new Date(Date.now() - 60_000);
      utimesSync(indexPath, t, t);
    };
    restoreStaleIndex();

    // Control: a plain `git diff` really does rewrite the index here, which is
    // the hazard the private index copy exists to avoid.
    const beforeControl = statSync(indexPath).mtimeMs;
    git(dir, ["diff", base, "--"]);
    expect(statSync(indexPath).mtimeMs).not.toBe(beforeControl);
    restoreStaleIndex();

    const indexBefore = readFileSync(indexPath);
    const mtimeBefore = statSync(indexPath).mtimeMs;
    const headBefore = git(dir, ["rev-parse", "HEAD"]);
    const refsBefore = git(dir, ["for-each-ref"]);

    await new Promise((r) => setTimeout(r, 20));
    await collectChangeset({ cwd: dir, base });

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(statSync(indexPath).mtimeMs).toBe(mtimeBefore);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(dir, ["for-each-ref"])).toBe(refsBefore);
  });

  it("ignores repository-local configuration and hostile environment", async () => {
    const { dir, base } = makeRepo(scratch, "hostile");
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    writeFileSync(join(dir, "n.txt"), "new\n");
    const plain = (await collectChangeset({ cwd: dir, base })).digest;

    git(dir, ["config", "diff.external", "/bin/false"]);
    git(dir, ["config", "diff.algorithm", "histogram"]);
    git(dir, ["config", "diff.context", "0"]);
    git(dir, ["config", "diff.noprefix", "true"]);
    git(dir, ["config", "diff.renames", "false"]);
    git(dir, ["config", "diff.interHunkContext", "20"]);
    git(dir, ["config", "diff.orderFile", join(dir, "nonexistent-file-list")]);
    git(dir, ["config", "core.quotePath", "false"]);
    git(dir, ["config", "core.fsmonitor", "/bin/false"]);
    git(dir, ["config", "core.hooksPath", "/nonexistent-hooks"]);
    const saved = process.env.GIT_EXTERNAL_DIFF;
    const savedDir = process.env.GIT_DIR;
    process.env.GIT_EXTERNAL_DIFF = "/bin/false";
    process.env.GIT_DIR = join(scratch, "not-a-repo");
    try {
      const hostile = (await collectChangeset({ cwd: dir, base })).digest;
      expect(hostile).toBe(plain);
    } finally {
      if (saved === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = saved;
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
    }
  });

  it("refuses bad input instead of guessing", async () => {
    const { dir, base } = makeRepo(scratch, "badinput");
    const code = async (opts: Parameters<typeof collectChangeset>[0]) => {
      try {
        await collectChangeset(opts);
      } catch (err) {
        return (err as DigestError).code;
      }
      return "no error";
    };
    expect(await code({ cwd: "relative/dir", base })).toBe("checkout_invalid");
    expect(await code({ cwd: `${dir}/../badinput`, base })).toBe("checkout_invalid");
    expect(await code({ cwd: join(scratch, "does-not-exist"), base })).toBe("checkout_invalid");
    expect(await code({ cwd: dir, base: "--output=/tmp/x" })).toBe("revision_invalid");
    expect(await code({ cwd: dir, base: "abc" })).toBe("revision_invalid");
    expect(await code({ cwd: dir, base, exclude: ["../up"] })).toBe("exclude_invalid");
    expect(await code({ cwd: dir, base, exclude: ["/abs"] })).toBe("exclude_invalid");
    expect(await code({ cwd: dir, base, exclude: [""] })).toBe("exclude_invalid");
    const notRepo = join(scratch, "plain-dir");
    mkdirSync(notRepo);
    expect(await code({ cwd: notRepo, base })).toBe("git_failed");
    // A well-formed hex id that is not a commit is a git failure, not a digest.
    expect(await code({ cwd: dir, base: "0".repeat(40) })).toBe("git_failed");
  });

  it("copies untracked files while hashing exactly the bytes it copied", async () => {
    const { dir, base } = makeRepo(scratch, "copying");
    writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "tool.sh"), 0o755);
    mkdirSync(join(dir, "deep", "er"), { recursive: true });
    writeFileSync(join(dir, "deep", "er", "f.bin"), Buffer.from([0, 1, 2, 255]));
    const out = join(scratch, "copy-out");
    mkdirSync(out);
    const snap = await collectChangeset({ cwd: dir, base, copyFilesTo: out });
    expect(snap.untracked.map((u) => u.path)).toEqual(["deep/er/f.bin", "tool.sh"]);
    expect(readFileSync(join(out, "deep", "er", "f.bin")).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(out, "tool.sh")).mode & 0o111).not.toBe(0);
    }
    expect((await collectChangeset({ cwd: dir, base })).digest).toBe(snap.digest);
  });
});

describe("exclusions", () => {
  it("normalizes: trailing slash, sorting, duplicates", () => {
    expect(normalizeExclude(["b/", "a", "b", "a/x"])).toEqual(["a", "a/x", "b"]);
    expect(normalizeExclude(undefined)).toEqual([]);
    expect(() => normalizeExclude(["a/../b"])).toThrow(DigestError);
    expect(() => normalizeExclude(["a//b"])).toThrow(DigestError);
    expect(() => normalizeExclude(["a\nb"])).toThrow(DigestError);
  });

  it("hides only the path and what is below it, never an ancestor", () => {
    const ex = ["foo/bar/baz"];
    expect(pathExcluded("foo/bar/baz", ex)).toBe(true);
    expect(pathExcluded("foo/bar/baz/inner.txt", ex)).toBe(true);
    expect(pathExcluded("foo", ex)).toBe(false);
    expect(pathExcluded("foo/bar", ex)).toBe(false);
    expect(pathExcluded("foo/bar/bazaar", ex)).toBe(false);
  });
});
