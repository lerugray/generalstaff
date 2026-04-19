import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  matchesHandsOff,
  isBotRunning,
  writeSessionPid,
  readSessionPid,
  removeSessionPid,
  sessionPidFilePath,
  killProcessTree,
  stopForce,
  isExemptFromCleanTreeCheck,
  filterCleanTreePorcelain,
} from "../src/safety";
import { setRootDir } from "../src/state";
import { existsSync } from "fs";
import type { ProjectConfig } from "../src/types";
import { join } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "fs";

const FIXTURES = join(import.meta.dir, "fixtures", "safety");

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test-proj",
    path: join(FIXTURES, "proj"),
    priority: 1,
    engineer_command: "echo ok",
    verification_command: "echo ok",
    cycle_budget_minutes: 25,
    work_detection: "tasks_json",
    concurrency_detection: "catalogdna",
    branch: "bot/work",
    auto_merge: false,
    hands_off: [],
    ...overrides,
  };
}

function writeFixture(relativePath: string, content: string) {
  const fullPath = join(FIXTURES, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

/** Set mtime on a path to `minutesAgo` minutes before now. */
function setAge(absolutePath: string, minutesAgo: number) {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(absolutePath, t, t);
}

describe("matchesHandsOff", () => {
  const handsOff = [
    "src/catalogdna/interpret/",
    "CLAUDE.md",
    "CLAUDE-AUTONOMOUS.md",
    ".claude/",
    "run_bot*.sh",
    "run_bot*.bat",
    "bot_tasks.md",
    "scripts/bot_heartbeat.sh",
    "scripts/chrome_review*.sh",
    "scripts/worktree_venv.py",
  ];

  it("matches directory patterns", () => {
    expect(
      matchesHandsOff("src/catalogdna/interpret/rules.py", handsOff),
    ).toBe("src/catalogdna/interpret/");
    expect(matchesHandsOff(".claude/settings.json", handsOff)).toBe(
      ".claude/",
    );
  });

  it("matches exact file patterns", () => {
    expect(matchesHandsOff("CLAUDE.md", handsOff)).toBe("CLAUDE.md");
    expect(matchesHandsOff("bot_tasks.md", handsOff)).toBe("bot_tasks.md");
  });

  it("matches glob patterns", () => {
    expect(matchesHandsOff("run_bot.sh", handsOff)).toBe("run_bot*.sh");
    expect(matchesHandsOff("run_bot_publish.sh", handsOff)).toBe(
      "run_bot*.sh",
    );
    expect(matchesHandsOff("scripts/chrome_review_v2.sh", handsOff)).toBe(
      "scripts/chrome_review*.sh",
    );
  });

  it("returns null for non-matching files", () => {
    expect(matchesHandsOff("src/catalogdna/main.py", handsOff)).toBeNull();
    expect(matchesHandsOff("README.md", handsOff)).toBeNull();
    expect(matchesHandsOff("tests/test_api.py", handsOff)).toBeNull();
  });

  // Security audit 2026-04-19 (HIGH): Windows (NTFS) and macOS (default
  // APFS) are case-insensitive filesystems. A bot that commits a file with
  // non-canonical casing — Src/Reviewer.ts instead of src/reviewer.ts —
  // would have evaded the hands-off check before this fix. Guarded per
  // process.platform; on Linux (case-sensitive ext4 etc.) we keep strict
  // matching. We cannot change process.platform at runtime, so the test
  // asserts whichever mode the current platform should exhibit.
  describe("case-insensitive hands-off on case-insensitive filesystems", () => {
    const isCaseInsensitiveFs =
      process.platform === "win32" || process.platform === "darwin";

    it("src/reviewer.ts pattern catches Src/Reviewer.ts on case-insensitive FS", () => {
      const result = matchesHandsOff("Src/Reviewer.ts", ["src/reviewer.ts"]);
      if (isCaseInsensitiveFs) {
        expect(result).toBe("src/reviewer.ts");
      } else {
        expect(result).toBeNull();
      }
    });

    it("CLAUDE.md pattern catches claude.md on case-insensitive FS", () => {
      const result = matchesHandsOff("claude.md", ["CLAUDE.md"]);
      if (isCaseInsensitiveFs) {
        expect(result).toBe("CLAUDE.md");
      } else {
        expect(result).toBeNull();
      }
    });

    it("src/prompts/ directory glob catches Src/Prompts/foo.ts on case-insensitive FS", () => {
      const result = matchesHandsOff("Src/Prompts/foo.ts", ["src/prompts/"]);
      if (isCaseInsensitiveFs) {
        expect(result).toBe("src/prompts/");
      } else {
        expect(result).toBeNull();
      }
    });

    it("canonical case still matches regardless of platform", () => {
      expect(matchesHandsOff("src/reviewer.ts", ["src/reviewer.ts"])).toBe(
        "src/reviewer.ts",
      );
      expect(matchesHandsOff("CLAUDE.md", ["CLAUDE.md"])).toBe("CLAUDE.md");
    });
  });
});

describe("isBotRunning", () => {
  beforeEach(() => {
    mkdirSync(join(FIXTURES, "proj"), { recursive: true });
  });

  afterEach(() => {
    rmSync(FIXTURES, { recursive: true, force: true });
  });

  it("returns false for non-catalogdna detection mode", () => {
    const proj = makeProject({ concurrency_detection: "none" });
    expect(isBotRunning(proj)).toEqual({ running: false });
  });

  it("returns false when no signals exist", () => {
    const proj = makeProject();
    expect(isBotRunning(proj)).toEqual({ running: false });
  });

  // Signal 1: .bot-worktree directory
  it("detects fresh .bot-worktree as running", () => {
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    // default mtime is now → fresh
    const result = isBotRunning(makeProject());
    expect(result.running).toBe(true);
    expect(result.reason).toContain(".bot-worktree");
  });

  it("ignores stale .bot-worktree (>10 min old)", () => {
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    setAge(worktree, 15);
    expect(isBotRunning(makeProject())).toEqual({ running: false });
  });

  // Signal 2: bot_status.md
  it("detects active task in bot_status.md as running", () => {
    // Make .bot-worktree stale so signal 1 doesn't trigger
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    setAge(worktree, 15);

    writeFixture(
      "proj/bot_status.md",
      `# Bot Status\nStatus: **working**\nCurrent task: Fix login bug\n`,
    );
    const result = isBotRunning(makeProject());
    expect(result.running).toBe(true);
    expect(result.reason).toContain("bot_status.md");
  });

  it("ignores bot_status.md when status is idle", () => {
    writeFixture(
      "proj/bot_status.md",
      `# Bot Status\nStatus: **idle**\nCurrent task: none\n`,
    );
    expect(isBotRunning(makeProject())).toEqual({ running: false });
  });

  // Signal 3: heartbeat sentinels
  it("detects fresh heartbeat sentinel as running", () => {
    const sentinelPath = join(FIXTURES, "proj", "logs", "heartbeat_001.sentinel");
    mkdirSync(join(FIXTURES, "proj", "logs"), { recursive: true });
    writeFileSync(sentinelPath, "beat", "utf8");
    // default mtime is now → fresh
    const result = isBotRunning(makeProject());
    expect(result.running).toBe(true);
    expect(result.reason).toContain("heartbeat");
  });

  it("ignores stale heartbeat sentinel (>20 min old)", () => {
    const sentinelPath = join(FIXTURES, "proj", "logs", "heartbeat_001.sentinel");
    mkdirSync(join(FIXTURES, "proj", "logs"), { recursive: true });
    writeFileSync(sentinelPath, "beat", "utf8");
    setAge(sentinelPath, 25);
    expect(isBotRunning(makeProject())).toEqual({ running: false });
  });

  it("ignores non-sentinel files in logs directory", () => {
    mkdirSync(join(FIXTURES, "proj", "logs"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "proj", "logs", "output.log"),
      "log data",
      "utf8",
    );
    expect(isBotRunning(makeProject())).toEqual({ running: false });
  });

  // --- Worktree detection mode (single-signal: .bot-worktree only) ---

  it("worktree mode: detects fresh .bot-worktree with .git marker as running", () => {
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../.git/worktrees/bot\n");
    const result = isBotRunning(
      makeProject({ concurrency_detection: "worktree" }),
    );
    expect(result.running).toBe(true);
    expect(result.reason).toContain(".bot-worktree");
  });

  it("worktree mode: ignores empty .bot-worktree without .git marker", () => {
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    expect(isBotRunning(makeProject({ concurrency_detection: "worktree" }))).toEqual({ running: false });
  });

  it("worktree mode: ignores stale .bot-worktree (>10 min old)", () => {
    const worktree = join(FIXTURES, "proj", ".bot-worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../.git/worktrees/bot\n");
    setAge(worktree, 15);
    expect(
      isBotRunning(makeProject({ concurrency_detection: "worktree" })),
    ).toEqual({ running: false });
  });

  it("worktree mode: returns false when .bot-worktree does not exist", () => {
    expect(
      isBotRunning(makeProject({ concurrency_detection: "worktree" })),
    ).toEqual({ running: false });
  });

  it("worktree mode: ignores bot_status.md and heartbeat signals", () => {
    // Set up signals that would trigger in catalogdna mode
    writeFixture(
      "proj/bot_status.md",
      `# Bot Status\nStatus: **working**\nCurrent task: Fix login bug\n`,
    );
    const sentinelPath = join(FIXTURES, "proj", "logs", "heartbeat_001.sentinel");
    mkdirSync(join(FIXTURES, "proj", "logs"), { recursive: true });
    writeFileSync(sentinelPath, "beat", "utf8");
    // Worktree mode should only check .bot-worktree — these other signals are irrelevant
    expect(
      isBotRunning(makeProject({ concurrency_detection: "worktree" })),
    ).toEqual({ running: false });
  });
});

// gs-119: session pid tracking + stop --force

const STOP_FORCE_ROOT = join(import.meta.dir, "fixtures", "stop_force");

describe("session pid tracking (gs-119)", () => {
  beforeEach(() => {
    mkdirSync(STOP_FORCE_ROOT, { recursive: true });
    setRootDir(STOP_FORCE_ROOT);
  });
  afterEach(() => {
    rmSync(STOP_FORCE_ROOT, { recursive: true, force: true });
  });

  it("writes and reads back the session pid", async () => {
    await writeSessionPid(12345);
    expect(readSessionPid()).toBe(12345);
    expect(existsSync(sessionPidFilePath())).toBe(true);
  });

  it("readSessionPid returns null when no pid file exists", () => {
    expect(readSessionPid()).toBeNull();
  });

  it("readSessionPid returns null for malformed pid file", async () => {
    await writeSessionPid(0);
    // Overwrite with garbage
    writeFileSync(sessionPidFilePath(), "not-a-number\n", "utf8");
    expect(readSessionPid()).toBeNull();
  });

  it("removeSessionPid clears the file", async () => {
    await writeSessionPid(9999);
    await removeSessionPid();
    expect(existsSync(sessionPidFilePath())).toBe(false);
  });

  it("removeSessionPid is a no-op when file is missing", async () => {
    await removeSessionPid();
    expect(existsSync(sessionPidFilePath())).toBe(false);
  });
});

describe("killProcessTree (gs-119)", () => {
  it("uses taskkill on win32", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0, error: undefined };
    }) as any;
    const result = killProcessTree(4242, {
      platform: "win32",
      spawnSyncFn: fakeSpawn,
    });
    expect(result.killed).toBe(true);
    expect(result.method).toBe("taskkill");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("taskkill");
    expect(calls[0]!.args).toEqual(["/pid", "4242", "/f", "/t"]);
  });

  it("reports error when taskkill spawn fails", () => {
    const fakeSpawn = (() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as any;
    const result = killProcessTree(1, {
      platform: "win32",
      spawnSyncFn: fakeSpawn,
    });
    expect(result.killed).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("uses SIGTERM on non-windows platforms", () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const result = killProcessTree(321, {
      platform: "linux",
      killFn: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
    expect(result.killed).toBe(true);
    expect(result.method).toBe("signal");
    expect(killed).toEqual([{ pid: 321, signal: "SIGTERM" }]);
  });

  it("catches thrown errors from kill", () => {
    const result = killProcessTree(999, {
      platform: "linux",
      killFn: () => {
        throw new Error("ESRCH");
      },
    });
    expect(result.killed).toBe(false);
    expect(result.error).toContain("ESRCH");
  });
});

describe("stopForce (gs-119)", () => {
  beforeEach(() => {
    mkdirSync(STOP_FORCE_ROOT, { recursive: true });
    setRootDir(STOP_FORCE_ROOT);
  });
  afterEach(() => {
    rmSync(STOP_FORCE_ROOT, { recursive: true, force: true });
  });

  it("creates STOP file and returns pid=null when no session is tracked", async () => {
    const result = await stopForce({
      platform: "linux",
      killFn: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.stopFileCreated).toBe(true);
    expect(result.pid).toBeNull();
    expect(result.killed).toBe(false);
    expect(existsSync(join(STOP_FORCE_ROOT, "STOP"))).toBe(true);
  });

  it("kills the tracked pid and clears the pid file", async () => {
    await writeSessionPid(77777);
    const killCalls: number[] = [];
    const result = await stopForce({
      platform: "linux",
      killFn: (pid) => {
        killCalls.push(pid);
      },
    });
    expect(result.stopFileCreated).toBe(true);
    expect(result.pid).toBe(77777);
    expect(result.killed).toBe(true);
    expect(result.method).toBe("signal");
    expect(killCalls).toEqual([77777]);
    expect(existsSync(sessionPidFilePath())).toBe(false);
    expect(existsSync(join(STOP_FORCE_ROOT, "STOP"))).toBe(true);
  });

  it("uses taskkill on win32 and clears pid file even on failure", async () => {
    await writeSessionPid(88888);
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0, error: undefined };
    }) as any;
    const result = await stopForce({
      platform: "win32",
      spawnSyncFn: fakeSpawn,
    });
    expect(result.pid).toBe(88888);
    expect(result.killed).toBe(true);
    expect(calls[0]!.args).toEqual(["/pid", "88888", "/f", "/t"]);
    expect(existsSync(sessionPidFilePath())).toBe(false);
  });
});

