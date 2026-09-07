import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  runEngineer,
  killChildTree,
  killActiveEngineer,
  getActiveEngineerChild,
  markOwnedUnixProcessGroup,
} from "../src/engineer";
import {
  setActiveEngineerChild,
  clearActiveEngineerChild,
  getActiveEngineerChildren,
  settleOwnedUnixProcessGroup,
  isOwnedUnixProcessGroupTracked,
} from "../src/active_engineer";
import { startStopFileWatcher } from "../src/stop_watcher";
import { setRootDir, readCycleFile } from "../src/state";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import type { ProjectConfig } from "../src/types";
import { GENERALSTAFF_TASK_CLAIM_PREFIX } from "../src/prompts/engineer_claim";

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
  setActiveEngineerChild(null);
});

afterEach(() => {
  setActiveEngineerChild(null);
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

    it("registers two owners without overwrite; kill signals both", () => {
      const kills: string[] = [];
      const a = {
        pid: 101,
        kill: () => {
          kills.push("a");
          return true;
        },
      };
      const b = {
        pid: 102,
        kill: () => {
          kills.push("b");
          return true;
        },
      };
      setActiveEngineerChild(a);
      setActiveEngineerChild(b);
      expect(getActiveEngineerChildren()).toHaveLength(2);
      expect(getActiveEngineerChild()).toBe(b);

      const killed = killActiveEngineer({
        platform: "linux",
        setTimeoutFn: () => 0,
      });
      expect(killed).toBe(true);
      expect(kills).toEqual(["a", "b"]);
    });

    it("clearing either owner leaves the sibling registered", () => {
      const a = { pid: 201, kill: () => true };
      const b = { pid: 202, kill: () => true };
      setActiveEngineerChild(a);
      setActiveEngineerChild(b);
      clearActiveEngineerChild(a);
      expect(getActiveEngineerChildren()).toEqual([b]);
      expect(getActiveEngineerChild()).toBe(b);
      clearActiveEngineerChild(b);
      expect(getActiveEngineerChildren()).toHaveLength(0);
      expect(getActiveEngineerChild()).toBeNull();
    });

    it("setActiveEngineerChild(null) clears all owners", () => {
      setActiveEngineerChild({ pid: 1, kill: () => true });
      setActiveEngineerChild({ pid: 2, kill: () => true });
      setActiveEngineerChild(null);
      expect(getActiveEngineerChildren()).toHaveLength(0);
      expect(killActiveEngineer()).toBe(false);
    });

    it("repeated stop returns true while active and does not stack escalations", () => {
      const killCalls: Array<string | number> = [];
      let timeoutCount = 0;
      const child = {
        pid: 303,
        kill: (sig?: NodeJS.Signals | number) => {
          killCalls.push(sig ?? "kill");
          return true;
        },
      };
      setActiveEngineerChild(child);
      const opts = {
        platform: "linux" as const,
        setTimeoutFn: (_cb: () => void, _ms: number) => {
          timeoutCount += 1;
          return timeoutCount;
        },
      };
      expect(killActiveEngineer(opts)).toBe(true);
      expect(killActiveEngineer(opts)).toBe(true);
      expect(timeoutCount).toBe(1);
      expect(killCalls).toEqual(["SIGTERM", "SIGTERM"]);
    });

    it("engineer exiting removes only itself while sibling remains", async () => {
      const projectA = makeProject({
        id: "own-a",
        engineer_command: "sleep 0.2",
      });
      const projectB = makeProject({
        id: "own-b",
        engineer_command: "sleep 5",
      });
      const runA = runEngineer(projectA, "cycle-exit-a");
      const runB = runEngineer(projectB, "cycle-exit-b");

      for (let i = 0; i < 40 && getActiveEngineerChildren().length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(getActiveEngineerChildren().length).toBeGreaterThanOrEqual(2);

      await runA;
      expect(getActiveEngineerChildren().length).toBe(1);
      expect(killActiveEngineer()).toBe(true);
      const resultB = await runB;
      expect(resultB.exitCode).not.toBe(0);
      expect(getActiveEngineerChildren()).toHaveLength(0);
    });

    it("overlapping real engineer processes are both killed by STOP", async () => {
      const projectA = makeProject({
        id: "para-a",
        engineer_command: "sleep 20",
      });
      const projectB = makeProject({
        id: "para-b",
        engineer_command: "sleep 20",
      });
      const runA = runEngineer(projectA, "cycle-para-a");
      const runB = runEngineer(projectB, "cycle-para-b");

      for (let i = 0; i < 40 && getActiveEngineerChildren().length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(getActiveEngineerChildren().length).toBe(2);

      expect(killActiveEngineer()).toBe(true);
      const [ra, rb] = await Promise.all([runA, runB]);
      expect(ra.exitCode).not.toBe(0);
      expect(rb.exitCode).not.toBe(0);
      expect(getActiveEngineerChildren()).toHaveLength(0);
    });
  });

  describe("Unix owned process groups", () => {
    const isUnix = process.platform !== "win32";
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

    /** Live process check: zombies/dead count as not alive (Linux /proc; kill(0) elsewhere). */
    function alive(pid: number): boolean {
      try {
        if (process.platform === "linux") {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const state = stat.charAt(stat.lastIndexOf(")") + 2);
          return state !== "Z" && state !== "X";
        }
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    function groupAlive(pgid: number): boolean {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    }
    // Fixture cleanup only ever targets the exact pids/groups the test created.
    function killGroup(pgid: number | null | undefined): void {
      if (!pgid || pgid <= 1 || pgid === process.pid) return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    function killPid(pid: number | null | undefined): void {
      if (!pid || pid <= 1 || pid === process.pid || !alive(pid)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    async function waitFor(fn: () => boolean, ms = 5_000, step = 25): Promise<boolean> {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) return false;
        await sleep(step);
      }
      return true;
    }
    async function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          p,
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`${label} did not complete in ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    function readPidFile(p: string): number {
      const n = Number(readFileSync(p, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    /** A descendant that ignores TERM, publishes its pid, and drops every stdio pipe. */
    function resistantRedirected(pidFile: string): string {
      return `trap "" TERM; echo $$ > ${q(pidFile)}; exec >/dev/null 2>&1; sleep 60`;
    }

    it("signals the process group (-pid) only for children marked as owned", () => {
      const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
      const killFn = (pid: number, sig?: NodeJS.Signals | number) => {
        killCalls.push([pid, sig]);
        return true;
      };
      const childKills: Array<NodeJS.Signals | number | undefined> = [];
      const owned = { pid: 4242, kill: (s?: NodeJS.Signals | number) => (childKills.push(s), true) };
      markOwnedUnixProcessGroup(owned);
      killChildTree(owned, { platform: "linux", setTimeoutFn: () => 0, killFn });
      expect(killCalls).toEqual([[-4242, "SIGTERM"]]);
      expect(childKills).toEqual([]);

      killCalls.length = 0;
      const unmarked = { pid: 4243, kill: (s?: NodeJS.Signals | number) => (childKills.push(s), true) };
      killChildTree(unmarked, { platform: "linux", setTimeoutFn: () => 0, killFn });
      expect(killCalls).toEqual([]);
      expect(childKills).toEqual(["SIGTERM"]);
    });

    it("never marks or negative-signals the parent's own pid or a pid-less child", () => {
      const killCalls: number[] = [];
      const killFn = (pid: number) => (killCalls.push(pid), true);
      const self = { pid: process.pid, kill: () => true };
      markOwnedUnixProcessGroup(self);
      expect(isOwnedUnixProcessGroupTracked(self)).toBe(false);
      killChildTree(self, { platform: "linux", setTimeoutFn: () => 0, killFn });
      const noPid = { pid: undefined, kill: () => true };
      markOwnedUnixProcessGroup(noPid);
      expect(isOwnedUnixProcessGroupTracked(noPid)).toBe(false);
      expect(killCalls.every((p) => p >= 0)).toBe(true);
    });

    it("escalation re-probes and never signals a group already observed gone", () => {
      const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
      let groupGone = false;
      const killFn = (pid: number, sig?: NodeJS.Signals | number) => {
        killCalls.push([pid, sig]);
        if (groupGone) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      };
      let escalate: (() => void) | null = null;
      const child = { pid: 5150, kill: () => true };
      markOwnedUnixProcessGroup(child);
      killChildTree(child, {
        platform: "linux",
        killFn,
        setTimeoutFn: (cb) => ((escalate = cb), 1),
        clearTimeoutFn: () => {},
      });
      expect(killCalls).toEqual([[-5150, "SIGTERM"]]);
      // Repeated STOP re-sends TERM but does not arm a second escalation.
      killChildTree(child, { platform: "linux", killFn, setTimeoutFn: () => 2 });
      expect(killCalls).toEqual([[-5150, "SIGTERM"], [-5150, "SIGTERM"]]);

      groupGone = true; // every member exited before the escalation fired
      escalate!();
      expect(killCalls[killCalls.length - 1]).toEqual([-5150, 0]); // probe only
      expect(killCalls.some(([, s]) => s === "SIGKILL")).toBe(false);
      expect(isOwnedUnixProcessGroupTracked(child)).toBe(false);

      // After the group is gone, no further negative signal is ever sent.
      killCalls.length = 0;
      killChildTree(child, { platform: "linux", killFn, setTimeoutFn: () => 3 });
      expect(killCalls).toEqual([]);
    });

    it("settlement keeps escalation alive when the leader closes but members remain", () => {
      const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
      const killFn = (pid: number, sig?: NodeJS.Signals | number) => (killCalls.push([pid, sig]), true);
      let escalate: (() => void) | null = null;
      let cleared = 0;
      const child = { pid: 6160, kill: () => true };
      markOwnedUnixProcessGroup(child);
      killChildTree(child, {
        platform: "linux",
        killFn,
        setTimeoutFn: (cb) => ((escalate = cb), 1),
        clearTimeoutFn: () => cleared++,
      });
      // Leader's close: group still alive (probe succeeds) → timer must survive.
      expect(settleOwnedUnixProcessGroup(child, { killFn })).toEqual({ lingering: true });
      expect(cleared).toBe(0);
      expect(isOwnedUnixProcessGroupTracked(child)).toBe(true);
      escalate!();
      expect(killCalls[killCalls.length - 1]).toEqual([-6160, "SIGKILL"]);
      expect(isOwnedUnixProcessGroupTracked(child)).toBe(false);
    });

    it("STOP reaps a TERM-ignoring descendant that redirected its stdio; unrelated sibling survives", async () => {
      if (!isUnix) return;
      const dir = mkdtempSync(join(tmpdir(), "gs-pg-redirect-"));
      const pidFile = join(dir, "desc.pid");
      const project = makeProject({
        path: dir,
        engineer_command: `bash -c ${q(resistantRedirected(pidFile))} & wait`,
      });
      const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
      let pgid: number | undefined;
      let desc = 0;
      let run: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      try {
        run = runEngineer(project, "cycle-pg-redirect");
        expect(await waitFor(() => existsSync(pidFile) && readPidFile(pidFile) > 0)).toBe(true);
        desc = readPidFile(pidFile);
        pgid = getActiveEngineerChild()?.pid;
        expect(pgid).toBeTruthy();
        expect(alive(desc)).toBe(true);

        expect(killActiveEngineer({ escalationMs: 100 })).toBe(true);
        const result = await bounded(run, 10_000, "runEngineer");
        expect(result.exitCode).not.toBe(0);
        expect(alive(desc)).toBe(false);
        expect(await waitFor(() => !alive(desc), 3_000)).toBe(true);
        expect(await waitFor(() => !groupAlive(pgid!), 3_000)).toBe(true);
        expect(alive(unrelated.pid!)).toBe(true);
        expect(readFileSync(result.logPath, "utf8")).toContain("owned process group");
      } finally {
        killGroup(pgid);
        killPid(desc);
        unrelated.kill("SIGKILL");
        if (run) await bounded(run, 5_000, "runEngineer cleanup").catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("engineer timeout reaps a TERM-ignoring descendant that redirected its stdio", async () => {
      if (!isUnix) return;
      const dir = mkdtempSync(join(tmpdir(), "gs-pg-timeout-"));
      const pidFile = join(dir, "desc.pid");
      const project = makeProject({
        path: dir,
        engineer_command: `bash -c ${q(resistantRedirected(pidFile))} & wait`,
      });
      let pgid: number | undefined;
      let desc = 0;
      let run: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      try {
        run = runEngineer(project, "cycle-pg-timeout", undefined, false, undefined, undefined, {
          timeoutMs: 400,
          escalationMs: 100,
        });
        expect(await waitFor(() => existsSync(pidFile) && readPidFile(pidFile) > 0)).toBe(true);
        desc = readPidFile(pidFile);
        pgid = getActiveEngineerChild()?.pid;
        expect(alive(desc)).toBe(true);

        const result = await bounded(run, 10_000, "runEngineer");
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
        expect(alive(desc)).toBe(false);
        expect(readFileSync(result.logPath, "utf8")).toContain("TIMED OUT");
        expect(await waitFor(() => !alive(desc), 3_000)).toBe(true);
        expect(await waitFor(() => !groupAlive(pgid!), 3_000)).toBe(true);
      } finally {
        killGroup(pgid);
        killPid(desc);
        if (run) await bounded(run, 5_000, "runEngineer cleanup").catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("a member outliving a normally-exited leader is terminated at settlement", async () => {
      if (!isUnix) return;
      const dir = mkdtempSync(join(tmpdir(), "gs-pg-linger-"));
      const pidFile = join(dir, "desc.pid");
      const project = makeProject({
        path: dir,
        engineer_command: `bash -c ${q(resistantRedirected(pidFile))} & exit 0`,
      });
      let desc = 0;
      let run: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      try {
        run = runEngineer(project, "cycle-pg-linger", undefined, false, undefined, undefined, {
          escalationMs: 100,
        });
        const result = await bounded(run, 10_000, "runEngineer");
        expect(result.exitCode).toBe(0);
        expect(await waitFor(() => existsSync(pidFile) && readPidFile(pidFile) > 0)).toBe(true);
        desc = readPidFile(pidFile);
        expect(readFileSync(result.logPath, "utf8")).toContain("still has members");
        expect(await waitFor(() => !alive(desc), 3_000)).toBe(true);
      } finally {
        killPid(desc);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("kills TERM-ignoring descendant that keeps the pipes and completes runEngineer promise", async () => {
      if (!isUnix) return;

      const fixtureDir = mkdtempSync(join(tmpdir(), "gs-pg-pipes-"));
      const project = makeProject({
        path: fixtureDir,
        // Descendant ignores TERM and inherits stdout; group SIGKILL must reap it.
        engineer_command: `trap "" TERM; sleep 60 & echo DESC:$!; wait`,
      });

      const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
      const unrelatedPid = unrelated.pid ?? null;
      let descPid: number | null = null;
      let pgid: number | undefined;
      let runPromise: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;

      try {
        runPromise = runEngineer(project, "cycle-pg-1");
        expect(await waitFor(() => !!getActiveEngineerChild())).toBe(true);
        pgid = getActiveEngineerChild()?.pid;
        expect(pgid).toBeTruthy();

        const logPath = join(TEST_DIR, "state", "test-proj", "cycles", "cycle-pg-1", "engineer.log");
        expect(
          await waitFor(() => {
            if (!existsSync(logPath)) return false;
            const m = readFileSync(logPath, "utf8").match(/DESC:(\d+)/);
            if (m) descPid = Number(m[1]);
            return descPid !== null;
          }),
        ).toBe(true);
        expect(alive(descPid!)).toBe(true);
        expect(unrelatedPid && alive(unrelatedPid)).toBe(true);

        expect(killActiveEngineer({ escalationMs: 50 })).toBe(true);
        const result = await bounded(runPromise, 10_000, "runEngineer");
        expect(result.exitCode).not.toBe(0);

        expect(await waitFor(() => !alive(descPid!), 3_000)).toBe(true);
        expect(await waitFor(() => !groupAlive(pgid!), 3_000)).toBe(true);
        expect(unrelatedPid && alive(unrelatedPid)).toBe(true);
      } finally {
        killGroup(pgid);
        killPid(descPid);
        killPid(unrelatedPid);
        unrelated.kill("SIGKILL");
        if (runPromise) await bounded(runPromise, 5_000, "runEngineer cleanup").catch(() => {});
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("markOwnedUnixProcessGroup enables group kill on a real spawn", async () => {
      if (!isUnix) return;

      const child = spawn(
        "bash",
        ["-c", 'trap "" TERM; sleep 60 & echo $!; wait'],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      markOwnedUnixProcessGroup(child);
      let descPid: number | null = null;
      try {
        await new Promise<void>((resolve) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            const n = Number(chunk.toString().trim().split("\n")[0]);
            if (Number.isFinite(n) && n > 0) descPid = n;
            resolve();
          });
          setTimeout(resolve, 2000);
        });
        expect(child.pid).toBeTruthy();
        expect(descPid).not.toBeNull();

        killChildTree(child, { escalationMs: 50 });
        await bounded(new Promise<void>((r) => child.on("close", () => r())), 10_000, "child close");
        expect(await waitFor(() => !alive(descPid!), 3_000)).toBe(true);
        expect(await waitFor(() => !isOwnedUnixProcessGroupTracked(child), 3_000)).toBe(true);
      } finally {
        killGroup(child.pid);
        killPid(descPid);
      }
    }, 20_000);
  });

  describe("STOP before spawn (late parallel sibling)", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    function killGroup(pgid: number | null | undefined): void {
      if (!pgid || pgid <= 1 || pgid === process.pid) return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    async function waitFor(fn: () => boolean, ms = 5_000): Promise<boolean> {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) return false;
        await sleep(25);
      }
      return true;
    }

    it("refuses to spawn a sibling that reaches spawn after STOP was written; running engineer stops", async () => {
      if (process.platform === "win32") return;
      const stopPath = join(TEST_DIR, "STOP");
      const marker = join(TEST_DIR, "late-started");
      let stops = 0;
      const watcher = startStopFileWatcher(stopPath, () => {
        stops++;
        killActiveEngineer({ escalationMs: 100 });
      });
      let aGroup: number | undefined;
      let a: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      let b: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      try {
        a = runEngineer(makeProject({ id: "early", engineer_command: "sleep 60" }), "cycle-early");
        expect(await waitFor(() => !!getActiveEngineerChild())).toBe(true);
        aGroup = getActiveEngineerChild()?.pid;

        // Sibling is "preparing" (worktree setup) and only reaches spawn later.
        b = (async () => {
          await sleep(250);
          return runEngineer(
            makeProject({ id: "late", engineer_command: `touch ${q(marker)}; sleep 60` }),
            "cycle-late",
          );
        })();

        writeFileSync(stopPath, "stop\n");
        expect(await waitFor(() => stops > 0)).toBe(true);

        const rb = await Promise.race([
          b,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("late sibling hung")), 5_000)),
        ]);
        expect(rb.stoppedBeforeSpawn).toBe(true);
        expect(rb.exitCode).toBeNull();
        expect(existsSync(marker)).toBe(false);
        expect(readFileSync(rb.logPath, "utf8")).toContain("STOP file present before spawn");

        const ra = await Promise.race([
          a,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("early engineer hung")), 5_000)),
        ]);
        expect(ra.exitCode).not.toBe(0);
        expect(getActiveEngineerChildren()).toHaveLength(0);

        const progress = readFileSync(join(TEST_DIR, "state", "late", "PROGRESS.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const completed = progress.find((e: { event: string }) => e.event === "engineer_completed");
        expect(completed.data.stopped_before_spawn).toBe(true);
      } finally {
        watcher.close();
        killGroup(aGroup);
        killActiveEngineer({ escalationMs: 50 });
        rmSync(stopPath, { force: true });
        if (a) await a.catch(() => {});
        if (b) await b.catch(() => {});
      }
    }, 20_000);

    it("negative control: without STOP the delayed sibling starts", async () => {
      if (process.platform === "win32") return;
      const marker = join(TEST_DIR, "late-started-control");
      let aGroup: number | undefined;
      let bGroup: number | undefined;
      let a: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      let b: Promise<Awaited<ReturnType<typeof runEngineer>>> | undefined;
      try {
        a = runEngineer(makeProject({ id: "early-c", engineer_command: "sleep 60" }), "cycle-early-c");
        expect(await waitFor(() => !!getActiveEngineerChild())).toBe(true);
        aGroup = getActiveEngineerChild()?.pid;
        b = (async () => {
          await sleep(250);
          return runEngineer(
            makeProject({ id: "late-c", engineer_command: `touch ${q(marker)}; sleep 60` }),
            "cycle-late-c",
          );
        })();
        expect(await waitFor(() => existsSync(marker))).toBe(true);
        expect(getActiveEngineerChildren()).toHaveLength(2);
        bGroup = getActiveEngineerChild()?.pid;
      } finally {
        killActiveEngineer({ escalationMs: 50 });
        killGroup(aGroup);
        killGroup(bGroup);
        if (a) await a.catch(() => {});
        if (b) await b.catch(() => {});
      }
    }, 20_000);
  });

  describe("dispatcher process signals", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    function alive(pid: number): boolean {
      try {
        if (process.platform === "linux") {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const state = stat.charAt(stat.lastIndexOf(")") + 2);
          return state !== "Z" && state !== "X";
        }
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    function killGroup(pgid: number | null | undefined): void {
      if (!pgid || pgid <= 1 || pgid === process.pid) return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    async function waitFor(fn: () => boolean, ms = 8_000): Promise<boolean> {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) return false;
        await sleep(25);
      }
      return true;
    }
    function readPid(p: string): number {
      if (!existsSync(p)) return 0;
      const n = Number(readFileSync(p, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    async function signalProbe(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), `gs-sig-${signal.toLowerCase()}-`));
      const pidFile = join(dir, "engineer.pid");
      const script = join(dir, "dispatcher.ts");
      const project = makeProject({
        id: "sig",
        path: dir,
        // `$$` is the group leader (bash), which exec's into sleep: one pid = leader = pgid.
        engineer_command: `echo $$ > ${q(pidFile)}; exec sleep 60`,
      });
      writeFileSync(
        script,
        `import { runEngineer } from ${JSON.stringify(join(import.meta.dir, "..", "src", "engineer.ts"))};\n` +
          `import { setRootDir } from ${JSON.stringify(join(import.meta.dir, "..", "src", "state.ts"))};\n` +
          `setRootDir(${JSON.stringify(dir)});\n` +
          `const result = await runEngineer(${JSON.stringify(project)}, "cycle-signal");\n` +
          `console.log("ENGINEER_DONE " + JSON.stringify(result.exitCode));\n`,
      );
      const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
      const dispatcher = spawn(process.execPath, [script], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      dispatcher.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      dispatcher.stdout?.on("data", () => {});
      const exited = new Promise<[number | null, string | null]>((r) =>
        dispatcher.on("exit", (code, sig) => r([code, sig])),
      );
      let engineer = 0;
      try {
        expect(await waitFor(() => readPid(pidFile) > 0)).toBe(true);
        engineer = readPid(pidFile);
        expect(alive(engineer)).toBe(true);

        dispatcher.kill(signal);
        const [code, sig] = await Promise.race([
          exited,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dispatcher did not exit")), 15_000)),
        ]);
        // Conventional termination: the dispatcher dies by the same signal.
        expect([code, sig]).toEqual([null, signal]);
        expect(await waitFor(() => !alive(engineer), 3_000)).toBe(true);
        expect(alive(unrelated.pid!)).toBe(true);
        expect(stderr).toContain(`${signal} received`);
      } finally {
        killGroup(engineer);
        try {
          dispatcher.kill("SIGKILL");
        } catch {
          /* gone */
        }
        unrelated.kill("SIGKILL");
        await exited.catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("SIGINT to the dispatcher terminates its detached engineer before exit", async () => {
      if (process.platform === "win32") return;
      await signalProbe("SIGINT");
    }, 30_000);

    it("SIGTERM to the dispatcher terminates its detached engineer before exit", async () => {
      if (process.platform === "win32") return;
      await signalProbe("SIGTERM");
    }, 30_000);

    it("SIGHUP to the dispatcher terminates its detached engineer before exit", async () => {
      if (process.platform === "win32") return;
      await signalProbe("SIGHUP");
    }, 30_000);

    it("installs signal/exit listeners only while an engineer is tracked and restores them after", async () => {
      const events = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const;
      const before = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
      const run = runEngineer(makeProject({ engineer_command: "sleep 0.3" }), "cycle-listeners");
      expect(await waitFor(() => !!getActiveEngineerChild())).toBe(true);
      for (const e of events) expect(process.listenerCount(e)).toBe(before[e] + 1);
      await run;
      expect(getActiveEngineerChildren()).toHaveLength(0);
      for (const e of events) expect(process.listenerCount(e)).toBe(before[e]);
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

  describe("claim-timeout early-kill (gs-302)", () => {
    // ~3s — long enough for spawn + stdout capture, short enough for CI.
    const claimTimeoutMin = 0.05;

    it("kills engineer with no claim line and sets killedNoClaim", async () => {
      const project = makeProject({
        engineer_command: "sleep 30",
        engineer_claim_timeout_minutes: claimTimeoutMin,
        cycle_budget_minutes: 30,
      });
      const started = Date.now();
      const result = await runEngineer(project, "cycle-no-claim-kill");

      expect(result.killedNoClaim).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.durationSeconds).toBeLessThan(15);

      const logContent = readFileSync(result.logPath, "utf8");
      expect(logContent).toContain("=== NO TASK CLAIM within 0.05 min ===");

      const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
      const events = readFileSync(progressPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const completed = events.find(
        (e: { event: string }) => e.event === "engineer_completed",
      );
      expect(completed.data.killed_no_claim).toBe(true);

      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("does not claim-timeout-kill when claim line appears in time", async () => {
      const claimLine = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"gs-302-test"}`;
      const project = makeProject({
        engineer_command: `printf '%s\\n' '${claimLine}' && sleep 2`,
        engineer_claim_timeout_minutes: claimTimeoutMin,
        cycle_budget_minutes: 30,
      });
      const result = await runEngineer(project, "cycle-with-claim");

      expect(result.killedNoClaim).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.attempted_task_id).toBe("gs-302-test");
      expect(result.durationSeconds).toBeGreaterThanOrEqual(1.5);
      expect(result.durationSeconds).toBeLessThan(10);

      const logContent = readFileSync(result.logPath, "utf8");
      expect(logContent).not.toContain("=== NO TASK CLAIM");
    });
  });
});

