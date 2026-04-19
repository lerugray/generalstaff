import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Motivation (gs-235): a wave-2 spin was caused by `.claude/scheduled_tasks.lock`
// (a ScheduleWakeup harness artifact) showing up as untracked and tripping
// safety.ts's clean-tree preflight. Commit ae299aa broadened the .gitignore rule
// from `.claude/settings.local.json` to `.claude/*` (with an allow-exception for
// `.claude/settings.json`). This regression test pins those patterns so a future
// edit cannot silently strip them.

const GITIGNORE_PATH = join(import.meta.dir, "..", ".gitignore");

function readGitignoreLines(): string[] {
  return readFileSync(GITIGNORE_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe(".gitignore coverage for .claude/ transient files", () => {
  it("ignores everything under .claude/ via the broad `.claude/*` pattern", () => {
    const lines = readGitignoreLines();
    expect(lines).toContain(".claude/*");
  });

  it("keeps `.claude/settings.json` tracked via a negation rule", () => {
    const lines = readGitignoreLines();
    expect(lines).toContain("!.claude/settings.json");
  });

  it("covers `.claude/settings.local.json` either explicitly or via the broad pattern", () => {
    const lines = readGitignoreLines();
    const explicit = lines.includes(".claude/settings.local.json");
    const subsumed = lines.includes(".claude/*");
    expect(explicit || subsumed).toBe(true);
  });
});

describe(".gitignore coverage for transient session pid file (gs-236)", () => {
  it("ignores `state/session.pid` so session-end cleanup doesn't leave tracked-file deletion residue", () => {
    const lines = readGitignoreLines();
    expect(lines).toContain("state/session.pid");
  });
});
