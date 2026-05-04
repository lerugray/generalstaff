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

// Fixture-based tests for the per-line / per-cause / per-fix error format
// added for gs-181. Each case exercises a common misconfiguration and asserts
// the message cites the right source line plus a concrete remediation hint.
describe("projects.yaml parse-error diagnostics (line + cause + fix)", () => {
  it("missing hands_off cites its project line and suggests adding a list", async () => {
    const path = writeYaml(
      "diag-missing-handsoff.yaml",
      `projects:
  - id: missing-ho
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/projects\.yaml line 2:/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/hands_off/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Hard Rule #5/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Likely cause:/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Fix:/);
    cleanup();
  });

  it("empty hands_off cites the hands_off line (not the project line)", async () => {
    const path = writeYaml(
      "diag-empty-handsoff.yaml",
      `projects:
  - id: empty-ho
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: []
`,
    );
    // hands_off is on line 8 (1-indexed, counting the `projects:` line).
    await expect(loadProjectsYaml(path)).rejects.toThrow(/projects\.yaml line 8:/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/must not be empty/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /Fix: add at least one glob/,
    );
    cleanup();
  });

  it("missing id cites the project line and suggests adding id:", async () => {
    const path = writeYaml(
      "diag-missing-id.yaml",
      `projects:
  - path: /tmp/no-id
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/projects\.yaml line 2:/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/id — is required but missing/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Fix: add an id:/);
    cleanup();
  });

  it("invalid id chars name the offending id and suggest a rename", async () => {
    const path = writeYaml(
      "diag-bad-id.yaml",
      `projects:
  - id: My Project!
    path: /tmp/bad-id
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"My Project!"/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/invalid chars/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/[a-z0-9_-]/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Fix:.*rename/i);
    cleanup();
  });

  it("duplicate project id is flagged with hint + fix", async () => {
    const path = writeYaml(
      "diag-dup.yaml",
      `projects:
  - id: twice
    path: /a
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
  - id: twice
    path: /b
    priority: 2
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [y]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Duplicate project id: "twice"/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Fix:.*rename/i);
    // The duplicate's line is where the second `id: twice` appears (line 9 —
    // yaml's scalar range points at the value position, which lines up with
    // the `id:` key line on the second project entry).
    await expect(loadProjectsYaml(path)).rejects.toThrow(/projects\.yaml line 9:/);
    cleanup();
  });

  it("non-glob hands_off entries (absolute path, `..`, empty, non-string) are flagged", async () => {
    const path = writeYaml(
      "diag-nonglob-ho.yaml",
      `projects:
  - id: bad-globs
    path: /tmp/bad-globs
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - /etc/passwd
      - "../escape"
      - ""
      - 42
`,
    );
    const result = loadProjectsYaml(path).catch((e) => (e as Error).message);
    const msg = await result;
    expect(msg).toContain("absolute path");
    expect(msg).toContain("/etc/passwd");
    expect(msg).toContain("traversal");
    expect(msg).toContain("empty or whitespace");
    expect(msg).toContain("must be a string");
    // Each entry-level error cites the hands_off list's source line (the
    // list starts on line 9 where its first item appears).
    expect(msg).toMatch(/projects\.yaml line 9:/);
    cleanup();
  });

  it("YAML syntax error (bad indent) is reformatted with line + hint + fix", async () => {
    // Mixing indents inside a single mapping triggers BAD_INDENT.
    const path = writeYaml(
      "diag-bad-indent.yaml",
      `projects:
  - id: bad-yaml
    path: /tmp/x
   priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off: [x]
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Invalid projects\.yaml/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/projects\.yaml line \d+:/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/Fix:/);
    cleanup();
  });

  it("validateConfig without source produces plain (no-line) messages", () => {
    // Back-compat check: callers that don't hand in a ConfigSource still
    // get readable errors, just without the `projects.yaml line X:` prefix.
    const { errors } = validateConfig({
      projects: [
        {
          id: "no-source",
          path: "/tmp",
          priority: 1,
          engineer_command: "echo",
          verification_command: "echo",
          cycle_budget_minutes: 30,
          hands_off: [],
        },
      ],
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).not.toContain("projects.yaml line");
    expect(errors[0]).toContain("hands_off");
    expect(errors[0]).toContain("Hard Rule #5");
  });
});

describe("engineer_provider parsing (gs-270, Phase 7)", () => {
  it("defaults engineer_provider to undefined when omitted (preserves claude default)", async () => {
    const path = writeYaml(
      "no-provider.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].engineer_provider).toBeUndefined();
    expect(yaml.projects[0].engineer_model).toBeUndefined();
    cleanup();
  });

  it("parses engineer_provider: aider when explicitly set", async () => {
    const path = writeYaml(
      "aider.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    engineer_provider: aider
    engineer_model: openrouter/qwen/qwen3-coder-plus
    hands_off:
      - secret/
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].engineer_provider).toBe("aider");
    expect(yaml.projects[0].engineer_model).toBe("openrouter/qwen/qwen3-coder-plus");
    cleanup();
  });

  it("rejects unknown engineer_provider values", async () => {
    const path = writeYaml(
      "bad-provider.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    engineer_provider: cursor
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/engineer_provider/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/cursor/);
    cleanup();
  });

  it("rejects non-string engineer_provider", async () => {
    const path = writeYaml(
      "numeric-provider.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    engineer_provider: 42
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/engineer_provider/);
    cleanup();
  });

  it("rejects empty engineer_model", async () => {
    const path = writeYaml(
      "empty-model.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    engineer_provider: aider
    engineer_model: ""
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/engineer_model/);
    cleanup();
  });
});

describe("creative-work opt-in fields parsing (gs-278)", () => {
  it("defaults all creative-work fields to undefined when omitted", async () => {
    const path = writeYaml(
      "no-creative.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].creative_work_allowed).toBeUndefined();
    expect(yaml.projects[0].creative_work_branch).toBeUndefined();
    expect(yaml.projects[0].creative_work_drafts_dir).toBeUndefined();
    expect(yaml.projects[0].voice_reference_paths).toBeUndefined();
    cleanup();
  });

  it("parses creative_work_allowed: true with branch and drafts dir overrides", async () => {
    const path = writeYaml(
      "creative-ok.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    creative_work_allowed: true
    creative_work_branch: "bot/my-drafts"
    creative_work_drafts_dir: "my-drafts/"
    voice_reference_paths:
      - "docs/voice/pih-1.md"
      - "docs/voice/pih-2.md"
    hands_off:
      - secret/
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].creative_work_allowed).toBe(true);
    expect(yaml.projects[0].creative_work_branch).toBe("bot/my-drafts");
    expect(yaml.projects[0].creative_work_drafts_dir).toBe("my-drafts/");
    expect(yaml.projects[0].voice_reference_paths).toEqual([
      "docs/voice/pih-1.md",
      "docs/voice/pih-2.md",
    ]);
    cleanup();
  });

  it("rejects non-boolean creative_work_allowed", async () => {
    const path = writeYaml(
      "creative-bad-type.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    creative_work_allowed: "yes"
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/creative_work_allowed/);
    cleanup();
  });

  it("rejects empty-string entry in voice_reference_paths", async () => {
    const path = writeYaml(
      "voice-empty.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    voice_reference_paths:
      - "docs/voice/ok.md"
      - ""
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/voice_reference_paths/);
    cleanup();
  });

  it("rejects empty-string creative_work_branch", async () => {
    const path = writeYaml(
      "creative-empty-branch.yaml",
      `
projects:
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    creative_work_branch: ""
    hands_off:
      - secret/
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/creative_work_branch/);
    cleanup();
  });
});

