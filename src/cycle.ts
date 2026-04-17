// GeneralStaff — cycle module (build step 12)
// Orchestrate: engineer → verification → reviewer → audit log

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { $ } from "bun";
import {
  ensureCycleDir,
  writeCycleFile,
  loadProjectState,
  saveProjectState,
  loadFleetState,
  saveFleetState,
  updateProjectFleetState,
  getRootDir,
} from "./state";
import { appendProgress } from "./audit";
import { runEngineer } from "./engineer";
import { runVerification } from "./verification";
import { runReviewer } from "./reviewer";
import { isStopFilePresent, isWorkingTreeClean, isBotRunning, matchesHandsOff } from "./safety";
import { loadProjectsYaml, getProject, ProjectNotFoundError } from "./projects";
import type {
  ProjectConfig,
  DispatcherConfig,
  CycleResult,
  CycleOutcome,
  SingleCycleOptions,
  DiffStats,
} from "./types";

function generateCycleId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}_${rand}`;
}

async function getGitSha(
  projectPath: string,
  ref: string = "HEAD",
): Promise<string> {
  try {
    const result = await $`git -C ${projectPath} rev-parse ${ref}`.text();
    return result.trim();
  } catch {
    return "unknown";
  }
}

// Count commits reachable from `branch` but not from `base`.
// Returns 0 if branch missing, base missing, or branch fully merged into base.
export async function countCommitsAhead(
  projectPath: string,
  branch: string,
  base: string,
): Promise<number> {
  try {
    const out = await $`git -C ${projectPath} rev-list --count ${base}..${branch}`
      .quiet()
      .text();
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function worktreePath(project: ProjectConfig): string {
  return join(project.path, ".bot-worktree");
}

// Build the "bot branch has unmerged commits ahead of HEAD" error reason.
// Resolves project.path to an absolute path so the suggested `git -C <path>`
// command works regardless of the user's current working directory.
export function formatUnmergedBranchError(
  project: ProjectConfig,
  branch: string,
  unmerged: number,
): string {
  const resolvedPath = resolvePath(project.path);
  return (
    `${branch} has ${unmerged} unmerged commit(s) ahead of HEAD; ` +
    `resetting would destroy that work. Merge manually ` +
    `(git -C ${resolvedPath} merge --no-ff ${branch}) or set ` +
    `auto_merge: true in projects.yaml for project ${project.id}.`
  );
}

async function autoCommitState(
  project: ProjectConfig,
  cycleId: string,
  outcome: CycleOutcome,
): Promise<void> {
  try {
    const root = getRootDir();
    // Stage state artifacts — use pathspec that won't error on ignored/missing paths
    await $`git -C ${root} add --ignore-errors state/`.quiet().nothrow();
    // Check if there's anything staged
    const hasStagedChanges = await $`git -C ${root} diff --cached --quiet`
      .quiet()
      .nothrow()
      .then((r) => r.exitCode !== 0);
    if (hasStagedChanges) {
      await $`git -C ${root} commit -m ${"state: cycle " + cycleId.slice(0, 12) + " — " + outcome}`.quiet();
    }
  } catch {
    // Non-fatal — state commit is convenience, not critical
    console.log("Warning: could not auto-commit state artifacts");
  }
}

async function cleanupWorktree(project: ProjectConfig): Promise<void> {
  const wt = worktreePath(project);
  if (existsSync(wt)) {
    try {
      await $`git -C ${project.path} worktree remove ${wt} --force`.quiet();
    } catch {
      // git worktree remove may fail if already pruned
    }
    // Belt-and-suspenders: rm the directory if git left it behind
    // (happens when worktree was already detached but dir remains)
    if (existsSync(wt)) {
      const { rmSync } = require("fs");
      try { rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// Pre-cycle cleanup. If the prior cycle was killed (engineer timeout,
// STOP file mid-run, manual taskkill, host crash), cleanupWorktree may
// not have fired — leaving .bot-worktree behind. The next `git worktree
// add` then fails. This runs defensively before engineer spawn, removes
// any stale worktree, and surfaces a warning (but does not crash) when
// removal fails — e.g. another process holds an open handle on Windows.
export async function preflightCleanupWorktree(
  project: ProjectConfig,
  rmFn?: (path: string) => void,
): Promise<{ wasStale: boolean; removed: boolean; warning?: string }> {
  const wt = worktreePath(project);
  if (!existsSync(wt)) {
    return { wasStale: false, removed: false };
  }
  try {
    await $`git -C ${project.path} worktree remove ${wt} --force`.quiet();
  } catch {
    // not tracked or already pruned — fall through to fs rm
  }
  if (!existsSync(wt)) {
    return { wasStale: true, removed: true };
  }
  const rm = rmFn ?? ((p: string) => {
    const { rmSync } = require("fs");
    rmSync(p, { recursive: true, force: true });
  });
  try {
    rm(wt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      wasStale: true,
      removed: false,
      warning: `stale ${wt} could not be removed (likely locked by another process): ${msg}`,
    };
  }
  return { wasStale: true, removed: !existsSync(wt) };
}

