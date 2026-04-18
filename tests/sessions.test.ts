import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSessionsFlag,
  stripSessionsArgs,
  loadRecentSessions,
  formatSessionsTable,
  formatBacklogTable,
  computeBacklogTotals,
  computeSessionTotals,
  formatSessionTotals,
  formatFleetTable,
  type SessionSummary,
  type BacklogRow,
  type FleetRow,
} from "../src/sessions";

describe("parseSessionsFlag", () => {
  it("returns disabled when --sessions absent", () => {
    expect(parseSessionsFlag(["--json"])).toEqual({
      enabled: false,
      limit: 10,
    });
  });

  it("defaults to 10 when --sessions given without value", () => {
    expect(parseSessionsFlag(["--sessions"])).toEqual({
      enabled: true,
      limit: 10,
    });
  });

  it("accepts a custom limit via --sessions=N", () => {
    expect(parseSessionsFlag(["--sessions=25"])).toEqual({
      enabled: true,
      limit: 25,
    });
  });

  it("ignores zero / negative / non-numeric values (keeps default)", () => {
    expect(parseSessionsFlag(["--sessions=0"]).limit).toBe(10);
    expect(parseSessionsFlag(["--sessions=-3"]).limit).toBe(10);
    expect(parseSessionsFlag(["--sessions=abc"]).limit).toBe(10);
  });
});

describe("stripSessionsArgs", () => {
  it("removes --sessions and --sessions=N tokens", () => {
    expect(
      stripSessionsArgs(["--json", "--sessions", "--watch", "--sessions=5"]),
    ).toEqual(["--json", "--watch"]);
  });
});

describe("loadRecentSessions", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gs-sessions-"));
    logPath = join(tmp, "PROGRESS.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] when the file is missing", async () => {
    const missing = join(tmp, "does-not-exist.jsonl");
    expect(await loadRecentSessions(10, missing)).toEqual([]);
  });

  it("returns [] when no session_complete events are present", async () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        event: "cycle_start",
        project_id: "_fleet",
        data: {},
      }) + "\n",
    );
    expect(await loadRecentSessions(10, logPath)).toEqual([]);
  });

  it("parses session_complete events and sorts newest-first", async () => {
    const lines = [
      {
        timestamp: "2026-04-17T10:00:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 30,
          total_cycles: 5,
          total_verified: 4,
          total_failed: 1,
          stop_reason: "budget",
          reviewer: "ollama (qwen3:8b)",
        },
      },
      {
        timestamp: "2026-04-17T14:00:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 60,
          total_cycles: 10,
          total_verified: 10,
          total_failed: 0,
          stop_reason: "max-cycles",
          reviewer: "claude",
        },
      },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const sessions = await loadRecentSessions(10, logPath);
    expect(sessions).toHaveLength(2);
    // newest first
    expect(sessions[0]!.stop_reason).toBe("max-cycles");
    expect(sessions[0]!.total_cycles).toBe(10);
    expect(sessions[0]!.reviewer).toBe("claude");
    // started_at back-computed from timestamp - duration
    expect(sessions[0]!.started_at).toBe("2026-04-17T13:00:00.000Z");
    expect(sessions[1]!.started_at).toBe("2026-04-17T09:30:00.000Z");
  });

  it("respects the limit (returns N most recent)", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({
      timestamp: `2026-04-17T1${i}:00:00.000Z`,
      event: "session_complete",
      project_id: "_fleet",
      data: {
        duration_minutes: 10,
        total_cycles: i,
        total_verified: i,
        total_failed: 0,
        stop_reason: "budget",
      },
    }));
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const sessions = await loadRecentSessions(2, logPath);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.total_cycles).toBe(4);
    expect(sessions[1]!.total_cycles).toBe(3);
  });

  it("falls back to '-' for missing reviewer field (historical events)", async () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 30,
          total_cycles: 5,
          total_verified: 5,
          total_failed: 0,
          stop_reason: "budget",
        },
      }) + "\n",
    );
    const sessions = await loadRecentSessions(10, logPath);
    expect(sessions[0]!.reviewer).toBe("-");
  });
});

