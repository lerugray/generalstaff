import { describe, expect, it } from "bun:test";
import { loadProjectsYaml } from "../src/projects";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

const FIXTURES = join(import.meta.dir, "fixtures");

function writeYaml(name: string, content: string): string {
  const dir = join(FIXTURES, "yaml");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function cleanup() {
  rmSync(FIXTURES, { recursive: true, force: true });
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

  it("rejects empty hands_off", async () => {
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
    await expect(loadProjectsYaml(path)).rejects.toThrow("hands_off");
    cleanup();
  });

  it("rejects missing engineer_command", async () => {
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
    await expect(loadProjectsYaml(path)).rejects.toThrow("engineer_command");
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

  it("rejects invalid work_detection mode", async () => {
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
    await expect(loadProjectsYaml(path)).rejects.toThrow("work_detection");
    cleanup();
  });
});
