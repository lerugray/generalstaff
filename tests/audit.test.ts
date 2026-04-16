import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { appendProgress, tailProgressLog, loadCycleHistory, printHistoryTable, printHistoryCompact, colorizeOutcome, summarizeCosts } from "../src/audit";
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

describe("session_end entries", () => {
  it("stores total_verified and total_failed alongside total_cycles and duration_minutes", async () => {
    await appendProgress("proj-sess", "session_end", {
      duration_minutes: 15,
      total_cycles: 4,
      total_verified: 3,
      total_failed: 1,
    });

    const filePath = join(TEST_DIR, "state", "proj-sess", "PROGRESS.jsonl");
    const content = readFileSync(filePath, "utf8");
    const entry = JSON.parse(content.trim());
    expect(entry.event).toBe("session_end");
    expect(entry.data.duration_minutes).toBe(15);
    expect(entry.data.total_cycles).toBe(4);
    expect(entry.data.total_verified).toBe(3);
    expect(entry.data.total_failed).toBe(1);
  });
});

describe("loadCycleHistory", () => {
  it("returns empty array when no state directory exists", async () => {
    const stateDir = join(TEST_DIR, "state");
    rmSync(stateDir, { recursive: true, force: true });
    const rows = await loadCycleHistory(undefined);
    expect(rows).toEqual([]);
  });

  it("returns empty array when project has no PROGRESS.jsonl", async () => {
    const rows = await loadCycleHistory("nonexistent");
    expect(rows).toEqual([]);
  });

  it("extracts cycle_end events into history rows", async () => {
    await appendProgress("proj-hist", "cycle_start", { start_sha: "aaa111bbb" }, "cycle-abc123def456");
    await appendProgress("proj-hist", "engineer_completed", { exit_code: 0, duration_seconds: 30 }, "cycle-abc123def456");
    await appendProgress("proj-hist", "cycle_end", {
      outcome: "verified",
      reason: "tests pass",
      start_sha: "aaa111bbb",
      end_sha: "ccc333ddd",
      duration_seconds: 120,
    }, "cycle-abc123def456");

    const rows = await loadCycleHistory("proj-hist");
    expect(rows).toHaveLength(1);
    expect(rows[0].cycle_id).toBe("cycle-abc123");
    expect(rows[0].project).toBe("proj-hist");
    expect(rows[0].outcome).toBe("verified");
    expect(rows[0].duration).toBe("2m");
    expect(rows[0].sha_range).toBe("aaa111b..ccc333d");
  });

  it("merges entries from multiple projects sorted by timestamp", async () => {
    await appendProgress("proj-a", "cycle_end", {
      outcome: "verified", start_sha: "aaa", end_sha: "bbb", duration_seconds: 60,
    }, "c-a1");
    await new Promise((r) => setTimeout(r, 10));
    await appendProgress("proj-b", "cycle_end", {
      outcome: "verification_failed", start_sha: "ccc", end_sha: "ddd", duration_seconds: 45,
    }, "c-b1");

    const rows = await loadCycleHistory(undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0].project).toBe("proj-a");
    expect(rows[1].project).toBe("proj-b");
    expect(rows[1].outcome).toBe("verification_failed");
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await appendProgress("proj-lim", "cycle_end", {
        outcome: "verified", start_sha: `s${i}`, end_sha: `e${i}`, duration_seconds: i * 10,
      }, `c-${i}`);
    }

    const rows = await loadCycleHistory("proj-lim", 3);
    expect(rows).toHaveLength(3);
    // Should be the last 3 (indices 2, 3, 4)
    expect(rows[0].cycle_id).toStartWith("c-2");
    expect(rows[2].cycle_id).toStartWith("c-4");
  });

  it("formats duration as seconds when under 60s", async () => {
    await appendProgress("proj-dur", "cycle_end", {
      outcome: "verified", start_sha: "a", end_sha: "b", duration_seconds: 45,
    }, "c-1");

    const rows = await loadCycleHistory("proj-dur");
    expect(rows[0].duration).toBe("45s");
  });

  it("shows same SHA when start equals end", async () => {
    await appendProgress("proj-same", "cycle_end", {
      outcome: "verified_weak", start_sha: "abc1234", end_sha: "abc1234", duration_seconds: 5,
    }, "c-1");

    const rows = await loadCycleHistory("proj-same");
    expect(rows[0].sha_range).toBe("abc1234");
  });
});

