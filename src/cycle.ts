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

async function getGitSha(projectPath: string): Promise<string> {
  try {
    const result = await $`git -C ${projectPath} rev-parse HEAD`.text();
    return result.trim();
  } catch {
    return "unknown";
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

  return "(Task detection not applicable for this work_detection mode)";
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

  // 2. Capture start SHA
  const cycleStartSha = await getGitSha(project.path);
  await appendProgress(project.id, "cycle_start", {
    start_sha: cycleStartSha,
  }, cycleId);
  console.log(`Start SHA: ${cycleStartSha.slice(0, 8)}`);

  // 3. Engineer step
  console.log(`Running engineer: ${project.engineer_command}`);
  const engineerResult = await runEngineer(project, cycleId, config, dryRun);
  console.log(
    `Engineer finished: exit=${engineerResult.exitCode}, ` +
      `${engineerResult.durationSeconds.toFixed(0)}s`,
  );

  // 4. Capture end SHA
  const cycleEndSha = await getGitSha(project.path);

  // 5. Diff capture
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
    files_changed: diffStat,
    diff_length: fullDiff.length,
  }, cycleId);

  // 6. Independent verification gate
  console.log("Running verification gate...");
  const verResult = await runVerification(project, cycleId, config, dryRun);
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
