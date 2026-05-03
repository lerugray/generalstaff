import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
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