describe("resolveEngineerCommand (gs-270, Phase 7)", () => {
  it("defaults to claude provider when engineer_provider is unset", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "echo ${cycle_budget_minutes}",
      cycle_budget_minutes: 30,
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("claude");
    expect(command).toBe("echo 30");
  });

  it("preserves claude path byte-identically when engineer_provider: claude", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "bash engineer_command.sh ${cycle_budget_minutes}",
      cycle_budget_minutes: 45,
      engineer_provider: "claude",
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("claude");
    expect(command).toBe("bash engineer_command.sh 45");
  });

  it("generates an aider bash command when engineer_provider: aider", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "ignored-when-aider",
      cycle_budget_minutes: 30,
      engineer_provider: "aider",
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("aider");
    expect(command).toContain("aider");
    expect(command).toContain("--model");
    expect(command).toContain("worktree");
    expect(command).toContain(project.verification_command);
    expect(command).not.toContain("ignored-when-aider");
  });

  it("includes engineer_model override in the generated aider command", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "aider",
      engineer_model: "openrouter/anthropic/claude-sonnet-4-6",
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("openrouter/anthropic/claude-sonnet-4-6");
  });

  it("uses the default aider model when engineer_model is unset", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const { DEFAULT_AIDER_MODEL } = await import("../src/engineer_providers/aider");
    const project = makeProject({ engineer_provider: "aider" });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain(DEFAULT_AIDER_MODEL);
  });

  it("shell-quotes hands_off values containing single quotes safely", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "aider",
      hands_off: ["path/with'quote"],
    });
    const { command } = resolveEngineerCommand(project);
    // The embedded single quote should appear inside the escape sequence,
    // not as a raw unquoted character that would break out of the shell.
    expect(command).toContain("path/with'\\''quote");
  });

  // gs-331 (v0.7.1): grok engineer provider — sub-backed Grok CLI.
  it("generates a grok bash command when engineer_provider: grok", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "ignored-when-grok",
      cycle_budget_minutes: 30,
      engineer_provider: "grok",
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("grok");
    expect(command).toContain("grok \\");
    expect(command).toContain("--always-approve");
    expect(command).toContain("--single");
    expect(command).toContain("--model");
    expect(command).toContain("worktree");
    expect(command).toContain(project.verification_command);
    expect(command).not.toContain("ignored-when-grok");
    // Sub-backed auth, NOT OpenRouter per-token.
    expect(command).toContain(".grok/auth.json");
    expect(command).not.toContain("OPENROUTER_API_KEY");
  });

  it("includes engineer_model override in the generated grok command", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "grok",
      engineer_model: "grok-build",
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("grok-build");
  });

  it("uses the default grok model when engineer_model is unset", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const { DEFAULT_GROK_MODEL } = await import("../src/engineer_providers/grok");
    const project = makeProject({ engineer_provider: "grok" });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain(DEFAULT_GROK_MODEL);
  });

  it("honors a task-level engineer_provider: grok override (source=task)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "claude",
      engineer_command: "echo claude",
    });
    const task = {
      id: "t-1",
      title: "do it",
      status: "pending",
      priority: 1,
      engineer_provider: "grok",
    } as const;
    const { provider, source, command } = resolveEngineerCommand(
      project,
      task as never,
    );
    expect(provider).toBe("grok");
    expect(source).toBe("task");
    expect(command).toContain("grok \\");
  });

  it("shell-quotes hands_off single quotes safely on the grok path too", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "grok",
      hands_off: ["path/with'quote"],
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("path/with'\\''quote");
  });

  // 2026-07-29 (experimental): codex engineer provider — OpenAI Codex CLI.
  it("generates a codex bash command when engineer_provider: codex", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "ignored-when-codex",
      cycle_budget_minutes: 30,
      engineer_provider: "codex",
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("codex");
    expect(command).toContain("codex exec");
    expect(command).toContain("--cd");
    expect(command).toContain("-s workspace-write");
    expect(command).toContain("worktree");
    expect(command).toContain(project.verification_command);
    expect(command).not.toContain("ignored-when-codex");
    // Sub-backed auth, NOT OpenRouter per-token. Omit model flag by default.
    expect(command).not.toContain("OPENROUTER_API_KEY");
    expect(command).not.toContain("\n  -m ");
  });

  it("includes engineer_model override in the generated codex command", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "codex",
      engineer_model: "gpt-5.6-sol-high",
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("gpt-5.6-sol-high");
    expect(command).toContain("\n  -m ");
  });

  it("omits -m from the codex command when engineer_model is unset", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_provider: "codex" });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("codex exec");
    expect(command).not.toContain("\n  -m ");
  });

  it("honors a task-level engineer_provider: codex override (source=task)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "claude",
      engineer_command: "echo claude",
    });
    const task = {
      id: "t-1",
      title: "do it",
      status: "pending",
      priority: 1,
      engineer_provider: "codex",
    } as const;
    const { provider, source, command } = resolveEngineerCommand(
      project,
      task as never,
    );
    expect(provider).toBe("codex");
    expect(source).toBe("task");
    expect(command).toContain("codex exec");
  });

  it("shell-quotes hands_off single quotes safely on the codex path too", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "codex",
      hands_off: ["path/with'quote"],
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("path/with'\\''quote");
  });

  // 2026-07-29 (experimental): kimi engineer provider — Moonshot kimi-code CLI.
  it("generates a kimi bash command when engineer_provider: kimi", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_command: "ignored-when-kimi",
      cycle_budget_minutes: 30,
      engineer_provider: "kimi",
    });
    const { provider, command } = resolveEngineerCommand(project);
    expect(provider).toBe("kimi");
    expect(command).toContain("kimi \\");
    expect(command).toContain("-p ");
    expect(command).toContain(".kimi-code/bin");
    expect(command).toContain("worktree");
    expect(command).toContain(project.verification_command);
    expect(command).not.toContain("ignored-when-kimi");
    // -p already auto-approves; must not combine with --yolo/--auto.
    expect(command).not.toContain("--yolo");
    expect(command).not.toContain("--auto");
    expect(command).not.toContain("OPENROUTER_API_KEY");
    expect(command).not.toContain("\n  -m ");
  });

  it("includes engineer_model override in the generated kimi command", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "kimi",
      engineer_model: "kimi-for-coding",
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("kimi-for-coding");
    expect(command).toContain("\n  -m ");
  });

  it("omits -m from the kimi command when engineer_model is unset", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_provider: "kimi" });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("kimi \\");
    expect(command).not.toContain("\n  -m ");
  });

  it("honors a task-level engineer_provider: kimi override (source=task)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "claude",
      engineer_command: "echo claude",
    });
    const task = {
      id: "t-1",
      title: "do it",
      status: "pending",
      priority: 1,
      engineer_provider: "kimi",
    } as const;
    const { provider, source, command } = resolveEngineerCommand(
      project,
      task as never,
    );
    expect(provider).toBe("kimi");
    expect(source).toBe("task");
    expect(command).toContain("kimi \\");
  });

  it("shell-quotes hands_off single quotes safely on the kimi path too", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "kimi",
      hands_off: ["path/with'quote"],
    });
    const { command } = resolveEngineerCommand(project);
    expect(command).toContain("path/with'\\''quote");
  });
});