describe("printHistoryTable", () => {
  it("prints 'No cycle history found.' when rows is empty", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryTable([])));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("No cycle history found.");
  });

  it("prints a header, separator, and data rows", async () => {
    const rows = [
      { cycle_id: "cycle-abc123", project: "myproj", outcome: "verified", duration: "2m", sha_range: "aaa..bbb", timestamp: "2026-04-16 12:00:00Z" },
    ];
    const lines = await captureLog(() => Promise.resolve(printHistoryTable(rows)));
    expect(lines).toHaveLength(3); // header + separator + 1 data row
    expect(lines[0]).toContain("CYCLE");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("OUTCOME");
    expect(lines[0]).toContain("DURATION");
    expect(lines[0]).toContain("SHA RANGE");
    expect(lines[1]).toMatch(/^[-\s]+$/);
    expect(lines[2]).toContain("cycle-abc123");
    expect(lines[2]).toContain("myproj");
    expect(lines[2]).toContain("verified");
    expect(lines[2]).toContain("2m");
  });
});

describe("printHistoryCompact", () => {
  it("outputs nothing when rows is empty", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact([])));
    expect(lines).toHaveLength(0);
  });

  it("outputs one tab-delimited line per row with no headers", async () => {
    const rows = [
      { cycle_id: "cycle-abc123", project: "myproj", outcome: "verified", duration: "2m", sha_range: "aaa..bbb", timestamp: "2026-04-16 12:00:00Z" },
      { cycle_id: "cycle-def456", project: "other", outcome: "failed", duration: "45s", sha_range: "ccc..ddd", timestamp: "2026-04-16 12:05:00Z" },
    ];
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows)));
    expect(lines).toHaveLength(2);
    // No header keywords
    expect(lines[0]).not.toContain("CYCLE");
    expect(lines[0]).not.toContain("PROJECT");
    // Tab-delimited fields
    const fields = lines[0].split("\t");
    expect(fields).toHaveLength(6);
    expect(fields[0]).toBe("2026-04-16 12:00:00Z");
    expect(fields[1]).toBe("myproj");
    expect(fields[2]).toBe("cycle-abc123");
    expect(fields[3]).toBe("verified");
    expect(fields[4]).toBe("2m");
    expect(fields[5]).toBe("aaa..bbb");
  });
});

describe("colorizeOutcome", () => {
  it("returns the raw outcome when useColor is false", () => {
    expect(colorizeOutcome("verified", false)).toBe("verified");
    expect(colorizeOutcome("verification_failed", false)).toBe("verification_failed");
    expect(colorizeOutcome("verified_weak", false)).toBe("verified_weak");
    expect(colorizeOutcome("cycle_skipped", false)).toBe("cycle_skipped");
    expect(colorizeOutcome("anything_else", false)).toBe("anything_else");
  });

  it("wraps known outcomes in the right ANSI codes when useColor is true", () => {
    expect(colorizeOutcome("verified", true)).toBe("\x1b[32mverified\x1b[0m");
    expect(colorizeOutcome("verification_failed", true)).toBe("\x1b[31mverification_failed\x1b[0m");
    expect(colorizeOutcome("verified_weak", true)).toBe("\x1b[33mverified_weak\x1b[0m");
    expect(colorizeOutcome("cycle_skipped", true)).toBe("\x1b[90mcycle_skipped\x1b[0m");
  });

  it("leaves unknown outcomes uncolored even when useColor is true", () => {
    expect(colorizeOutcome("mystery", true)).toBe("mystery");
  });
});

