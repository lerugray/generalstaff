import { describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import { fetchCommitSubject } from "../src/git";
import { setRootDir } from "../src/state";

async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await $`git -C ${path} init -b master`.quiet();
  await $`git -C ${path} config user.email test@example.com`.quiet();
  await $`git -C ${path} config user.name test`.quiet();
  await $`git -C ${path} config commit.gpgsign false`.quiet();
}

async function commitFile(
  path: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  writeFileSync(join(path, file), content, "utf8");
  await $`git -C ${path} add ${file}`.quiet();
  await $`git -C ${path} commit -m ${message}`.quiet();
  const sha = (await $`git -C ${path} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  return sha;
}

describe("fetchCommitSubject", () => {
  it("returns the commit subject line for a valid SHA", async () => {
    const repo = join(tmpdir(), "gs-git-subject-" + Date.now());
    try {
      await initRepo(repo);
      const sha1 = await commitFile(repo, "a.txt", "one", "initial commit");
      const sha2 = await commitFile(repo, "b.txt", "two", "second commit subject");
      setRootDir(repo);
      expect(fetchCommitSubject(sha1, sha2)).toBe("second commit subject");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty string when start and end SHA are equal", async () => {
    const repo = join(tmpdir(), "gs-git-same-" + Date.now());
    try {
      await initRepo(repo);
      const sha = await commitFile(repo, "a.txt", "one", "only commit");
      setRootDir(repo);
      expect(fetchCommitSubject(sha, sha)).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty string when endSha is empty", () => {
    expect(fetchCommitSubject("abc", "")).toBe("");
  });

  it("returns empty string when endSha does not resolve to any commit", async () => {
    const repo = join(tmpdir(), "gs-git-bad-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "a.txt", "one", "initial");
      setRootDir(repo);
      expect(fetchCommitSubject("abc", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // gs-097 regression: reproduces the "cycle 1 subject missing from digest"
  // scenario. Session-init commit A lands on master, bot/work is forked from
  // A, bot commits B on bot/work, the session-end merge brings B into master.
  // fetchCommitSubject(A, B) must still resolve B's subject — the 2026-04-17
  // morning digest fell back to cycle_id for cycle 1 despite B existing and
  // being reachable. If this test ever fails, the bug has a genuine git-level
  // cause (object missing, ref collision, etc.) rather than a data-plumbing
  // issue upstream.
  it("resolves end SHA after session-init + merge-into-master flow", async () => {
    const repo = join(tmpdir(), "gs-git-merged-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "seed.txt", "seed", "initial master commit");
      const sessionInitSha = await commitFile(
        repo,
        "state.txt",
        "state",
        "state: session init",
      );
      await $`git -C ${repo} branch bot/work master`.quiet();
      await $`git -C ${repo} checkout bot/work`.quiet();
      const botCommitSha = await commitFile(
        repo,
        "task.txt",
        "done",
        "gs-087: parseDigest test regression",
      );
      await $`git -C ${repo} checkout master`.quiet();
      await $`git -C ${repo} merge --no-ff bot/work -m ${"Merge branch 'bot/work'"}`.quiet();
      setRootDir(repo);
      expect(fetchCommitSubject(sessionInitSha, botCommitSha)).toBe(
        "gs-087: parseDigest test regression",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