describe("runEngineer dry-run with alternative provider (gs-270)", () => {
  it("logs provider=aider in dry-run output", async () => {
    const project = makeProject({
      engineer_provider: "aider",
      engineer_command: "this-is-ignored-for-aider",
    });
    const result = await runEngineer(project, "cycle-aider-dry", undefined, true);
    expect(result.exitCode).toBe(0);

    const logContent = await readCycleFile("test-proj", "cycle-aider-dry", "engineer.log");
    expect(logContent).not.toBeNull();
    expect(logContent!).toContain("[DRY RUN]");
    expect(logContent!).toContain("provider=aider");
    expect(logContent!).toContain("aider");
    expect(logContent!).not.toContain("this-is-ignored-for-aider");
  });

  it("logs provider=grok in dry-run output", async () => {
    const project = makeProject({
      engineer_provider: "grok",
      engineer_command: "this-is-ignored-for-grok",
    });
    const result = await runEngineer(project, "cycle-grok-dry", undefined, true);
    expect(result.exitCode).toBe(0);

    const logContent = await readCycleFile("test-proj", "cycle-grok-dry", "engineer.log");
    expect(logContent).not.toBeNull();
    expect(logContent!).toContain("[DRY RUN]");
    expect(logContent!).toContain("provider=grok");
    expect(logContent!).toContain("grok");
    expect(logContent!).not.toContain("this-is-ignored-for-grok");
  });

  it("logs provider=codex in dry-run output", async () => {
    const project = makeProject({
      engineer_provider: "codex",
      engineer_command: "this-is-ignored-for-codex",
    });
    const result = await runEngineer(project, "cycle-codex-dry", undefined, true);
    expect(result.exitCode).toBe(0);

    const logContent = await readCycleFile("test-proj", "cycle-codex-dry", "engineer.log");
    expect(logContent).not.toBeNull();
    expect(logContent!).toContain("[DRY RUN]");
    expect(logContent!).toContain("provider=codex");
    expect(logContent!).toContain("codex");
    expect(logContent!).not.toContain("this-is-ignored-for-codex");
  });

  it("logs provider=kimi in dry-run output", async () => {
    const project = makeProject({
      engineer_provider: "kimi",
      engineer_command: "this-is-ignored-for-kimi",
    });
    const result = await runEngineer(project, "cycle-kimi-dry", undefined, true);
    expect(result.exitCode).toBe(0);

    const logContent = await readCycleFile("test-proj", "cycle-kimi-dry", "engineer.log");
    expect(logContent).not.toBeNull();
    expect(logContent!).toContain("[DRY RUN]");
    expect(logContent!).toContain("provider=kimi");
    expect(logContent!).toContain("kimi");
    expect(logContent!).not.toContain("this-is-ignored-for-kimi");
  });

  it("logs provider=claude in dry-run for default path", async () => {
    const project = makeProject({ engineer_command: "claude -p 'hi'" });
    await runEngineer(project, "cycle-claude-dry", undefined, true);

    const logContent = await readCycleFile("test-proj", "cycle-claude-dry", "engineer.log");
    expect(logContent!).toContain("provider=claude");
    expect(logContent!).toContain("claude -p");
  });
});

