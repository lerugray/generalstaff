import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import { commitRootState, isOwnRepoTopLevel } from "../src/state_commit";
import { testTempDir } from "./helpers/temp_dir";

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await $`git -C ${dir} init -q -b master`.quiet();
  await $`git -C ${dir} config user.email test@example.com`.quiet();
  await $`git -C ${dir} config user.name test`.quiet();
  await $`git -C ${dir} config commit.gpgsign false`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} add seed.txt`.quiet();
  await $`git -C ${dir} commit -q -m initial`.quiet();
}

const head = async (dir: string) => (await $`git -C ${dir} rev-parse HEAD`.quiet()).stdout.toString().trim();
const staged = async (dir: string) =>
  (await $`git -C ${dir} diff --cached --name-only`.quiet()).stdout.toString().trim();

describe("commitRootState (v0.18.1)", () => {
  it("commits state/ and leaves the user's other staged work staged", async () => {
    const repo = testTempDir("state-commit-own");
    await initRepo(repo);
    writeFileSync(join(repo, "work.txt"), "user work\n");
    await $`git -C ${repo} add work.txt`.quiet();
    mkdirSync(join(repo, "state", "p"), { recursive: true });
    writeFileSync(join(repo, "state", "p", "PROGRESS.jsonl"), '{"event":"cycle_end"}\n');

    expect(await commitRootState(repo, "state: cycle test")).toBe(true);
    const files = (await $`git -C ${repo} show --name-only --format= HEAD`.quiet()).stdout.toString().trim();
    expect(files).toBe("state/p/PROGRESS.jsonl");
    expect(await staged(repo)).toBe("work.txt");
  });

  it("never commits an enclosing repo when the root is a plain folder inside it", async () => {
    const outer = testTempDir("state-commit-outer");
    await initRepo(outer);
    writeFileSync(join(outer, "staged.txt"), "developer's staged change\n");
    await $`git -C ${outer} add staged.txt`.quiet();
    const root = join(outer, "tests", "fixtures", "some_test");
    mkdirSync(join(root, "state", "p"), { recursive: true });
    writeFileSync(join(root, "state", "p", "PROGRESS.jsonl"), '{"event":"cycle_end"}\n');
    const before = await head(outer);

    expect(await isOwnRepoTopLevel(root)).toBe(false);
    expect(await commitRootState(root, "state: cycle test")).toBe(false);
    expect(await head(outer)).toBe(before);
    expect(await staged(outer)).toBe("staged.txt");
  });

  it("ignores a GIT_DIR in the environment that points at another repository", async () => {
    const outer = testTempDir("state-commit-gitdir");
    await initRepo(outer);
    const root = join(outer, "nested");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "x.jsonl"), "{}\n");
    const before = await head(outer);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(outer, ".git");
    try {
      expect(await commitRootState(root, "state: cycle test")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    expect(await head(outer)).toBe(before);
  });

  it("returns false with nothing to commit, and outside any repo", async () => {
    const repo = testTempDir("state-commit-clean");
    await initRepo(repo);
    expect(await commitRootState(repo, "state: nothing")).toBe(false);
    const bare = testTempDir("state-commit-norepo");
    expect(await commitRootState(bare, "state: nothing")).toBe(false);
  });
});