async function getGitDiff(
  projectPath: string,
  startSha: string,
  endSha: string,
): Promise<string> {
  if (startSha === "unknown" || endSha === "unknown") return "";
  if (startSha === endSha) return "";
  try {
    const result =
      await $`git -C ${projectPath} diff ${startSha} ${endSha}`.text();
    return result;
  } catch {
    return "";
  }
}

async function getGitDiffStat(
  projectPath: string,
  startSha: string,
  endSha: string,
): Promise<string> {
  if (startSha === "unknown" || endSha === "unknown") return "";
  if (startSha === endSha) return "(no changes)";
  try {
    const result =
      await $`git -C ${projectPath} diff --stat ${startSha} ${endSha}`.text();
    return result.trim();
  } catch {
    return "";
  }
}

export function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) {
      files.push(match[1]);
    }
  }
  return files;
}

export function diffSummaryStats(diff: string): DiffStats {
  if (!diff) {
    return { files_changed: 0, insertions: 0, deletions: 0 };
  }
  let insertions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      files.add(fileMatch[1]);
      continue;
    }
    // Skip file headers; count only hunk body lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return {
    files_changed: files.size,
    insertions,
    deletions,
  };
}

async function detectMarkedDoneTasks(
  project: ProjectConfig,
  startSha: string,
  endSha: string,
): Promise<string> {
  if (startSha === endSha) return "(No changes detected)";

  if (project.work_detection === "catalogdna_bot_tasks") {
    // Check for newly checked items in bot_tasks.md
    try {
      const diff =
        await $`git -C ${project.path} diff ${startSha} ${endSha} -- bot_tasks.md`.text();
      if (!diff.trim()) return "(bot_tasks.md not modified)";

      // Extract lines that went from [ ] to [x]
      const addedChecked = diff
        .split("\n")
        .filter((l) => l.startsWith("+") && /^\+- \[x\]/.test(l))
        .map((l) => l.slice(1).trim());

      if (addedChecked.length === 0) return "(No tasks newly marked done)";
      return addedChecked.join("\n");
    } catch {
      return "(Could not read bot_tasks.md diff)";
    }
  }

  if (project.work_detection === "tasks_json") {
    // Check tasks.json diff for status changes to "done"
    try {
      const diff =
        await $`git -C ${project.path} diff ${startSha} ${endSha} -- state/${project.id}/tasks.json`.text();
      if (!diff.trim()) return "(tasks.json not modified)";

      // Extract lines where status changed to "done"
      const doneLines = diff
        .split("\n")
        .filter((l) => l.startsWith("+") && /"status":\s*"done"/.test(l));

      if (doneLines.length === 0) return "(No tasks newly marked done)";

      // Try to extract task titles from context
      const addedLines = diff
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      return addedLines.map((l) => l.slice(1).trim()).join("\n");
    } catch {
      return "(Could not read tasks.json diff)";
    }
  }

  if (project.work_detection === "git_issues") {
    // git_issues mode tracks pending work as commits ahead of origin/master.
    // There is no per-cycle "task done" signal — work is removed when commits
    // are merged upstream.
    return "(git_issues mode: no per-cycle task tracking)";
  }

  if (project.work_detection === "git_unmerged") {
    // git_unmerged mode tracks pending work as bot-branch commits ahead of
    // local master. No per-cycle "task done" signal — work is removed when
    // the branch is merged into master.
    return "(git_unmerged mode: no per-cycle task tracking)";
  }

  return "(Unknown work_detection mode)";
}