describe("resolveEngineerCommand — per-task override precedence (gs-275)", () => {
  it("returns source='default' when nothing is set", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject();
    const { provider, source } = resolveEngineerCommand(project);
    expect(provider).toBe("claude");
    expect(source).toBe("default");
  });

  it("returns source='project' when project.engineer_provider is set", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_provider: "aider" });
    const { provider, source } = resolveEngineerCommand(project);
    expect(provider).toBe("aider");
    expect(source).toBe("project");
  });

  it("returns source='task' when task.engineer_provider is set", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject();
    const nextTask = {
      id: "t-001",
      title: "x",
      status: "pending" as const,
      priority: 1,
      engineer_provider: "aider" as const,
    };
    const { provider, source } = resolveEngineerCommand(project, nextTask);
    expect(provider).toBe("aider");
    expect(source).toBe("task");
  });

  it("task override wins over project default (task > project precedence)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_provider: "aider" });
    const nextTask = {
      id: "t-001",
      title: "x",
      status: "pending" as const,
      priority: 1,
      engineer_provider: "claude" as const,
    };
    const { provider, source } = resolveEngineerCommand(project, nextTask);
    expect(provider).toBe("claude");
    expect(source).toBe("task");
  });

  it("task.engineer_model overrides project.engineer_model for aider", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({
      engineer_provider: "aider",
      engineer_model: "openrouter/qwen/qwen3-coder-plus",
    });
    const nextTask = {
      id: "t-001",
      title: "x",
      status: "pending" as const,
      priority: 1,
      engineer_model: "openrouter/anthropic/claude-haiku-4-5",
    };
    const { command } = resolveEngineerCommand(project, nextTask);
    expect(command).toContain("openrouter/anthropic/claude-haiku-4-5");
    expect(command).not.toContain("qwen3-coder-plus");
  });

  it("undefined nextTask behaves identically to no-task call (backward compat)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_command: "echo ${cycle_budget_minutes}", cycle_budget_minutes: 25 });
    const withNoTask = resolveEngineerCommand(project);
    const withUndefinedTask = resolveEngineerCommand(project, undefined);
    expect(withNoTask.command).toBe(withUndefinedTask.command);
    expect(withNoTask.provider).toBe(withUndefinedTask.provider);
    expect(withNoTask.source).toBe(withUndefinedTask.source);
  });
});

