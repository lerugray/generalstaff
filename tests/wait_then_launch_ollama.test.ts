// Smoke test for scripts/wait_then_launch_ollama.ps1 (gs-124).
//
// The script is Windows-only (PowerShell + cmd.exe). On non-Windows
// platforms the tests skip rather than error — this keeps the suite
// green for any future cross-platform CI without losing the coverage
// on Ray's actual target environment.

import { describe, expect, it, beforeEach, afterEach, setDefaultTimeout } from "bun:test";

// Allow the child deadline (up to 30s) plus process cleanup and assertions.
setDefaultTimeout(35_000);
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const IS_WIN = process.platform === "win32";
const SCRIPT = join(import.meta.dir, "..", "scripts", "wait_then_launch_ollama.ps1");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "wait_then_launch_ollama");

function setMtimeSecondsAgo(path: string, secondsAgo: number) {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(path, t, t);
}

async function runScript(args: string[], timeoutMs = 20000) {
  // Keep PowerShell noninteractive with stdin closed, and drain both output
  // streams while it runs. The synchronous pipe harness timed out on Windows
  // on the two successful launch paths (CI 36685540993).
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT,
    ...args,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", chunk => stdout += chunk);
  child.stderr!.setEncoding("utf8").on("data", chunk => stderr += chunk);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    if (timedOut || result.status === null) {
      const diagIndex = args.indexOf("-DiagLog");
      const diagPath = diagIndex >= 0 ? args[diagIndex + 1] : undefined;
      const diag = diagPath && existsSync(diagPath) ? readFileSync(diagPath, "utf8") : "(no diagnostic log)";
      throw new Error(`PowerShell ${timedOut ? "timed out" : "was killed"} (${result.signal})\nstdout: ${stdout}\nstderr: ${stderr}\ndiag: ${diag}`);
    }
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
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
  it.skipIf(!IS_WIN)("fires when the most recent log is already idle past the threshold", async () => {
    const logPath = join(FIXTURE_DIR, "logs", "session_test.log");
    writeFileSync(logPath, "prior session output\n");
    setMtimeSecondsAgo(logPath, 120); // 2 min old, > 5s threshold

    const diag = join(FIXTURE_DIR, "diag.log");
    const result = await runScript([
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

  it.skipIf(!IS_WIN)("fires immediately when the logs directory is empty", async () => {
    const diag = join(FIXTURE_DIR, "diag.log");
    const result = await runScript([
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

  it.skipIf(!IS_WIN)("times out and exits 1 when the log is never idle", async () => {
    const logPath = join(FIXTURE_DIR, "logs", "session_busy.log");
    writeFileSync(logPath, "fresh output\n");
    setMtimeSecondsAgo(logPath, 0); // just now

    const diag = join(FIXTURE_DIR, "diag.log");
    // A zero wait budget gives up before the fresh log can become idle.
    const result = await runScript([
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

  it.skipIf(!IS_WIN)("exits 2 when ProjectRoot does not exist", async () => {
    const badRoot = join(FIXTURE_DIR, "does_not_exist");
    const result = await runScript([
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