describe("printHistoryTable colorization", () => {
  const rows = [
    { cycle_id: "c1", project: "p1", outcome: "verified", duration: "1m", sha_range: "a..b", timestamp: "2026-04-16 12:00:00Z" },
    { cycle_id: "c2", project: "p2", outcome: "verification_failed", duration: "2m", sha_range: "c..d", timestamp: "2026-04-16 12:01:00Z" },
    { cycle_id: "c3", project: "p3", outcome: "verified_weak", duration: "3m", sha_range: "e..f", timestamp: "2026-04-16 12:02:00Z" },
    { cycle_id: "c4", project: "p4", outcome: "cycle_skipped", duration: "0s", sha_range: "g..h", timestamp: "2026-04-16 12:03:00Z" },
  ];

  it("emits no ANSI escapes when useColor is false", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryTable(rows, false)));
    for (const line of lines) {
      expect(line).not.toContain("\x1b[");
    }
  });

  it("emits the expected ANSI color per outcome when useColor is true", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryTable(rows, true)));
    // header + separator + 4 rows
    expect(lines).toHaveLength(6);
    expect(lines[2]).toContain("\x1b[32mverified\x1b[0m");
    expect(lines[3]).toContain("\x1b[31mverification_failed\x1b[0m");
    expect(lines[4]).toContain("\x1b[33mverified_weak\x1b[0m");
    expect(lines[5]).toContain("\x1b[90mcycle_skipped\x1b[0m");
  });

  it("preserves column alignment when colorizing", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryTable(rows, true)));
    // Strip ANSI codes; padded line length should match the header line length.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const headerLen = lines[0].length;
    for (let i = 2; i < lines.length; i++) {
      expect(stripAnsi(lines[i]).length).toBe(headerLen);
    }
  });
});

describe("summarizeCosts", () => {
  it("returns zero totals when state directory is missing", async () => {
    const stateDir = join(TEST_DIR, "state");
    rmSync(stateDir, { recursive: true, force: true });
    const summary = await summarizeCosts();
    expect(summary.reviewer_invocations).toBe(0);
    expect(summary.prompt_chars).toBe(0);
    expect(summary.estimated_tokens).toBe(0);
    expect(summary.by_cycle).toEqual({});
  });

  it("returns zero totals when project has no PROGRESS.jsonl", async () => {
    const summary = await summarizeCosts("nonexistent");
    expect(summary.reviewer_invocations).toBe(0);
    expect(summary.by_cycle).toEqual({});
  });

  it("counts reviewer_invoked events and sums prompt_length", async () => {
    await appendProgress("proj-cost", "cycle_start", { start_sha: "a" }, "cycle-aaa111222333");
    await appendProgress("proj-cost", "reviewer_invoked", { prompt_length: 400, dry_run: false }, "cycle-aaa111222333");
    await appendProgress("proj-cost", "reviewer_invoked", { prompt_length: 800, dry_run: false }, "cycle-bbb444555666");

    const summary = await summarizeCosts("proj-cost");
    expect(summary.reviewer_invocations).toBe(2);
    expect(summary.prompt_chars).toBe(1200);
    // 1200 chars / 4 = 300 tokens
    expect(summary.estimated_tokens).toBe(300);
  });

  it("keys by_cycle with the 12-char cycle prefix used in history rows", async () => {
    await appendProgress("proj-cost", "reviewer_invoked", { prompt_length: 100 }, "cycle-aaa111222333extra");
    const summary = await summarizeCosts("proj-cost");
    // Key is the first 12 chars of the full cycle_id, matching CycleHistoryRow.cycle_id.
    expect(Object.keys(summary.by_cycle)).toEqual(["cycle-aaa111"]);
    expect(summary.by_cycle["cycle-aaa111"].reviewer_invocations).toBe(1);
    expect(summary.by_cycle["cycle-aaa111"].prompt_chars).toBe(100);
    expect(summary.by_cycle["cycle-aaa111"].estimated_tokens).toBe(25);
  });

  it("merges multiple reviewer_invoked events on the same cycle", async () => {
    // A cycle that retries the reviewer will emit reviewer_invoked more than once.
    await appendProgress("proj-retry", "reviewer_invoked", { prompt_length: 500 }, "cycle-ret111222333");
    await appendProgress("proj-retry", "reviewer_invoked", { prompt_length: 700 }, "cycle-ret111222333");

    const summary = await summarizeCosts("proj-retry");
    expect(summary.by_cycle["cycle-ret111"].reviewer_invocations).toBe(2);
    expect(summary.by_cycle["cycle-ret111"].prompt_chars).toBe(1200);
    expect(summary.by_cycle["cycle-ret111"].estimated_tokens).toBe(300);
  });

  it("aggregates across projects when projectId is undefined", async () => {
    await appendProgress("proj-x", "reviewer_invoked", { prompt_length: 400 }, "cycle-xxx111222333");
    await appendProgress("proj-y", "reviewer_invoked", { prompt_length: 200 }, "cycle-yyy111222333");

    const summary = await summarizeCosts();
    expect(summary.reviewer_invocations).toBe(2);
    expect(summary.prompt_chars).toBe(600);
    expect(summary.estimated_tokens).toBe(150);
    expect(Object.keys(summary.by_cycle)).toHaveLength(2);
  });

  it("ignores non-reviewer_invoked events", async () => {
    await appendProgress("proj-mix", "cycle_start", { start_sha: "a" }, "cycle-mix111222333");
    await appendProgress("proj-mix", "engineer_invoked", { cmd: "test" }, "cycle-mix111222333");
    await appendProgress("proj-mix", "cycle_end", { outcome: "verified" }, "cycle-mix111222333");

    const summary = await summarizeCosts("proj-mix");
    expect(summary.reviewer_invocations).toBe(0);
    expect(summary.prompt_chars).toBe(0);
  });

  it("tolerates missing or non-numeric prompt_length", async () => {
    await appendProgress("proj-bad", "reviewer_invoked", { dry_run: true }, "cycle-bad111222333");
    await appendProgress("proj-bad", "reviewer_invoked", { prompt_length: "not a number" }, "cycle-bad111222333");

    const summary = await summarizeCosts("proj-bad");
    expect(summary.reviewer_invocations).toBe(2);
    expect(summary.prompt_chars).toBe(0);
    expect(summary.estimated_tokens).toBe(0);
  });
});

