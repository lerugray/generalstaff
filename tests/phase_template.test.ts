// Phase B+ (2026-05-04) — tests for tasks_template placeholder
// expansion logic. Validation tests for unknown placeholders and
// the parser live in phase.test.ts; this file covers the runtime
// expansion via buildExpansionContext + expandTaskTemplates and
// the end-to-end advance flow.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { setRootDir } from "../src/state";
import {
  buildExpansionContext,
  expandTaskTemplates,
  loadRoadmap,
  roadmapPath,
  executePhaseAdvance,
  findPhase,
  evaluateCriteria,
} from "../src/phase";
import { loadPhaseState } from "../src/phase_state";
import type { ProjectConfig, RoadmapLiteralTask } from "../src/types";

const TEST_DIR = join(process.cwd(), "tmp-test-phase-template");
const PROJECT_ID = "tmplproj";

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

describe("expandTaskTemplates — placeholder substitution", () => {
  it("substitutes {phase_id}, {prev_phase}, {project_id} in title", () => {
    const ctx = buildExpansionContext(
      "myapp",
      "mvp",
      "launch",
      new Date("2026-05-04T10:30:00Z"),
    );
    const templates: RoadmapLiteralTask[] = [
      {
        title: "Cut the {phase_id} release tag for {project_id} (was on {prev_phase})",
      },
    ];
    const expanded = expandTaskTemplates(templates, ctx);
    expect(expanded[0]!.title).toBe(
      "Cut the launch release tag for myapp (was on mvp)",
    );
  });

  it("substitutes {date} and {datetime} from the context's now", () => {
    const ctx = buildExpansionContext(
      "myapp",
      "mvp",
      "launch",
      new Date("2026-05-04T10:30:45Z"),
    );
    const templates: RoadmapLiteralTask[] = [
      { title: "Daily standup {date} at {datetime}" },
    ];
    const expanded = expandTaskTemplates(templates, ctx);
    expect(expanded[0]!.title).toBe(
      "Daily standup 2026-05-04 at 2026-05-04T10:30:45Z",
    );
  });

  it("substitutes placeholders in interactive_only_reason and expected_touches", () => {
    const ctx = buildExpansionContext("myapp", "mvp", "launch");
    const templates: RoadmapLiteralTask[] = [
      {
        title: "Review {phase_id} copy",
        interactive_only: true,
        interactive_only_reason: "Voice-bearing for {phase_id} announcement",
        expected_touches: ["docs/{phase_id}/announcement.md"],
      },
    ];
    const expanded = expandTaskTemplates(templates, ctx);
    expect(expanded[0]!.interactive_only_reason).toBe(
      "Voice-bearing for launch announcement",
    );
    expect(expanded[0]!.expected_touches).toEqual([
      "docs/launch/announcement.md",
    ]);
  });

  it("preserves priority and other non-string fields", () => {
    const ctx = buildExpansionContext("myapp", "mvp", "launch");
    const templates: RoadmapLiteralTask[] = [
      { title: "Task {phase_id}", priority: 1, interactive_only: true },
    ];
    const expanded = expandTaskTemplates(templates, ctx);
    expect(expanded[0]!.priority).toBe(1);
    expect(expanded[0]!.interactive_only).toBe(true);
  });

  it("leaves strings without placeholders unchanged", () => {
    const ctx = buildExpansionContext("myapp", "mvp", "launch");
    const templates: RoadmapLiteralTask[] = [
      { title: "Just a plain task" },
    ];
    const expanded = expandTaskTemplates(templates, ctx);
    expect(expanded[0]!.title).toBe("Just a plain task");
  });
});

describe("executePhaseAdvance — tasks_template seeding", () => {
  const ROADMAP_WITH_TEMPLATE = `project_id: ${PROJECT_ID}
current_phase: mvp

phases:
  - id: mvp
    goal: "Working e2e flow"
    completion_criteria:
      - all_tasks_done: true
    next_phase: launch

  - id: launch
    goal: "Public launch"
    depends_on: mvp
    tasks:
      - title: "Smoke-test the live deployment"
        priority: 1
    tasks_template:
      - title: "Cut the {phase_id} release tag"
        priority: 2
      - title: "Post {phase_id} announcement on {date}"
        priority: 3
        interactive_only: true
        interactive_only_reason: "Voice-bearing copy for {project_id}"
    completion_criteria:
      - all_tasks_done: true
`;

  beforeEach(() => {
    writeFileSync(roadmapPath(PROJECT_ID), ROADMAP_WITH_TEMPLATE, "utf-8");
  });

  it("seeds literal tasks + expanded template tasks on advance", async () => {
    const projectConfig = makeProjectConfig();
    const roadmap = await loadRoadmap(PROJECT_ID);
    const mvp = findPhase(roadmap, "mvp")!;
    const launch = findPhase(roadmap, "launch")!;
    const criteriaResults = await evaluateCriteria(mvp, projectConfig);

    const result = await executePhaseAdvance(
      projectConfig,
      mvp,
      launch,
      criteriaResults,
    );

    // 1 literal + 2 templated = 3 seeded tasks
    expect(result.seeded_task_ids).toHaveLength(3);

    const tasksRaw = readFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "tasks.json"),
      "utf-8",
    );
    const tasks = JSON.parse(tasksRaw);
    expect(tasks).toHaveLength(3);

    // Literal task came first (preserves declared order)
    expect(tasks[0].title).toBe("Smoke-test the live deployment");
    expect(tasks[0].priority).toBe(1);

    // Templated tasks expanded with launch context
    expect(tasks[1].title).toBe("Cut the launch release tag");
    expect(tasks[1].priority).toBe(2);

    expect(tasks[2].title).toMatch(
      /^Post launch announcement on \d{4}-\d{2}-\d{2}$/,
    );
    expect(tasks[2].priority).toBe(3);
    expect(tasks[2].interactive_only).toBe(true);
    expect(tasks[2].interactive_only_reason).toBe(
      `Voice-bearing copy for ${PROJECT_ID}`,
    );

    // PHASE_STATE.json reflects the advance
    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("launch");
  });
});
