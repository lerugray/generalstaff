import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BundleError, MAX_BUNDLE_PATH_DEPTH, readBundle, writeBundle } from "../src/verify_only/bundle";
import {
  collectChangeset,
  digestOfBytes,
} from "../src/verify_only/digest";
import {
  materializeSnapshot,
  parseNumstatZ,
  removeVerifyTree,
  renderReviewDiff,
} from "../src/verify_only/materialize";
import { VerifyRefusal } from "../src/verify_only/refusal";
import { git, makeRepo } from "./helpers/verify_only_fixture";

let scratch: string;
let counter = 0;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-bundle-test-")));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fresh(name: string, files?: Record<string, string>) {
  counter += 1;
  return makeRepo(scratch, `${name}-${counter}`, { files });
}

async function refusalOf(p: Promise<unknown>): Promise<VerifyRefusal> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(VerifyRefusal);
    return err as VerifyRefusal;
  }
  throw new Error("expected a refusal, got success");
}

function materialize(
  dir: string,
  base: string,
  bundle: string,
  digest: string,
  exclude: string[] = [],
) {
  counter += 1;
  return materializeSnapshot({
    checkout: dir,
    verifyDir: join(scratch, `verify-${counter}`),
    base,
    bundleDir: bundle,
    expectedDigest: digest,
    exclude,
  });
}