describe("session_budget parsing (gs-297)", () => {
  // Minimal valid project stanza used across these tests. Callers
  // append per-scenario fields (session_budget, etc.) below.
  const BASE_PROJECT = `
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/`;

  it("loads without session_budget — existing behavior preserved", async () => {
    const path = writeYaml(
      "budget-absent.yaml",
      `
projects:${BASE_PROJECT}
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].session_budget).toBeUndefined();
    expect(yaml.dispatcher.session_budget).toBeUndefined();
    cleanup();
  });

  it("accepts fleet-wide max_usd only", async () => {
    const path = writeYaml(
      "budget-fleet-usd.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 5.50
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.dispatcher.session_budget?.max_usd).toBe(5.5);
    expect(yaml.dispatcher.session_budget?.max_tokens).toBeUndefined();
    expect(yaml.dispatcher.session_budget?.max_cycles).toBeUndefined();
    cleanup();
  });

  it("accepts per-project max_cycles without a fleet cap", async () => {
    const path = writeYaml(
      "budget-project-cycles.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_cycles: 10
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].session_budget?.max_cycles).toBe(10);
    expect(yaml.dispatcher.session_budget).toBeUndefined();
    cleanup();
  });

  it("accepts fleet + per-project when project ≤ fleet (same unit)", async () => {
    const path = writeYaml(
      "budget-both-same-unit.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_usd: 2.00
dispatcher:
  session_budget:
    max_usd: 5.00
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.dispatcher.session_budget?.max_usd).toBe(5);
    expect(yaml.projects[0].session_budget?.max_usd).toBe(2);
    cleanup();
  });

  it("accepts per-project value equal to fleet value (boundary)", async () => {
    const path = writeYaml(
      "budget-equal.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_cycles: 10
dispatcher:
  session_budget:
    max_cycles: 10
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].session_budget?.max_cycles).toBe(10);
    cleanup();
  });

  it("preserves explicit enforcement and provider_source values", async () => {
    const path = writeYaml(
      "budget-full.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 3.00
    enforcement: advisory
    provider_source: openrouter
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.dispatcher.session_budget?.enforcement).toBe("advisory");
    expect(yaml.dispatcher.session_budget?.provider_source).toBe("openrouter");
    cleanup();
  });

  it("rejects setting multiple units in the fleet scope", async () => {
    const path = writeYaml(
      "budget-multi-unit-fleet.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 5
    max_tokens: 100000
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/exactly one of/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/dispatcher/);
    cleanup();
  });

  it("rejects setting multiple units in a per-project scope", async () => {
    const path = writeYaml(
      "budget-multi-unit-project.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_cycles: 10
      max_tokens: 50000
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/exactly one of/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"test"/);
    cleanup();
  });

  it("rejects non-positive max_usd", async () => {
    const path = writeYaml(
      "budget-zero-usd.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 0
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /must be a positive finite number/,
    );
    cleanup();
  });

  it("rejects fractional max_tokens", async () => {
    const path = writeYaml(
      "budget-fractional-tokens.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_tokens: 1000.5
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/must be an integer/);
    cleanup();
  });

  it("rejects invalid enforcement value", async () => {
    const path = writeYaml(
      "budget-bad-enforcement.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 5
    enforcement: hard-stop
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/enforcement/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(/hard, advisory/);
    cleanup();
  });

  it("rejects invalid provider_source value", async () => {
    const path = writeYaml(
      "budget-bad-provider.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 5
    provider_source: claude-code
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/provider_source/);
    cleanup();
  });

  it("rejects per-project value that exceeds fleet-wide (same unit)", async () => {
    const path = writeYaml(
      "budget-project-over-fleet.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_usd: 10.00
dispatcher:
  session_budget:
    max_usd: 5.00
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /exceeds fleet-wide value 5/,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/"test"/);
    cleanup();
  });

  it("rejects session_budget given as an array", async () => {
    const path = writeYaml(
      "budget-as-array.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    - max_usd
    - 5
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/must be an object/);
    cleanup();
  });

  it("accepts on_exhausted='skip-project' on a per-project cap (gs-298)", async () => {
    const path = writeYaml(
      "budget-skip-project.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_usd: 2.00
      on_exhausted: skip-project
dispatcher:
  session_budget:
    max_usd: 5.00
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].session_budget?.on_exhausted).toBe("skip-project");
    cleanup();
  });

  it("accepts on_exhausted='break-session' on a per-project cap", async () => {
    const path = writeYaml(
      "budget-break-session.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_cycles: 5
      on_exhausted: break-session
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].session_budget?.on_exhausted).toBe("break-session");
    cleanup();
  });

  it("rejects on_exhausted set on the fleet-wide dispatcher scope", async () => {
    const path = writeYaml(
      "budget-fleet-on-exhausted.yaml",
      `
projects:${BASE_PROJECT}
dispatcher:
  session_budget:
    max_usd: 5.00
    on_exhausted: skip-project
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /on_exhausted.*only valid on per-project/,
    );
    cleanup();
  });

  it("rejects invalid on_exhausted value on a per-project cap", async () => {
    const path = writeYaml(
      "budget-bad-on-exhausted.yaml",
      `
projects:${BASE_PROJECT}
    session_budget:
      max_usd: 2.00
      on_exhausted: skip-everything
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/on_exhausted/);
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /break-session, skip-project/,
    );
    cleanup();
  });
});

describe("missionswarm + journal block validation (gs-306 / gs-311)", () => {
  const BASE = `
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/`;

  it("accepts a minimal missionswarm block", async () => {
    const path = writeYaml(
      "ms-min.yaml",
      `
projects:${BASE}
    missionswarm:
      default_audience: gaming-community
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].missionswarm?.default_audience).toBe("gaming-community");
    expect(yaml.projects[0].missionswarm?.n_agents).toBeUndefined();
    expect(yaml.projects[0].missionswarm?.n_rounds).toBeUndefined();
    cleanup();
  });

  it("accepts a full missionswarm block with overrides", async () => {
    const path = writeYaml(
      "ms-full.yaml",
      `
projects:${BASE}
    missionswarm:
      default_audience: tech-dev
      n_agents: 8
      n_rounds: 3
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].missionswarm?.default_audience).toBe("tech-dev");
    expect(yaml.projects[0].missionswarm?.n_agents).toBe(8);
    expect(yaml.projects[0].missionswarm?.n_rounds).toBe(3);
    cleanup();
  });

  it("rejects missionswarm without default_audience", async () => {
    const path = writeYaml(
      "ms-no-audience.yaml",
      `
projects:${BASE}
    missionswarm:
      n_agents: 4
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/default_audience/);
    cleanup();
  });

  it("rejects non-integer n_agents", async () => {
    const path = writeYaml(
      "ms-bad-agents.yaml",
      `
projects:${BASE}
    missionswarm:
      default_audience: gaming-community
      n_agents: 2.5
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/n_agents/);
    cleanup();
  });

  it("rejects zero or negative n_rounds", async () => {
    const path = writeYaml(
      "ms-bad-rounds.yaml",
      `
projects:${BASE}
    missionswarm:
      default_audience: gaming-community
      n_rounds: 0
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/n_rounds/);
    cleanup();
  });

  it("accepts a minimal journal block", async () => {
    const path = writeYaml(
      "journal-min.yaml",
      `
projects:${BASE}
    journal:
      mission_bullet_root: /home/ray/mission-bullet
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].journal?.mission_bullet_root).toBe(
      "/home/ray/mission-bullet",
    );
    expect(yaml.projects[0].journal?.scan_days).toBeUndefined();
    expect(yaml.projects[0].journal?.reviewer_context).toBeUndefined();
    cleanup();
  });

  it("accepts journal with scan_days + reviewer_context", async () => {
    const path = writeYaml(
      "journal-full.yaml",
      `
projects:${BASE}
    journal:
      mission_bullet_root: /home/ray/mission-bullet
      scan_days: 14
      reviewer_context: true
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].journal?.mission_bullet_root).toBe(
      "/home/ray/mission-bullet",
    );
    expect(yaml.projects[0].journal?.scan_days).toBe(14);
    expect(yaml.projects[0].journal?.reviewer_context).toBe(true);
    cleanup();
  });

  it("rejects journal without mission_bullet_root", async () => {
    const path = writeYaml(
      "journal-no-root.yaml",
      `
projects:${BASE}
    journal:
      scan_days: 7
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(
      /mission_bullet_root/,
    );
    cleanup();
  });

  it("rejects journal scan_days <= 0", async () => {
    const path = writeYaml(
      "journal-bad-days.yaml",
      `
projects:${BASE}
    journal:
      mission_bullet_root: /home/ray/mission-bullet
      scan_days: 0
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/scan_days/);
    cleanup();
  });

  it("rejects journal reviewer_context with non-boolean value", async () => {
    const path = writeYaml(
      "journal-bad-reviewer.yaml",
      `
projects:${BASE}
    journal:
      mission_bullet_root: /home/ray/mission-bullet
      reviewer_context: "yes"
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/reviewer_context/);
    cleanup();
  });

  it("accepts both blocks together", async () => {
    const path = writeYaml(
      "both-blocks.yaml",
      `
projects:${BASE}
    missionswarm:
      default_audience: gaming-community
    journal:
      mission_bullet_root: /home/ray/mission-bullet
      reviewer_context: false
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].missionswarm?.default_audience).toBe("gaming-community");
    expect(yaml.projects[0].journal?.mission_bullet_root).toBe(
      "/home/ray/mission-bullet",
    );
    cleanup();
  });
});

