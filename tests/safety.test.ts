import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { matchesHandsOff, isBotRunning } from "../src/safety";
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
