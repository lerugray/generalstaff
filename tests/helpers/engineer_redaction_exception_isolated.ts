import { describe, expect, it, mock } from "bun:test";
import { runEngineer } from "../../src/engineer";
import { setRootDir } from "../../src/state";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync } from "fs";
import type { ProjectConfig } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "engineer_redaction_exception_isolated_test");

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test-proj",
    path: TEST_DIR,
    priority: 1,
    engineer_command: "echo 'doing work'",
    verification_command: "test 1 -eq 1",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["CLAUDE.md"],
    ...overrides,
  };
}

mock.module("../../src/secrets", () => ({
  redactSecretsSafe: () => {
    throw new Error("injected scanner failure");
  },
}));

describe("engineer secret redaction failure path (isolated)", () => {
  it("does not fail the cycle when the secret scanner throws", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    setRootDir(TEST_DIR);

    try {
      const project = makeProject({ engineer_command: "echo 'keep going'" });
      const result = await runEngineer(project, "cycle-redact-fail");

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);

      const log = readFileSync(result.logPath, "utf8");
      expect(log).toContain("secret redaction failed");
      expect(log).toContain("keep going");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});