describe("bundle write and read", () => {
  it("round-trips a mixed change-set into an isolated worktree with the same digest", async () => {
    const { dir, base } = fresh("roundtrip", {
      "a.txt": "one\n",
      "b.txt": "two\n",
      "old-name.txt": "body\nmore\nlines\nfor\nrename\ndetect\nsimilarity\nand\nmore\n",
      "bin/blob.dat": "placeholder",
      "crlf.txt": "a\r\nb\r\n",
      "tool.sh": "#!/bin/sh\necho hi\n",
    });
    // Tracked edit, staged add, delete, staged rename with an edit, untracked text and binary.
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    writeFileSync(join(dir, "staged-new.txt"), "staged\n");
    git(dir, ["add", "staged-new.txt"]);
    rmSync(join(dir, "b.txt"));
    git(dir, ["mv", "old-name.txt", "new-name.txt"]);
    writeFileSync(join(dir, "new-name.txt"), "body\nmore\nlines\nfor\nrename\ndetect\nsimilarity\nand\nmore\nplus\n");
    writeFileSync(join(dir, "bin", "blob.dat"), Buffer.from([0, 1, 2, 3, 255, 0]));
    mkdirSync(join(dir, "deep"), { recursive: true });
    writeFileSync(join(dir, "deep", "untracked.txt"), "hello\n");
    writeFileSync(join(dir, "untracked.bin"), Buffer.from([9, 0, 9, 0]));
    // Line endings are carried byte for byte, and a mode change travels too.
    writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\nc\r\n");
    if (process.platform !== "win32") chmodSync(join(dir, "tool.sh"), 0o755);

    const live = await collectChangeset({ cwd: dir, base });
    const status = git(dir, ["status", "--porcelain"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const branches = git(dir, ["branch", "--list"]);

    const out = join(scratch, "rt-bundle");
    const info = await writeBundle({ checkout: dir, base, outDir: out });
    expect(info.digest).toBe(live.digest);
    expect(info.digestAlgorithm).toBe("gs-patch-digest/v1");
    expect(info.untrackedFileCount).toBe(2);
    expect(readdirSync(out).sort()).toEqual(["diff.patch", "files"]);
    expect(readFileSync(join(out, "files", "deep", "untracked.txt"), "utf8")).toBe("hello\n");

    const m = await materialize(dir, base, out, info.digest);
    expect(m.snapshot.digest).toBe(info.digest);
    expect(digestOfBytes(m.snapshot.digestInput)).toBe(info.digest);
    // The isolated tree holds the change; the checkout is untouched.
    expect(readFileSync(join(m.treePath, "a.txt"), "utf8")).toBe("one\nchanged\n");
    expect(existsSync(join(m.treePath, "b.txt"))).toBe(false);
    expect(readFileSync(join(m.treePath, "bin", "blob.dat")).equals(Buffer.from([0, 1, 2, 3, 255, 0]))).toBe(true);
    expect(readFileSync(join(m.treePath, "deep", "untracked.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(m.treePath, "crlf.txt"), "utf8")).toBe("a\r\nb\r\nc\r\n");
    if (process.platform !== "win32") {
      expect(statSync(join(m.treePath, "tool.sh")).mode & 0o111).not.toBe(0);
    }
    expect(m.treePath.startsWith(scratch)).toBe(true);

    const review = await renderReviewDiff(m.treePath, base);
    expect(review.diff).toContain("deep/untracked.txt");
    expect(review.diff).toContain("+hello");
    expect(review.diff).toContain("rename from");
    expect(review.stat).toContain("untracked.bin");

    expect(await removeVerifyTree(dir, m.verifyDir)).toBe(true);
    expect(existsSync(m.verifyDir)).toBe(false);
    expect(git(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(existsSync(join(dir, ".git", "worktrees"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toBe(status);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(dir, ["branch", "--list"])).toBe(branches);
    expect(git(dir, ["stash", "list"])).toBe("");
    // And the bundle reproduces the same digest from the checkout again.
    expect((await collectChangeset({ cwd: dir, base })).digest).toBe(info.digest);
  });

  it("leaves scaffold out of the bundle, the digest and the review diff", async () => {
    const { dir, base } = fresh("scaffold");
    mkdirSync(join(dir, ".generalstaff-proposal"));
    writeFileSync(join(dir, ".generalstaff-proposal", "notes.md"), "scaffold\n");
    writeFileSync(join(dir, "engineer_command.sh"), "#!/bin/sh\n");
    writeFileSync(join(dir, "real.txt"), "real change\n");
    const exclude = [".generalstaff-proposal/notes.md", "engineer_command.sh"];
    const out = join(scratch, "scaffold-bundle");
    const info = await writeBundle({ checkout: dir, base, outDir: out, exclude });
    expect(info.excludedPaths).toEqual([".generalstaff-proposal/notes.md", "engineer_command.sh"]);
    expect(readdirSync(join(out, "files"))).toEqual(["real.txt"]);

    const m = await materialize(dir, base, out, info.digest, exclude);
    expect(existsSync(join(m.treePath, "engineer_command.sh"))).toBe(false);
    const review = await renderReviewDiff(m.treePath, base);
    expect(review.diff).not.toContain("engineer_command");
    expect(review.diff).not.toContain("generalstaff-proposal");
    await removeVerifyTree(dir, m.verifyDir);

    // Without the exclusions the digest differs (the scaffold is a real untracked file).
    expect((await collectChangeset({ cwd: dir, base })).digest).not.toBe(info.digest);
  });

  it("a tracked binary change travels in the transport patch", async () => {
    const { dir, base } = fresh("binary", { "a.txt": "x\n", "blob.dat": "AAAA" });
    writeFileSync(join(dir, "blob.dat"), Buffer.from([0, 255, 0, 255, 1, 2, 3]));
    const out = join(scratch, "bin-bundle");
    const info = await writeBundle({ checkout: dir, base, outDir: out });
    expect(readFileSync(join(out, "diff.patch"), "utf8")).toContain("GIT binary patch");
    const m = await materialize(dir, base, out, info.digest);
    expect(readFileSync(join(m.treePath, "blob.dat")).equals(Buffer.from([0, 255, 0, 255, 1, 2, 3]))).toBe(true);
    await removeVerifyTree(dir, m.verifyDir);
  });

  it("refuses an empty change-set, a bad output directory, and cleans up after a failure", async () => {
    const { dir, base } = fresh("writer-refusals");
    const none = join(scratch, "none-bundle");
    await expect(writeBundle({ checkout: dir, base, outDir: none })).rejects.toMatchObject({ code: "empty_patch" });
    expect(existsSync(none)).toBe(false);

    writeFileSync(join(dir, "n.txt"), "x\n");
    await expect(
      writeBundle({ checkout: dir, base, outDir: join(dir, "inside-bundle") }),
    ).rejects.toMatchObject({ code: "out_invalid" });
    expect(existsSync(join(dir, "inside-bundle"))).toBe(false);

    const occupied = join(scratch, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "keep\n");
    await expect(writeBundle({ checkout: dir, base, outDir: occupied })).rejects.toMatchObject({ code: "out_invalid" });
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("keep\n");

    // An untracked symlink aborts the snapshot and removes the half-written bundle.
    if (process.platform !== "win32") {
      symlinkSync("n.txt", join(dir, "link.txt"));
      const failing = join(scratch, "failing-bundle");
      await expect(writeBundle({ checkout: dir, base, outDir: failing })).rejects.toMatchObject({
        code: "untracked_symlink",
      });
      expect(existsSync(failing)).toBe(false);
    }
  });
});

describe("a bundle is only accepted if it reproduces the bound digest", () => {
  async function bundleOf(name: string) {
    const { dir, base } = fresh(name, { "a.txt": "one\n", "b.txt": "two\n", ".gitignore": "*.log\n" });
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    writeFileSync(join(dir, "new.txt"), "new file\n");
    const out = join(scratch, `${name}-bundle`);
    const info = await writeBundle({ checkout: dir, base, outDir: out });
    return { dir, base, out, digest: info.digest };
  }

  it("refuses when diff.patch was altered but still applies", async () => {
    const { dir, base, out, digest } = await bundleOf("tamper-patch");
    const patch = join(out, "diff.patch");
    writeFileSync(patch, readFileSync(patch, "utf8").replace("+changed", "+tampered"));
    const r = await refusalOf(materialize(dir, base, out, digest));
    expect(r.code).toBe("digest_mismatch");
    expect(readdirSync(join(scratch)).filter((n) => n.startsWith("verify-") && existsSync(join(scratch, n, "tree")))).toEqual([]);
  });

  it("refuses when diff.patch no longer applies", async () => {
    const { dir, base, out, digest } = await bundleOf("broken-patch");
    const patch = join(out, "diff.patch");
    writeFileSync(patch, readFileSync(patch, "utf8").replace(" one\n", " ONE\n"));
    const r = await refusalOf(materialize(dir, base, out, digest));
    expect(["materialize_failed", "bundle_unreadable"]).toContain(r.code);
  });

  it("refuses a missing, extra or altered bundled file", async () => {
    const a = await bundleOf("tamper-files-a");
    rmSync(join(a.out, "files", "new.txt"));
    expect((await refusalOf(materialize(a.dir, a.base, a.out, a.digest))).code).toBe("digest_mismatch");

    const b = await bundleOf("tamper-files-b");
    writeFileSync(join(b.out, "files", "extra.txt"), "extra\n");
    expect((await refusalOf(materialize(b.dir, b.base, b.out, b.digest))).code).toBe("digest_mismatch");

    const c = await bundleOf("tamper-files-c");
    writeFileSync(join(c.out, "files", "new.txt"), "altered\n");
    expect((await refusalOf(materialize(c.dir, c.base, c.out, c.digest))).code).toBe("digest_mismatch");
  });

  it("refuses a bundled file that git would ignore (it would sit in the tree unbound)", async () => {
    const { dir, base, out, digest } = await bundleOf("ignored-extra");
    writeFileSync(join(out, "files", "sneaky.log"), "hidden\n");
    const r = await refusalOf(materialize(dir, base, out, digest));
    expect(r.code).toBe("bundle_extra_files");
  });

  it("refuses the wrong digest", async () => {
    const { dir, base, out } = await bundleOf("wrong-digest");
    const r = await refusalOf(materialize(dir, base, out, `sha256:${"0".repeat(64)}`));
    expect(r.code).toBe("digest_mismatch");
  });

  it("refuses a bundle whose files/ nest deeper than the path-depth cap", async () => {
    // Deep nesting costs unbounded recursion before any file-count or size
    // cap fires, so the bundle reader refuses it outright.
    if (process.platform === "win32") return;
    const f = await bundleOf("too-deep");
    let deep = join(f.out, "files");
    for (let i = 0; i <= MAX_BUNDLE_PATH_DEPTH + 1; i++) {
      deep = join(deep, "d");
      mkdirSync(deep);
    }
    writeFileSync(join(deep, "bottom.txt"), "one file at the bottom\n");
    const r = await refusalOf(materialize(f.dir, f.base, f.out, f.digest));
    expect(r.code).toBe("snapshot_limit");
    expect(r.message).toContain("deeper than 128");
    // Nothing was left behind.
    expect(
      readdirSync(scratch).filter((n) => n.startsWith("verify-") && existsSync(join(scratch, n, "tree"))),
    ).toEqual([]);
  });

  it("refuses symlinks, .git entries and non-directories inside the bundle", async () => {
    if (process.platform === "win32") return;
    const a = await bundleOf("sym-file");
    symlinkSync("/etc/hosts", join(a.out, "files", "link.txt"));
    expect((await refusalOf(materialize(a.dir, a.base, a.out, a.digest))).code).toBe("bundle_escapes");

    const b = await bundleOf("sym-dir");
    symlinkSync(tmpdir(), join(b.out, "files", "linked-dir"));
    expect((await refusalOf(materialize(b.dir, b.base, b.out, b.digest))).code).toBe("bundle_escapes");

    const c = await bundleOf("dotgit");
    mkdirSync(join(c.out, "files", ".git"));
    writeFileSync(join(c.out, "files", ".git", "config"), "[core]\n");
    expect((await refusalOf(materialize(c.dir, c.base, c.out, c.digest))).code).toBe("bundle_escapes");

    const d = await bundleOf("files-is-link");
    rmSync(join(d.out, "files"), { recursive: true });
    symlinkSync(tmpdir(), join(d.out, "files"));
    expect((await refusalOf(materialize(d.dir, d.base, d.out, d.digest))).code).toBe("bundle_escapes");

    const e = await bundleOf("patch-is-link");
    rmSync(join(e.out, "diff.patch"));
    symlinkSync(join(a.out, "diff.patch"), join(e.out, "diff.patch"));
    expect((await refusalOf(materialize(e.dir, e.base, e.out, e.digest))).code).toBe("bundle_unreadable");
  });

  it("never writes through a symlink the patch itself created", async () => {
    if (process.platform === "win32") return;
    const { dir, base } = fresh("through-link", { "a.txt": "one\n" });
    const outside = join(scratch, "outside-target");
    mkdirSync(outside);
    // A hand-built bundle: the patch adds a symlink `escape -> outside`, and
    // files/ carries escape/pwned.txt, which would land outside if followed.
    const bundle = join(scratch, "link-bundle");
    mkdirSync(join(bundle, "files", "escape"), { recursive: true });
    writeFileSync(join(bundle, "files", "escape", "pwned.txt"), "pwned\n");
    writeFileSync(
      join(bundle, "diff.patch"),
      [
        "diff --git a/escape b/escape",
        "new file mode 120000",
        "--- /dev/null",
        "+++ b/escape",
        "@@ -0,0 +1 @@",
        `+${outside}`,
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    const r = await refusalOf(materialize(dir, base, bundle, digestOfBytes(new Uint8Array(1))));
    expect(["bundle_escapes", "materialize_failed", "bundle_unreadable", "digest_mismatch"]).toContain(r.code);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  it("refuses patches that name paths outside the worktree", async () => {
    const { dir, base } = fresh("traversal", { "a.txt": "one\n" });
    const bundle = join(scratch, "traversal-bundle");
    mkdirSync(bundle);
    const victim = join(scratch, "victim.txt");
    writeFileSync(
      join(bundle, "diff.patch"),
      [
        "diff --git a/../victim.txt b/../victim.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/../victim.txt",
        "@@ -0,0 +1 @@",
        "+owned",
        "",
      ].join("\n"),
    );
    const r = await refusalOf(materialize(dir, base, bundle, digestOfBytes(new Uint8Array(1))));
    expect(["bundle_escapes", "bundle_unreadable", "materialize_failed"]).toContain(r.code);
    expect(existsSync(victim)).toBe(false);
  });

  it("names empty, missing and unreadable bundles", async () => {
    const { dir, base } = fresh("bundle-shapes");
    const digest = digestOfBytes(new Uint8Array(0));
    const missing = join(scratch, "no-such-bundle");
    expect((await refusalOf(materialize(dir, base, missing, digest))).code).toBe("bundle_missing");

    const emptyDir = join(scratch, "empty-bundle-dir");
    mkdirSync(emptyDir);
    expect((await refusalOf(materialize(dir, base, emptyDir, digest))).code).toBe("bundle_empty");

    const noPatch = join(scratch, "no-patch-bundle");
    mkdirSync(join(noPatch, "files"), { recursive: true });
    expect((await refusalOf(materialize(dir, base, noPatch, digest))).code).toBe("bundle_missing");

    const zero = join(scratch, "zero-bundle");
    mkdirSync(zero);
    writeFileSync(join(zero, "diff.patch"), "");
    expect((await refusalOf(materialize(dir, base, zero, digest))).code).toBe("empty_patch");

    const file = join(scratch, "bundle-is-a-file");
    writeFileSync(file, "x");
    expect((await refusalOf(materialize(dir, base, file, digest))).code).toBe("bundle_unreadable");
    expect(() => readBundle(file)).toThrow(BundleError);
  });
});

describe("parseNumstatZ", () => {
  it("reads plain, binary and rename records", () => {
    const out =
      "3\t1\ta.txt\0" +
      "-\t-\tbin.dat\0" +
      "0\t0\t\0old name.txt\0new name.txt\0";
    expect(parseNumstatZ(out)).toEqual(["a.txt", "bin.dat", "old name.txt", "new name.txt"]);
    expect(parseNumstatZ("")).toEqual([]);
  });
});