describe("runEngineer with task override (gs-275)", () => {
  it("logs provider_source=task in audit when task carries override", async () => {
    const project = makeProject({ engineer_command: "echo default" });
    const nextTask = {
      id: "t-001",
      title: "x",
      status: "pending" as const,
      priority: 1,
      engineer_provider: "aider" as const,
    };
    await runEngineer(project, "cycle-task-override", undefined, true, nextTask);
    const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    const lines = readFileSync(progressPath, "utf8").trim().split("\n");
    const invoked = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "engineer_invoked");
    expect(invoked.data.provider).toBe("aider");
    expect(invoked.data.provider_source).toBe("task");
    expect(invoked.data.task_override).toBe(true);
    expect(invoked.data.peeked_task_id).toBe("t-001");
  });
});

describe("buildAiderPrompt — creative cycle (gs-279)", () => {
  it("falls back to non-creative prompt when context is undefined", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject({ id: "proj-ncp", verification_command: "bun test" });
    const prompt = buildAiderPrompt(project);
    expect(prompt).toContain("autonomous engineering bot");
    expect(prompt).toContain("Verification gate");
    expect(prompt).not.toContain("CREATIVE_WORK");
    expect(prompt).not.toContain("calibrate voice");
  });

  it("falls back to non-creative prompt when context.isCreative is false", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject();
    const prompt = buildAiderPrompt(project, {
      isCreative: false,
      effectiveBranch: "bot/work",
      voiceReferencePaths: [],
      draftsDir: "drafts/",
    });
    expect(prompt).toContain("autonomous engineering bot");
    expect(prompt).not.toContain("CREATIVE_WORK");
  });

  it("emits the creative variant when context.isCreative is true", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject({ id: "bookfinder-general" });
    const prompt = buildAiderPrompt(project, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["docs/voice/manual-a.md", "docs/voice/manual-b.md"],
      draftsDir: "drafts/",
    });
    expect(prompt).toContain("autonomous drafting bot");
    expect(prompt).toContain("CREATIVE_WORK cycle");
    expect(prompt).toContain("Before drafting — calibrate voice");
    expect(prompt).toContain("docs/voice/manual-a.md");
    expect(prompt).toContain("docs/voice/manual-b.md");
    expect(prompt).toContain("drafts/");
    // Creative prompt must NOT include the non-creative "Verification gate"
    // section — it's skipped by cycle.ts for creative cycles.
    expect(prompt).not.toContain("Verification gate\nTests must pass");
  });

  it("handles empty voice_reference_paths gracefully with a neutral-register fallback", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject();
    const prompt = buildAiderPrompt(project, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: [],
      draftsDir: "drafts/",
    });
    expect(prompt).toContain("no voice references configured");
    expect(prompt).toContain("neutral technical register");
  });

  it("names the effectiveBranch in the creative prompt", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject();
    const prompt = buildAiderPrompt(project, {
      isCreative: true,
      effectiveBranch: "bot/custom-drafts",
      voiceReferencePaths: [],
      draftsDir: "drafts/",
    });
    expect(prompt).toContain("bot/custom-drafts");
  });

  it("names the draftsDir in the creative prompt", async () => {
    const { buildAiderPrompt } = await import("../src/engineer_providers/aider");
    const project = makeProject();
    const prompt = buildAiderPrompt(project, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: [],
      draftsDir: "content/draft-output/",
    });
    expect(prompt).toContain("content/draft-output/");
  });
});