describe("public_facing flag (gs-315)", () => {
  const BASE = `
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/`;

  it("defaults to undefined when public_facing is not set", async () => {
    const path = writeYaml(
      "pf-unset.yaml",
      `
projects:${BASE}
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].public_facing).toBeUndefined();
    cleanup();
  });

  it("accepts public_facing: true", async () => {
    const path = writeYaml(
      "pf-true.yaml",
      `
projects:${BASE}
    public_facing: true
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].public_facing).toBe(true);
    cleanup();
  });

  it("accepts public_facing: false", async () => {
    const path = writeYaml(
      "pf-false.yaml",
      `
projects:${BASE}
    public_facing: false
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].public_facing).toBe(false);
    cleanup();
  });

  it("rejects non-boolean public_facing", async () => {
    const path = writeYaml(
      "pf-bad.yaml",
      `
projects:${BASE}
    public_facing: "yes"
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/public_facing/);
    cleanup();
  });
});

// Phase B+ followup: lifecycle field on ProjectConfig drives the
// lifecycle_transition phase-completion criterion.
describe("lifecycle field", () => {
  const BASE = `
  - id: test
    path: /tmp/test
    priority: 1
    engineer_command: "echo"
    verification_command: "echo"
    cycle_budget_minutes: 30
    hands_off:
      - secret/`;

  it("defaults to undefined when lifecycle is not set", async () => {
    const path = writeYaml(
      "lc-unset.yaml",
      `
projects:${BASE}
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].lifecycle).toBeUndefined();
    cleanup();
  });

  it("accepts lifecycle: dev", async () => {
    const path = writeYaml(
      "lc-dev.yaml",
      `
projects:${BASE}
    lifecycle: dev
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].lifecycle).toBe("dev");
    cleanup();
  });

  it("accepts lifecycle: live", async () => {
    const path = writeYaml(
      "lc-live.yaml",
      `
projects:${BASE}
    lifecycle: live
`,
    );
    const yaml = await loadProjectsYaml(path);
    expect(yaml.projects[0].lifecycle).toBe("live");
    cleanup();
  });

  it("rejects unrecognized lifecycle values (e.g. typo 'alive')", async () => {
    const path = writeYaml(
      "lc-typo.yaml",
      `
projects:${BASE}
    lifecycle: alive
`,
    );
    await expect(loadProjectsYaml(path)).rejects.toThrow(/lifecycle/);
    cleanup();
  });
});

