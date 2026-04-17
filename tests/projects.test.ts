import { describe, expect, it } from "bun:test";
import {
  loadProjectsYaml,
  validateHandsOff,
  warnProjectPaths,
  getProject,
  ProjectNotFoundError,
  validateConfig,
  assertValidConfig,
} from "../src/projects";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { ProjectConfig } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures");

function writeYaml(name: string, content: string): string {
  const dir = join(FIXTURES, "yaml");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function cleanup() {
  // Only nuke this test's own yaml subdir — sibling fixture subdirs
  // (e.g. tests/fixtures/reviewer_calibration/, which holds tracked
  // data files) must not be collateral damage.
  rmSync(join(FIXTURES, "yaml"), { recursive: true, force: true });
}

describe("projects.yaml loader", () => {
  it("loads a valid projects.yaml", async () => {
    const path = writeYaml(
      "valid.yaml",
      `
projects:
  - id: test-project
    path: /tmp/test
    priority: 1
    engineer_command: "echo hello"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    auto_merge: false
    hands_off:
      - secret/
      - config.yaml
dispatcher:
  state_dir: ./state
  fleet_state_file: ./fleet_state.json
  stop_file: ./STOP
  override_file: ./next_project.txt
  picker: priority_x_staleness
  max_cycles_per_project_per_session: 3
  log_dir: ./logs
  digest_dir: ./digests
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects).toHaveLength(1);
    expect(yaml.projects[0].id).toBe("test-project");
    expect(yaml.projects[0].work_detection).toBe("tasks_json"); // default
    expect(yaml.projects[0].concurrency_detection).toBe("none"); // default
    expect(yaml.dispatcher.max_cycles_per_project_per_session).toBe(3);
    cleanup();
  });

  it("rejects empty hands_off with specific message (names project + Rule 5)", async () => {
    const path = writeYaml(
      "no-handsoff.yaml",
      `
projects:
  - id: bad
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: []
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("must not be empty");
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"bad"/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Hard Rule #5/);
    cleanup();
  });

  it("rejects missing hands_off with 'required but missing' (names project + Rule 5)", async () => {
    const path = writeYaml(
      "missing-handsoff.yaml",
      `
projects:
  - id: bad
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("required but missing");
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"bad"/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Hard Rule #5/);
    cleanup();
  });

  it("rejects config when only one of multiple projects has empty hands_off", async () => {
    const path = writeYaml(
      "mixed-handsoff.yaml",
      `
projects:
  - id: good
    path: /tmp/a
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [secret/]
  - id: bad-one
    path: /tmp/b
    priority: 2
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: []
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"bad-one"/);
    await expect(loadProjectsYaml(path)).rejects.toThrow("must not be empty");
    cleanup();
  });

  it("rejects missing engineer_command with 'required but missing'", async () => {
    const path = writeYaml(
      "no-eng.yaml",
      `
projects:
  - id: bad
    path: /tmp/test
    priority: 1
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - x
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("required but missing");
    cleanup();
  });

  it("rejects wrong-type priority with 'got string'", async () => {
    const path = writeYaml(
      "bad-priority.yaml",
      `
projects:
  - id: bad
    path: /tmp/test
    priority: "high"
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("got string");
    cleanup();
  });

  it("rejects non-integer cycle_budget_minutes", async () => {
    const path = writeYaml(
      "bad-budget.yaml",
      `
projects:
  - id: bad
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 2.5
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("must be an integer");
    cleanup();
  });

  it("rejects duplicate project IDs", async () => {
    const path = writeYaml(
      "dup.yaml",
      `
projects:
  - id: same
    path: /a
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
  - id: same
    path: /b
    priority: 2
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [y]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow("Duplicate");
    cleanup();
  });

  it("rejects invalid work_detection with actual value", async () => {
    const path = writeYaml(
      "bad-wd.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    work_detection: magic
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow('got "magic"');
    cleanup();
  });
});

function fakeProject(overrides: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "test",
    path: "/tmp/test",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["x"],
    ...overrides,
  };
}

describe("warnProjectPaths", () => {
  it("warns when path does not exist on disk", () => {
    const warnings = warnProjectPaths([
      fakeProject({ id: "missing", path: "/nonexistent/path/that/does/not/exist" }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].projectId).toBe("missing");
    expect(warnings[0].message).toContain("does not exist");
  });

  it("warns when path exists but is not a git repo", () => {
    // Use a temp dir outside the repo so git rev-parse won't find a parent .git
    const tmpDir = join(tmpdir(), "gs-test-not-a-repo-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    try {
      const warnings = warnProjectPaths([
        fakeProject({ id: "no-git", path: tmpDir }),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].projectId).toBe("no-git");
      expect(warnings[0].message).toContain("not a git repository");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns no warnings for a valid git repo", () => {
    // The generalstaff repo itself is a valid git repo
    const repoRoot = join(import.meta.dir, "..");
    const warnings = warnProjectPaths([
      fakeProject({ id: "valid-repo", path: repoRoot }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it("reports per-project warnings when given a mix of valid git repo and non-git dir", () => {
    const repoRoot = join(import.meta.dir, "..");
    const tmpDir = join(tmpdir(), "gs-test-mixed-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    try {
      const warnings = warnProjectPaths([
        fakeProject({ id: "valid", path: repoRoot }),
        fakeProject({ id: "not-git", path: tmpDir }),
        fakeProject({ id: "missing", path: "/nope/nada/none" }),
      ]);
      expect(warnings).toHaveLength(2);
      const byId = Object.fromEntries(warnings.map((w) => [w.projectId, w.message]));
      expect(byId["not-git"]).toContain("not a git repository");
      expect(byId["missing"]).toContain("does not exist");
      expect(byId["valid"]).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not throw — loadProjectsYaml succeeds with non-existent path", async () => {
    const path = writeYaml(
      "missing-path.yaml",
      `
projects:
  - id: ghost
    path: /this/path/does/not/exist/anywhere
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
`,
    );
    // Should resolve without throwing — warnings go to console.warn
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects).toHaveLength(1);
    expect(yaml.projects[0].id).toBe("ghost");
    cleanup();
  });
});

describe("validateHandsOff", () => {
  const repoRoot = join(import.meta.dir, "..");

  it("warns when a pattern matches no tracked files", () => {
    const warnings = validateHandsOff(
      fakeProject({
        id: "typo",
        path: repoRoot,
        hands_off: ["src/projects.ts", "src/no_such_file_xyz.ts"],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].projectId).toBe("typo");
    expect(warnings[0].message).toContain("no_such_file_xyz.ts");
    expect(warnings[0].message).toContain("matches no tracked files");
  });

  it("returns no warnings when all patterns match tracked files", () => {
    const warnings = validateHandsOff(
      fakeProject({
        id: "ok",
        path: repoRoot,
        hands_off: ["src/projects.ts", "src/**", "*.md"],
      }),
    );
    expect(warnings).toHaveLength(0);
  });

  it("skips validation (no warnings) when path does not exist", () => {
    const warnings = validateHandsOff(
      fakeProject({
        id: "missing",
        path: "/nonexistent/path/that/does/not/exist",
        hands_off: ["definitely_not_there"],
      }),
    );
    expect(warnings).toHaveLength(0);
  });

  it("skips validation (no warnings) when path is not a git repo", () => {
    const tmpDir = join(tmpdir(), "gs-validate-handsoff-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    try {
      const warnings = validateHandsOff(
        fakeProject({
          id: "no-git",
          path: tmpDir,
          hands_off: ["definitely_not_there"],
        }),
      );
      expect(warnings).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports one warning per unmatched pattern", () => {
    const warnings = validateHandsOff(
      fakeProject({
        id: "multi",
        path: repoRoot,
        hands_off: ["bogus_one.xyz", "bogus_two.xyz", "src/projects.ts"],
      }),
    );
    expect(warnings).toHaveLength(2);
    const patterns = warnings.map((w) => w.message);
    expect(patterns.some((m) => m.includes("bogus_one.xyz"))).toBe(true);
    expect(patterns.some((m) => m.includes("bogus_two.xyz"))).toBe(true);
  });
});

describe("validateConfig", () => {
  function validProjectRaw(overrides: Record<string, unknown> = {}) {
    return {
      id: "ok",
      path: "/tmp/ok",
      priority: 1,
      engineer_command: "echo",
      verification_command: "echo",
      cycle_budget_minutes: 30,
      hands_off: ["secret/"],
      ...overrides,
    };
  }

  it("returns no errors for a valid single-project config", () => {
    const { errors } = validateConfig({ projects: [validProjectRaw()] });
    expect(errors).toEqual([]);
  });

  it("collects multiple errors in a single pass (doesn't fail-fast)", () => {
    const { errors } = validateConfig({
      projects: [
        {
          id: "bad",
          // path missing
          // engineer_command missing
          verification_command: "",
          cycle_budget_minutes: 0,
          hands_off: [],
        },
      ],
    });
    // Expect errors for each of: path, engineer_command, verification_command,
    // cycle_budget_minutes, hands_off (5 distinct issues).
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.some((e) => e.includes("path"))).toBe(true);
    expect(errors.some((e) => e.includes("engineer_command"))).toBe(true);
    expect(errors.some((e) => e.includes("verification_command"))).toBe(true);
    expect(errors.some((e) => e.includes("cycle_budget_minutes"))).toBe(true);
    expect(errors.some((e) => e.includes("hands_off"))).toBe(true);
    // Every error should reference the project id.
    for (const e of errors) {
      expect(e).toContain('"bad"');
    }
  });

  it("collects errors across multiple projects in one pass", () => {
    const { errors } = validateConfig({
      projects: [
        { ...validProjectRaw({ id: "good" }) },
        { ...validProjectRaw({ id: "bad1", hands_off: [] }) },
        { ...validProjectRaw({ id: "bad2", cycle_budget_minutes: -5 }) },
      ],
    });
    expect(errors.length).toBe(2);
    expect(errors.some((e) => e.includes('"bad1"') && e.includes("hands_off"))).toBe(
      true,
    );
    expect(
      errors.some((e) => e.includes('"bad2"') && e.includes("cycle_budget_minutes")),
    ).toBe(true);
    expect(errors.some((e) => e.includes('"good"'))).toBe(false);
  });

  it("flags missing projects array", () => {
    const { errors } = validateConfig({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("projects");
  });

  it("flags empty projects array", () => {
    const { errors } = validateConfig({ projects: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("at least one project");
  });

  it("flags non-object root", () => {
    const { errors } = validateConfig("not an object");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("root must be an object");
  });

  it("flags duplicate project ids as a single error", () => {
    const { errors } = validateConfig({
      projects: [
        validProjectRaw({ id: "same" }),
        validProjectRaw({ id: "same" }),
      ],
    });
    expect(errors.some((e) => e.includes("Duplicate") && e.includes("same"))).toBe(
      true,
    );
  });

  it("flags empty branch override as invalid", () => {
    const { errors } = validateConfig({
      projects: [validProjectRaw({ branch: "   " })],
    });
    expect(errors.some((e) => e.includes("branch"))).toBe(true);
  });

  it("accepts default branch (unset) without error", () => {
    const raw = validProjectRaw();
    delete (raw as Record<string, unknown>).branch;
    const { errors } = validateConfig({ projects: [raw] });
    expect(errors).toEqual([]);
  });

  it("flags cycle_budget_minutes = 0 as not > 0", () => {
    const { errors } = validateConfig({
      projects: [validProjectRaw({ cycle_budget_minutes: 0 })],
    });
    expect(errors.some((e) => e.includes("cycle_budget_minutes"))).toBe(true);
  });

  it("flags non-integer cycle_budget_minutes", () => {
    const { errors } = validateConfig({
      projects: [validProjectRaw({ cycle_budget_minutes: 2.5 })],
    });
    expect(errors.some((e) => e.includes("must be an integer"))).toBe(true);
  });

  it("flags wrong-type hands_off", () => {
    const { errors } = validateConfig({
      projects: [validProjectRaw({ hands_off: "secret/" })],
    });
    expect(errors.some((e) => e.includes("must be an array"))).toBe(true);
  });
});

describe("assertValidConfig", () => {
  it("does not throw on valid config", () => {
    expect(() =>
      assertValidConfig({
        projects: [
          {
            id: "ok",
            path: "/tmp/ok",
            priority: 1,
            engineer_command: "echo",
            verification_command: "echo",
            cycle_budget_minutes: 30,
            hands_off: ["x"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("throws with aggregated multi-line message listing every problem", () => {
    try {
      assertValidConfig({
        projects: [
          {
            id: "broken",
            // no path, no engineer_command, hands_off empty
            verification_command: "echo",
            cycle_budget_minutes: 30,
            hands_off: [],
          },
        ],
      });
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Invalid projects.yaml");
      expect(msg).toContain("3 errors"); // path, engineer_command, hands_off
      expect(msg).toContain("path");
      expect(msg).toContain("engineer_command");
      expect(msg).toContain("hands_off");
      expect(msg).toContain('"broken"');
      // Multi-line format: one bullet per issue.
      expect(msg.split("\n").length).toBeGreaterThanOrEqual(4);
    }
  });

  it("uses singular header for a single error", () => {
    try {
      assertValidConfig({
        projects: [
          {
            id: "one-bad",
            path: "/tmp",
            priority: 1,
            engineer_command: "echo",
            verification_command: "echo",
            cycle_budget_minutes: 30,
            hands_off: [],
          },
        ],
      });
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Invalid projects.yaml:");
      expect(msg).not.toContain("errors)");
    }
  });
});

describe("getProject", () => {
  const sample = [
    fakeProject({ id: "alpha" }),
    fakeProject({ id: "beta" }),
    fakeProject({ id: "gamma" }),
  ];

  it("returns the matching project", () => {
    const p = getProject(sample, "beta");
    expect(p.id).toBe("beta");
  });

  it("throws ProjectNotFoundError with available ids when not found", () => {
    try {
      getProject(sample, "delta");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectNotFoundError);
      const e = err as ProjectNotFoundError;
      expect(e.projectId).toBe("delta");
      expect(e.availableIds).toEqual(["alpha", "beta", "gamma"]);
      expect(e.message).toContain("delta");
      expect(e.message).toContain("alpha");
      expect(e.message).toContain("beta");
      expect(e.message).toContain("gamma");
    }
  });

  it("error message notes when no projects are registered", () => {
    try {
      getProject([], "anything");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectNotFoundError);
      expect((err as ProjectNotFoundError).availableIds).toEqual([]);
      expect((err as Error).message).toContain("No projects are registered");
    }
  });
});

