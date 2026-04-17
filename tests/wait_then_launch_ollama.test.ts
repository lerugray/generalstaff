// Smoke test for scripts/wait_then_launch_ollama.ps1 (gs-124).
//
// The script is Windows-only (PowerShell + cmd.exe). On non-Windows
// platforms the tests skip rather than error — this keeps the suite
// green for any future cross-platform CI without losing the coverage
// on Ray's actual target environment.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from "fs";
import { join } from "path";

const IS_WIN = process.platform === "win32";
const SCRIPT = join(import.meta.dir, "..", "scripts", "wait_then_launch_ollama.ps1");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "wait_then_launch_ollama");

function setMtimeSecondsAgo(path: string, secondsAgo: number) {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(path, t, t);
}

function runScript(args: string[], timeoutMs = 20000) {
  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT,
    ...args,
  ];
  return spawnSync("powershell.exe", psArgs, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(join(FIXTURE_DIR, "logs"), { recursive: true });
  // The script checks the bat exists before Start-Process — in dry-run
  // mode it short-circuits before that check, so we don't need a real
  // scripts/ directory inside the fixture.
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("wait_then_launch_ollama.ps1", () => {
  it.skipIf(!IS_WIN)("fires when the most recent log is already idle past the threshold", () => {
    const logPath = join(FIXTURE_DIR, "logs", "session_test.log");
    writeFileSync(logPath, "prior session output\n");
    setMtimeSecondsAgo(logPath, 120); // 2 min old, > 5s threshold

    const diag = join(FIXTURE_DIR, "diag.log");
    const result = runScript([
      "-ProjectRoot", FIXTURE_DIR,
      "-IdleThresholdSeconds", "5",
      "-MaxWaitMinutes", "1",
      "-PollSeconds", "1",
      "-DryRun",
      "-DiagLog", diag,
    ]);

    expect(result.status).toBe(0);
    const diagContent = readFileSync(diag, "utf8");
    expect(diagContent).toContain("launch condition met: log idle");
    expect(diagContent).toContain("dry-run");
    // Should never have polled past the first iteration.
    expect(diagContent).toContain("polling: newest=session_test.log");
  });

  it.skipIf(!IS_WIN)("fires immediately when the logs directory is empty", () => {
    const diag = join(FIXTURE_DIR, "diag.log");
    const result = runScript([
      "-ProjectRoot", FIXTURE_DIR,
      "-IdleThresholdSeconds", "60",
      "-MaxWaitMinutes", "1",
      "-PollSeconds", "1",
      "-DryRun",
      "-DiagLog", diag,
    ]);

    expect(result.status).toBe(0);
    const diagContent = readFileSync(diag, "utf8");
    expect(diagContent).toContain("launch condition met: no session logs found");
  });

  it.skipIf(!IS_WIN)("times out and exits 1 when the log is never idle", () => {
    const logPath = join(FIXTURE_DIR, "logs", "session_busy.log");
    writeFileSync(logPath, "fresh output\n");
    setMtimeSecondsAgo(logPath, 0); // just now

    const diag = join(FIXTURE_DIR, "diag.log");
    // MaxWaitMinutes=1 but PollSeconds=30 means at most 2 iterations before
    // elapsed > 1 min. We keep the budget tight so the test stays fast.
    //
    // Note: TotalMinutes > 1 triggers the giveup branch, so with poll=30s
    // we need at least ~70s of runtime. Use a fresh-written file and rely
    // on the max-wait path. To keep the test under 20s, we instead spin
    // PollSeconds=1 and MaxWaitMinutes=0 — the very first iteration will
    // see elapsed > 0 min is false (TotalMinutes of ~0 is NOT > 0), so
    // we need a slightly-older start. Cleanest: keep file fresh and set
    // a short max-wait via a larger threshold difference.
    //
    // Simpler approach: refresh the file once per iteration by using a
    // touch-loop. But PowerShell has no external process here. Instead,
    // set IdleThresholdSeconds very high (3600) and MaxWaitMinutes=0 so
    // giveup fires on the second iteration.
    const result = runScript([
      "-ProjectRoot", FIXTURE_DIR,
      "-IdleThresholdSeconds", "3600",
      "-MaxWaitMinutes", "0",
      "-PollSeconds", "1",
      "-DryRun",
      "-DiagLog", diag,
    ], 30000);

    expect(result.status).toBe(1);
    const diagContent = readFileSync(diag, "utf8");
    expect(diagContent).toContain("giving up after 0 min");
  });

  it.skipIf(!IS_WIN)("exits 2 when ProjectRoot does not exist", () => {
    const badRoot = join(FIXTURE_DIR, "does_not_exist");
    const result = runScript([
      "-ProjectRoot", badRoot,
      "-IdleThresholdSeconds", "5",
      "-MaxWaitMinutes", "1",
      "-PollSeconds", "1",
      "-DryRun",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("project root not found");
  });
});