async function findSessionNote(
  project: ProjectConfig,
  startSha: string,
  endSha: string,
): Promise<string> {
  if (startSha === endSha) return "";

  // Check for new files in docs/Sessions/ for catalogdna
  try {
    const diff =
      await $`git -C ${project.path} diff --name-only ${startSha} ${endSha} -- docs/Sessions/`.text();
    const newFiles = diff.trim().split("\n").filter(Boolean);
    if (newFiles.length === 0) return "";

    // Read the most recent session note
    const latest = newFiles[newFiles.length - 1];
    const content = await readFile(join(project.path, latest), "utf8");
    // Truncate to avoid blowing up the reviewer prompt
    return content.length > 5000
      ? content.slice(0, 5000) + "\n\n[... truncated]"
      : content;
  } catch {
    return "";
  }
}

export async function executeCycle(
  project: ProjectConfig,
  config: DispatcherConfig,
  dryRun: boolean = false,
): Promise<CycleResult> {
  const cycleId = generateCycleId();
  const startedAt = new Date().toISOString();
  console.log(`\n=== Cycle ${cycleId} on ${project.id} ===`);

  ensureCycleDir(project.id, cycleId, config);

  // Mutable builder. Populated as the cycle progresses; finalized once at the
  // bottom via a single assembly block. Defaults match the "skip" shape so
  // pre-engineer short-circuits only need to set `reason` + break out.
  const result: CycleResult = {
    cycle_id: cycleId,
    project_id: project.id,
    started_at: startedAt,
    ended_at: "",
    cycle_start_sha: "skipped",
    cycle_end_sha: "skipped",
    engineer_exit_code: null,
    verification_outcome: "failed",
    reviewer_verdict: "verification_failed",
    final_outcome: "cycle_skipped",
    reason: "",
  };

  // Which terminal block to run:
  //   "skip" — emit cycle_skipped, no state updates, no cleanup
  //   "full" — emit cycle_end, update fleet/project state, cleanup, auto-commit
  let terminus: "skip" | "full" = "skip";
  let handsOffViolations: Array<{ file: string; pattern: string }> | undefined;

  assemble: {
    // 1. Pre-flight skip paths
    if (await isStopFilePresent()) {
      console.log("STOP file detected — aborting cycle.");
      result.reason = "STOP file present";
      break assemble;
    }

    const concurrency = isBotRunning(project);
    if (concurrency.running) {
      console.log(`Bot already running on ${project.id}: ${concurrency.reason}`);
      result.reason = concurrency.reason!;
      break assemble;
    }

    const treeCheck = await isWorkingTreeClean(project.path);
    if (!treeCheck.clean) {
      console.log(`Working tree not clean: ${treeCheck.reason}`);
      result.reason = treeCheck.reason!;
      break assemble;
    }

    const preflight = await preflightCleanupWorktree(project);
    if (preflight.wasStale) {
      if (preflight.removed) {
        console.log("Removed stale .bot-worktree from a prior cycle.");
        await appendProgress(project.id, "worktree_preflight", {
          status: "removed",
        }, cycleId);
      } else {
        console.error(`Warning: ${preflight.warning}`);
        await appendProgress(project.id, "worktree_preflight", {
          status: "warning",
          warning: preflight.warning,
        }, cycleId);
      }
    }

    // 2. Before resetting bot branch to HEAD, check whether it has unmerged
    //    work. `branch -f <branch> HEAD` is destructive — without this guard,
    //    a verified cycle's commits sit on bot/work, then the next cycle starts
    //    and overwrites them, leaving the work orphaned in the reflog and
    //    never integrated into master. (Discovered 2026-04-16, observation run
    //    cycles 1-3 all reimplemented gs-056 because of this gap.)
    const branch = project.branch;
    const branchSha = await getGitSha(project.path, branch);
    if (branchSha !== "unknown") {
      const unmerged = await countCommitsAhead(project.path, branch, "HEAD");
      if (unmerged > 0) {
        if (project.auto_merge) {
          // Opt-in: fast-forward-or-merge bot's prior verified work into HEAD
          // before resetting. Use --no-ff so the merge is always legible in
          // the history even when a fast-forward would work.
          console.log(
            `Auto-merging ${unmerged} commit(s) from ${branch} into HEAD...`,
          );
          try {
            const msg = `Merge branch '${branch}' (auto, ${unmerged} cycle-commit(s))`;
            await $`git -C ${project.path} merge --no-ff ${branch} -m ${msg}`.quiet();
            console.log(`Merged ${branch} into HEAD.`);
          } catch {
            result.reason =
              `auto-merge of ${branch} into HEAD failed — ` +
              `manual intervention required (likely a conflict with interactive work on master)`;
            console.log(`\nERROR: ${result.reason}\n`);
            break assemble;
          }
        } else {
          // auto_merge: false — default per Hard Rule #4. Do NOT overwrite work.
          result.reason = formatUnmergedBranchError(project, branch, unmerged);
          console.log(`\nERROR: ${result.reason}\n`);
          break assemble;
        }
      }
    }

    // Now safe to reset — either branch was clean of unmerged work, didn't
    // exist, or we just merged it in above.
    try {
      await $`git -C ${project.path} branch -f ${branch} HEAD`.quiet();
      console.log(`Branch ${branch} reset to HEAD`);
    } catch {
      // Branch may not exist yet or may be checked out — log and continue
      console.log(`Warning: could not reset ${branch} to HEAD, continuing with current position`);
    }

    // 3. Capture start SHA on the bot's branch
    const branchExists =
      (await getGitSha(project.path, branch)) !== "unknown";
    const cycleStartSha = branchExists
      ? await getGitSha(project.path, branch)
      : await getGitSha(project.path); // fallback to HEAD if branch doesn't exist yet
    result.cycle_start_sha = cycleStartSha;
    await appendProgress(project.id, "cycle_start", {
      start_sha: cycleStartSha,
      branch,
    }, cycleId);
    console.log(`Start SHA (${branch}): ${cycleStartSha.slice(0, 8)}`);

    // 4. Engineer step
    console.log(`Running engineer: ${project.engineer_command}`);
    const engineerResult = await runEngineer(project, cycleId, config, dryRun);
    console.log(
      `Engineer finished: exit=${engineerResult.exitCode}, ` +
        `${engineerResult.durationSeconds.toFixed(0)}s`,
    );
    result.engineer_exit_code = engineerResult.exitCode;

    // 4a. If the STOP file was written mid-engineer (gs-131), the session
    //     watcher will have killed the subprocess. Route to cycle_skipped
    //     rather than the gs-111 abnormal-exit path — the operator didn't
    //     observe a bug, they asked for a stop.
    if (await isStopFilePresent()) {
      console.log("STOP file detected during engineer run — skipping cycle.");
      result.reason = "STOP file triggered during engineer";
      break assemble;
    }

    // 5. Capture end SHA on the bot's branch
    const cycleEndSha = await getGitSha(project.path, branch);
    result.cycle_end_sha = cycleEndSha;
    console.log(`End SHA (${branch}): ${cycleEndSha.slice(0, 8)}`);

    // 6. Diff capture (between branch SHAs — works regardless of which dir we're in)
    const fullDiff = await getGitDiff(project.path, cycleStartSha, cycleEndSha);
    const diffStat = await getGitDiffStat(
      project.path,
      cycleStartSha,
      cycleEndSha,
    );
    await writeCycleFile(
      project.id,
      cycleId,
      "diff.patch",
      fullDiff || "(empty diff)\n",
      config,
    );
    await appendProgress(project.id, "diff_summary", {
      start_sha: cycleStartSha,
      end_sha: cycleEndSha,
      branch,
      files_changed: diffStat,
      diff_length: fullDiff.length,
    }, cycleId);

    // Past this point we're committed to a "full" terminal block regardless
    // of whether verification+reviewer actually run.
    terminus = "full";

    // 6a. If engineer exited abnormally (killed mid-task or non-zero exit),
    //     block verification + reviewer. Partial work from a killed engineer
    //     must never be accepted as verified. (Fix: gs-111 — observed
    //     2026-04-17 cycle 10 when engineer timeout killed claude.exe but the
    //     partial diff was still reviewed and marked verified.)
    if (engineerResult.exitCode === null || engineerResult.exitCode !== 0) {
      result.final_outcome = "verification_failed";
      result.reason = `engineer exited abnormally (code=${engineerResult.exitCode})`;
      result.verification_outcome = "failed";
      result.reviewer_verdict = "verification_failed";
      result.diff_stats = diffSummaryStats(fullDiff);
      console.log(`\nSkipping verification and reviewer: ${result.reason}`);
      break assemble;
    }

    // 6b. Skip verification and reviewer if diff is empty — nothing to test or review
    if (!fullDiff.trim()) {
      result.final_outcome = "verified_weak";
      result.reason = "empty diff, skipping verification and reviewer";
      result.verification_outcome = "weak";
      result.reviewer_verdict = "verified_weak";
      result.diff_stats = { files_changed: 0, insertions: 0, deletions: 0 };
      console.log(`\nSkipping verification and reviewer: ${result.reason}`);
      break assemble;
    }

    // 6c. Check for hands-off violations — skip verification + reviewer if found
    const diffStats = diffSummaryStats(fullDiff);
    const changedFiles = extractChangedFiles(fullDiff);
    const violations: Array<{ file: string; pattern: string }> = [];
    for (const file of changedFiles) {
      const pattern = matchesHandsOff(file, project.hands_off);
      if (pattern) {
        violations.push({ file, pattern });
      }
    }
    if (violations.length > 0) {
      handsOffViolations = violations;
      const violationList = violations
        .map((v) => `${v.file} (matched ${v.pattern})`)
        .join(", ");
      result.final_outcome = "verification_failed";
      result.reason = `hands-off violation: ${violationList}`;
      result.verification_outcome = "failed";
      result.reviewer_verdict = "verification_failed";
      result.diff_stats = diffStats;
      console.log(`\nHands-off violation detected: ${result.reason}`);
      break assemble;
    }

    // 7. Independent verification gate
    //    Run in the worktree if it exists (tests the bot's code, not master)
    const wt = worktreePath(project);
    const verCwd = existsSync(wt) ? wt : undefined;
    if (verCwd) {
      console.log(`Running verification gate in worktree: ${wt}`);
    } else {
      console.log("Running verification gate...");
    }
    const verResult = await runVerification(
      project, cycleId, config, dryRun, verCwd,
    );
    console.log(
      `Verification: ${verResult.outcome} (exit ${verResult.exitCode})`,
    );

    // 8. Reviewer agent
    const markedDone = await detectMarkedDoneTasks(
      project,
      cycleStartSha,
      cycleEndSha,
    );
    const sessionNote = await findSessionNote(
      project,
      cycleStartSha,
      cycleEndSha,
    );

    let verificationOutput = "";
    try {
      verificationOutput = await readFile(verResult.logPath, "utf8");
    } catch {
      // ok
    }

    // Reviewer runs in worktree if available (so it can read the bot's files)
    const reviewerCwd = existsSync(wt) ? wt : undefined;
    console.log("Running reviewer agent...");
    const reviewerResult = await runReviewer(
      project,
      cycleId,
      {
        projectId: project.id,
        markedDoneTasks: markedDone,
        sessionNoteOrNone: sessionNote,
        fullDiff,
        diffStat,
        verificationCommand: project.verification_command,
        verificationExitCode: verResult.exitCode,
        verificationOutputTruncated: verificationOutput,
        handsOffList: project.hands_off,
      },
      config,
      dryRun,
      reviewerCwd,
    );
    console.log(`Reviewer verdict: ${reviewerResult.verdict}`);
    if (reviewerResult.parseError) {
      console.log(`Reviewer parse error: ${reviewerResult.parseError}`);
    }

    // 9. Determine final outcome
    if (verResult.outcome === "failed") {
      result.final_outcome = "verification_failed";
      result.reason = `Verification gate failed (exit ${verResult.exitCode})`;
    } else if (reviewerResult.verdict === "verification_failed") {
      result.final_outcome = "verification_failed";
      result.reason = reviewerResult.response?.reason ?? "Reviewer rejected";
    } else if (
      verResult.outcome === "weak" ||
      reviewerResult.verdict === "verified_weak"
    ) {
      result.final_outcome = "verified_weak";
      result.reason =
        reviewerResult.response?.reason ?? "Weak verification or low confidence";
    } else {
      result.final_outcome = "verified";
      result.reason = reviewerResult.response?.reason ?? "Verification passed, scope matched";
    }
    result.verification_outcome = verResult.outcome;
    result.reviewer_verdict = reviewerResult.verdict;
    result.diff_stats = diffStats;
  }

  // --- Single terminal assembly block ---
  if (terminus === "skip") {
    await appendProgress(project.id, "cycle_skipped", {
      reason: result.reason,
    }, cycleId);
    result.ended_at = new Date().toISOString();
  } else {
    result.ended_at = new Date().toISOString();
    console.log(`\nCycle outcome: ${result.final_outcome} — ${result.reason}`);

    // Field order mirrors the pre-refactor event layout so on-disk JSON
    // line shape is unchanged for downstream consumers.
    const cycleEndData: Record<string, unknown> = {
      outcome: result.final_outcome,
      reason: result.reason,
      start_sha: result.cycle_start_sha,
      end_sha: result.cycle_end_sha,
      engineer_exit_code: result.engineer_exit_code,
      verification_outcome: result.verification_outcome,
      reviewer_verdict: result.reviewer_verdict,
      ...(handsOffViolations ? { hands_off_violations: handsOffViolations } : {}),
      diff_stats: result.diff_stats,
      duration_seconds: Math.round(
        (new Date(result.ended_at).getTime() -
          new Date(result.started_at).getTime()) /
          1000,
      ),
    };
    await appendProgress(project.id, "cycle_end", cycleEndData, cycleId);

    const fleet = await loadFleetState(config);
    const durationMinutes =
      (new Date(result.ended_at).getTime() -
        new Date(result.started_at).getTime()) /
      60_000;
    updateProjectFleetState(
      fleet,
      project.id,
      result.final_outcome,
      durationMinutes,
    );
    await saveFleetState(fleet, config);

    const projState = await loadProjectState(project.id, config);
    projState.current_cycle_id = null;
    projState.last_cycle_id = cycleId;
    projState.last_cycle_outcome = result.final_outcome;
    projState.last_cycle_at = result.ended_at;
    projState.cycles_this_session += 1;
    await saveProjectState(projState, config);

    await cleanupWorktree(project);
    await autoCommitState(project, cycleId, result.final_outcome);
  }

  return result;
}

// --- Single cycle entry point (for `generalstaff cycle` command) ---

export async function runSingleCycle(options: SingleCycleOptions) {
  const yaml = await loadProjectsYaml();
  let project;
  try {
    project = getProject(yaml.projects, options.projectId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      console.error(`Error: project '${err.projectId}' not found`);
      if (err.availableIds.length > 0) {
        console.error(`  Available: ${err.availableIds.join(", ")}`);
      }
      process.exit(1);
    }
    throw err;
  }

  const result = await executeCycle(project, yaml.dispatcher, options.dryRun);
  console.log(`\n=== Cycle complete: ${result.final_outcome} ===`);
  return result;
}

// Re-export for cli.ts
export { loadProjectsYaml };
