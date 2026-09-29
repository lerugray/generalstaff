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
import { createHash } from "crypto";
import {
  collectChangeset,
  DigestError,
  digestOfBytes,
  normalizeExclude,
  pathExcluded,
  PATCH_DIGEST_ALGORITHM,
} from "../src/verify_only/digest";
import { resolveGlobalExcludes } from "../src/verify_only/excludes";
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
      "global-excludes-config",
      "global-excludes-xdg",
      "global-excludes-none",
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
      // A vector that names global excludes gets a hermetic HOME (and XDG)
      // holding exactly that setup; resolution then runs through the real
      // resolver, so the frozen digest also pins the resolution rules.
      let restoreEnv: (() => void) | undefined;
      let globalExcludesFile: string | null = null;
      if (v.globalExcludes) {
        const home = join(scratch, `${v.id}-home`);
        mkdirSync(home, { recursive: true });
        const prev = {
          HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        };
        restoreEnv = () => {
          for (const [k, val] of Object.entries(prev)) {
            if (val === undefined) delete process.env[k];
            else process.env[k] = val;
          }
        };
        process.env.HOME = home;
        delete process.env.XDG_CONFIG_HOME;
        delete process.env.GIT_CONFIG_GLOBAL;
        const text = v.globalExcludes.text ?? "";
        if (v.globalExcludes.source === "config") {
          const f = join(scratch, `${v.id}-ignore`);
          writeFileSync(f, text);
          writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${f}\n`);
        } else if (v.globalExcludes.source === "xdg") {
          const xdg = join(scratch, `${v.id}-xdg`);
          mkdirSync(join(xdg, "git"), { recursive: true });
          writeFileSync(join(xdg, "git", "ignore"), text);
          process.env.XDG_CONFIG_HOME = xdg;
        }
      }
      try {
        if (v.globalExcludes) {
          const r = await resolveGlobalExcludes();
          expect(r.source).toBe(v.globalExcludes.source);
          globalExcludesFile = r.path;
        }
        const run = () =>
          collectChangeset({
            cwd: dir,
            base,
            exclude: v.exclude,
            limits: v.limits,
            ...(v.globalExcludes ? { globalExcludesFile } : {}),
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
        const oracle = oracleDigest(dir, base, v.exclude ?? [], globalExcludesFile);
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
      } finally {
        restoreEnv?.();
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

// --- The global excludes pin ----------------------------------

describe("global excludes resolution and pinning", () => {
  // resolveGlobalExcludes reads the calling process's environment, which in
  // these tests is the test runner's own env: save, redirect, restore.
  function redirectedEnv(home: string, xdg?: string): () => void {
    const prev = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.GIT_CONFIG_GLOBAL;
    if (xdg !== undefined) process.env.XDG_CONFIG_HOME = xdg;
    return () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  }

  it("resolves core.excludesFile from the user's git config and hashes it", async () => {
    const home = join(scratch, "excl-home-config");
    mkdirSync(home, { recursive: true });
    const ignoreFile = join(scratch, "config-ignore");
    writeFileSync(ignoreFile, ".env\n*.pem\n");
    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${ignoreFile}\n`);
    const restore = redirectedEnv(home);
    try {
      const r = await resolveGlobalExcludes();
      expect(r.source).toBe("config");
      expect(r.path).toBe(ignoreFile);
      expect(r.sha256).toBe(createHash("sha256").update(".env\n*.pem\n").digest("hex"));
    } finally {
      restore();
    }
  });

  it("falls back to $XDG_CONFIG_HOME/git/ignore when no core.excludesFile is set", async () => {
    const home = join(scratch, "excl-home-xdg");
    mkdirSync(home, { recursive: true });
    const xdg = join(scratch, "excl-xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "ignore"), ".env\n");
    const restore = redirectedEnv(home, xdg);
    try {
      const r = await resolveGlobalExcludes();
      expect(r.source).toBe("xdg");
      expect(r.path).toBe(join(xdg, "git", "ignore"));
    } finally {
      restore();
    }
  });

  it("falls back to HOME/.config/git/ignore when neither config nor XDG names one", async () => {
    const home = join(scratch, "excl-home-default");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), ".env\n");
    const restore = redirectedEnv(home);
    try {
      const r = await resolveGlobalExcludes();
      expect(r.source).toBe("default");
      expect(r.path).toBe(join(home, ".config", "git", "ignore"));
    } finally {
      restore();
    }
  });

  it("with XDG_CONFIG_HOME set, does not fall back to HOME/.config/git/ignore (matches git)", async () => {
    const home = join(scratch, "excl-home-xdg-nofallback");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), ".env\n");
    const xdg = join(scratch, "excl-xdg-empty");
    mkdirSync(xdg, { recursive: true });
    const restore = redirectedEnv(home, xdg);
    try {
      const r = await resolveGlobalExcludes();
      expect(r.source).toBe("none");
      expect(r.path).toBeNull();
      expect(r.sha256).toBeNull();
    } finally {
      restore();
    }
  });

  it("reports none when the user has no global excludes file", async () => {
    const home = join(scratch, "excl-home-none");
    mkdirSync(home, { recursive: true });
    const restore = redirectedEnv(home);
    try {
      const r = await resolveGlobalExcludes();
      expect(r.source).toBe("none");
      expect(r.path).toBeNull();
      expect(r.sha256).toBeNull();
    } finally {
      restore();
    }
  });

  it("a globally-ignored file stays out of U when the pin is in force, and returns when it is not", async () => {
    const { dir, base } = makeRepo(scratch, "excludes-pin");
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    writeFileSync(join(dir, ".env"), "SECRET=live-token\n");
    const ignoreFile = join(scratch, "pin-ignore");
    writeFileSync(ignoreFile, ".env\n");

    // Pinned to a file that ignores .env: the digest is the digest of the
    // same change-set WITHOUT .env at all.
    const pinned = await collectChangeset({ cwd: dir, base, globalExcludesFile: ignoreFile });
    rmSync(join(dir, ".env"));
    const without = await collectChangeset({ cwd: dir, base });
    expect(pinned.digest).toBe(without.digest);
    expect(pinned.digestInput.includes(Buffer.from("gs-untracked-file: .env"))).toBe(false);

    // Unpinned: the same working tree binds the secret's bytes.
    writeFileSync(join(dir, ".env"), "SECRET=live-token\n");
    const unpinned = await collectChangeset({ cwd: dir, base, globalExcludesFile: null });
    expect(unpinned.digest).not.toBe(pinned.digest);
    expect(unpinned.digestInput.includes(Buffer.from("gs-untracked-file: .env"))).toBe(true);
  });
});
