// GeneralStaff — Phase 6 integration test: `view` subcommand end-to-end (gs-241).
//
// Spawns `bun src/cli.ts view <name> --json` against the checked-in fixture
// registry under tests/fixtures/view_integration/ and asserts each view
// returns the shape expected by downstream HTML / UI consumers. Regression
// guard for the data contract the Phase 5 reference renderers depend on.

import { describe, expect, it } from "bun:test";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  "view_integration",
);

// Force inbox --since to a date well before the fixture messages so the
// view returns them regardless of when the test runs.
const FIXTURE_SINCE = "2020-01-01T00:00:00.000Z";

async function runView(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    cwd: FIXTURE_DIR,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("view subcommand integration (gs-241)", () => {
  it("fleet-overview --json returns projects[] with expected ids", async () => {
    const result = await runView(["view", "fleet-overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("projects");
    expect(parsed).toHaveProperty("aggregates");
    expect(parsed).toHaveProperty("rendered_at");
    expect(Array.isArray(parsed.projects)).toBe(true);
    expect(parsed.projects).toHaveLength(1);
    const row = parsed.projects[0];
    expect(row.id).toBe("gs-test");
    expect(row.branch).toBe("bot/work");
    expect(row.auto_merge).toBe(true);
    expect(row.priority).toBe(1);
    // 2 verified + 1 verification_failed from the project PROGRESS.jsonl.
    expect(row.cycles_total).toBe(3);
    expect(row.verified).toBe(2);
    expect(row.failed).toBe(1);
    // bot_pickable: t-2 is the only ready task (t-3 interactive_only,
    // t-4 hands_off_intersect, t-1 in_progress, t-5 done).
    expect(row.bot_pickable).toBe(1);
    // No STATE.json fixture → last_cycle fields are null.
    expect(row.last_cycle_at).toBeNull();
    expect(row.last_cycle_outcome).toBeNull();
    expect(parsed.aggregates.project_count).toBe(1);
    expect(parsed.aggregates.total_cycles).toBe(3);
    expect(parsed.aggregates.total_verified).toBe(2);
    expect(parsed.aggregates.total_failed).toBe(1);
    // pass_rate = 2 / (2 + 1) ≈ 0.6666…
    expect(parsed.aggregates.pass_rate).toBeGreaterThan(0.66);
    expect(parsed.aggregates.pass_rate).toBeLessThan(0.67);
  });

  it("task-queue gs-test --json returns 4-bucket structure", async () => {
    const result = await runView([
      "view",
      "task-queue",
      "gs-test",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.project_id).toBe("gs-test");
    expect(Array.isArray(parsed.in_flight)).toBe(true);
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(Array.isArray(parsed.blocked)).toBe(true);
    expect(Array.isArray(parsed.shipped)).toBe(true);
    expect(parsed.in_flight).toHaveLength(1);
    expect(parsed.in_flight[0].id).toBe("t-1");
    expect(parsed.ready).toHaveLength(1);
    expect(parsed.ready[0].id).toBe("t-2");
    expect(parsed.blocked).toHaveLength(2);
    const blockedIds = parsed.blocked.map(
      (e: { id: string }) => e.id,
    ) as string[];
    expect(blockedIds).toContain("t-3");
    expect(blockedIds).toContain("t-4");
    const interactive = parsed.blocked.find(
      (e: { id: string }) => e.id === "t-3",
    );
    expect(interactive.block_reason).toBe("interactive_only");
    const handsOff = parsed.blocked.find(
      (e: { id: string }) => e.id === "t-4",
    );
    expect(handsOff.block_reason).toBe("hands_off_intersect");
    expect(parsed.shipped).toHaveLength(1);
    expect(parsed.shipped[0].id).toBe("t-5");
    expect(parsed.shipped[0].completed_at).toBe(
      "2026-04-17T10:00:00.000Z",
    );
  });

  it("session-tail --json returns sessions[] with the fixture session id", async () => {
    const result = await runView(["view", "session-tail", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("sessions");
    expect(parsed).toHaveProperty("earlier_rail");
    expect(parsed).toHaveProperty("rendered_at");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions).toHaveLength(1);
    const session = parsed.sessions[0];
    expect(session.session_id).toBe("sess-int-001");
    expect(session.budget_minutes).toBe(30);
    expect(session.reviewer).toBe("openrouter");
    expect(session.stop_reason).toBe("max-cycles");
    expect(session.duration_minutes).toBe(10);
    expect(Array.isArray(session.cycles)).toBe(true);
    expect(session.cycles).toHaveLength(1);
    const cycle = session.cycles[0];
    expect(cycle.cycle_id).toBe("cyc-int-001");
    expect(cycle.project_id).toBe("gs-test");
    expect(cycle.task_id).toBe("t-2");
    expect(cycle.verdict).toBe("verified");
    expect(cycle.duration_seconds).toBe(120);
    expect(cycle.diff_added).toBe(12);
    expect(cycle.diff_removed).toBe(3);
    expect(cycle.files_touched).toEqual(["src/foo.ts"]);
    // Only one session in the fixture → earlier_rail is empty.
    expect(parsed.earlier_rail).toEqual([]);
  });

  it("dispatch-detail cyc-int-001 --json returns the expected cycle", async () => {
    const result = await runView([
      "view",
      "dispatch-detail",
      "cyc-int-001",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.cycle_id).toBe("cyc-int-001");
    expect(parsed.project_id).toBe("gs-test");
    expect(parsed.session_id).toBe("sess-int-001");
    expect(parsed.task_id).toBe("t-2");
    // Task-title lookup resolves via projects.yaml → tasks.json.
    expect(parsed.task_title).toBe("ready pickable task");
    expect(parsed.verdict).toBe("verified");
    expect(parsed.duration_seconds).toBe(120);
    expect(parsed.sha_before).toBe("aaa111");
    expect(parsed.sha_after).toBe("bbb222");
    expect(parsed.diff_added).toBe(12);
    expect(parsed.diff_removed).toBe(3);
    expect(Array.isArray(parsed.files_touched)).toBe(true);
    expect(parsed.files_touched).toHaveLength(1);
    expect(parsed.files_touched[0].path).toBe("src/foo.ts");
    // No reviewer_verdict event in the fixture → checks[] is empty.
    expect(parsed.checks).toEqual([]);
    // Phases without dedicated events stay null-skeleton.
    expect(parsed.engineer.started_at).toBeNull();
    expect(parsed.verification.started_at).toBeNull();
    expect(parsed.review.started_at).toBeNull();
  });

  it("dispatch-detail unknown-cycle exits 1 with DispatchDetailError", async () => {
    const result = await runView([
      "view",
      "dispatch-detail",
      "cyc-does-not-exist",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cycle not found: cyc-does-not-exist");
  });

  it("inbox --json returns groups[] with the fixture message", async () => {
    const result = await runView([
      "view",
      "inbox",
      `--since=${FIXTURE_SINCE}`,
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("groups");
    expect(parsed).toHaveProperty("unread_count");
    expect(parsed).toHaveProperty("oldest_shown");
    expect(parsed).toHaveProperty("rendered_at");
    expect(parsed.unread_count).toBe(1);
    expect(Array.isArray(parsed.groups)).toBe(true);
    expect(parsed.groups).toHaveLength(1);
    const group = parsed.groups[0];
    expect(Array.isArray(group.messages)).toBe(true);
    expect(group.messages).toHaveLength(1);
    const msg = group.messages[0];
    expect(msg.from).toBe("generalstaff-bot");
    expect(msg.from_type).toBe("bot");
    expect(msg.kind).toBe("fyi");
    expect(msg.body).toContain("integration fixture message");
    expect(Array.isArray(msg.refs)).toBe(true);
    expect(msg.refs).toHaveLength(1);
    expect(msg.refs[0]).toMatchObject({
      session_id: "sess-int-001",
      task_id: "t-2",
      cycle_id: "cyc-int-001",
    });
  });
});
