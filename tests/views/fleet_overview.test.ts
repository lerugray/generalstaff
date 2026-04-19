import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir } from "../../src/state";
import { getFleetOverview } from "../../src/views/fleet_overview";

const FIXTURE_DIR = join(tmpdir(), `gs-fleet-overview-${process.pid}`);

function writeYaml(projects: Array<{ id: string; path: string; priority?: number; auto_merge?: boolean; branch?: string }>) {
  const yaml = [
    "projects:",
    ...projects.flatMap((p) => [
      `  - id: ${p.id}`,
      `    path: ${p.path.replace(/\\/g, "/")}`,
      `    priority: ${p.priority ?? 1}`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: ${p.branch ?? "bot/work"}`,
      `    auto_merge: ${p.auto_merge ?? false}`,
      `    hands_off:`,
      `      - secret/`,
    ]),
    "dispatcher:",
    "  max_parallel_slots: 1",
  ].join("\n");
  writeFileSync(join(FIXTURE_DIR, "projects.yaml"), yaml, "utf8");
}

function makeProjectDir(
  id: string,
  opts: {
    state?: { last_cycle_at: string | null; last_cycle_outcome: string | null };
    cycles?: Array<{ outcome: string }>;
    tasks?: Array<{ id: string; status: string; priority: number; interactive_only?: boolean; expected_touches?: string[] }>;
  } = {},
): string {
  const dir = join(FIXTURE_DIR, `proj-${id}`);
  const stateDir = join(dir, "state", id);
  mkdirSync(stateDir, { recursive: true });
  if (opts.state !== undefined) {
    writeFileSync(
      join(stateDir, "STATE.json"),
      JSON.stringify({
        project_id: id,
        current_cycle_id: null,
        last_cycle_id: null,
        last_cycle_outcome: opts.state.last_cycle_outcome,
        last_cycle_at: opts.state.last_cycle_at,
        cycles_this_session: 0,
      }),
    );
  }
  if (opts.cycles !== undefined) {
    const lines = opts.cycles.map((c) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "cycle_end",
        cycle_id: "c1",
        project_id: id,
        data: { outcome: c.outcome },
      }),
    );
    writeFileSync(join(stateDir, "PROGRESS.jsonl"), lines.join("\n") + "\n");
  }
  writeFileSync(
    join(stateDir, "tasks.json"),
    JSON.stringify(opts.tasks ?? []),
  );
  return dir;
}

function writeFleetLog(events: Array<Record<string, unknown>>) {
  const dir = join(FIXTURE_DIR, "state", "_fleet");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  writeFileSync(join(dir, "PROGRESS.jsonl"), lines.join("\n") + "\n");
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("getFleetOverview", () => {
  it("returns per-project rows + aggregated totals for a 2-project fleet", async () => {
    const aPath = makeProjectDir("alpha", {
      state: { last_cycle_at: "2026-04-18T10:00:00Z", last_cycle_outcome: "verified" },
      cycles: [{ outcome: "verified" }, { outcome: "verified" }, { outcome: "verification_failed" }],
      tasks: [
        { id: "a-1", status: "pending", priority: 1 },
        { id: "a-2", status: "done", priority: 1 },
      ],
    });
    const bPath = makeProjectDir("beta", {
      state: { last_cycle_at: "2026-04-18T11:00:00Z", last_cycle_outcome: "verified_weak" },
      cycles: [{ outcome: "verified_weak" }],
      tasks: [
        { id: "b-1", status: "pending", priority: 2 },
        { id: "b-2", status: "pending", priority: 2 },
      ],
    });
    writeYaml([
      { id: "alpha", path: aPath, priority: 1, auto_merge: true, branch: "bot/work" },
      { id: "beta", path: bPath, priority: 2 },
    ]);

    const data = await getFleetOverview();

    expect(data.projects).toHaveLength(2);
    const alpha = data.projects.find((p) => p.id === "alpha")!;
    expect(alpha.cycles_total).toBe(3);
    expect(alpha.verified).toBe(2);
    expect(alpha.failed).toBe(1);
    expect(alpha.bot_pickable).toBe(1);
    expect(alpha.auto_merge).toBe(true);
    expect(alpha.branch).toBe("bot/work");
    expect(alpha.priority).toBe(1);
    expect(alpha.last_cycle_at).toBe("2026-04-18T10:00:00Z");
    expect(alpha.last_cycle_outcome).toBe("verified");

    const beta = data.projects.find((p) => p.id === "beta")!;
    expect(beta.cycles_total).toBe(1);
    expect(beta.verified).toBe(1);
    expect(beta.failed).toBe(0);
    expect(beta.bot_pickable).toBe(2);
    expect(beta.auto_merge).toBe(false);

    expect(data.aggregates.total_cycles).toBe(4);
    expect(data.aggregates.total_verified).toBe(3);
    expect(data.aggregates.total_failed).toBe(1);
    expect(data.aggregates.pass_rate).toBeCloseTo(3 / 4, 6);
    expect(data.aggregates.project_count).toBe(2);
    expect(data.aggregates.slot_efficiency_recent).toBeNull();
    expect(typeof data.rendered_at).toBe("string");
  });

  it("handles a project with zero cycles (last_cycle_at null)", async () => {
    const path = makeProjectDir("solo", { tasks: [] });
    writeYaml([{ id: "solo", path }]);

    const data = await getFleetOverview();
    expect(data.projects[0].last_cycle_at).toBeNull();
    expect(data.projects[0].last_cycle_outcome).toBeNull();
    expect(data.projects[0].cycles_total).toBe(0);
    expect(data.projects[0].bot_pickable).toBe(0);
  });

  it("pass_rate is 0 when there are no verified or failed cycles", async () => {
    const path = makeProjectDir("solo", { tasks: [] });
    writeYaml([{ id: "solo", path }]);

    const data = await getFleetOverview();
    expect(data.aggregates.pass_rate).toBe(0);
    expect(data.aggregates.total_cycles).toBe(0);
  });

  it("pass_rate uses verified / (verified + failed) formula", async () => {
    const path = makeProjectDir("solo", {
      cycles: [
        { outcome: "verified" },
        { outcome: "verified" },
        { outcome: "verified" },
        { outcome: "verification_failed" },
      ],
      tasks: [],
    });
    writeYaml([{ id: "solo", path }]);

    const data = await getFleetOverview();
    expect(data.aggregates.pass_rate).toBeCloseTo(3 / 4, 6);
  });

  it("slot_efficiency_recent returns null when fewer than 5 parallel sessions exist", async () => {
    const path = makeProjectDir("solo", { tasks: [] });
    writeYaml([{ id: "solo", path }]);
    // 4 parallel sessions — below the MIN_SAMPLES threshold of 5.
    writeFleetLog([
      ...Array.from({ length: 4 }, () => ({
        timestamp: new Date().toISOString(),
        event: "session_complete",
        data: { max_parallel_slots: 2, parallel_efficiency: 0.8 },
      })),
    ]);

    const data = await getFleetOverview();
    expect(data.aggregates.slot_efficiency_recent).toBeNull();
  });

  it("slot_efficiency_recent averages the most recent up-to-10 parallel sessions", async () => {
    const path = makeProjectDir("solo", { tasks: [] });
    writeYaml([{ id: "solo", path }]);
    // 5 parallel sessions with mixed efficiencies + 1 sequential session
    // (max_parallel_slots: 1) that must be excluded from the average.
    writeFleetLog([
      {
        timestamp: "2026-04-01T00:00:00Z",
        event: "session_complete",
        data: { max_parallel_slots: 1, parallel_efficiency: 0.0 },
      },
      ...[0.6, 0.7, 0.8, 0.9, 1.0].map((eff, i) => ({
        timestamp: `2026-04-02T0${i}:00:00Z`,
        event: "session_complete",
        data: { max_parallel_slots: 2, parallel_efficiency: eff },
      })),
    ]);

    const data = await getFleetOverview();
    // Mean of [0.6, 0.7, 0.8, 0.9, 1.0] = 0.8
    expect(data.aggregates.slot_efficiency_recent).toBeCloseTo(0.8, 6);
  });
});