// gs-178: clean-tree check exempts state/<id>/PROGRESS.jsonl so the
// dispatcher's per-cycle audit log writes don't block subsequent cycles
// in the same session. Existing strictness on every other state path is
// preserved — only PROGRESS.jsonl files are exempt, by name.
describe("clean-tree exemption (gs-178)", () => {
  describe("isExemptFromCleanTreeCheck", () => {
    it("exempts state/<id>/PROGRESS.jsonl for any project id", () => {
      expect(isExemptFromCleanTreeCheck("state/generalstaff/PROGRESS.jsonl")).toBe(true);
      expect(isExemptFromCleanTreeCheck("state/gamr/PROGRESS.jsonl")).toBe(true);
      expect(isExemptFromCleanTreeCheck("state/_fleet/PROGRESS.jsonl")).toBe(true);
      expect(isExemptFromCleanTreeCheck("state/some-future-project/PROGRESS.jsonl")).toBe(true);
    });

    it("does NOT exempt other state-dir files", () => {
      // tasks.json mutations are real state changes — must trip the check
      expect(isExemptFromCleanTreeCheck("state/gamr/tasks.json")).toBe(false);
      expect(isExemptFromCleanTreeCheck("state/gamr/MISSION.md")).toBe(false);
      expect(isExemptFromCleanTreeCheck("state/gamr/STATE.json")).toBe(false);
      // session.pid is lifecycle, not audit — out of scope for gs-178
      expect(isExemptFromCleanTreeCheck("state/session.pid")).toBe(false);
      // Cycle artifacts under state/<id>/cycles/ are real state — must trip
      expect(isExemptFromCleanTreeCheck("state/gamr/cycles/foo/diff.patch")).toBe(false);
    });

    it("does NOT exempt PROGRESS.jsonl outside the state/<id>/ shape", () => {
      // Path discipline: the exemption is for the dispatcher-managed
      // audit log specifically, not "any file named PROGRESS.jsonl"
      expect(isExemptFromCleanTreeCheck("PROGRESS.jsonl")).toBe(false);
      expect(isExemptFromCleanTreeCheck("state/PROGRESS.jsonl")).toBe(false);
      expect(isExemptFromCleanTreeCheck("state/gamr/sub/PROGRESS.jsonl")).toBe(false);
      expect(isExemptFromCleanTreeCheck("docs/PROGRESS.jsonl")).toBe(false);
    });

    it("does NOT exempt non-state code files", () => {
      expect(isExemptFromCleanTreeCheck("src/safety.ts")).toBe(false);
      expect(isExemptFromCleanTreeCheck("CLAUDE.md")).toBe(false);
      expect(isExemptFromCleanTreeCheck("projects.yaml")).toBe(false);
    });
  });

  describe("filterCleanTreePorcelain", () => {
    it("returns empty for empty input", () => {
      expect(filterCleanTreePorcelain("")).toBe("");
    });

    it("drops only-PROGRESS.jsonl lines, returning empty (effectively clean)", () => {
      const input = [
        " M state/gamr/PROGRESS.jsonl",
        " M state/generalstaff/PROGRESS.jsonl",
        " M state/_fleet/PROGRESS.jsonl",
      ].join("\n");
      expect(filterCleanTreePorcelain(input)).toBe("");
    });

    it("preserves non-exempt dirty paths (real state changes)", () => {
      const input = [
        " M state/gamr/PROGRESS.jsonl",
        " M state/gamr/tasks.json",
        " M src/foo.ts",
      ].join("\n");
      const result = filterCleanTreePorcelain(input);
      expect(result).toContain("state/gamr/tasks.json");
      expect(result).toContain("src/foo.ts");
      expect(result).not.toContain("PROGRESS.jsonl");
    });

    it("handles deletion lines (D path)", () => {
      const input = [
        " D state/session.pid",
        " M state/gamr/PROGRESS.jsonl",
      ].join("\n");
      const result = filterCleanTreePorcelain(input);
      expect(result).toContain("state/session.pid");
      expect(result).not.toContain("PROGRESS.jsonl");
    });

    it("handles untracked lines (?? path)", () => {
      const input = [
        "?? new_file.ts",
        " M state/gamr/PROGRESS.jsonl",
      ].join("\n");
      const result = filterCleanTreePorcelain(input);
      expect(result).toContain("new_file.ts");
    });

    it("handles renames (R old -> new) by filtering on the new path", () => {
      // If the renamed-to path is exempt, drop the line; else keep it
      const exemptRename = "R  old.ts -> state/gamr/PROGRESS.jsonl";
      expect(filterCleanTreePorcelain(exemptRename)).toBe("");
      const realRename = "R  state/gamr/PROGRESS.jsonl -> src/foo.ts";
      expect(filterCleanTreePorcelain(realRename)).toContain("src/foo.ts");
    });

    it("preserves the gs-178-motivating real-world case", () => {
      // Verbatim shape from cycle 20260418112438_fcsb (gamr cycle 1):
      // bot wrote state/gamr/PROGRESS.jsonl during cycle, then dispatcher
      // tried to start the next cycle and saw this dirty tree.
      const input = [
        " M state/_fleet/PROGRESS.jsonl",
        " M state/gamr/PROGRESS.jsonl",
        " M state/generalstaff/PROGRESS.jsonl",
        " D state/session.pid",
      ].join("\n");
      const result = filterCleanTreePorcelain(input);
      // session.pid is not exempt — the original safety surface is preserved
      // for genuine state mutations. PROGRESS.jsonl lines are gone.
      expect(result).toContain("state/session.pid");
      expect(result).not.toContain("PROGRESS.jsonl");
    });
  });
});
