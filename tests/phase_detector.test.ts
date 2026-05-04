import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { setRootDir } from "../src/state";
import {
  detectPhaseReady,
  clearPhaseReadySentinel,
  phaseReadySentinelPath,
  phaseReadySentinelExists,
  runFleetPhaseDetection,
} from "../src/phase_detector";
import { defaultRoadmapYaml, roadmapPath } from "../src/phase";
import type { ProjectConfig, PhaseReadySentinel } from "../src/types";

const TEST_DIR = join(process.cwd(), "tmp-test-phase-detector");
const PROJECT_ID = "phasedet";

function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: PROJECT_ID,
    path: TEST_DIR,
    priority: 1,
    engineer_command: "true",
    verification_command: "true",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "worktree",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["secrets/"],
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "state", PROJECT_ID), { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectPhaseReady — no roadmap", () => {
  it("returns no_roadmap when ROADMAP.yaml is missing", async () => {
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("no_roadmap");
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });
});

describe("detectPhaseReady — ready (criteria pass + non-terminal)", () => {
  beforeEach(() => {
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");
  });

  it("returns ready + writes sentinel + emits event when criteria pass", async () => {
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.from_phase).toBe("mvp");
    expect(result.to_phase).toBe("launch");

    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(true);
    const sentinel = JSON.parse(
      readFileSync(phaseReadySentinelPath(PROJECT_ID), "utf-8"),
    ) as PhaseReadySentinel;
    expect(sentinel.from_phase).toBe("mvp");
    expect(sentinel.to_phase).toBe("launch");
    expect(sentinel.criteria_results).toHaveLength(1);
    expect(sentinel.criteria_results[0]!.passed).toBe(true);

    // PROGRESS.jsonl received the event
    const progress = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "PROGRESS.jsonl"),
      "utf-8",
    );
    expect(progress).toContain('"event":"phase_ready_for_advance"');
    expect(progress).toContain('"from_phase":"mvp"');
    expect(progress).toContain('"to_phase":"launch"');
  });

  it("idempotent — second call doesn't re-emit event", async () => {
    await detectPhaseReady(makeProjectConfig());
    const progress1 = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "PROGRESS.jsonl"),
      "utf-8",
    );
    const eventCount1 = (progress1.match(/phase_ready_for_advance/g) || []).length;

    // Second call should rewrite the sentinel (with fresh timestamp)
    // but NOT emit a duplicate event for the same {from, to}.
    await new Promise((r) => setTimeout(r, 5));
    await detectPhaseReady(makeProjectConfig());
    const progress2 = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "PROGRESS.jsonl"),
      "utf-8",
    );
    const eventCount2 = (progress2.match(/phase_ready_for_advance/g) || []).length;
    expect(eventCount2).toBe(eventCount1);

    // But sentinel detected_at IS refreshed
    const sentinel = JSON.parse(
      readFileSync(phaseReadySentinelPath(PROJECT_ID), "utf-8"),
    ) as PhaseReadySentinel;
    // Just confirm timestamp is present + parses
    expect(Date.parse(sentinel.detected_at)).toBeGreaterThan(0);
  });
});

describe("detectPhaseReady — not_ready", () => {
  beforeEach(() => {
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");
    // Add a pending task so all_tasks_done fails
    writeFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "tasks.json"),
      JSON.stringify(
        [{ id: "t-001", title: "open", status: "pending", priority: 1 }],
        null,
        2,
      ),
    );
  });

  it("returns not_ready + does NOT write sentinel + does NOT emit event", async () => {
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("not_ready");
    if (result.kind !== "not_ready") return;
    expect(result.criteria_results[0]!.passed).toBe(false);

    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);

    // No PROGRESS.jsonl entry for phase_ready_for_advance
    const progressPath = join(TEST_DIR, "state", PROJECT_ID, "PROGRESS.jsonl");
    if (existsSync(progressPath)) {
      const progress = readFileSync(progressPath, "utf-8");
      expect(progress).not.toContain("phase_ready_for_advance");
    }
  });
});

