import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSessionsFlag,
  stripSessionsArgs,
  loadRecentSessions,
  formatSessionsTable,
  type SessionSummary,
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
});
