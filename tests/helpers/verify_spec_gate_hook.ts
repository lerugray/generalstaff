// Isolated helper: runs executeCycle with the spec-anchor gate in a given mode
// and reports whether the engineer was reached and what the cycle said.
// Env: SG_MODE (off|flag|block|none), SG_VERDICT (ON-SPEC|OFF-SPEC|BROKEN).
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

// Outside the repo: the cycle's state auto-commit runs `git -C <root>`, and a
// root inside this checkout would commit the enclosing repo's index.
const TEST_DIR = mkdtempSync(join(tmpdir(), `gs-cycle-spec-gate-${process.env.SG_MODE}-${process.env.SG_VERDICT}-`));
const PROJ_DIR = join(TEST_DIR, "proj");
const MODE = process.env.SG_MODE ?? "off";
const VERDICT = process.env.SG_VERDICT ?? "ON-SPEC";

let engineerCalled = false;
let fetchCalls = 0;
const events: Array<{ event: string; data: Record<string, unknown> }> = [];

mock.module("../../src/engineer", () => ({
  runEngineer: async () => {
    engineerCalled = true;
    return { exitCode: 0, durationSeconds: 1, timedOut: false, logPath: join(TEST_DIR, "engineer.log") };
  },
}));

mock.module("../../src/verification", () => ({
  runVerification: async () => ({
    outcome: "passed",
    exitCode: 0,
    durationSeconds: 1,
    logPath: join(TEST_DIR, "verification.log"),
  }),
}));

mock.module("../../src/reviewer", () => ({
  runQuorumReview: async () => ({ verdict: "verified", response: null, rawResponse: "{}", parseError: null }),
  runReviewer: async () => ({ verdict: "verified", response: null, rawResponse: "{}", parseError: null }),
}));

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
  isBotRunning: () => ({ running: false }),
  isWorkingTreeClean: async () => ({ clean: true }),
  matchesHandsOff: () => null,
  matchesHandsOffSymlinkAware: () => null,
}));

mock.module("../../src/state", () => ({
  ensureCycleDir: () => {
    const dir = join(TEST_DIR, "cycle-out");
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  writeCycleFile: async () => {},
  loadProjectState: async (projectId: string) => ({
    project_id: projectId,
    current_cycle_id: null,
    last_cycle_id: null,
    last_cycle_outcome: null,
    last_cycle_at: null,
    cycles_this_session: 0,
  }),
  saveProjectState: async () => {},
  loadFleetState: async () => ({ version: 1, updated_at: new Date().toISOString(), projects: {} }),
  saveFleetState: async () => {},
  updateProjectFleetState: () => {},
  withFleetStateTransaction: async (mutator: (fleet: unknown) => unknown) =>
    await mutator({ version: 1, updated_at: new Date().toISOString(), projects: {} }),
  getRootDir: () => TEST_DIR,
  botWorktreePath: (project: { path: string }) => join(project.path, ".bot-worktree"),
}));

mock.module("../../src/audit", () => ({
  appendProgress: async (_p: string, event: string, data: Record<string, unknown>) => {
    events.push({ event, data });
  },
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

const checkerReply = () => {
  if (VERDICT === "BROKEN") return "not json";
  return JSON.stringify({
    kind: "build",
    verdict: VERDICT,
    user_can: "do the thing",
    anchor_step: "step 1",
    reason: VERDICT === "ON-SPEC" ? "Matches step 1." : "Builds a rehearsal.",
    owner_words_present: true,
    stand_in: VERDICT === "OFF-SPEC",
  });
};

process.env.OPENROUTER_API_KEY = "test-key";
delete process.env.GENERALSTAFF_SPEC_GATE_OVERRIDE;
delete process.env.GS_CO_SEAT;
globalThis.fetch = (async () => {
  fetchCalls++;
  return new Response(
    JSON.stringify({ choices: [{ message: { content: checkerReply() }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as unknown as typeof fetch;

const { executeCycle } = await import("../../src/cycle");

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "state", "test-proj"), { recursive: true });
    await $`git -C ${PROJ_DIR} init -b master`.quiet();
    await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
    writeFileSync(join(PROJ_DIR, "README.md"), "initial\n");
    writeFileSync(join(PROJ_DIR, "SPEC.md"), "A player plays a match.\n\n## Out of spec\nrehearsals\n");
    writeFileSync(
      join(TEST_DIR, "state", "test-proj", "tasks.json"),
      JSON.stringify([
        {
          id: "t-1",
          title: "Add the match screen",
          status: "pending",
          priority: 1,
          user_facing: true,
          owner_words: "I want to play a match from the start screen",
        },
      ]),
    );
    await $`git -C ${PROJ_DIR} add .`.quiet();
    await $`git -C ${PROJ_DIR} commit -m "initial commit"`.quiet();
    await $`git -C ${PROJ_DIR} checkout -b bot/work`.quiet();
    await $`git -C ${PROJ_DIR} checkout master`.quiet();

    const overrides: Record<string, unknown> = {
      path: PROJ_DIR,
      verification_command: "bun test",
      hands_off: ["CLAUDE.md"],
    };
    if (MODE !== "none") overrides.spec_gate = MODE;
    const project = makeProjectConfig(overrides);
    const config = makeDispatcherConfig({ state_dir: join(TEST_DIR, "state") });

    const result = await executeCycle(project, config);
    console.log(
      JSON.stringify({
        engineer_called: engineerCalled,
        fetch_calls: fetchCalls,
        final_outcome: result.final_outcome,
        reason: result.reason,
        spec_events: events.filter((e) => e.event.startsWith("spec_")).map((e) => ({ event: e.event, verdict: e.data.verdict })),
      }),
    );
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}

run();
