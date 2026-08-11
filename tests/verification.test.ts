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
        "/home/operator/proj",
      );
      expect(hint).toContain("bun");
      expect(hint).toContain("/home/operator/proj");
      expect(hint).toContain("(Try: cd /home/operator/proj && bun)");
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

  describe("customer_facing_smoke (gs-316)", () => {
    it("keeps passed when smoke exits 0 on a public_facing project", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        public_facing: true,
        customer_facing_smoke: "true",
      });
      const result = await runVerification(project, "cycle-smoke-pass");

      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("=== Customer-facing smoke ===");
    });

    it("returns failed when smoke exits non-zero despite passing main verification", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        public_facing: true,
        customer_facing_smoke: "exit 1",
      });
      const result = await runVerification(project, "cycle-smoke-fail");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(1);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("=== Customer-facing smoke ===");
    });

    it("does not run smoke when project is not public_facing or smoke is unset", async () => {
      const withoutFlag = makeProject({
        verification_command: "test 1 -eq 1",
        customer_facing_smoke: "exit 1",
      });
      const withoutSmoke = makeProject({
        verification_command: "test 1 -eq 1",
        public_facing: true,
      });

      const r1 = await runVerification(withoutFlag, "cycle-smoke-skip-1");
      const r2 = await runVerification(withoutSmoke, "cycle-smoke-skip-2");

      expect(r1.outcome).toBe("passed");
      expect(r2.outcome).toBe("passed");
      expect(readFileSync(r1.logPath, "utf8")).not.toContain(
        "Customer-facing smoke",
      );
      expect(readFileSync(r2.logPath, "utf8")).not.toContain(
        "Customer-facing smoke",
      );
    });

    it("does not run smoke when main verification already failed", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 2",
        public_facing: true,
        customer_facing_smoke: "exit 1",
      });
      const result = await runVerification(project, "cycle-smoke-skip-fail");

      expect(result.outcome).toBe("failed");
      const log = readFileSync(result.logPath, "utf8");
      expect(log).not.toContain("Customer-facing smoke");
    });
  });

  describe("player_path_command", () => {
    it("runs after main verification and keeps passed when the probe exits 0", async () => {
      const project = makeProject({
        verification_command: "printf 'unit\\n'",
        player_path_command: "printf 'player-path\\n'",
      });
      const result = await runVerification(project, "cycle-player-pass");

      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("=== Player-path verification ===");
      expect(log.indexOf("unit")).toBeLessThan(log.indexOf("player-path"));
    });

    it("fails the cycle when the player-path probe exits non-zero", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        player_path_command: "exit 7",
      });
      const result = await runVerification(project, "cycle-player-fail");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(7);
    });

    it("does not run the player-path probe when main verification fails", async () => {
      const marker = join(TEST_DIR, "player-path-ran");
      const project = makeProject({
        verification_command: "exit 1",
        player_path_command: `touch '${marker}'`,
      });
      const result = await runVerification(project, "cycle-player-skip");

      expect(result.outcome).toBe("failed");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(result.logPath, "utf8")).not.toContain(
        "Player-path verification",
      );
    });

    it("records the optional probe in dry-run output without executing it", async () => {
      const marker = join(TEST_DIR, "player-path-dry-ran");
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        player_path_command: `touch '${marker}'`,
      });
      const result = await runVerification(
        project,
        "cycle-player-dry",
        undefined,
        true,
      );

      expect(result.outcome).toBe("passed");
      expect(existsSync(marker)).toBe(false);
      const log = await readCycleFile(
        "test-proj",
        "cycle-player-dry",
        "verification.log",
      );
      expect(log).toContain("Would execute player-path verification");
    });

    it("writes player-path run and outcome events", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        player_path_command: "test 2 -eq 2",
      });
      await runVerification(project, "cycle-player-audit");

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      const events = readFileSync(progressPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const runEvent = events.find(
        (event: { event: string }) => event.event === "player_path_run",
      );
      const outcomeEvent = events.find(
        (event: { event: string }) => event.event === "player_path_outcome",
      );

      expect(runEvent.data.command).toBe("test 2 -eq 2");
      expect(outcomeEvent.data.outcome).toBe("passed");
      expect(outcomeEvent.data.exit_code).toBe(0);
    });

    it("runs before the additional customer-facing smoke", async () => {
      const project = makeProject({
        verification_command: "printf 'unit-stage\\n'",
        player_path_command: "printf 'player-stage\\n'",
        public_facing: true,
        customer_facing_smoke: "printf 'smoke-stage\\n'",
      });
      const result = await runVerification(project, "cycle-player-order");

      expect(result.outcome).toBe("passed");
      const log = readFileSync(result.logPath, "utf8");
      expect(log.indexOf("unit-stage")).toBeLessThan(
        log.indexOf("player-stage"),
      );
      expect(log.indexOf("player-stage")).toBeLessThan(
        log.indexOf("smoke-stage"),
      );
    });

  });

  describe("claim_battery_command", () => {
    it("runs after main verification (and after player_path when both set) and keeps passed on exit 0", async () => {
      const project = makeProject({
        verification_command: "printf 'unit\\n'",
        player_path_command: "printf 'player-path\\n'",
        claim_battery_command: "printf 'claim-battery\\n'",
      });
      const result = await runVerification(project, "cycle-claim-pass");

      expect(result.outcome).toBe("passed");
      expect(result.exitCode).toBe(0);
      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("=== Claim-battery verification ===");
      expect(log.indexOf("unit")).toBeLessThan(log.indexOf("player-path"));
      expect(log.indexOf("player-path")).toBeLessThan(
        log.indexOf("claim-battery"),
      );
    });

    it("fails the cycle when the claim-battery exits non-zero", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        claim_battery_command: "exit 7",
      });
      const result = await runVerification(project, "cycle-claim-fail");

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(7);
    });

    it("does not run the claim-battery when main verification fails", async () => {
      const marker = join(TEST_DIR, "claim-battery-ran");
      const project = makeProject({
        verification_command: "exit 1",
        claim_battery_command: `touch '${marker}'`,
      });
      const result = await runVerification(project, "cycle-claim-skip");

      expect(result.outcome).toBe("failed");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(result.logPath, "utf8")).not.toContain(
        "Claim-battery verification",
      );
    });

    it("does not run the claim-battery when player_path fails", async () => {
      const marker = join(TEST_DIR, "claim-battery-after-player-fail");
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        player_path_command: "exit 3",
        claim_battery_command: `touch '${marker}'`,
      });
      const result = await runVerification(
        project,
        "cycle-claim-skip-player-fail",
      );

      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(3);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(result.logPath, "utf8")).not.toContain(
        "Claim-battery verification",
      );
    });

    it("records the optional battery in dry-run output without executing it", async () => {
      const marker = join(TEST_DIR, "claim-battery-dry-ran");
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        claim_battery_command: `touch '${marker}'`,
      });
      const result = await runVerification(
        project,
        "cycle-claim-dry",
        undefined,
        true,
      );

      expect(result.outcome).toBe("passed");
      expect(existsSync(marker)).toBe(false);
      const log = await readCycleFile(
        "test-proj",
        "cycle-claim-dry",
        "verification.log",
      );
      expect(log).toContain("Would execute claim-battery verification");
    });

    it("writes claim-battery run and outcome events", async () => {
      const project = makeProject({
        verification_command: "test 1 -eq 1",
        claim_battery_command: "test 2 -eq 2",
      });
      await runVerification(project, "cycle-claim-audit");

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      const events = readFileSync(progressPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const runEvent = events.find(
        (event: { event: string }) => event.event === "claim_battery_run",
      );
      const outcomeEvent = events.find(
        (event: { event: string }) => event.event === "claim_battery_outcome",
      );

      expect(runEvent.data.command).toBe("test 2 -eq 2");
      expect(outcomeEvent.data.outcome).toBe("passed");
      expect(outcomeEvent.data.exit_code).toBe(0);
    });

    it("runs unit → player → claim → smoke when all configured", async () => {
      const project = makeProject({
        verification_command: "printf 'unit-stage\\n'",
        player_path_command: "printf 'player-stage\\n'",
        claim_battery_command: "printf 'claim-stage\\n'",
        public_facing: true,
        customer_facing_smoke: "printf 'smoke-stage\\n'",
      });
      const result = await runVerification(project, "cycle-claim-order");

      expect(result.outcome).toBe("passed");
      const log = readFileSync(result.logPath, "utf8");
      expect(log.indexOf("unit-stage")).toBeLessThan(
        log.indexOf("player-stage"),
      );
      expect(log.indexOf("player-stage")).toBeLessThan(
        log.indexOf("claim-stage"),
      );
      expect(log.indexOf("claim-stage")).toBeLessThan(
        log.indexOf("smoke-stage"),
      );
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