describe("printHistoryCompact with costs column", () => {
  const rows = [
    { cycle_id: "cycle-abc123", project: "myproj", outcome: "verified", duration: "1m", sha_range: "aaa..bbb", timestamp: "2026-04-16 12:00:00Z" },
    { cycle_id: "cycle-def456", project: "myproj", outcome: "verified", duration: "2m", sha_range: "ccc..ddd", timestamp: "2026-04-16 12:05:00Z" },
  ];

  it("adds invocations and tokens columns when costs map is provided", async () => {
    const costs = {
      "cycle-abc123": { cycle_id: "cycle-abc123", reviewer_invocations: 1, prompt_chars: 400, estimated_tokens: 100 },
      "cycle-def456": { cycle_id: "cycle-def456", reviewer_invocations: 2, prompt_chars: 800, estimated_tokens: 200 },
    };
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows, false, costs)));
    expect(lines).toHaveLength(2);
    const first = lines[0].split("\t");
    expect(first).toHaveLength(8);
    expect(first[6]).toBe("1");   // invocations
    expect(first[7]).toBe("100"); // estimated tokens
    const second = lines[1].split("\t");
    expect(second[6]).toBe("2");
    expect(second[7]).toBe("200");
  });

  it("emits 0/0 for rows with no matching cost entry", async () => {
    const costs = {
      "cycle-abc123": { cycle_id: "cycle-abc123", reviewer_invocations: 1, prompt_chars: 400, estimated_tokens: 100 },
    };
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows, false, costs)));
    const second = lines[1].split("\t");
    expect(second[6]).toBe("0");
    expect(second[7]).toBe("0");
  });

  it("preserves 6-field output when costs argument is omitted", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows, false)));
    expect(lines[0].split("\t")).toHaveLength(6);
  });
});

describe("printHistoryCompact colorization", () => {
  const rows = [
    { cycle_id: "c1", project: "p1", outcome: "verified", duration: "1m", sha_range: "a..b", timestamp: "2026-04-16 12:00:00Z" },
    { cycle_id: "c2", project: "p2", outcome: "verification_failed", duration: "2m", sha_range: "c..d", timestamp: "2026-04-16 12:01:00Z" },
  ];

  it("emits no ANSI escapes when useColor is false", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows, false)));
    for (const line of lines) {
      expect(line).not.toContain("\x1b[");
    }
  });

  it("colorizes the outcome field when useColor is true", async () => {
    const lines = await captureLog(() => Promise.resolve(printHistoryCompact(rows, true)));
    expect(lines[0].split("\t")[3]).toBe("\x1b[32mverified\x1b[0m");
    expect(lines[1].split("\t")[3]).toBe("\x1b[31mverification_failed\x1b[0m");
  });
});