describe("formatSessionsTable", () => {
  it("returns a placeholder when there are no sessions", () => {
    expect(formatSessionsTable([])).toBe("No sessions recorded yet.");
  });

  it("renders a header and one row per session", () => {
    const now = new Date("2026-04-17T15:00:00.000Z");
    const session: SessionSummary = {
      started_at: "2026-04-17T14:00:00.000Z",
      duration_minutes: 30,
      total_cycles: 5,
      total_verified: 4,
      total_failed: 1,
      stop_reason: "budget",
      reviewer: "claude",
    };
    const out = formatSessionsTable([session], now);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^Started\s+Duration\s+Cycles\s+Pass\s+Reviewer\s+Stop reason$/);
    expect(lines[1]).toMatch(/^-+\s+-+/);
    expect(lines[2]).toContain("30m");
    expect(lines[2]).toContain("5 cycles");
    expect(lines[2]).toContain("4/5 verified");
    expect(lines[2]).toContain("claude");
    expect(lines[2]).toContain("budget");
  });

  it("pluralizes cycle count correctly for single-cycle sessions", () => {
    const now = new Date("2026-04-17T15:00:00.000Z");
    const s: SessionSummary = {
      started_at: "2026-04-17T14:00:00.000Z",
      duration_minutes: 5,
      total_cycles: 1,
      total_verified: 1,
      total_failed: 0,
      stop_reason: "budget",
      reviewer: "ollama",
    };
    expect(formatSessionsTable([s], now)).toContain("1 cycle ");
  });

  it("adds a Parallel column when any session used parallel mode (gs-188)", () => {
    const now = new Date("2026-04-17T15:00:00.000Z");
    const seq: SessionSummary = {
      started_at: "2026-04-17T13:00:00.000Z",
      duration_minutes: 30,
      total_cycles: 4,
      total_verified: 4,
      total_failed: 0,
      stop_reason: "budget",
      reviewer: "openrouter",
    };
    const par: SessionSummary = {
      started_at: "2026-04-17T14:00:00.000Z",
      duration_minutes: 30,
      total_cycles: 6,
      total_verified: 6,
      total_failed: 0,
      stop_reason: "budget",
      reviewer: "openrouter",
      max_parallel_slots: 3,
      parallel_rounds: 2,
      slot_idle_seconds: 30,
      parallel_efficiency: 0.95,
    };
    const out = formatSessionsTable([par, seq], now);
    expect(out).toContain("Parallel");
    // Parallel row shows slots × efficiency%
    expect(out).toContain("3× @ 95%");
    // Sequential row in a mixed-table shows an em-dash placeholder so
    // columns line up, not a blank cell.
    expect(out).toContain("—");
  });

  it("does NOT add a Parallel column when every session was sequential (gs-188 back-compat)", () => {
    const now = new Date("2026-04-17T15:00:00.000Z");
    const s: SessionSummary = {
      started_at: "2026-04-17T14:00:00.000Z",
      duration_minutes: 30,
      total_cycles: 5,
      total_verified: 5,
      total_failed: 0,
      stop_reason: "budget",
      reviewer: "claude",
    };
    const out = formatSessionsTable([s], now);
    expect(out).not.toContain("Parallel");
  });

  it("loadRecentSessions lifts parallel metrics from session_complete (gs-188)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gs188-"));
    const logPath = join(tmp, "PROGRESS.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-04-17T10:30:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 30,
          total_cycles: 8,
          total_verified: 7,
          total_failed: 1,
          stop_reason: "budget",
          reviewer: "openrouter",
          max_parallel_slots: 2,
          parallel_rounds: 4,
          slot_idle_seconds: 120,
          parallel_efficiency: 0.88,
        },
      }) + "\n",
    );
    try {
      const sessions = await loadRecentSessions(10, logPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.max_parallel_slots).toBe(2);
      expect(sessions[0]!.parallel_rounds).toBe(4);
      expect(sessions[0]!.slot_idle_seconds).toBe(120);
      expect(sessions[0]!.parallel_efficiency).toBe(0.88);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadRecentSessions leaves parallel fields undefined for sequential sessions (gs-188)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gs188seq-"));
    const logPath = join(tmp, "PROGRESS.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-04-17T10:30:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 30,
          total_cycles: 5,
          total_verified: 5,
          total_failed: 0,
          stop_reason: "budget",
          reviewer: "claude",
          max_parallel_slots: 1, // explicitly sequential
        },
      }) + "\n",
    );
    try {
      const sessions = await loadRecentSessions(10, logPath);
      expect(sessions[0]!.max_parallel_slots).toBeUndefined();
      expect(sessions[0]!.parallel_rounds).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("computeSessionTotals (gs-202)", () => {
  it("returns zero totals for an empty history", () => {
    const totals = computeSessionTotals([]);
    expect(totals).toEqual({
      total_sessions: 0,
      total_cycles: 0,
      total_verified: 0,
      total_failed: 0,
      total_duration_hours: 0,
      parallel_sessions: 0,
      sequential_sessions: 0,
      weighted_avg_parallel_efficiency: null,
      first_seen: null,
      last_seen: null,
    });
  });

  it("aggregates counts, duration, and weighted efficiency across a mixed fixture", () => {
    const sessions: SessionSummary[] = [
      {
        started_at: "2026-04-17T10:00:00.000Z",
        duration_minutes: 60,
        total_cycles: 8,
        total_verified: 7,
        total_failed: 1,
        stop_reason: "budget",
        reviewer: "openrouter",
        max_parallel_slots: 2,
        parallel_rounds: 3,
        slot_idle_seconds: 30,
        parallel_efficiency: 0.8,
      },
      {
        started_at: "2026-04-17T12:00:00.000Z",
        duration_minutes: 30,
        total_cycles: 3,
        total_verified: 3,
        total_failed: 0,
        stop_reason: "budget",
        reviewer: "claude",
      },
      {
        started_at: "2026-04-17T14:00:00.000Z",
        duration_minutes: 30,
        total_cycles: 2,
        total_verified: 1,
        total_failed: 1,
        stop_reason: "max-cycles",
        reviewer: "claude",
      },
    ];
    const totals = computeSessionTotals(sessions);
    expect(totals.total_sessions).toBe(3);
    expect(totals.total_cycles).toBe(13);
    expect(totals.total_verified).toBe(11);
    expect(totals.total_failed).toBe(2);
    expect(totals.total_duration_hours).toBeCloseTo(2.0, 6);
    expect(totals.parallel_sessions).toBe(1);
    expect(totals.sequential_sessions).toBe(2);
    // Only one parallel session so the duration-weighted avg equals its own efficiency.
    expect(totals.weighted_avg_parallel_efficiency).toBeCloseTo(0.8, 6);
    expect(totals.first_seen).toBe("2026-04-17T10:00:00.000Z");
    expect(totals.last_seen).toBe("2026-04-17T14:00:00.000Z");
  });

  it("weighted-average efficiency is duration-weighted across multiple parallel sessions", () => {
    const sessions: SessionSummary[] = [
      {
        started_at: "2026-04-17T10:00:00.000Z",
        duration_minutes: 60,
        total_cycles: 10,
        total_verified: 10,
        total_failed: 0,
        stop_reason: "budget",
        reviewer: "openrouter",
        max_parallel_slots: 2,
        parallel_efficiency: 1.0,
      },
      {
        started_at: "2026-04-17T12:00:00.000Z",
        duration_minutes: 20,
        total_cycles: 4,
        total_verified: 4,
        total_failed: 0,
        stop_reason: "budget",
        reviewer: "openrouter",
        max_parallel_slots: 2,
        parallel_efficiency: 0.5,
      },
    ];
    const totals = computeSessionTotals(sessions);
    // (1.0 * 60 + 0.5 * 20) / (60 + 20) = 70 / 80 = 0.875
    expect(totals.weighted_avg_parallel_efficiency).toBeCloseTo(0.875, 6);
  });

  it("leaves weighted-avg null when no session ran in parallel mode", () => {
    const sessions: SessionSummary[] = [
      {
        started_at: "2026-04-17T10:00:00.000Z",
        duration_minutes: 30,
        total_cycles: 5,
        total_verified: 5,
        total_failed: 0,
        stop_reason: "budget",
        reviewer: "claude",
      },
    ];
    expect(
      computeSessionTotals(sessions).weighted_avg_parallel_efficiency,
    ).toBeNull();
  });
});

describe("formatSessionTotals (gs-202)", () => {
  it("renders a placeholder when no sessions exist", () => {
    expect(formatSessionTotals(computeSessionTotals([]))).toBe(
      "No sessions recorded yet.",
    );
  });

  it("renders every field on a populated fixture", () => {
    const sessions: SessionSummary[] = [
      {
        started_at: "2026-04-17T10:00:00.000Z",
        duration_minutes: 60,
        total_cycles: 8,
        total_verified: 7,
        total_failed: 1,
        stop_reason: "budget",
        reviewer: "openrouter",
        max_parallel_slots: 2,
        parallel_efficiency: 0.8,
      },
    ];
    const out = formatSessionTotals(computeSessionTotals(sessions));
    expect(out).toContain("Total sessions:");
    expect(out).toContain("Total cycles:");
    expect(out).toContain("Parallel sessions:");
    expect(out).toContain("Weighted-avg parallel efficiency: 80.0%");
    expect(out).toContain("First seen:");
    expect(out).toContain("Last seen:");
  });
});

describe("formatBacklogTable (gs-199)", () => {
  it("returns placeholder when there are no projects", () => {
    expect(formatBacklogTable([])).toBe("No projects registered.");
  });

  it("renders header, rows, and a TOTAL row with mixed-status fixture", () => {
    const rows: BacklogRow[] = [
      {
        project_id: "alpha",
        bot_pickable: 3,
        interactive_only: 1,
        handsoff_conflict: 0,
        in_progress: 2,
        done: 10,
      },
      {
        project_id: "beta",
        bot_pickable: 0,
        interactive_only: 2,
        handsoff_conflict: 4,
        in_progress: 0,
        done: 5,
      },
    ];
    const out = formatBacklogTable(rows);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      /^Project\s+Bot-pickable\s+Interactive-only\s+Hands-off-conflict\s+In-progress\s+Done$/,
    );
    // Dividers under every column
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+\s+-+\s+-+\s+-+$/);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    // Totals row sums the four pending-bucket columns + done + in_progress
    const totalLine = lines[lines.length - 1]!;
    expect(totalLine).toContain("TOTAL");
    expect(totalLine).toContain("3"); // bot_pickable total
    expect(totalLine).toContain("4"); // handsoff_conflict total
    expect(totalLine).toContain("15"); // done total 10+5
  });

  it("computeBacklogTotals sums the four pending buckets", () => {
    const rows: BacklogRow[] = [
      {
        project_id: "a",
        bot_pickable: 1,
        interactive_only: 2,
        handsoff_conflict: 3,
        in_progress: 4,
        done: 99,
      },
      {
        project_id: "b",
        bot_pickable: 10,
        interactive_only: 20,
        handsoff_conflict: 30,
        in_progress: 40,
        done: 99,
      },
    ];
    expect(computeBacklogTotals(rows)).toEqual({
      bot_pickable: 11,
      interactive_only: 22,
      handsoff_conflict: 33,
      in_progress: 44,
    });
  });
});

