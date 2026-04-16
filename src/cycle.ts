// GeneralStaff — cycle module (build step 12)
// Orchestrate: engineer → verification → reviewer → audit log

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
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
import { isStopFilePresent, isWorkingTreeClean, isBotRunning } from "./safety";
import { loadProjectsYaml, findProject } from "./projects";
import type {
  ProjectConfig,
  DispatcherConfig,
  CycleResult,
  CycleOutcome,
  ReviewerVerdict,
  SingleCycleOptions,
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

function worktreePath(project: ProjectConfig): string {
  return join(project.path, ".bot-worktree");
}

async function autoCommitState(
  project: ProjectConfig,
  cycleId: string,
  outcome: CycleOutcome,
): Promise<void> {
  try {
    const root = getRootDir();
    // Stage state artifacts (fleet_state.json + state/ + digests/)
    await $`git -C ${root} add state/ fleet_state.json digests/ 2>/dev/null`.quiet();
    // Check if there's anything to commit
    const status = await $`git -C ${root} diff --cached --quiet`.quiet().then(
      () => false,
      () => true,
    );
    if (status) {
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
      // Best-effort cleanup
      console.log("Warning: could not remove worktree, may need manual cleanup");
    }
  }
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

  // 1. Pre-flight
  if (await isStopFilePresent()) {
    console.log("STOP file detected — aborting cycle.");
    await appendProgress(project.id, "cycle_skipped", {
      reason: "STOP file present",
    }, cycleId);
    return skipResult(cycleId, project.id, startedAt, "STOP file present");
  }

  const concurrency = isBotRunning(project);
  if (concurrency.running) {
    console.log(`Bot already running on ${project.id}: ${concurrency.reason}`);
    await appendProgress(project.id, "cycle_skipped", {
      reason: concurrency.reason,
    }, cycleId);
    return skipResult(cycleId, project.id, startedAt, concurrency.reason!);
  }

  const treeCheck = await isWorkingTreeClean(project.path);
  if (!treeCheck.clean) {
    console.log(`Working tree not clean: ${treeCheck.reason}`);
    await appendProgress(project.id, "cycle_skipped", {
      reason: treeCheck.reason,
    }, cycleId);
    return skipResult(cycleId, project.id, startedAt, treeCheck.reason!);
  }

  // 2. Capture start SHA on the bot's branch (not HEAD/master)
  const branch = project.branch;
  const branchExists =
    (await getGitSha(project.path, branch)) !== "unknown";
  const cycleStartSha = branchExists
    ? await getGitSha(project.path, branch)
    : await getGitSha(project.path); // fallback to HEAD if branch doesn't exist yet
  await appendProgress(project.id, "cycle_start", {
    start_sha: cycleStartSha,
    branch,
  }, cycleId);
  console.log(`Start SHA (${branch}): ${cycleStartSha.slice(0, 8)}`);

  // 3. Engineer step
  console.log(`Running engineer: ${project.engineer_command}`);
  const engineerResult = await runEngineer(project, cycleId, config, dryRun);
  console.log(
    `Engineer finished: exit=${engineerResult.exitCode}, ` +
      `${engineerResult.durationSeconds.toFixed(0)}s`,
  );

  // 4. Capture end SHA on the bot's branch
  const cycleEndSha = await getGitSha(project.path, branch);
  console.log(`End SHA (${branch}): ${cycleEndSha.slice(0, 8)}`);

  // 5. Diff capture (between branch SHAs — works regardless of which dir we're in)
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

  // 6. Independent verification gate
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

  // 7. Reviewer agent
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

  // 8. Determine final outcome
  let finalOutcome: CycleOutcome;
  let reason: string;

  if (verResult.outcome === "failed") {
    finalOutcome = "verification_failed";
    reason = `Verification gate failed (exit ${verResult.exitCode})`;
  } else if (reviewerResult.verdict === "verification_failed") {
    finalOutcome = "verification_failed";
    reason = reviewerResult.response?.reason ?? "Reviewer rejected";
  } else if (
    verResult.outcome === "weak" ||
    reviewerResult.verdict === "verified_weak"
  ) {
    finalOutcome = "verified_weak";
    reason =
      reviewerResult.response?.reason ?? "Weak verification or low confidence";
  } else {
    finalOutcome = "verified";
    reason = reviewerResult.response?.reason ?? "Verification passed, scope matched";
  }

  const endedAt = new Date().toISOString();
  console.log(`\nCycle outcome: ${finalOutcome} — ${reason}`);

  await appendProgress(project.id, "cycle_end", {
    outcome: finalOutcome,
    reason,
    start_sha: cycleStartSha,
    end_sha: cycleEndSha,
    engineer_exit_code: engineerResult.exitCode,
    verification_outcome: verResult.outcome,
    reviewer_verdict: reviewerResult.verdict,
    duration_seconds: Math.round(
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    ),
  }, cycleId);

  // 9. Update state
  const fleet = await loadFleetState(config);
  const durationMinutes =
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000;
  updateProjectFleetState(fleet, project.id, finalOutcome, durationMinutes);
  await saveFleetState(fleet, config);

  const projState = await loadProjectState(project.id, config);
  projState.current_cycle_id = null;
  projState.last_cycle_id = cycleId;
  projState.last_cycle_outcome = finalOutcome;
  projState.last_cycle_at = endedAt;
  projState.cycles_this_session += 1;
  await saveProjectState(projState, config);

  // 10. Clean up worktree (dispatcher owns the lifecycle)
  await cleanupWorktree(project);

  // 11. Auto-commit state artifacts so the tree stays clean for chaining
  await autoCommitState(project, cycleId, finalOutcome);

  return {
    cycle_id: cycleId,
    project_id: project.id,
    started_at: startedAt,
    ended_at: endedAt,
    cycle_start_sha: cycleStartSha,
    cycle_end_sha: cycleEndSha,
    engineer_exit_code: engineerResult.exitCode,
    verification_outcome: verResult.outcome,
    reviewer_verdict: reviewerResult.verdict,
    final_outcome: finalOutcome,
    reason,
  };
}

function skipResult(
  cycleId: string,
  projectId: string,
  startedAt: string,
  reason: string,
): CycleResult {
  const now = new Date().toISOString();
  return {
    cycle_id: cycleId,
    project_id: projectId,
    started_at: startedAt,
    ended_at: now,
    cycle_start_sha: "skipped",
    cycle_end_sha: "skipped",
    engineer_exit_code: null,
    verification_outcome: "failed",
    reviewer_verdict: "verification_failed",
    final_outcome: "cycle_skipped",
    reason,
  };
}

// --- Single cycle entry point (for `generalstaff cycle` command) ---

export async function runSingleCycle(options: SingleCycleOptions) {
  const yaml = await loadProjectsYaml();
  const project = findProject(yaml.projects, options.projectId);
  if (!project) {
    console.error(`Project "${options.projectId}" not found in projects.yaml`);
    process.exit(1);
  }

  const result = await executeCycle(project, yaml.dispatcher, options.dryRun);
  console.log(`\n=== Cycle complete: ${result.final_outcome} ===`);
  return result;
}

// Re-export for cli.ts
export { loadProjectsYaml };
