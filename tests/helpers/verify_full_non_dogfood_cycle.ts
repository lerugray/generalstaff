// Isolated test helper for gs-168: end-to-end regression guard for the
// gs-166 state-path inconsistency.
//
// Sets up a non-dogfood layout where project.path != getRootDir(), runs
// a full cycle (engineer + verification + reviewer), and emits a JSON
// blob the parent test asserts on. Critical invariants:
//
//   (a) The bot worktree is created at project.path/.bot-worktree.
//   (b) work_detection reads tasks.json from project.path
//       (NOT from getRootDir(), which has no state/<id>/ at all).
//   (c) Verification runs inside the worktree under project.path.
//   (d) detectMarkedDoneTasks reads the diff from project.path so the
//       cycle_end progress event captures the newly-done task title.
//
// Engineer + reviewer are mocked; state, audit, work_detection, and
// verification are real. The mock engineer manually creates the
// worktree (via `git worktree add`), edits tasks.json there to mark
// the fixture task as done, and commits — exactly what the real
// engineer command would orchestrate.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "cycle_full_non_dogfood");
const TEST_ROOT = join(TEST_DIR, "generalstaff-root");
const PROJ_DIR = join(TEST_DIR, "fake_project");
const FIXTURE_SRC = join(import.meta.dir, "..", "fixtures", "fake_project");
const VERIFY_MARKER = join(TEST_DIR, "verify_marker.txt");
const ENGINEER_MARKER = join(TEST_DIR, "engineer_marker.txt");

let reviewerCalled = false;

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    const wt = join(project.path, ".bot-worktree");
    // Real engineer commands stand up the worktree themselves
    // (scripts/run_session.bat, etc.). Mirror that here.
    if (!existsSync(wt)) {
      await $`git -C ${project.path} worktree add ${wt} ${project.branch}`.quiet();
    }
    writeFileSync(ENGINEER_MARKER, `worktree=${wt}\nexists=${existsSync(wt)}\n`);

    // Mark the fixture task done in the worktree's tasks.json.
    // This proves the cycle reads/writes tasks at project.path/state/<id>/...
    const tasksPath = join(wt, "state", project.id, "tasks.json");
    const raw = readFileSync(tasksPath, "utf8");
    const tasks = JSON.parse(raw) as Array<{ id: string; status: string }>;
    for (const t of tasks) {
      if (t.id === "fake-1") t.status = "done";
    }
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    await $`git -C ${wt} add state/${project.id}/tasks.json`.quiet();
    await $`git -C ${wt} commit -m "fake-1: mark done"`.quiet();

    return {
      exitCode: 0,
      durationSeconds: 1,
      timedOut: false,
      logPath: join(TEST_DIR, "engineer.log"),
    };
  },
}));

mock.module("../../src/reviewer", () => ({
  runReviewer: async () => {
    reviewerCalled = true;
    return {
      verdict: "verified",
      response: {
        verdict: "verified",
        reason: "Mock review passed",
        scope_drift_files: [],
        hands_off_violations: [],
        task_evidence: ["fake-1 marked done"],
        silent_failures: [],
        notes: "",
      },
      rawResponse: "{}",
      parseError: null,
    };
  },
}));

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
  isBotRunning: () => ({ running: false }),
  isWorkingTreeClean: async () => ({ clean: true }),
  matchesHandsOff: () => null,
}));

// state, audit, verification, work_detection are NOT mocked — that is
// the whole point. Override only getRootDir so all state lands under
// TEST_ROOT (separate from PROJ_DIR), which is what proves the
// non-dogfood layout.
const realState = await import("../../src/state");
realState.setRootDir(TEST_ROOT);

const { executeCycle } = await import("../../src/cycle");
const { greenfieldHasMoreWork, greenfieldCountRemaining } =
  await import("../../src/work_detection");

