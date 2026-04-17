// gs-160: proves runSession prints the pre-flight Ollama reachability
// warning when GENERALSTAFF_REVIEWER_PROVIDER=ollama and the server is
// unreachable. Regression guard — gs-158 wiring sits in writeDigest
// which is called from the same session.ts, and a future refactor
// could easily rearrange the pre-flight block into the dead path.
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  "ollama_preflight_test",
);

mock.module("../../src/ollama", () => ({
  checkOllamaReachable: async () => ({
    reachable: false,
    host: "http://localhost:11434",
    error: "connection refused",
  }),
}));

const project: ProjectConfig = {
  id: "test-proj",
  path: TEST_DIR,
  priority: 1,
  engineer_command: "echo ok",
  verification_command: "bun test",
  cycle_budget_minutes: 1,
  work_detection: "tasks_json",
  concurrency_detection: "none",
  branch: "bot/work",
  auto_merge: false,
  hands_off: [],
};

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [project],
    dispatcher: {
      state_dir: join(TEST_DIR, "state"),
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: 1,
      log_dir: "logs",
      digest_dir: "digests",
    },
  }),
}));

mock.module("../../src/cycle", () => ({
  countCommitsAhead: async () => 0,
  executeCycle: async (): Promise<CycleResult> => {
    const now = new Date().toISOString();
    return {
      cycle_id: "c-1",
      project_id: project.id,
      started_at: now,
      ended_at: now,
      cycle_start_sha: "abc",
      cycle_end_sha: "def",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
      final_outcome: "verified",
      reason: "ok",
    };
  },
}));

mock.module("../../src/dispatcher", () => ({
  // Returning null immediately ends the session right after the
  // pre-flight check — we only need the warning to fire once.
  pickNextProject: async () => null,
  shouldChain: async () => ({ chain: false, reason: "no" }),
  estimateSessionPlan: () => ({
    picks: [],
    per_project: [],
    total_cycles: 0,
    budget_used_minutes: 0,
    budget_remaining_minutes: 0,
  }),
}));

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
}));

mock.module("../../src/state", () => ({
  loadFleetState: async () => ({
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
  }),
  saveFleetState: async () => {},
  loadProjectState: async (id: string) => ({
    project_id: id,
    current_cycle_id: null,
    last_cycle_id: null,
    last_cycle_outcome: null,
    last_cycle_at: null,
    cycles_this_session: 0,
  }),
  saveProjectState: async () => {},
  getRootDir: () => TEST_DIR,
}));

mock.module("../../src/audit", () => ({
  appendProgress: async () => {},
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

mock.module("../../src/work_detection", () => ({
  countRemainingWork: async () => 0,
}));

mock.module("../../src/notify", () => ({
  notifySessionEnd: async () => {},
}));

process.env.GENERALSTAFF_REVIEWER_PROVIDER = "ollama";
delete process.env.GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER;

const { runSession } = await import("../../src/session");

async function run() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

  const warns: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  console.log = () => {};

  try {
    await runSession({ budgetMinutes: 10, dryRun: false });
    console.warn = origWarn;
    console.log = origLog;

    const hasPreflight = warns.some((w) => w.includes("Ollama unreachable"));
    const errors: string[] = [];
    if (!hasPreflight) {
      errors.push(
        `expected an 'Ollama unreachable' warn; got ${JSON.stringify(warns)}`,
      );
    }
    const output = {
      pass: errors.length === 0,
      has_preflight_warning: hasPreflight,
      warn_count: warns.length,
      warns,
      errors,
    };
    console.log(JSON.stringify(output));
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.warn = origWarn;
    console.log = origLog;
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