describe("buildAiderCommand — creative cycle branch override (gs-279)", () => {
  it("uses project.branch in the generated bash when context is undefined", async () => {
    const { buildAiderCommand } = await import("../src/engineer_providers/aider");
    const project = makeProject({ branch: "bot/work", engineer_provider: "aider" });
    const command = buildAiderCommand(project);
    expect(command).toContain("BRANCH='bot/work'");
  });

  it("emits a gs-291 task claim echo when nextTask is passed", async () => {
    const { buildAiderCommand } = await import("../src/engineer_providers/aider");
    const project = makeProject({ branch: "bot/work", engineer_provider: "aider" });
    const command = buildAiderCommand(project, undefined, {
      id: "gs-claim-test",
      title: "t",
      status: "pending",
      priority: 1,
    });
    expect(command).toContain("GENERALSTAFF_TASK_CLAIM_JSON:");
    expect(command).toContain("gs-claim-test");
  });

  it("wires the best-effort repo-context orientation into the aider --message (feat/repo-context-dispatch)", async () => {
    const { buildAiderCommand } = await import("../src/engineer_providers/aider");
    const project = makeProject({ branch: "bot/work", engineer_provider: "aider" });
    const command = buildAiderCommand(project);
    // The helper is invoked on the WORKTREE after it's created, captured
    // into REPO_CTX, and tolerant of failure (|| true). The static prompt
    // moves into PROMPT and the two combine into MSG, which --message reads.
    expect(command).toContain(
      'REPO_CTX="$(bash "$GENERALSTAFF_ROOT/scripts/gen-repo-context.sh" "$WORKTREE_DIR" 2>/dev/null || true)"',
    );
    expect(command).toContain("PROMPT='You are an autonomous engineering bot");
    expect(command).toContain('if [ -n "$REPO_CTX" ]; then');
    expect(command).toContain("MSG=");
    expect(command).toContain('--message "$MSG"');
    // The capture must come AFTER the worktree exists (orientation maps the
    // worktree, not master) and BEFORE aider launches.
    const ctxIdx = command.indexOf("gen-repo-context.sh");
    const wtIdx = command.indexOf('worktree add "$WORKTREE_DIR"');
    const launchIdx = command.indexOf("Launching aider");
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(wtIdx);
    expect(launchIdx).toBeGreaterThan(ctxIdx);
  });

  it("uses context.effectiveBranch in the generated bash when isCreative", async () => {
    const { buildAiderCommand } = await import("../src/engineer_providers/aider");
    const project = makeProject({ branch: "bot/work", engineer_provider: "aider" });
    const command = buildAiderCommand(project, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["docs/voice/manual.md"],
      draftsDir: "drafts/",
    });
    // Worktree setup must use the creative branch, not bot/work
    expect(command).toContain("BRANCH='bot/creative-drafts'");
    expect(command).not.toContain("BRANCH='bot/work'");
  });

  it("embeds the creative prompt in the aider --message for creative cycles", async () => {
    const { buildAiderCommand } = await import("../src/engineer_providers/aider");
    const project = makeProject({ engineer_provider: "aider" });
    const command = buildAiderCommand(project, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["docs/voice/manual.md"],
      draftsDir: "drafts/",
    });
    // The aider --message arg should contain the creative-specific prompt text
    expect(command).toContain("CREATIVE_WORK cycle");
    expect(command).toContain("docs/voice/manual.md");
  });
});