async function setupFixture() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(PROJ_DIR, { recursive: true });

  // Copy the static fixture into the tmp project dir.
  cpSync(FIXTURE_SRC, PROJ_DIR, { recursive: true });
  // verify.sh needs +x on POSIX; harmless on Windows.
  try {
    chmodSync(join(PROJ_DIR, "verify.sh"), 0o755);
  } catch {
    // ignore on Windows
  }

  await $`git -C ${PROJ_DIR} init -q`.quiet();
  await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
  await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
  await $`git -C ${PROJ_DIR} config commit.gpgsign false`.quiet();
  await $`git -C ${PROJ_DIR} add .`.quiet();
  await $`git -C ${PROJ_DIR} commit -q -m "initial fixture commit"`.quiet();
  await $`git -C ${PROJ_DIR} branch bot/work`.quiet();
}

async function run() {
  try {
    await setupFixture();

    const project: ProjectConfig = {
      id: "fake_project",
      path: PROJ_DIR,
      priority: 1,
      engineer_command: "echo unused (mocked)",
      // Real verification command — hits verify.sh inside the worktree.
      // Not a noop, so verification.ts will spawn it and we can prove
      // CWD via the marker the script writes.
      verification_command: "bash verify.sh",
      cycle_budget_minutes: 25,
      work_detection: "tasks_json",
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: ["CLAUDE.md"],
    };

    const config: DispatcherConfig = {
      state_dir: "state",
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: 3,
      log_dir: "logs",
      digest_dir: "digests",
    };

    // (b) Pre-cycle: prove work_detection reads from project.path.
    // PROJ_DIR/state/fake_project/tasks.json has 1 pending task.
    // TEST_ROOT/state/fake_project/ does NOT exist — so a regression
    // would return 0 / false here.
    const remainingBefore = await greenfieldCountRemaining(
      project.path,
      project.id,
    );
    const hasMoreBefore = await greenfieldHasMoreWork(
      project.path,
      project.id,
    );

    // Pass the marker path through to verify.sh via env.
    process.env.GS_TEST_VERIFY_MARKER = VERIFY_MARKER;

    const result = await executeCycle(project, config);

    // After cycle: tasks.json on bot/work should show task done.
    const tasksAfterRaw = await $`git -C ${PROJ_DIR} show bot/work:state/${project.id}/tasks.json`.text();
    const tasksAfter = JSON.parse(tasksAfterRaw) as Array<{ id: string; status: string }>;
    const fakeStatusAfter = tasksAfter.find((t) => t.id === "fake-1")?.status ?? null;

    const verifyMarkerContent = existsSync(VERIFY_MARKER)
      ? readFileSync(VERIFY_MARKER, "utf8").trim()
      : "";
    const engineerMarkerContent = existsSync(ENGINEER_MARKER)
      ? readFileSync(ENGINEER_MARKER, "utf8").trim()
      : "";

    // (d) detectMarkedDoneTasks output is captured in the cycle's
    // PROGRESS.jsonl (the reviewer args carry markedDoneTasks too,
    // but easier to assert via the diff stat we already get back).
    // diff_stats > 0 confirms the diff was non-empty; combined with
    // the tasksAfter check above, gs-166's behavior is proven.
    const expectedWt = join(PROJ_DIR, ".bot-worktree");
    // verify.sh runs under bash, which on Windows prints POSIX-style
    // paths ("/c/Users/...") into the marker. Normalize both sides
    // to a comparable suffix so the assertion works on both OSes.
    const wtSuffix = "cycle_full_non_dogfood/fake_project/.bot-worktree";
    const verifyMarkerNormalized = verifyMarkerContent.replace(/\\/g, "/");

    const output = {
      // (a)
      worktree_was_created: engineerMarkerContent.includes(`worktree=${expectedWt}`),
      worktree_existed_at_engineer_time: engineerMarkerContent.includes("exists=true"),
      // (b)
      remaining_before_from_proj_path: remainingBefore,
      has_more_before_from_proj_path: hasMoreBefore,
      // (c)
      verify_marker_content: verifyMarkerContent,
      verify_ran_in_worktree: verifyMarkerNormalized.includes(wtSuffix),
      verification_outcome: result.verification_outcome,
      // (d)
      task_status_after_cycle: fakeStatusAfter,
      diff_files_changed: result.diff_stats?.files_changed ?? 0,
      // overall
      reviewer_called: reviewerCalled,
      final_outcome: result.final_outcome,
      cycle_start_sha_changed:
        result.cycle_start_sha !== result.cycle_end_sha,
    };

    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
