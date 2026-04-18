import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(
  args: string[],
  cwd?: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env },
    cwd,
  });
  if (proc.stdin) {
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// gs-175: register now reads tasks.json from the TARGET project
// (aligned with work_detection.ts, bootstrap.ts), not GeneralStaff's
// root. Seed inside projectDir, not rootDir.
function seedStateDir(projectDir: string, projectId: string): void {
  const stateDir = join(projectDir, "state", projectId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "tasks.json"),
    JSON.stringify(
      [{ id: `${projectId}-001`, title: "seed", status: "pending", priority: 1 }],
      null,
      2,
    ) + "\n",
  );
}

function seedProjectDir(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "hands_off.yaml"),
    `patterns:
  - "CLAUDE.md"
  - "node_modules/"
`,
  );
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "myproj",
        version: "0.0.1",
        devDependencies: { "@types/bun": "latest" },
      },
      null,
      2,
    ) + "\n",
  );
}

describe("register command", () => {
  const TEST_DIR = join(import.meta.dir, "fixtures", "register_test");
  const PROJECT_DIR = join(TEST_DIR, "myproj");

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    seedProjectDir(PROJECT_DIR);
    seedStateDir(PROJECT_DIR, "myproj");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("adds a new project to projects.yaml with --yes", async () => {
    const result = await runCli(
      ["register", "myproj", `--path=${PROJECT_DIR}`, "--yes"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);

    const projectsPath = join(TEST_DIR, "projects.yaml");
    expect(existsSync(projectsPath)).toBe(true);
    const content = readFileSync(projectsPath, "utf8");
    expect(content).toContain("projects:");
    expect(content).toContain("id: myproj");
    expect(content).toContain("priority: 2");
    expect(content).toContain("hands_off:");
    expect(content).toContain('"CLAUDE.md"');
    expect(content).toContain('"node_modules/"');
    expect(content).toContain("bun test");
  });

  it("rejects a duplicate project id", async () => {
    const first = await runCli(
      ["register", "myproj", `--path=${PROJECT_DIR}`, "--yes"],
      TEST_DIR,
    );
    expect(first.exitCode).toBe(0);

    const second = await runCli(
      ["register", "myproj", `--path=${PROJECT_DIR}`, "--yes"],
      TEST_DIR,
    );
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already registered");

    const content = readFileSync(join(TEST_DIR, "projects.yaml"), "utf8");
    const occurrences = content.match(/id: myproj/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("rejects without confirmation (user answers 'n')", async () => {
    const result = await runCli(
      ["register", "myproj", `--path=${PROJECT_DIR}`],
      TEST_DIR,
      "n\n",
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(TEST_DIR, "projects.yaml"))).toBe(false);
  });

  it("rejects if state/<id>/ doesn't exist (points at bootstrap + proposal dir)", async () => {
    const result = await runCli(
      ["register", "other", `--path=${PROJECT_DIR}`, "--yes"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bootstrap");
    expect(result.stderr).toContain("state/other/tasks.json");
  });

  it("is listed in --help output with the hands-off exception note", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("register");
    expect(result.stdout).toContain("hands_off");
  });

  // gs-175 regression: for non-dogfood projects (projectPath != cwd),
  // register must read tasks.json from the TARGET project, not from
  // GeneralStaff's root. Seed only in the root and verify rejection.
  it("rejects when tasks.json is only in GeneralStaff root (not in target project)", async () => {
    const OTHER_PROJECT = join(TEST_DIR, "otherproj");
    seedProjectDir(OTHER_PROJECT);
    const rootStateDir = join(TEST_DIR, "state", "otherproj");
    mkdirSync(rootStateDir, { recursive: true });
    writeFileSync(
      join(rootStateDir, "tasks.json"),
      JSON.stringify([], null, 2) + "\n",
    );

    const result = await runCli(
      ["register", "otherproj", `--path=${OTHER_PROJECT}`, "--yes"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("state/otherproj/tasks.json not found");
    // Error should point at the target project path, not GeneralStaff's.
    expect(result.stderr).toContain(OTHER_PROJECT);
  });

  it("inserts new project above a `dispatcher:` section when present", async () => {
    writeFileSync(
      join(TEST_DIR, "projects.yaml"),
      `projects:
  - id: other
    path: /tmp/other
    priority: 1
    engineer_command: "echo"
    verification_command: "true"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    concurrency_detection: none
    branch: bot/work
    auto_merge: false
    hands_off:
      - "README.md"

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
    const result = await runCli(
      ["register", "myproj", `--path=${PROJECT_DIR}`, "--yes"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);
    const content = readFileSync(join(TEST_DIR, "projects.yaml"), "utf8");
    expect(content).toContain("id: other");
    expect(content).toContain("id: myproj");
    const myprojIdx = content.indexOf("id: myproj");
    const dispatcherIdx = content.indexOf("dispatcher:");
    expect(myprojIdx).toBeGreaterThan(0);
    expect(dispatcherIdx).toBeGreaterThan(myprojIdx);
  });
});
