import { describe, expect, it } from "bun:test";
import { matchesHandsOff } from "../src/safety";

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