describe("resolveEngineerCommand — creative cycle threading (gs-279)", () => {
  it("threads context through to the aider command", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    const project = makeProject({ engineer_provider: "aider", branch: "bot/work" });
    const { command } = resolveEngineerCommand(project, undefined, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["docs/voice.md"],
      draftsDir: "drafts/",
    });
    expect(command).toContain("BRANCH='bot/creative-drafts'");
    expect(command).toContain("CREATIVE_WORK cycle");
  });

  it("claude path ignores creative context in the command string (env-var contract instead)", async () => {
    const { resolveEngineerCommand } = await import("../src/engineer");
    // Claude path returns project.engineer_command verbatim — creative state
    // for that path flows through env vars set by runEngineer, not the
    // command string. This test locks the contract so future changes don't
    // accidentally start interpolating creative state into the claude
    // command (which would break projects whose engineer_command.sh isn't
    // ready for it).
    const project = makeProject({
      engineer_command: "bash engineer_command.sh ${cycle_budget_minutes}",
      cycle_budget_minutes: 30,
    });
    const { provider, command } = resolveEngineerCommand(project, undefined, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["x.md"],
      draftsDir: "drafts/",
    });
    expect(provider).toBe("claude");
    expect(command).toBe("bash engineer_command.sh 30");
    expect(command).not.toContain("creative");
    expect(command).not.toContain("x.md");
  });
});

