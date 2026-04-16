import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { appendProgress, tailProgressLog } from "../src/audit";
import { setRootDir } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";

const TEST_DIR = join(import.meta.dir, "fixtures", "audit_test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("audit writer", () => {
  it("creates PROGRESS.jsonl and appends entries", async () => {
    await appendProgress("test-proj", "cycle_start", {
      start_sha: "abc123",
    }, "cycle-001");

    const filePath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("cycle_start");
    expect(entry.project_id).toBe("test-proj");
    expect(entry.cycle_id).toBe("cycle-001");
    expect(entry.data.start_sha).toBe("abc123");
    expect(entry.timestamp).toBeTruthy();
  });

  it("appends multiple entries", async () => {
    await appendProgress("proj", "cycle_start", { start_sha: "a" }, "c1");
    await appendProgress("proj", "engineer_invoked", { cmd: "test" }, "c1");
    await appendProgress("proj", "cycle_end", { outcome: "verified" }, "c1");

    const filePath = join(TEST_DIR, "state", "proj", "PROGRESS.jsonl");
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe("cycle_start");
    expect(JSON.parse(lines[1]).event).toBe("engineer_invoked");
    expect(JSON.parse(lines[2]).event).toBe("cycle_end");
  });
});

// Helper: capture console.log output during an async function
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return captured;
}

describe("tailProgressLog", () => {
  it("formats a single project entry with timestamp, project, cycle, event, and data", async () => {
    await appendProgress("proj-a", "cycle_start", { start_sha: "abcdef1234" }, "cycle-99");

    const lines = await captureLog(() => tailProgressLog("proj-a", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("proj-a");
    expect(lines[0]).toContain("[cycle-99");
    expect(lines[0]).toContain("cycle_start");
    expect(lines[0]).toContain("sha=abcdef12"); // truncated to 8 chars
  });

  it("merges entries from multiple projects sorted by timestamp", async () => {
    // Write to proj-b first (earlier timestamp), then proj-a
    await appendProgress("proj-b", "cycle_start", { start_sha: "bbb" }, "c-b");
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 10));
    await appendProgress("proj-a", "cycle_start", { start_sha: "aaa" }, "c-a");

    const lines = await captureLog(() => tailProgressLog(undefined, 10));

    expect(lines).toHaveLength(2);
    // proj-b was written first → appears first in time-sorted output
    expect(lines[0]).toContain("proj-b");
    expect(lines[1]).toContain("proj-a");
  });

  it("respects the lines limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendProgress("proj-limit", "cycle_start", { start_sha: `sha${i}` }, `c-${i}`);
    }

    const lines = await captureLog(() => tailProgressLog("proj-limit", 3));
    expect(lines).toHaveLength(3);
    // Should be the last 3 entries
    expect(lines[0]).toContain("c-2");
    expect(lines[1]).toContain("c-3");
    expect(lines[2]).toContain("c-4");
  });

  it("formats cycle_end with outcome and reason", async () => {
    await appendProgress("proj-fmt", "cycle_end", {
      outcome: "verified",
      reason: "tests pass",
    }, "c-1");

    const lines = await captureLog(() => tailProgressLog("proj-fmt", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cycle_end");
    expect(lines[0]).toContain("outcome=verified");
    expect(lines[0]).toContain("reason=tests pass");
  });

  it("formats engineer_completed with exit code and duration", async () => {
    await appendProgress("proj-fmt", "engineer_completed", {
      exit_code: 0,
      duration_seconds: 45,
    }, "c-1");

    const lines = await captureLog(() => tailProgressLog("proj-fmt", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("exit=0");
    expect(lines[0]).toContain("duration=45s");
  });

  it("formats verification_outcome with result and exit code", async () => {
    await appendProgress("proj-fmt", "verification_outcome", {
      outcome: "passed",
      exit_code: 0,
    }, "c-1");

    const lines = await captureLog(() => tailProgressLog("proj-fmt", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=passed");
    expect(lines[0]).toContain("exit=0");
  });

  it("formats reviewer_verdict with verdict and reason", async () => {
    await appendProgress("proj-fmt", "reviewer_verdict", {
      verdict: "verified_weak",
      reason: "minor scope drift",
    }, "c-1");

    const lines = await captureLog(() => tailProgressLog("proj-fmt", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("verdict=verified_weak");
    expect(lines[0]).toContain("reason=minor scope drift");
  });

  it("formats cycle_skipped with reason", async () => {
    await appendProgress("proj-fmt", "cycle_skipped", {
      reason: "no remaining work",
    });

    const lines = await captureLog(() => tailProgressLog("proj-fmt", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cycle_skipped");
    expect(lines[0]).toContain("reason=no remaining work");
  });

  it("shows message when project has no PROGRESS.jsonl", async () => {
    const lines = await captureLog(() => tailProgressLog("nonexistent", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("No PROGRESS.jsonl");
    expect(lines[0]).toContain("nonexistent");
  });

  it("shows message when no state directory exists", async () => {
    // Clean state dir so nothing exists
    const stateDir = join(TEST_DIR, "state");
    rmSync(stateDir, { recursive: true, force: true });

    const lines = await captureLog(() => tailProgressLog(undefined, 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("No state directory");
  });

  it("omits cycle tag when cycle_id is absent", async () => {
    await appendProgress("proj-nocycle", "session_start", { budget: 30 });

    const lines = await captureLog(() => tailProgressLog("proj-nocycle", 10));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("proj-nocycle");
    expect(lines[0]).toContain("session_start");
    // No bracket-delimited cycle id
    expect(lines[0]).not.toMatch(/\[.*\]/);
  });
});