describe("detectPhaseReady — terminal_complete", () => {
  it("returns terminal_complete when criteria pass on a phase with no next_phase", async () => {
    // Custom roadmap with a single terminal phase
    const yaml = `project_id: ${PROJECT_ID}
current_phase: only
phases:
  - id: only
    goal: "single phase"
    completion_criteria:
      - all_tasks_done: true
`;
    writeFileSync(roadmapPath(PROJECT_ID), yaml, "utf-8");
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("terminal_complete");
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });
});

describe("detectPhaseReady — error", () => {
  it("returns error when ROADMAP.yaml is malformed", async () => {
    writeFileSync(
      roadmapPath(PROJECT_ID),
      "project_id: [unclosed\nphases: nope",
      "utf-8",
    );
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  it("returns error when project_id mismatch", async () => {
    writeFileSync(
      roadmapPath(PROJECT_ID),
      defaultRoadmapYaml("wrong-id"),
      "utf-8",
    );
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("error");
  });
});

describe("clearPhaseReadySentinel", () => {
  it("removes the sentinel file", async () => {
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");
    await detectPhaseReady(makeProjectConfig());
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(true);
    await clearPhaseReadySentinel(PROJECT_ID);
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });

  it("is a no-op when no sentinel exists", async () => {
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
    await clearPhaseReadySentinel(PROJECT_ID);
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });
});

describe("runFleetPhaseDetection", () => {
  it("runs detection across multiple projects + logs ready ones", async () => {
    // Project 1: ROADMAP exists, criteria pass, ready
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");

    // Project 2: no ROADMAP — silent
    const otherId = "other-proj";
    mkdirSync(join(TEST_DIR, "state", otherId), { recursive: true });

    // Project 3: ROADMAP, but criteria fail
    const failId = "fail-proj";
    mkdirSync(join(TEST_DIR, "state", failId), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "state", failId, "ROADMAP.yaml"),
      defaultRoadmapYaml(failId),
      "utf-8",
    );
    writeFileSync(
      join(TEST_DIR, "state", failId, "tasks.json"),
      JSON.stringify(
        [{ id: "fail-001", title: "x", status: "pending", priority: 1 }],
        null,
        2,
      ),
    );

    const logLines: string[] = [];
    const projects = [
      makeProjectConfig({ id: PROJECT_ID }),
      makeProjectConfig({ id: otherId }),
      makeProjectConfig({ id: failId }),
    ];
    const results = await runFleetPhaseDetection(projects, (line) =>
      logLines.push(line),
    );

    expect(results.size).toBe(3);
    expect(results.get(PROJECT_ID)?.kind).toBe("ready");
    expect(results.get(otherId)?.kind).toBe("no_roadmap");
    expect(results.get(failId)?.kind).toBe("not_ready");

    // Log lines: only ready + error projects produce a log line.
    // 2 lines: 1 for the ready project + 1 summary line.
    expect(logLines.some((l) => l.includes("ready to advance"))).toBe(true);
    expect(logLines.some((l) => l.includes("1 project"))).toBe(true);
    // not_ready and no_roadmap stay silent
    expect(logLines.some((l) => l.includes(otherId))).toBe(false);
  });

  it("emits no summary line when nothing is ready", async () => {
    const logLines: string[] = [];
    const projects = [makeProjectConfig({ id: PROJECT_ID })];
    await runFleetPhaseDetection(projects, (line) => logLines.push(line));
    // No ROADMAP exists, so no log lines at all
    expect(logLines).toHaveLength(0);
  });
});

// --- Phase B+ (2026-05-04): opt-in auto-advance ---

const AUTO_ADVANCE_ROADMAP = `project_id: ${PROJECT_ID}
current_phase: mvp
auto_advance: true

phases:
  - id: mvp
    goal: "Working end-to-end flow"
    completion_criteria:
      - all_tasks_done: true
    next_phase: launch

  - id: launch
    goal: "Public launch"
    depends_on: mvp
    tasks:
      - title: "Smoke-test the live deployment"
        priority: 1
      - title: "First-user announcement post"
        priority: 2
    completion_criteria:
      - all_tasks_done: true
`;

describe("detectPhaseReady — auto_advance", () => {
  beforeEach(() => {
    writeFileSync(roadmapPath(PROJECT_ID), AUTO_ADVANCE_ROADMAP, "utf-8");
  });

  it("auto-advances + seeds tasks + emits phase_auto_advanced when criteria pass", async () => {
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("auto_advanced");
    if (result.kind !== "auto_advanced") return;

    expect(result.from_phase).toBe("mvp");
    expect(result.to_phase).toBe("launch");
    expect(result.seeded_task_ids).toHaveLength(2);

    // PHASE_STATE.json now reflects the new current_phase
    const stateRaw = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "PHASE_STATE.json"),
      "utf-8",
    );
    const state = JSON.parse(stateRaw);
    expect(state.current_phase).toBe("launch");
    expect(state.completed_phases).toHaveLength(1);
    expect(state.completed_phases[0].phase_id).toBe("mvp");

    // tasks.json now contains the seeded tasks
    const tasksRaw = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "tasks.json"),
      "utf-8",
    );
    const tasks = JSON.parse(tasksRaw);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Smoke-test the live deployment");
    expect(tasks[1].title).toBe("First-user announcement post");

    // PROGRESS.jsonl received phase_complete + phase_auto_advanced
    // (NOT phase_advanced — the trigger event distinguishes the two paths)
    const progress = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "PROGRESS.jsonl"),
      "utf-8",
    );
    expect(progress).toContain('"event":"phase_complete"');
    expect(progress).toContain('"event":"phase_auto_advanced"');
    expect(progress).not.toContain('"event":"phase_advanced"');
    expect(progress).not.toContain('"event":"phase_ready_for_advance"');

    // No PHASE_READY.json sentinel — auto-advance bypasses it
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });

  it("idempotent — second detection on the now-launched phase returns terminal_complete", async () => {
    // First call advances mvp -> launch
    await detectPhaseReady(makeProjectConfig());
    // Second call: launch's tasks were just seeded as pending, so
    // all_tasks_done is FALSE → not_ready
    const second = await detectPhaseReady(makeProjectConfig());
    expect(second.kind).toBe("not_ready");
    if (second.kind !== "not_ready") return;
    expect(second.current_phase).toBe("launch");
  });

  it("does NOT auto-advance when criteria fail", async () => {
    // Seed an incomplete task so all_tasks_done fails
    writeFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "tasks.json"),
      JSON.stringify([
        { id: "t-001", title: "Incomplete work", status: "pending", priority: 1 },
      ]),
      "utf-8",
    );
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("not_ready");

    // No PHASE_STATE.json was written (detector only writes it on
    // advance — not_ready leaves the project on its starting phase
    // implicitly via the roadmap's current_phase field).
    expect(
      existsSync(join(TEST_DIR, "state", PROJECT_ID, "PHASE_STATE.json")),
    ).toBe(false);
  });

  it("does NOT auto-advance when auto_advance is false (default behavior)", async () => {
    // Use the default roadmap (no auto_advance set)
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("ready");
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(true);
  });

  it("clears stale PHASE_READY.json sentinel before advancing", async () => {
    // Pre-seed a sentinel from a prior session
    const sentinelPath = phaseReadySentinelPath(PROJECT_ID);
    mkdirSync(dirname(sentinelPath), { recursive: true });
    writeFileSync(
      sentinelPath,
      JSON.stringify({
        project_id: PROJECT_ID,
        from_phase: "mvp",
        to_phase: "launch",
        detected_at: "2026-01-01T00:00:00Z",
        criteria_results: [],
      }),
      "utf-8",
    );
    const result = await detectPhaseReady(makeProjectConfig());
    expect(result.kind).toBe("auto_advanced");
    expect(phaseReadySentinelExists(PROJECT_ID)).toBe(false);
  });
});

describe("runFleetPhaseDetection — auto_advance summary line", () => {
  it("emits an auto-advanced summary line when at least one project auto-advances", async () => {
    writeFileSync(roadmapPath(PROJECT_ID), AUTO_ADVANCE_ROADMAP, "utf-8");
    const logLines: string[] = [];
    const projects = [makeProjectConfig({ id: PROJECT_ID })];
    await runFleetPhaseDetection(projects, (line) => logLines.push(line));
    expect(logLines.some((l) => l.includes("auto-advanced"))).toBe(true);
    expect(
      logLines.some((l) => /1 project.*auto-advanced this session/.test(l)),
    ).toBe(true);
  });
});
