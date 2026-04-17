import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  runEngineer,
  killChildTree,
  killActiveEngineer,
  getActiveEngineerChild,
} from "../src/engineer";
import { setRootDir, readCycleFile } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import type { ProjectConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, "fixtures", "engineer_test");

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test-proj",
    path: TEST_DIR,
    priority: 1,
    engineer_command: "echo 'doing work'",
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

describe("engineer module", () => {
  describe("dry runs", () => {
    it("returns exitCode 0 and zero duration", async () => {
      const project = makeProject();
      const result = await runEngineer(project, "cycle-001", undefined, true);

      expect(result.exitCode).toBe(0);
      expect(result.durationSeconds).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it("writes dry-run log with the command", async () => {
      const project = makeProject({ engineer_command: "claude --budget 30" });
      const result = await runEngineer(project, "cycle-002", undefined, true);

      const logContent = await readCycleFile("test-proj", "cycle-002", "engineer.log");
      expect(logContent).not.toBeNull();
      expect(logContent!).toContain("[DRY RUN]");
      expect(logContent!).toContain("claude --budget 30");
    });

    it("does not execute the command in dry-run mode", async () => {
      // A command that would fail if actually run
      const project = makeProject({ engineer_command: "exit 1" });
      const result = await runEngineer(project, "cycle-003", undefined, true);

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it("includes logPath pointing to cycle directory", async () => {
      const project = makeProject();
      const result = await runEngineer(project, "cycle-004", undefined, true);

      expect(result.logPath).toContain("cycle-004");
      expect(result.logPath).toContain("engineer.log");
    });
  });

  describe("audit trail", () => {
    it("writes progress entries for dry-run engineer invocation", async () => {
      const project = makeProject({ engineer_command: "echo test" });
      await runEngineer(project, "cycle-010", undefined, true);

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      expect(existsSync(progressPath)).toBe(true);

      const lines = readFileSync(progressPath, "utf8").trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const invokedEvent = events.find((e: { event: string }) => e.event === "engineer_invoked");
      const completedEvent = events.find((e: { event: string }) => e.event === "engineer_completed");

      expect(invokedEvent).toBeDefined();
      expect(invokedEvent.data.command).toBe("echo test");
      expect(invokedEvent.data.dry_run).toBe(true);

      expect(completedEvent).toBeDefined();
      expect(completedEvent.data.exit_code).toBe(0);
      expect(completedEvent.data.dry_run).toBe(true);
      expect(completedEvent.data.duration_seconds).toBe(0);
    });

    it("records cycle_budget_minutes in invoked event", async () => {
      const project = makeProject({ cycle_budget_minutes: 45 });
      await runEngineer(project, "cycle-011", undefined, true);

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      const lines = readFileSync(progressPath, "utf8").trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const invokedEvent = events.find((e: { event: string }) => e.event === "engineer_invoked");
      expect(invokedEvent.data.cycle_budget_minutes).toBe(45);
    });
  });

  describe("killChildTree", () => {
    it("uses taskkill /f /t on Windows when pid is set", () => {
      const spawnCalls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
      const killCalls: Array<NodeJS.Signals | number | undefined> = [];
      const fakeSpawnSync = ((cmd: string, args: readonly string[], opts: unknown) => {
        spawnCalls.push({ cmd, args, opts });
        return { status: 0, signal: null, pid: 0, output: [], stdout: "", stderr: "" } as unknown as ReturnType<typeof import("child_process").spawnSync>;
      }) as unknown as typeof import("child_process").spawnSync;
      const fakeChild = {
        pid: 12345,
        kill: (sig?: NodeJS.Signals | number) => {
          killCalls.push(sig);
          return true;
        },
      };

      killChildTree(fakeChild, {
        platform: "win32",
        spawnSyncFn: fakeSpawnSync,
      });

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].cmd).toBe("taskkill");
      expect(spawnCalls[0].args).toEqual(["/pid", "12345", "/f", "/t"]);
      expect(spawnCalls[0].opts).toEqual({ stdio: "ignore" });
      // On Windows we must NOT fall back to the signal path — signals don't
      // propagate through the process tree on win32.
      expect(killCalls.length).toBe(0);
    });

    it("uses SIGTERM then schedules SIGKILL on non-Windows platforms", () => {
      const killCalls: Array<NodeJS.Signals | number | undefined> = [];
      const spawnCalls: Array<unknown> = [];
      let scheduledCb: (() => void) | null = null;
      let scheduledDelay: number = -1;
      const fakeSpawnSync = ((..._args: unknown[]) => {
        spawnCalls.push(_args);
        return {} as unknown as ReturnType<typeof import("child_process").spawnSync>;
      }) as unknown as typeof import("child_process").spawnSync;
      const fakeSetTimeout = (cb: () => void, ms: number) => {
        scheduledCb = cb;
        scheduledDelay = ms;
        return 0;
      };
      const fakeChild = {
        pid: 6789,
        kill: (sig?: NodeJS.Signals | number) => {
          killCalls.push(sig);
          return true;
        },
      };

      killChildTree(fakeChild, {
        platform: "linux",
        spawnSyncFn: fakeSpawnSync,
        setTimeoutFn: fakeSetTimeout,
      });

      expect(spawnCalls.length).toBe(0);
      expect(killCalls).toEqual(["SIGTERM"]);
      expect(scheduledDelay).toBe(10_000);

      // Fire the scheduled SIGKILL callback and confirm it escalates.
      expect(scheduledCb).not.toBeNull();
      scheduledCb!();
      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("falls back to signal path on Windows when pid is missing", () => {
      // Defensive: win32 branch is guarded by `child.pid` truthiness.
      // Without a pid there's nothing for taskkill to target, so we fall
      // through to child.kill — matches the current engineer.ts behavior.
      const killCalls: Array<NodeJS.Signals | number | undefined> = [];
      const spawnCalls: Array<unknown> = [];
      const fakeSpawnSync = ((..._args: unknown[]) => {
        spawnCalls.push(_args);
        return {} as unknown as ReturnType<typeof import("child_process").spawnSync>;
      }) as unknown as typeof import("child_process").spawnSync;
      const fakeSetTimeout = (_cb: () => void, _ms: number) => 0;
      const fakeChild = {
        pid: undefined,
        kill: (sig?: NodeJS.Signals | number) => {
          killCalls.push(sig);
          return true;
        },
      };

      killChildTree(fakeChild, {
        platform: "win32",
        spawnSyncFn: fakeSpawnSync,
        setTimeoutFn: fakeSetTimeout,
      });

      expect(spawnCalls.length).toBe(0);
      expect(killCalls).toEqual(["SIGTERM"]);
    });
  });

  describe("active-engineer registry (gs-131)", () => {
    it("returns false from killActiveEngineer when no engineer is running", () => {
      expect(killActiveEngineer()).toBe(false);
      expect(getActiveEngineerChild()).toBeNull();
    });

    it("kills the live child and clears the registry when STOP triggers mid-run", async () => {
      // A long-running sleep stands in for a real claude invocation — the
      // session watcher fires killActiveEngineer once STOP is observed.
      const project = makeProject({ engineer_command: "sleep 30" });
      const runPromise = runEngineer(project, "cycle-kill-1");

      // Wait for the child to be registered (spawn is async).
      for (let i = 0; i < 20 && !getActiveEngineerChild(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(getActiveEngineerChild()).not.toBeNull();

      const killed = killActiveEngineer();
      expect(killed).toBe(true);

      const result = await runPromise;
      // Killed subprocesses report exitCode=null (signal) or non-zero on
      // win32 taskkill. Either way, it's not a clean 0.
      expect(result.exitCode).not.toBe(0);
      expect(getActiveEngineerChild()).toBeNull();
    });
  });

  describe("real runs", () => {
    it("returns exit code from command", async () => {
      const project = makeProject({ engineer_command: "echo hello" });
      const result = await runEngineer(project, "cycle-020");

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
    });

    it("captures non-zero exit code", async () => {
      const project = makeProject({ engineer_command: "exit 42" });
      const result = await runEngineer(project, "cycle-021");

      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });

    it("writes log with header and footer", async () => {
      const project = makeProject({ engineer_command: "echo 'test output'" });
      const result = await runEngineer(project, "cycle-022");

      expect(existsSync(result.logPath)).toBe(true);
      const logContent = readFileSync(result.logPath, "utf8");
      expect(logContent).toContain("GeneralStaff Engineer");
      expect(logContent).toContain("echo 'test output'");
      expect(logContent).toContain("Exit code: 0");
    });

    it("expands ${cycle_budget_minutes} in command", async () => {
      const project = makeProject({
        engineer_command: "echo budget=${cycle_budget_minutes}",
        cycle_budget_minutes: 25,
      });
      const result = await runEngineer(project, "cycle-023");

      const logContent = readFileSync(result.logPath, "utf8");
      expect(logContent).toContain("Command: echo budget=25");
    });
  });
});
