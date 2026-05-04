import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { setRootDir } from "../src/state";
import {
  loadRoadmap,
  validateRoadmap,
  findPhase,
  evaluateCriteria,
  allPassed,
  roadmapPath,
  roadmapExists,
  defaultRoadmapYaml,
  RoadmapLoadError,
  RoadmapValidationError,
} from "../src/phase";
import type { ProjectConfig, RoadmapPhase } from "../src/types";

const TEST_DIR = join(process.cwd(), "tmp-test-phase");
const PROJECT_ID = "phasetest";

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
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "state", PROJECT_ID), { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("validateRoadmap", () => {
  it("accepts a minimal single-phase roadmap", () => {
    const r = validateRoadmap(
      {
        project_id: PROJECT_ID,
        current_phase: "mvp",
        phases: [
          {
            id: "mvp",
            goal: "Working flow",
            completion_criteria: [{ all_tasks_done: true }],
          },
        ],
      },
      PROJECT_ID,
    );
    expect(r.project_id).toBe(PROJECT_ID);
    expect(r.current_phase).toBe("mvp");
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0]!.id).toBe("mvp");
  });

  it("rejects non-object input", () => {
    expect(() => validateRoadmap(null, PROJECT_ID)).toThrow(RoadmapValidationError);
    expect(() => validateRoadmap("string", PROJECT_ID)).toThrow(RoadmapValidationError);
    expect(() => validateRoadmap([], PROJECT_ID)).toThrow(RoadmapValidationError);
  });

  it("rejects missing project_id / current_phase / phases", () => {
    expect(() =>
      validateRoadmap({ current_phase: "mvp", phases: [] }, PROJECT_ID),
    ).toThrow(/project_id/);
    expect(() =>
      validateRoadmap({ project_id: PROJECT_ID, phases: [] }, PROJECT_ID),
    ).toThrow(/current_phase/);
    expect(() =>
      validateRoadmap({ project_id: PROJECT_ID, current_phase: "mvp" }, PROJECT_ID),
    ).toThrow(/phases/);
  });

  it("rejects mismatched project_id", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: "wrong",
          current_phase: "mvp",
          phases: [
            { id: "mvp", goal: "x", completion_criteria: [] },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/does not match registry id/);
  });

  it("rejects current_phase not in phases list", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "ghost",
          phases: [
            { id: "mvp", goal: "x", completion_criteria: [] },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/current_phase="ghost"/);
  });

  it("rejects duplicate phase ids", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            { id: "mvp", goal: "a", completion_criteria: [] },
            { id: "mvp", goal: "b", completion_criteria: [] },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/Duplicate phase ids/);
  });

  it("rejects dangling next_phase reference", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            {
              id: "mvp",
              goal: "x",
              completion_criteria: [],
              next_phase: "ghost",
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/next_phase="ghost"/);
  });

  it("rejects dangling depends_on reference", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            {
              id: "mvp",
              goal: "x",
              completion_criteria: [],
              depends_on: "ghost",
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/depends_on="ghost"/);
  });

  it("accepts tasks_template (Phase B+, 2026-05-04)", () => {
    const r = validateRoadmap(
      {
        project_id: PROJECT_ID,
        current_phase: "mvp",
        phases: [
          {
            id: "mvp",
            goal: "x",
            completion_criteria: [],
            tasks_template: [{ title: "Cut the {phase_id} release tag" }],
          },
        ],
      },
      PROJECT_ID,
    );
    expect(r.phases[0]!.tasks_template).toHaveLength(1);
    expect(r.phases[0]!.tasks_template![0]!.title).toBe(
      "Cut the {phase_id} release tag",
    );
  });

  it("rejects unknown placeholder in tasks_template", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            {
              id: "mvp",
              goal: "x",
              completion_criteria: [],
              tasks_template: [{ title: "Bad {nope} placeholder" }],
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/unknown placeholder "\{nope\}"/);
  });

  it("rejects criterion with multiple keys", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            {
              id: "mvp",
              goal: "x",
              completion_criteria: [
                { all_tasks_done: true, custom_check: "true" },
              ],
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/exactly one criterion key/);
  });

  it("rejects unknown criterion key", () => {
    expect(() =>
      validateRoadmap(
        {
          project_id: PROJECT_ID,
          current_phase: "mvp",
          phases: [
            {
              id: "mvp",
              goal: "x",
              completion_criteria: [{ totally_made_up: "yes" }],
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toThrow(/totally_made_up/);
  });

  it("accepts custom_check + all_tasks_done in same phase", () => {
    const r = validateRoadmap(
      {
        project_id: PROJECT_ID,
        current_phase: "mvp",
        phases: [
          {
            id: "mvp",
            goal: "x",
            completion_criteria: [
              { all_tasks_done: true },
              { custom_check: "echo ok" },
            ],
          },
        ],
      },
      PROJECT_ID,
    );
    expect(r.phases[0]!.completion_criteria).toHaveLength(2);
  });

  it("preserves task ordering within a phase", () => {
    const r = validateRoadmap(
      {
        project_id: PROJECT_ID,
        current_phase: "mvp",
        phases: [
          {
            id: "mvp",
            goal: "x",
            completion_criteria: [],
            tasks: [
              { title: "First", priority: 1 },
              { title: "Second", priority: 2 },
            ],
          },
        ],
      },
      PROJECT_ID,
    );
    expect(r.phases[0]!.tasks).toHaveLength(2);
    expect(r.phases[0]!.tasks?.[0]!.title).toBe("First");
    expect(r.phases[0]!.tasks?.[1]!.title).toBe("Second");
  });
});

describe("loadRoadmap", () => {
  it("throws RoadmapLoadError when ROADMAP.yaml is missing", async () => {
    await expect(loadRoadmap(PROJECT_ID)).rejects.toThrow(RoadmapLoadError);
    await expect(loadRoadmap(PROJECT_ID)).rejects.toThrow(/not found/);
  });

  it("loads + parses a valid file", async () => {
    writeFileSync(
      roadmapPath(PROJECT_ID),
      defaultRoadmapYaml(PROJECT_ID),
      "utf-8",
    );
    const r = await loadRoadmap(PROJECT_ID);
    expect(r.project_id).toBe(PROJECT_ID);
    expect(r.current_phase).toBe("mvp");
    expect(r.phases.length).toBeGreaterThan(0);
  });

  it("throws on malformed YAML", async () => {
    writeFileSync(
      roadmapPath(PROJECT_ID),
      "project_id: [unclosed list\nphases: nope",
      "utf-8",
    );
    await expect(loadRoadmap(PROJECT_ID)).rejects.toThrow(RoadmapLoadError);
  });
});

describe("findPhase", () => {
  it("returns phase by id", () => {
    const r = validateRoadmap(
      {
        project_id: PROJECT_ID,
        current_phase: "a",
        phases: [
          { id: "a", goal: "x", completion_criteria: [] },
          { id: "b", goal: "y", completion_criteria: [] },
        ],
      },
      PROJECT_ID,
    );
    expect(findPhase(r, "b")?.goal).toBe("y");
    expect(findPhase(r, "ghost")).toBeUndefined();
  });
});

describe("roadmapExists", () => {
  it("returns false when missing", () => {
    expect(roadmapExists(PROJECT_ID)).toBe(false);
  });
  it("returns true after write", () => {
    writeFileSync(roadmapPath(PROJECT_ID), defaultRoadmapYaml(PROJECT_ID), "utf-8");
    expect(roadmapExists(PROJECT_ID)).toBe(true);
  });
});

describe("evaluateCriteria — all_tasks_done", () => {
  function writeTasks(rows: Array<{ id: string; status: string; priority?: number }>): void {
    const tasks = rows.map((r) => ({
      id: r.id,
      title: `task ${r.id}`,
      status: r.status,
      priority: r.priority ?? 2,
    }));
    writeFileSync(
      join(TEST_DIR, "state", PROJECT_ID, "tasks.json"),
      JSON.stringify(tasks, null, 2),
      "utf-8",
    );
  }

  it("passes when no tasks exist (vacuously)", async () => {
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [{ all_tasks_done: true }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
  });

  it("passes when all tasks are done/skipped/superseded", async () => {
    writeTasks([
      { id: "t1", status: "done" },
      { id: "t2", status: "skipped" },
      { id: "t3", status: "superseded" },
    ]);
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [{ all_tasks_done: true }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(true);
  });

  it("fails when any task is pending", async () => {
    writeTasks([
      { id: "t1", status: "done" },
      { id: "t2", status: "pending" },
    ]);
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [{ all_tasks_done: true }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("t2");
  });
});

describe("evaluateCriteria — custom_check", () => {
  it("passes when bash command exits 0", async () => {
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [{ custom_check: "true" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.kind).toBe("custom_check");
  });

  it("fails when bash command exits non-zero", async () => {
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [{ custom_check: "false" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("exited 1");
  });

  it("captures stderr tail on failure", async () => {
    const phase: RoadmapPhase = {
      id: "mvp",
      goal: "x",
      completion_criteria: [
        { custom_check: "echo 'check failed: missing flag' >&2; exit 2" },
      ],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("missing flag");
  });
});

describe("evaluateCriteria — launch_gate", () => {
  it("passes when LAUNCH-PLAN.md has the gate id checked", async () => {
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      `## Phase 2 — Billing\n\n- [x] stripe-test-mode-verified — webhooks pass on staging\n`,
    );
    const phase: RoadmapPhase = {
      id: "billing",
      goal: "x",
      completion_criteria: [{ launch_gate: "stripe-test-mode-verified" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.kind).toBe("launch_gate");
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.detail).toContain("closed");
  });

  it("accepts uppercase [X] as closed", async () => {
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      `- [X] some-gate — done\n`,
    );
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "some-gate" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(true);
  });

  it("accepts a **bold-wrapped** gate id as closed", async () => {
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      `- [x] **billing-history-page** — view / cancel / change card\n`,
    );
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "billing-history-page" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(true);
  });

  it("fails with detail 'declared but open' when checkbox is empty", async () => {
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      `- [ ] first-paid-subscription — pending Phase 5\n`,
    );
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "first-paid-subscription" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("declared but open");
  });

  it("fails with detail 'not declared' when the gate id is absent", async () => {
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      `- [x] something-else — irrelevant\n`,
    );
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "missing-gate" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("not declared");
  });

  it("fails when LAUNCH-PLAN.md does not exist at the project path", async () => {
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "any-gate" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("LAUNCH-PLAN.md not found");
  });

  it("does not match a gate id appearing inside another gate's description", async () => {
    // The gate id "stripe" should NOT match the second bullet, where
    // "stripe" appears in the description but isn't the bullet's leading
    // identifier. Anchoring is what prevents that false positive.
    writeFileSync(
      join(TEST_DIR, "LAUNCH-PLAN.md"),
      [
        `- [x] payments-overview — overview page mentions stripe`,
        `- [ ] stripe — actual stripe gate, still open`,
      ].join("\n") + "\n",
    );
    const phase: RoadmapPhase = {
      id: "p",
      goal: "x",
      completion_criteria: [{ launch_gate: "stripe" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("declared but open");
  });
});

describe("evaluateCriteria — git_tag", () => {
  function git(args: string[]): void {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
      );
    }
  }

  function initRepoWithCommit(): void {
    git(["init", "--initial-branch=master"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(TEST_DIR, "README.md"), "initial\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "initial"]);
  }

  it("passes when the tag exists in the project's repo", async () => {
    initRepoWithCommit();
    git(["tag", "v0.1.0"]);
    const phase: RoadmapPhase = {
      id: "release",
      goal: "x",
      completion_criteria: [{ git_tag: "v0.1.0" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.kind).toBe("git_tag");
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.detail).toContain("tag exists");
  });

  it("fails when the tag does not exist", async () => {
    initRepoWithCommit();
    // No tag created.
    const phase: RoadmapPhase = {
      id: "release",
      goal: "x",
      completion_criteria: [{ git_tag: "v0.1.0" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("does not exist");
  });

  it("does not glob-expand the tag name (wildcards are literal)", async () => {
    initRepoWithCommit();
    // Tag a real "v0.1.0" but try to match "v*". With glob expansion
    // this would pass; with exact matching (rev-parse refs/tags/v*),
    // git treats "v*" as a literal name component which doesn't exist.
    git(["tag", "v0.1.0"]);
    const phase: RoadmapPhase = {
      id: "release",
      goal: "x",
      completion_criteria: [{ git_tag: "v*" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("does not exist");
  });

  it("does not match a branch name that shares the tag's id", async () => {
    initRepoWithCommit();
    // Branch named "v0.1.0" but no tag — refs/tags/ prefix means
    // the branch ref doesn't satisfy the criterion.
    git(["branch", "v0.1.0"]);
    const phase: RoadmapPhase = {
      id: "release",
      goal: "x",
      completion_criteria: [{ git_tag: "v0.1.0" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
  });

  it("fails with stderr detail when the project path is not a git repo", async () => {
    // TEST_DIR is fresh from beforeEach; no git init.
    const phase: RoadmapPhase = {
      id: "release",
      goal: "x",
      completion_criteria: [{ git_tag: "v0.1.0" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    // Either "stderr:" surfacing git's "not a git repository" message,
    // or the empty-stderr fallback. Either way, no false-positive pass.
    expect(results[0]!.kind).toBe("git_tag");
  });
});

describe("evaluateCriteria — lifecycle_transition", () => {
  it("passes when project.lifecycle equals the target", async () => {
    const phase: RoadmapPhase = {
      id: "launch",
      goal: "x",
      completion_criteria: [{ lifecycle_transition: "dev -> live" }],
    };
    const results = await evaluateCriteria(
      phase,
      makeProjectConfig({ lifecycle: "live" }),
    );
    expect(results[0]!.kind).toBe("lifecycle_transition");
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.detail).toContain('lifecycle is "live"');
  });

  it("fails when project.lifecycle is the source (not yet transitioned)", async () => {
    const phase: RoadmapPhase = {
      id: "launch",
      goal: "x",
      completion_criteria: [{ lifecycle_transition: "dev -> live" }],
    };
    const results = await evaluateCriteria(
      phase,
      makeProjectConfig({ lifecycle: "dev" }),
    );
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain('lifecycle is "dev"');
  });

  it("treats absent project.lifecycle as 'dev'", async () => {
    const phase: RoadmapPhase = {
      id: "launch",
      goal: "x",
      completion_criteria: [{ lifecycle_transition: "dev -> live" }],
    };
    const cfg = makeProjectConfig();
    delete (cfg as { lifecycle?: unknown }).lifecycle;
    const results = await evaluateCriteria(phase, cfg);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain('lifecycle is "dev"');
  });

  it("rejects malformed spec strings", async () => {
    const phase: RoadmapPhase = {
      id: "launch",
      goal: "x",
      completion_criteria: [{ lifecycle_transition: "live" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain('expected format "<from> -> <to>"');
  });

  it("rejects unrecognized target stages", async () => {
    const phase: RoadmapPhase = {
      id: "launch",
      goal: "x",
      completion_criteria: [{ lifecycle_transition: "dev -> beta" }],
    };
    const results = await evaluateCriteria(phase, makeProjectConfig());
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain('not a recognized stage');
  });
});

describe("allPassed", () => {
  it("returns false on empty array", () => {
    expect(allPassed([])).toBe(false);
  });
  it("returns true when all pass", () => {
    expect(
      allPassed([
        { kind: "all_tasks_done", passed: true, detail: "" },
        { kind: "custom_check", passed: true, detail: "" },
      ]),
    ).toBe(true);
  });
  it("returns false when any fails", () => {
    expect(
      allPassed([
        { kind: "all_tasks_done", passed: true, detail: "" },
        { kind: "custom_check", passed: false, detail: "" },
      ]),
    ).toBe(false);
  });
});

describe("defaultRoadmapYaml", () => {
  it("produces valid YAML for the given project", () => {
    const yaml = defaultRoadmapYaml(PROJECT_ID);
    writeFileSync(roadmapPath(PROJECT_ID), yaml, "utf-8");
    // Round-trip: should parse + validate cleanly.
    const r = validateRoadmap(
      // Use the actual loader to verify YAML well-formedness.
      // (loadRoadmap is async; use the sync validator after parsing manually.)
      JSON.parse(JSON.stringify(yamlParse(yaml))),
      PROJECT_ID,
    );
    expect(r.project_id).toBe(PROJECT_ID);
  });
});

// Inline yaml import to avoid the module-import overhead on the test file.
import { parse as yamlParse } from "yaml";
