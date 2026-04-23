import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { buildSessionReport, formatSessionReport } from "../src/session_report";
import { setRootDir } from "../src/state";

const TEST_DIR = join(import.meta.dir, "fixtures", "session_report_test");

function sessionComplete(opts: {
  ts: string;
  stop_reason: string;
  duration_minutes: number;
  total_cycles: number;
  total_verified?: number;
  total_failed?: number;
  consumption?: {
    total_usd: number;
    total_tokens: number;
    cycles_used: number;
    source: string;
  };
}): string {
  const data: Record<string, unknown> = {
    duration_minutes: opts.duration_minutes,
    total_cycles: opts.total_cycles,
    total_verified: opts.total_verified ?? opts.total_cycles,
    total_failed: opts.total_failed ?? 0,
    stop_reason: opts.stop_reason,
    reviewer: "claude",
  };
  if (opts.consumption) {
    data.consumption_summary = opts.consumption;
  }
  return JSON.stringify({
    timestamp: opts.ts,
    event: "session_complete",
    project_id: "_fleet",
    data,
  });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("buildSessionReport", () => {
  it("returns empty report when no state directory exists", async () => {
    rmSync(join(TEST_DIR, "state"), { recursive: true, force: true });
    const r = await buildSessionReport();
    expect(r.total_sessions).toBe(0);
    expect(r.by_stop_reason).toEqual([]);
    expect(r.empty_cycles_share).toBe(0);
    expect(r.healthy_stop_share).toBe(0);
    expect(r.window_last_n).toBeNull();
  });

  it("ignores non-session_complete events in _fleet/PROGRESS.jsonl", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const noise = JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      event: "session_start",
      project_id: "_fleet",
      data: {},
    });
    const log = [
      noise,
      sessionComplete({ ts: "2026-04-21T10:30:00.000Z", stop_reason: "budget", duration_minutes: 30, total_cycles: 5 }),
      noise,
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.total_sessions).toBe(1);
    expect(r.by_stop_reason).toHaveLength(1);
    expect(r.by_stop_reason[0]?.reason).toBe("budget");
  });

  it("aggregates counts + averages by stop_reason, sorted desc by count", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const log = [
      sessionComplete({ ts: "2026-04-21T10:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 20, total_cycles: 8, total_verified: 6, total_failed: 2 }),
      sessionComplete({ ts: "2026-04-21T11:00:00.000Z", stop_reason: "budget", duration_minutes: 60, total_cycles: 10, total_verified: 10, total_failed: 0 }),
      sessionComplete({ ts: "2026-04-21T12:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 30, total_cycles: 12, total_verified: 9, total_failed: 3 }),
      sessionComplete({ ts: "2026-04-21T13:00:00.000Z", stop_reason: "no-project", duration_minutes: 5, total_cycles: 1 }),
      sessionComplete({ ts: "2026-04-21T14:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 25, total_cycles: 10, total_verified: 7, total_failed: 3 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.total_sessions).toBe(5);
    // Sorted descending by count: empty-cycles(3), then budget(1), then no-project(1)
    expect(r.by_stop_reason[0]?.reason).toBe("empty-cycles");
    expect(r.by_stop_reason[0]?.count).toBe(3);
    expect(r.by_stop_reason[0]?.avg_duration_minutes).toBe(25);
    expect(r.by_stop_reason[0]?.avg_cycles).toBe(10);
    expect(r.by_stop_reason[0]?.avg_verified).toBeCloseTo(22 / 3);
    expect(r.by_stop_reason[0]?.avg_failed).toBeCloseTo(8 / 3);
    // empty-cycles share = 3/5 = 0.6
    expect(r.empty_cycles_share).toBeCloseTo(0.6);
    // Healthy = budget only (1/5 = 0.2). insufficient-budget and max-cycles absent.
    expect(r.healthy_stop_share).toBeCloseTo(0.2);
  });

  it("classifies all four healthy stops (budget, insufficient-budget, max-cycles, usage-budget)", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const log = [
      sessionComplete({ ts: "2026-04-21T10:00:00.000Z", stop_reason: "budget", duration_minutes: 60, total_cycles: 10 }),
      sessionComplete({ ts: "2026-04-21T11:00:00.000Z", stop_reason: "insufficient-budget", duration_minutes: 55, total_cycles: 8 }),
      sessionComplete({ ts: "2026-04-21T12:00:00.000Z", stop_reason: "max-cycles", duration_minutes: 30, total_cycles: 5 }),
      sessionComplete({ ts: "2026-04-21T13:00:00.000Z", stop_reason: "usage-budget", duration_minutes: 40, total_cycles: 6 }),
      sessionComplete({ ts: "2026-04-21T14:00:00.000Z", stop_reason: "stop-file", duration_minutes: 10, total_cycles: 2 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.healthy_stop_share).toBeCloseTo(0.8);
    expect(r.empty_cycles_share).toBe(0);
  });

  it("respects lastN window — most-recent N sessions only", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const log = [
      sessionComplete({ ts: "2026-04-21T10:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 30, total_cycles: 8 }),
      sessionComplete({ ts: "2026-04-21T11:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 30, total_cycles: 8 }),
      sessionComplete({ ts: "2026-04-21T12:00:00.000Z", stop_reason: "budget", duration_minutes: 60, total_cycles: 10 }),
      sessionComplete({ ts: "2026-04-21T13:00:00.000Z", stop_reason: "budget", duration_minutes: 60, total_cycles: 10 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const full = await buildSessionReport();
    expect(full.total_sessions).toBe(4);
    expect(full.empty_cycles_share).toBeCloseTo(0.5);
    expect(full.window_last_n).toBeNull();

    const last2 = await buildSessionReport({ lastN: 2 });
    expect(last2.total_sessions).toBe(2);
    // Last two are budget/budget — no empty-cycles
    expect(last2.empty_cycles_share).toBe(0);
    expect(last2.healthy_stop_share).toBe(1);
    expect(last2.window_last_n).toBe(2);
  });

  it("aggregates consumption_summary across sessions into fleet totals (gs-299)", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const log = [
      sessionComplete({
        ts: "2026-04-21T10:00:00.000Z",
        stop_reason: "usage-budget",
        duration_minutes: 30,
        total_cycles: 4,
        consumption: { total_usd: 1.25, total_tokens: 150000, cycles_used: 4, source: "claude-code" },
      }),
      sessionComplete({
        ts: "2026-04-21T11:00:00.000Z",
        stop_reason: "budget",
        duration_minutes: 60,
        total_cycles: 10,
        consumption: { total_usd: 0.75, total_tokens: 80000, cycles_used: 10, source: "claude-code" },
      }),
      // A pre-gs-298 event with no consumption_summary — must NOT contribute.
      sessionComplete({
        ts: "2026-04-21T12:00:00.000Z",
        stop_reason: "empty-cycles",
        duration_minutes: 15,
        total_cycles: 3,
      }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.total_sessions).toBe(3);
    expect(r.consumption_sessions).toBe(2);
    expect(r.total_consumption_usd).toBeCloseTo(2.0);
    expect(r.total_consumption_tokens).toBe(230000);

    const usageBucket = r.by_stop_reason.find((b) => b.reason === "usage-budget");
    expect(usageBucket?.consumption_sessions).toBe(1);
    expect(usageBucket?.sum_usd).toBeCloseTo(1.25);
    expect(usageBucket?.sum_tokens).toBe(150000);

    const emptyBucket = r.by_stop_reason.find((b) => b.reason === "empty-cycles");
    expect(emptyBucket?.consumption_sessions).toBe(0);
    expect(emptyBucket?.sum_usd).toBe(0);
    expect(emptyBucket?.sum_tokens).toBe(0);
  });

  it("leaves consumption totals at zero when no session carries summary (regression)", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    const log = [
      sessionComplete({ ts: "2026-04-21T10:00:00.000Z", stop_reason: "budget", duration_minutes: 60, total_cycles: 10 }),
      sessionComplete({ ts: "2026-04-21T11:00:00.000Z", stop_reason: "empty-cycles", duration_minutes: 20, total_cycles: 8 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.consumption_sessions).toBe(0);
    expect(r.total_consumption_usd).toBe(0);
    expect(r.total_consumption_tokens).toBe(0);
    for (const bucket of r.by_stop_reason) {
      expect(bucket.consumption_sessions).toBe(0);
      expect(bucket.sum_usd).toBe(0);
      expect(bucket.sum_tokens).toBe(0);
    }
  });

  it("treats missing stop_reason as '(missing)' bucket, not a crash", async () => {
    const stateDir = join(TEST_DIR, "state", "_fleet");
    mkdirSync(stateDir, { recursive: true });
    // Handwrite an event missing stop_reason to simulate old session_complete
    // entries logged before stop_reason was added (gs-108 historical data).
    const log = JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      event: "session_complete",
      project_id: "_fleet",
      data: { duration_minutes: 30, total_cycles: 5, total_verified: 5, total_failed: 0 },
    }) + "\n";
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), log);

    const r = await buildSessionReport();
    expect(r.total_sessions).toBe(1);
    expect(r.by_stop_reason[0]?.reason).toBe("(missing)");
  });
});

describe("formatSessionReport", () => {
  it("produces a readable table with empty-cycles + healthy-stop shares", () => {
    const out = formatSessionReport({
      total_sessions: 5,
      window_last_n: null,
      by_stop_reason: [
        { reason: "empty-cycles", count: 3, avg_duration_minutes: 25, avg_cycles: 10, avg_verified: 7, avg_failed: 3, consumption_sessions: 0, sum_usd: 0, sum_tokens: 0 },
        { reason: "budget", count: 1, avg_duration_minutes: 60, avg_cycles: 10, avg_verified: 10, avg_failed: 0, consumption_sessions: 0, sum_usd: 0, sum_tokens: 0 },
        { reason: "no-project", count: 1, avg_duration_minutes: 5, avg_cycles: 1, avg_verified: 1, avg_failed: 0, consumption_sessions: 0, sum_usd: 0, sum_tokens: 0 },
      ],
      empty_cycles_share: 0.6,
      healthy_stop_share: 0.2,
      total_consumption_usd: 0,
      total_consumption_tokens: 0,
      consumption_sessions: 0,
    });
    expect(out).toContain("5 sessions");
    expect(out).toContain("empty-cycles");
    expect(out).toContain("Empty-cycles share: 60.0%");
    expect(out).toContain("Healthy-stop share: 20.0%");
    // gs-299: consumption block is suppressed when no session carried data —
    // don't print a misleading "$0.00 spent" on pre-gs-298 fleets.
    expect(out).not.toContain("Consumption:");
  });

  it("handles empty report gracefully", () => {
    const out = formatSessionReport({
      total_sessions: 0,
      window_last_n: null,
      by_stop_reason: [],
      empty_cycles_share: 0,
      healthy_stop_share: 0,
      total_consumption_usd: 0,
      total_consumption_tokens: 0,
      consumption_sessions: 0,
    });
    expect(out).toContain("0 sessions");
    expect(out).toContain("no session_complete events");
  });

  it("shows the last-N window label when set", () => {
    const out = formatSessionReport({
      total_sessions: 10,
      window_last_n: 10,
      by_stop_reason: [
        { reason: "budget", count: 10, avg_duration_minutes: 60, avg_cycles: 10, avg_verified: 10, avg_failed: 0, consumption_sessions: 0, sum_usd: 0, sum_tokens: 0 },
      ],
      empty_cycles_share: 0,
      healthy_stop_share: 1,
      total_consumption_usd: 0,
      total_consumption_tokens: 0,
      consumption_sessions: 0,
    });
    expect(out).toContain("(last 10)");
  });

  it("marks usage-budget rows with $ and renders the consumption block (gs-299)", () => {
    const out = formatSessionReport({
      total_sessions: 3,
      window_last_n: null,
      by_stop_reason: [
        { reason: "usage-budget", count: 2, avg_duration_minutes: 35, avg_cycles: 5, avg_verified: 5, avg_failed: 0, consumption_sessions: 2, sum_usd: 2.5, sum_tokens: 300000 },
        { reason: "empty-cycles", count: 1, avg_duration_minutes: 15, avg_cycles: 3, avg_verified: 2, avg_failed: 1, consumption_sessions: 0, sum_usd: 0, sum_tokens: 0 },
      ],
      empty_cycles_share: 1 / 3,
      healthy_stop_share: 2 / 3,
      total_consumption_usd: 2.5,
      total_consumption_tokens: 300000,
      consumption_sessions: 2,
    });
    // Marker on the usage-budget row in the main table.
    expect(out).toMatch(/\$usage-budget/);
    // empty-cycles gets a space instead of $, so no accidental "$empty-cycles".
    expect(out).not.toContain("$empty-cycles");
    // Consumption block renders with the fleet total.
    expect(out).toContain("Consumption: $2.50");
    expect(out).toContain("2 session(s) with data");
    // Per-bucket breakdown is visible for buckets that carry consumption.
    expect(out).toMatch(/\$usage-budget\s+\$\s*2\.50/);
    // Buckets with no consumption data are not in the breakdown list.
    const breakdownStart = out.indexOf("Consumption:");
    expect(out.slice(breakdownStart)).not.toContain("empty-cycles");
  });
});
