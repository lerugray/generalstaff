import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir } from "../../src/state";
import { getRecentSessions } from "../../src/views/session_tail";

const FIXTURE_DIR = join(tmpdir(), `gs-session-tail-${process.pid}`);

function writeFleetLog(events: Array<Record<string, unknown>>): void {
  const dir = join(FIXTURE_DIR, "state", "_fleet");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  writeFileSync(join(dir, "PROGRESS.jsonl"), lines.join("\n") + "\n");
}

function writeFleetRaw(contents: string): void {
  const dir = join(FIXTURE_DIR, "state", "_fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROGRESS.jsonl"), contents);
}

function sessionStart(
  id: string,
  ts: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "session_start",
    data: { session_id: id, budget_minutes: 30, ...extra },
  };
}

function sessionEnd(
  id: string,
  ts: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "session_end",
    data: {
      session_id: id,
      duration_minutes: 10,
      stop_reason: "max-cycles",
      reviewer: "openrouter",
      ...extra,
    },
  };
}

function cycleStart(
  sessionId: string,
  cycleId: string,
  ts: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "cycle_start",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: sessionId,
      task_id: "gs-1",
      sha_before: "aaa111",
      ...extra,
    },
  };
}

function cycleEnd(
  sessionId: string,
  cycleId: string,
  ts: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "cycle_end",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: sessionId,
      outcome,
      verdict_prose: "looks good",
      duration_seconds: 60,
      sha_after: "bbb222",
      files_touched: ["src/foo.ts"],
      diff_stats: { additions: 10, deletions: 2 },
      ...extra,
    },
  };
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("getRecentSessions", () => {
  it("returns SessionRecords for two sessions with mixed verdicts", async () => {
    writeFleetLog([
      sessionStart("sess-a", "2026-04-18T10:00:00Z"),
      cycleStart("sess-a", "c1", "2026-04-18T10:01:00Z", { task_id: "gs-10" }),
      cycleEnd("sess-a", "c1", "2026-04-18T10:02:00Z", "verified"),
      cycleStart("sess-a", "c2", "2026-04-18T10:03:00Z", { task_id: "gs-11" }),
      cycleEnd("sess-a", "c2", "2026-04-18T10:05:00Z", "verification_failed", {
        verdict_prose: "scope drift",
      }),
      sessionEnd("sess-a", "2026-04-18T10:10:00Z"),

      sessionStart("sess-b", "2026-04-18T11:00:00Z", {
        max_parallel_slots: 2,
      }),
      cycleStart("sess-b", "c3", "2026-04-18T11:01:00Z"),
      cycleEnd("sess-b", "c3", "2026-04-18T11:02:00Z", "verified"),
      sessionEnd("sess-b", "2026-04-18T11:10:00Z", {
        stop_reason: "insufficient-budget",
      }),
    ]);

    const data = await getRecentSessions();
    expect(data.sessions).toHaveLength(2);
    // Newest first (sess-b).
    expect(data.sessions[0].session_id).toBe("sess-b");
    expect(data.sessions[0].max_parallel_slots).toBe(2);
    expect(data.sessions[0].stop_reason).toBe("insufficient-budget");
    expect(data.sessions[0].cycles).toHaveLength(1);
    expect(data.sessions[0].cycles[0].verdict).toBe("verified");

    expect(data.sessions[1].session_id).toBe("sess-a");
    expect(data.sessions[1].cycles).toHaveLength(2);
    const verdicts = data.sessions[1].cycles.map((c) => c.verdict);
    expect(verdicts).toEqual(["verified", "failed"]);
    const c1 = data.sessions[1].cycles[0];
    expect(c1.task_id).toBe("gs-10");
    expect(c1.sha_before).toBe("aaa111");
    expect(c1.sha_after).toBe("bbb222");
    expect(c1.diff_added).toBe(10);
    expect(c1.diff_removed).toBe(2);
    expect(c1.files_touched).toEqual(["src/foo.ts"]);
    expect(c1.verdict_prose).toBe("looks good");
    expect(data.earlier_rail).toHaveLength(0);
  });

  it("limit=1 returns 1 SessionRecord + rest as earlier_rail", async () => {
    writeFleetLog([
      sessionStart("sess-a", "2026-04-18T10:00:00Z"),
      cycleStart("sess-a", "c1", "2026-04-18T10:01:00Z"),
      cycleEnd("sess-a", "c1", "2026-04-18T10:02:00Z", "verified"),
      cycleStart("sess-a", "c2", "2026-04-18T10:03:00Z"),
      cycleEnd("sess-a", "c2", "2026-04-18T10:05:00Z", "verification_failed"),
      sessionEnd("sess-a", "2026-04-18T10:10:00Z"),

      sessionStart("sess-b", "2026-04-18T11:00:00Z"),
      cycleStart("sess-b", "c3", "2026-04-18T11:01:00Z"),
      cycleEnd("sess-b", "c3", "2026-04-18T11:02:00Z", "verified"),
      sessionEnd("sess-b", "2026-04-18T11:10:00Z"),
    ]);

    const data = await getRecentSessions(1);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].session_id).toBe("sess-b");
    expect(data.earlier_rail).toHaveLength(1);
    const row = data.earlier_rail[0];
    expect(row.session_id).toBe("sess-a");
    expect(row.cycles_total).toBe(2);
    expect(row.cycles_verified).toBe(1);
    expect(row.cycles_failed).toBe(1);
    expect(row.mixed).toBe(true);
  });

  it("returns empty SessionTailData when PROGRESS.jsonl is missing", async () => {
    const data = await getRecentSessions();
    expect(data.sessions).toEqual([]);
    expect(data.earlier_rail).toEqual([]);
    expect(typeof data.rendered_at).toBe("string");
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const goodLine = JSON.stringify(sessionStart("sess-a", "2026-04-18T10:00:00Z"));
    const endLine = JSON.stringify(sessionEnd("sess-a", "2026-04-18T10:10:00Z"));
    writeFleetRaw([goodLine, "{not json", endLine].join("\n") + "\n");

    const warnings: string[] = [];
    const data = await getRecentSessions(3, { warn: (m) => warnings.push(m) });
    expect(data.sessions).toHaveLength(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("malformed");
  });

  it("handles a session with session_end but no cycle events (empty session)", async () => {
    writeFleetLog([
      sessionStart("sess-empty", "2026-04-18T09:00:00Z"),
      sessionEnd("sess-empty", "2026-04-18T09:05:00Z", {
        stop_reason: "empty-cycles",
      }),
    ]);

    const data = await getRecentSessions();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].cycles).toEqual([]);
    expect(data.sessions[0].stop_reason).toBe("empty-cycles");
  });

  it("in-progress session (no session_end) returns ended_at: null and duration from now()", async () => {
    const now = new Date("2026-04-18T10:20:00Z");
    writeFleetLog([
      sessionStart("sess-live", "2026-04-18T10:00:00Z"),
      cycleStart("sess-live", "c1", "2026-04-18T10:01:00Z"),
      cycleEnd("sess-live", "c1", "2026-04-18T10:02:00Z", "verified"),
    ]);

    const data = await getRecentSessions(3, { now });
    expect(data.sessions).toHaveLength(1);
    const s = data.sessions[0];
    expect(s.ended_at).toBeNull();
    expect(s.duration_minutes).toBe(20);
    expect(s.cycles).toHaveLength(1);
  });

  it("classifies verified_weak as 'verified' and unknown outcome as 'other'", async () => {
    writeFleetLog([
      sessionStart("sess-a", "2026-04-18T10:00:00Z"),
      cycleStart("sess-a", "c1", "2026-04-18T10:01:00Z"),
      cycleEnd("sess-a", "c1", "2026-04-18T10:02:00Z", "verified_weak"),
      cycleStart("sess-a", "c2", "2026-04-18T10:03:00Z"),
      cycleEnd("sess-a", "c2", "2026-04-18T10:04:00Z", "weirdo"),
      sessionEnd("sess-a", "2026-04-18T10:05:00Z"),
    ]);

    const data = await getRecentSessions();
    const verdicts = data.sessions[0].cycles.map((c) => c.verdict);
    expect(verdicts).toEqual(["verified", "other"]);
  });
});
