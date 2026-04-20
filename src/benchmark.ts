// GeneralStaff — engineer benchmark harness (gs-271, Phase 7)
//
// Replays N previously-shipped tasks against an alternative engineer
// provider (aider+OpenRouter, opencode, etc.) in isolated temp clones
// so we can measure verified-rate, duration, and diff characteristics
// before flipping any managed project's default.
//
// Isolation strategy: for each task we `git clone --shared
// --no-hardlinks` the managed project into a temp dir, check out the
// commit immediately before the task landed, create a bot/work branch
// there, inject a single-task tasks.json so the engineer picks it
// deterministically, then spawn the engineer via
// resolveEngineerCommand. The engineer creates its own .bot-worktree
// *inside* our temp clone (git handles nested worktrees fine). After
// the engineer exits we measure diff stats between our injection
// commit and the final bot/work tip, then run the project's
// verification_command in the engineer's worktree to decide the
// verdict. The temp clone is deleted on exit.
//
// Why a temp clone and not the real bot/work branch? Running the
// benchmark against the live project would contend with its actual
// bot cycles, leave benchmark commits on bot/work, and require
// nontrivial reset logic on failure. The disposable clone has zero
// blast radius and parallelizes trivially if we ever want that.

import { spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import { resolveEngineerCommand } from "./engineer";
import { DEFAULT_AIDER_MODEL } from "./engineer_providers/aider";
import type {
  EngineerProvider,
  ProjectConfig,
  GreenfieldTask,
} from "./types";

// --- Public types ---

export type BenchmarkVerdict =
  | "verified"
  | "verification_failed"
  | "empty_diff"
  | "engineer_failed"
  | "engineer_timeout"
  | "setup_failed";

export interface BenchmarkTaskResult {
  task_id: string;
  pre_task_sha: string | null;
  verdict: BenchmarkVerdict;
  engineer_exit_code: number | null;
  engineer_duration_seconds: number;
  engineer_timed_out: boolean;
  verification_exit_code: number | null;
  verification_duration_seconds: number;
  diff_files_changed: number;
  diff_insertions: number;
  diff_deletions: number;
  error?: string;
  worktree_path?: string;
}

export interface BenchmarkSummary {
  total: number;
  verified: number;
  verification_failed: number;
  engineer_failed: number;
  engineer_timeout: number;
  empty_diff: number;
  setup_failed: number;
  verified_rate: number;
  mean_engineer_duration_seconds: number;
  mean_verification_duration_seconds: number;
}

export interface BenchmarkReport {
  started_at: string;
  ended_at: string;
  project_id: string;
  provider: EngineerProvider;
  engineer_model: string;
  tasks: BenchmarkTaskResult[];
  summary: BenchmarkSummary;
}

export interface BenchmarkOptions {
  projectId: string;
  taskIds: string[];
  provider: EngineerProvider;
  engineerModel?: string;
  outputPath?: string;
  dryRun?: boolean;
  // Cap each task's engineer subprocess. Defaults to
  // project.cycle_budget_minutes + 5; overrideable for faster
  // smoke tests.
  taskTimeoutSeconds?: number;
  // Preserve temp clones on exit so the operator can inspect what
  // the engineer actually produced. Useful during the first
  // benchmark smoke — a clean verdict of "empty_diff" tells you
  // the engineer didn't commit, but not why; leaving the clone
  // lets you look at its .bot-worktree for intermediate state.
  keepWorktree?: boolean;
}

// --- Pure helpers (trivially testable) ---

// Given engineer exit state, diff shape, and verification exit code,
// decide the benchmark verdict. Pure function — no I/O. The ordering
// matters: engineer failure short-circuits before diff/verification
// because a failed spawn means we can't trust downstream signals.
export function decideBenchmarkVerdict(input: {
  engineerExitCode: number | null;
  engineerTimedOut: boolean;
  diffFilesChanged: number;
  verificationExitCode: number | null;
}): BenchmarkVerdict {
  if (input.engineerTimedOut) return "engineer_timeout";
  if (input.engineerExitCode === null || input.engineerExitCode !== 0) {
    return "engineer_failed";
  }
  if (input.diffFilesChanged === 0) return "empty_diff";
  if (input.verificationExitCode === null || input.verificationExitCode !== 0) {
    return "verification_failed";
  }
  return "verified";
}

// Aggregate per-task results into a summary — counts, verified rate,
// mean durations. Pure function over the task rows.
export function summarizeBenchmark(
  tasks: BenchmarkTaskResult[],
): BenchmarkSummary {
  const counts: Record<BenchmarkVerdict, number> = {
    verified: 0,
    verification_failed: 0,
    engineer_failed: 0,
    engineer_timeout: 0,
    empty_diff: 0,
    setup_failed: 0,
  };
  for (const t of tasks) counts[t.verdict] += 1;

  const total = tasks.length;
  const sumEngDur = tasks.reduce((s, t) => s + t.engineer_duration_seconds, 0);
  const sumVerDur = tasks.reduce(
    (s, t) => s + t.verification_duration_seconds,
    0,
  );

  return {
    total,
    verified: counts.verified,
    verification_failed: counts.verification_failed,
    engineer_failed: counts.engineer_failed,
    engineer_timeout: counts.engineer_timeout,
    empty_diff: counts.empty_diff,
    setup_failed: counts.setup_failed,
    verified_rate: total === 0 ? 0 : counts.verified / total,
    mean_engineer_duration_seconds: total === 0 ? 0 : sumEngDur / total,
    mean_verification_duration_seconds: total === 0 ? 0 : sumVerDur / total,
  };
}

// --- Git helpers (thin wrappers over Bun $) ---

// Find the commit whose subject line begins with "<taskId>:" and
// return its parent SHA (= the pre-task state). Falls back to null
// if no matching commit is found or git errors out.
//
// The anchored regex handles both "gamr-020: ..." and
// "gs-270: ..." shapes without false-matching "foo gamr-020 bar".
export async function findPreTaskSha(
  projectPath: string,
  taskId: string,
): Promise<string | null> {
  try {
    const result = await $`git -C ${projectPath} log --all --format=%H --grep=^${taskId}: --extended-regexp -n 1`
      .quiet()
      .text();
    const completionSha = result.trim();
    if (!completionSha) return null;
    const parentResult = await $`git -C ${projectPath} rev-parse ${completionSha}^`
      .quiet()
      .text();
    const parent = parentResult.trim();
    return parent || null;
  } catch {
    return null;
  }
}

// Load tasks.json as it existed at a specific commit via `git show`.
// Returns [] if the file didn't exist at that commit or the JSON is
// malformed — caller treats empty as setup failure.
export async function loadTasksJsonAtSha(
  projectPath: string,
  projectId: string,
  sha: string,
): Promise<GreenfieldTask[]> {
  const rel = `state/${projectId}/tasks.json`;
  try {
    const text = await $`git -C ${projectPath} show ${sha}:${rel}`
      .quiet()
      .text();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Compute diff stats between two refs. Parses `git diff --numstat`
// output — each line is "<ins>\t<del>\t<path>", summed across all
// files. Binary files show "-\t-" which we count as 0 for both.
async function getDiffNumstat(
  repoPath: string,
  fromSha: string,
  toSha: string,
): Promise<{ files: number; insertions: number; deletions: number }> {
  try {
    const text = await $`git -C ${repoPath} diff --numstat ${fromSha} ${toSha}`
      .quiet()
      .text();
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [ins, del] = line.split("\t");
      files += 1;
      if (ins !== "-") insertions += parseInt(ins, 10) || 0;
      if (del !== "-") deletions += parseInt(del, 10) || 0;
    }
    return { files, insertions, deletions };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

async function getHeadSha(repoPath: string, ref: string = "HEAD"): Promise<string> {
  try {
    const text = await $`git -C ${repoPath} rev-parse ${ref}`.quiet().text();
    return text.trim();
  } catch {
    return "";
  }
}

// --- Subprocess helper ---

interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  durationSeconds: number;
}

async function spawnBashCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  logPath?: string,
): Promise<SpawnResult> {
  const startTime = Date.now();
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Route stdout/stderr to an optional log file so benchmark
    // failures are debuggable. Without this the harness silently
    // drops the engineer's output, which makes any real-world
    // aider issue invisible. The log sink is per-task so
    // concurrent calls don't interleave.
    const logStream = logPath
      ? createWriteStream(logPath, { flags: "w" })
      : null;
    if (logStream) {
      logStream.write(`=== spawnBashCommand ===\n`);
      logStream.write(`CWD: ${cwd}\n`);
      logStream.write(`Timeout: ${Math.round(timeoutMs / 1000)}s\n`);
      logStream.write(`Command (first 500 chars):\n`);
      logStream.write(command.slice(0, 500) + (command.length > 500 ? "\n...(truncated)\n" : "\n"));
      logStream.write(`${"=".repeat(40)}\n`);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (logStream) logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (logStream) logStream.write(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (logStream) {
        logStream.write(`\n=== exit ${code} (timedOut=${timedOut}) ===\n`);
        logStream.end();
      }
      resolve({
        exitCode: code,
        timedOut,
        durationSeconds: (Date.now() - startTime) / 1000,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (logStream) {
        logStream.write(`\n=== spawn error: ${err.message} ===\n`);
        logStream.end();
      }
      resolve({
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startTime) / 1000,
      });
    });
  });
}

// --- Setup / teardown ---

// Create a disposable clone of the managed project at the target
// pre-task SHA, then branch bot/work off it. The --shared flag means
// git objects are referenced from the origin repo (zero duplication),
// so this is fast and cheap even on large histories.
async function setupBenchmarkClone(
  project: ProjectConfig,
  preSha: string,
): Promise<string> {
  const tempDir = join(
    tmpdir(),
    `gs-benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  // Parent dir must exist for bun $ clone to work on every platform.
  mkdirSync(tempDir, { recursive: true });
  // Remove the empty dir we just made — git clone requires the
  // target directory to be empty or non-existent and mkdirSync
  // on Windows sometimes leaves metadata that trips git.
  await rm(tempDir, { recursive: true, force: true });

  await $`git clone --shared --no-hardlinks --no-checkout ${project.path} ${tempDir}`.quiet();
  await $`git -C ${tempDir} checkout ${preSha}`.quiet();
  // Point bot/work at the pre-task SHA but do NOT check it out here —
  // the engineer's generated command will `git worktree add` on
  // project.branch, which fails if that branch is already checked out
  // in any working tree (git prevents two trees on the same branch).
  // We'll temporarily switch to bot/work to make the injection
  // commit, then switch back to detached HEAD in
  // injectSingleTaskQueue before returning. -f forces bot/work to
  // the pre-task SHA even if the clone brought over a more recent
  // bot/work ref from origin.
  await $`git -C ${tempDir} branch -f ${project.branch} HEAD`.quiet();
  return tempDir;
}

// Overwrite tasks.json in the clone so only the target task is
// pending. The engineer's autonomous pick rules ("lowest priority,
// lowest id") then select it deterministically regardless of what
// the original queue looked like. Commit the injection so the
// engineer's worktree (created on bot/work) sees it.
async function injectSingleTaskQueue(
  clonePath: string,
  projectId: string,
  branch: string,
  task: GreenfieldTask,
): Promise<string> {
  // Switch to the bot branch to make the injection commit, then
  // switch back to a detached HEAD on that same commit so git will
  // let the engineer's `worktree add <branch>` succeed (worktree add
  // rejects a branch that's currently checked out elsewhere).
  await $`git -C ${clonePath} checkout ${branch}`.quiet();

  const tasksPath = join(clonePath, "state", projectId, "tasks.json");
  mkdirSync(join(clonePath, "state", projectId), { recursive: true });
  const singleTaskQueue: GreenfieldTask[] = [
    { ...task, status: "pending" },
  ];
  writeFileSync(
    tasksPath,
    JSON.stringify(singleTaskQueue, null, 2) + "\n",
    "utf8",
  );
  await $`git -C ${clonePath} add state/${projectId}/tasks.json`.quiet();
  await $`git -C ${clonePath} commit --no-verify -m ${"benchmark: inject single-task queue (" + task.id + ")"}`.quiet();
  const injectionSha = (await $`git -C ${clonePath} rev-parse HEAD`.quiet().text()).trim();

  // Detach HEAD so the bot branch isn't checked out here — otherwise
  // aider's `worktree add <branch>` fails with "already used by worktree".
  await $`git -C ${clonePath} checkout --detach HEAD`.quiet();
  return injectionSha;
}

async function teardownBenchmarkClone(clonePath: string): Promise<void> {
  try {
    // Best-effort: `git worktree remove` on any nested worktree the
    // engineer created, then rm the whole clone.
    const wt = join(clonePath, ".bot-worktree");
    if (existsSync(wt)) {
      await $`git -C ${clonePath} worktree remove ${wt} --force`
        .quiet()
        .nothrow();
    }
    await rm(clonePath, { recursive: true, force: true });
  } catch {
    /* cleanup is best-effort — leftover tmp dirs are noise, not fatal */
  }
}

// --- Per-task runner ---

async function runOneBenchmarkTask(
  project: ProjectConfig,
  taskId: string,
  opts: BenchmarkOptions,
): Promise<BenchmarkTaskResult> {
  const zeroResult: BenchmarkTaskResult = {
    task_id: taskId,
    pre_task_sha: null,
    verdict: "setup_failed",
    engineer_exit_code: null,
    engineer_duration_seconds: 0,
    engineer_timed_out: false,
    verification_exit_code: null,
    verification_duration_seconds: 0,
    diff_files_changed: 0,
    diff_insertions: 0,
    diff_deletions: 0,
  };

  if (opts.dryRun) {
    return { ...zeroResult, verdict: "setup_failed", error: "dry run — no setup performed" };
  }

  const preSha = await findPreTaskSha(project.path, taskId);
  if (!preSha) {
    return {
      ...zeroResult,
      error: `could not resolve pre-task SHA for ${taskId} (no commit subject starting with "${taskId}:")`,
    };
  }

  const tasksAtSha = await loadTasksJsonAtSha(project.path, project.id, preSha);
  const targetTask = tasksAtSha.find((t) => t.id === taskId);
  if (!targetTask) {
    return {
      ...zeroResult,
      pre_task_sha: preSha,
      error: `task ${taskId} not present in state/${project.id}/tasks.json at pre-task SHA ${preSha.slice(0, 8)}`,
    };
  }

  let clonePath = "";
  try {
    clonePath = await setupBenchmarkClone(project, preSha);
    const injectionSha = await injectSingleTaskQueue(
      clonePath,
      project.id,
      project.branch,
      targetTask,
    );

    const synthProject: ProjectConfig = {
      ...project,
      path: clonePath,
      engineer_provider: opts.provider,
      engineer_model: opts.engineerModel,
    };
    const { command } = resolveEngineerCommand(synthProject);

    const timeoutMs =
      (opts.taskTimeoutSeconds ?? (project.cycle_budget_minutes + 5) * 60) *
      1000;
    const engLogPath = opts.outputPath
      ? opts.outputPath.replace(/\.json$/, "") + `.${taskId}.engineer.log`
      : undefined;
    const engResult = await spawnBashCommand(command, clonePath, timeoutMs, engLogPath);

    // Engineer runs in .bot-worktree (aider creates it). Measure diff
    // from injection commit to final bot/work tip. If the engineer
    // never committed, bot/work still points at injectionSha and
    // diff is empty — which the verdict logic correctly labels
    // empty_diff rather than verification_failed.
    const endSha = await getHeadSha(clonePath, project.branch);
    const diff = await getDiffNumstat(clonePath, injectionSha, endSha || injectionSha);

    // Verification runs in the engineer's worktree if it exists,
    // else in the clone root. Same pattern cycle.ts uses.
    const verCwd = existsSync(join(clonePath, ".bot-worktree"))
      ? join(clonePath, ".bot-worktree")
      : clonePath;
    const verLogPath = opts.outputPath
      ? opts.outputPath.replace(/\.json$/, "") + `.${taskId}.verification.log`
      : undefined;
    const verResult = await spawnBashCommand(
      project.verification_command,
      verCwd,
      5 * 60 * 1000,
      verLogPath,
    );

    const verdict = decideBenchmarkVerdict({
      engineerExitCode: engResult.exitCode,
      engineerTimedOut: engResult.timedOut,
      diffFilesChanged: diff.files,
      verificationExitCode: verResult.exitCode,
    });

    return {
      task_id: taskId,
      pre_task_sha: preSha,
      verdict,
      engineer_exit_code: engResult.exitCode,
      engineer_duration_seconds: Number(engResult.durationSeconds.toFixed(2)),
      engineer_timed_out: engResult.timedOut,
      verification_exit_code: verResult.exitCode,
      verification_duration_seconds: Number(
        verResult.durationSeconds.toFixed(2),
      ),
      diff_files_changed: diff.files,
      diff_insertions: diff.insertions,
      diff_deletions: diff.deletions,
      worktree_path: clonePath,
    };
  } catch (err) {
    return {
      ...zeroResult,
      pre_task_sha: preSha,
      error: err instanceof Error ? err.message : String(err),
      worktree_path: clonePath || undefined,
    };
  } finally {
    if (clonePath && !opts.keepWorktree) {
      await teardownBenchmarkClone(clonePath);
    } else if (clonePath && opts.keepWorktree) {
      console.log(`[benchmark] keeping worktree: ${clonePath}`);
    }
  }
}

// --- Public entry point ---

export async function runEngineerBenchmark(
  project: ProjectConfig,
  opts: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const started_at = new Date().toISOString();
  const results: BenchmarkTaskResult[] = [];
  for (const taskId of opts.taskIds) {
    const result = await runOneBenchmarkTask(project, taskId, opts);
    results.push(result);
  }
  const ended_at = new Date().toISOString();

  const report: BenchmarkReport = {
    started_at,
    ended_at,
    project_id: project.id,
    provider: opts.provider,
    engineer_model:
      opts.engineerModel ??
      (opts.provider === "aider" ? DEFAULT_AIDER_MODEL : "(provider default)"),
    tasks: results,
    summary: summarizeBenchmark(results),
  };

  if (opts.outputPath) {
    writeFileSync(
      opts.outputPath,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
  }

  return report;
}