describe("runEngineer — creative audit trail (gs-279)", () => {
  it("records creative metadata in engineer_invoked event for creative cycles", async () => {
    const project = makeProject({ engineer_command: "echo default" });
    await runEngineer(project, "cycle-creative-audit", undefined, true, undefined, {
      isCreative: true,
      effectiveBranch: "bot/creative-drafts",
      voiceReferencePaths: ["docs/voice/a.md", "docs/voice/b.md"],
      draftsDir: "drafts/",
    });
    const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    const lines = readFileSync(progressPath, "utf8").trim().split("\n");
    const invoked = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "engineer_invoked");
    expect(invoked.data.creative).toBe(true);
    expect(invoked.data.effective_branch).toBe("bot/creative-drafts");
    expect(invoked.data.voice_reference_path_count).toBe(2);
  });

  it("omits creative metadata in engineer_invoked event for non-creative cycles", async () => {
    const project = makeProject({ engineer_command: "echo default" });
    await runEngineer(project, "cycle-noncreative-audit", undefined, true);
    const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    const lines = readFileSync(progressPath, "utf8").trim().split("\n");
    const invoked = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "engineer_invoked");
    expect(invoked.data.creative).toBeUndefined();
    expect(invoked.data.effective_branch).toBeUndefined();
    expect(invoked.data.voice_reference_path_count).toBeUndefined();
  });

  it("omits creative metadata when context.isCreative is false", async () => {
    // Regression guard: passing a context object with isCreative=false
    // must not leak creative fields into the audit log — only genuinely
    // creative cycles should be distinguishable in the grep.
    const project = makeProject({ engineer_command: "echo default" });
    await runEngineer(project, "cycle-explicit-false", undefined, true, undefined, {
      isCreative: false,
      effectiveBranch: "bot/work",
      voiceReferencePaths: [],
      draftsDir: "drafts/",
    });
    const progressPath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    const lines = readFileSync(progressPath, "utf8").trim().split("\n");
    const invoked = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "engineer_invoked");
    expect(invoked.data.creative).toBeUndefined();
  });
});

describe("engineer subprocess secret redaction", () => {
  it("redacts known secret patterns from stdout before persisting the log", async () => {
    const openaiValue = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const awsValue = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const secretFile = join(TEST_DIR, "secret.txt");
    writeFileSync(
      secretFile,
      `stdout: ${openaiValue}\nstderr: ${awsValue}\n`,
    );
    const project = makeProject({ engineer_command: "cat secret.txt" });
    const result = await runEngineer(project, "cycle-redact-stdout");

    expect(result.exitCode).toBe(0);
    const log = readFileSync(result.logPath, "utf8");
    expect(log).toContain("[REDACTED:openai_token]");
    expect(log).toContain("[REDACTED:aws_access_key]");
    expect(log).not.toContain(openaiValue);
    expect(log).not.toContain(awsValue);
  });

  it("redacts known secret patterns from stderr before persisting the log", async () => {
    const openaiValue = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const secretFile = join(TEST_DIR, "secret.txt");
    writeFileSync(secretFile, `leaked: ${openaiValue}\n`);
    const project = makeProject({ engineer_command: "cat secret.txt >&2" });
    const result = await runEngineer(project, "cycle-redact-stderr");

    expect(result.exitCode).toBe(0);
    const log = readFileSync(result.logPath, "utf8");
    expect(log).toContain("[REDACTED:openai_token]");
    expect(log).not.toContain(openaiValue);
  });
});