describe("formatFleetTable (gs-217)", () => {
  const NOW = new Date("2026-04-18T12:00:00.000Z");

  it("returns placeholder when there are no projects", () => {
    expect(formatFleetTable([])).toBe("No projects registered.");
  });

  it("renders header, one row per project, and a TOTAL row", () => {
    const rows: FleetRow[] = [
      {
        project_id: "alpha",
        last_cycle_at: "2026-04-18T11:30:00.000Z",
        total_cycles: 10,
        total_verified: 8,
        total_failed: 2,
        bot_pickable: 3,
        auto_merge: true,
        branch: "bot/work",
      },
      {
        project_id: "beta",
        last_cycle_at: null,
        total_cycles: 0,
        total_verified: 0,
        total_failed: 0,
        bot_pickable: 4,
        auto_merge: false,
        branch: "main",
      },
    ];
    const out = formatFleetTable(rows, NOW);
    const lines = out.split("\n");
    expect(lines[0]!.trim()).toMatch(
      /^Project\s+Last cycle\s+Total cycles\s+Verified\s+Failed\s+Bot-pickable\s+Auto-merge\s+Branch$/,
    );
    expect(lines[1]!.trim()).toMatch(/^-+\s+-+\s+-+\s+-+\s+-+\s+-+\s+-+\s+-+$/);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("never"); // beta has no last_cycle
    expect(out).toContain("on"); // alpha auto_merge=true
    expect(out).toContain("off"); // beta auto_merge=false
    expect(out).toContain("bot/work");
    expect(out).toContain("main");
    const totalLine = lines[lines.length - 1]!;
    expect(totalLine).toContain("TOTAL");
    const totalCells = totalLine.trim().split(/\s{2,}/);
    // Project | Last cycle | Total cycles | Verified | Failed | Bot-pickable | Auto-merge | Branch
    expect(totalCells[0]).toBe("TOTAL");
    expect(totalCells[1]).toBe("-");
    expect(totalCells[2]).toBe("10"); // total_cycles sum
    expect(totalCells[3]).toBe("8"); // total_verified sum
    expect(totalCells[4]).toBe("2"); // total_failed sum
    expect(totalCells[5]).toBe("7"); // bot_pickable sum 3+4
    expect(totalCells[6]).toBe("-");
    expect(totalCells[7]).toBe("-");
  });
});
