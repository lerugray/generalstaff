import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  runVerification,
  isNoopCommand,
  isCommandNotFoundSignature,
  formatCommandNotFoundHint,
} from "../src/verification";
import { setRootDir, readCycleFile } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import type { ProjectConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, "fixtures", "verification_test");

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test-proj",
    path: TEST_DIR,
    priority: 1,
    engineer_command: "echo engineer",
    verification_command: "test 1 -eq 1",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["CLAUDE.md"],
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("verification gate", () => {
  describe("real runs", () => {
    it("returns passed when command exits 0", async () => {
      const project = makeProject({ verification_command: "test 1 -eq 1" });
      const result = await runVerification(project, "cycle-001");

      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(existsSync(result.logPath)).toBe(true);
    });

    it("returns failed when command exits non-zero", async () => {
      const project = makeProject({ verification_command: "test 1 -eq 2" });
      const result = await runVerification(project, "cycle-002");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).not.toBe(0);
    });

    it("returns weak for no-op command: true", async () => {
      const project = makeProject({ verification_command: "true" });
      const result = await runVerification(project, "cycle-003");

      expect(result.outcome).toBe("weak");
      expect(result.exitCode).toBe(0);
    });

    it("returns weak for no-op command: :", async () => {
      const project = makeProject({ verification_command: ":" });
      const result = await runVerification(project, "cycle-004");

      expect(result.outcome).toBe("weak");
      expect(result.exitCode).toBe(0);
    });

    it("returns weak for no-op command: echo", async () => {
      const project = makeProject({ verification_command: "echo hello" });
      const result = await runVerification(project, "cycle-005");

      expect(result.outcome).toBe("weak");
      expect(result.exitCode).toBe(0);
    });

    it("writes verification log with command output", async () => {
      const project = makeProject({ verification_command: "test 1 -eq 1" });
      const result = await runVerification(project, "cycle-006");

      const logContent = readFileSync(result.logPath, "utf8");
      expect(logContent).toContain("GeneralStaff Verification Gate");
      expect(logContent).toContain("test 1 -eq 1");
      expect(logContent).toContain("Exit code: 0");
    });

  });

  describe("dry runs", () => {
    it("returns passed for real command in dry-run mode", async () => {
      const project = makeProject({ verification_command: "test 1 -eq 1" });
      const result = await runVerification(project, "cycle-010", undefined, true);

      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.durationSeconds).toBe(0);
    });

    it("returns weak for no-op command in dry-run mode", async () => {
      const project = makeProject({ verification_command: "true" });
      const result = await runVerification(project, "cycle-011", undefined, true);

      expect(result.outcome).toBe("weak");
      expect(result.exitCode).toBe(0);
    });

    it("writes dry-run log file", async () => {
      const project = makeProject({ verification_command: "bun test" });
      const result = await runVerification(project, "cycle-012", undefined, true);

      const logContent = await readCycleFile("test-proj", "cycle-012", "verification.log");
      expect(logContent).not.toBeNull();
      expect(logContent!).toContain("[DRY RUN]");
      expect(logContent!).toContain("bun test");
    });

    it("does not execute the command in dry-run mode", async () => {
      // A command that would fail if actually run
      const project = makeProject({ verification_command: "exit 1" });
      const result = await runVerification(project, "cycle-013", undefined, true);

      // Dry run always reports passed (exit 1 is a noop match, but "exit 1" != "exit 0")
      // "exit 1" doesn't match any NOOP_COMMANDS, so dry run returns "passed"
      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("isNoopCommand", () => {
    it("treats bare 'true' as a noop", () => {
      expect(isNoopCommand("true")).toBe(true);
    });

    it("treats bare ':' as a noop", () => {
      expect(isNoopCommand(":")).toBe(true);
    });

    it("treats bare 'echo' as a noop", () => {
      expect(isNoopCommand("echo")).toBe(true);
    });

    it("treats 'exit 0' as a noop", () => {
      expect(isNoopCommand("exit 0")).toBe(true);
    });

    it("treats prefix-with-space matches as noops (e.g. 'true && npm test')", () => {
      // Documented behavior: startsWith(noop + ' ') matches, so a real test
      // suite chained after `true` is still flagged as a noop. The chained
      // command is not inspected — this is intentional but worth pinning.
      expect(isNoopCommand("true && npm test")).toBe(true);
    });

    it("does not match commands that merely start with noop letters but no word boundary", () => {
      // 'tree' shares no prefix; 'truecheck' begins with 'true' but the
      // startsWith(noop + ' ') guard requires a space, so neither is a noop.
      expect(isNoopCommand("tree")).toBe(false);
      expect(isNoopCommand("truecheck")).toBe(false);
    });

    it("returns false for whitespace-only and empty input", () => {
      expect(isNoopCommand("   ")).toBe(false);
      expect(isNoopCommand("")).toBe(false);
    });

    it("trims surrounding whitespace before matching", () => {
      expect(isNoopCommand("  true  ")).toBe(true);
      expect(isNoopCommand("\techo hello\n")).toBe(true);
    });
  });

  describe("command-not-found hint (gs-261)", () => {
    it("adds the hint when exit code is 127", async () => {
      const project = makeProject({
        verification_command: "exit 127",
      });
      const result = await runVerification(project, "cycle-cnf-1");

      expect(result.outcome).toBe("failed");
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("not found");
      expect(log).toContain(TEST_DIR);
      expect(log).toContain("exit");
    });

    it("adds the hint when stderr contains 'command not found'", async () => {
      // Use exit 1 so we exercise the stderr path, not the exit-127 path.
      const project = makeProject({
        verification_command:
          "printf 'bash: bogusbinary: command not found\\n' >&2; exit 1",
      });
      const result = await runVerification(project, "cycle-cnf-2");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(1);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("not found");
      expect(log).toContain(TEST_DIR);
    });

    it("does NOT add the hint for a normal non-zero exit", async () => {
      const project = makeProject({ verification_command: "exit 1" });
      const result = await runVerification(project, "cycle-cnf-3");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(1);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).not.toContain("Verification command");
      expect(log).not.toContain("is the tool installed");
    });

    it("hint message includes project path and command head", async () => {
      const hint = formatCommandNotFoundHint(
        "bun test --coverage",
        "/home/ray/proj",
      );
      expect(hint).toContain("bun");
      expect(hint).toContain("/home/ray/proj");
      expect(hint).toContain("(Try: cd /home/ray/proj && bun)");
      expect(hint.startsWith("Verification command 'bun' not found")).toBe(true);
    });

    it("isCommandNotFoundSignature matches 127, substrings, not normal exits", () => {
      expect(isCommandNotFoundSignature(127, "")).toBe(true);
      expect(
        isCommandNotFoundSignature(1, "bash: foo: command not found"),
      ).toBe(true);
      expect(
        isCommandNotFoundSignature(
          1,
          "'foo' is not recognized as an internal or external command",
        ),
      ).toBe(true);
      expect(isCommandNotFoundSignature(1, "cannot find 'foo'")).toBe(true);
      expect(isCommandNotFoundSignature(1, "test failed")).toBe(false);
      expect(isCommandNotFoundSignature(0, "")).toBe(false);
    });
  });

  describe("audit trail", () => {
    it("writes progress entries for verification", async () => {
      const project = makeProject({ verification_command: "test 1 -eq 1" });
      await runVerification(project, "cycle-020");

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      expect(existsSync(progressPath)).toBe(true);

      const lines = readFileSync(progressPath, "utf8").trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const runEvent = events.find((e: { event: string }) => e.event === "verification_run");
      const outcomeEvent = events.find((e: { event: string }) => e.event === "verification_outcome");

      expect(runEvent).toBeDefined();
      expect(runEvent.data.command).toBe("test 1 -eq 1");

      expect(outcomeEvent).toBeDefined();
      expect(outcomeEvent.data.outcome).toBe("passed");
      expect(outcomeEvent.data.exit_code).toBe(0);
    });
  });
});
