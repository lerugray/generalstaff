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
  botWorktreePath,
} from "./state";
import { appendProgress } from "./audit";
import { runEngineer } from "./engineer";
import { loadTasks, nextBotPickableTask } from "./tasks";
import { runVerification } from "./verification";
import { runReviewer, type ReviewerResult } from "./reviewer";
import { runMissionSwarmPreview } from "./integrations/mission_swarm/hook";
import { isStopFilePresent, isWorkingTreeClean, isBotRunning, matchesHandsOff, matchesHandsOffSymlinkAware } from "./safety";
import { loadProjectsYaml, getProject, ProjectNotFoundError } from "./projects";
import type {
  ProjectConfig,
  DispatcherConfig,
  CycleResult,
  CycleOutcome,
  SingleCycleOptions,
  DiffStats,
  GreenfieldTask,
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

// Build the "bot branch has unmerged commits ahead of HEAD" error reason.
// Resolves project.path to an absolute path so the suggested `git -C <path>`
// command works regardless of the user's current working directory.
//
// Retained post-gs-177 for the auto_merge=true conflict path
// (`auto-merge of <branch> into HEAD failed`) and for any future
// strict-abort use case. With gs-177 the auto_merge=false path no
// longer aborts — it accumulates instead, so this helper is unused by
// the dispatcher's normal happy paths but kept exported because tests
// pin its message shape.
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

// gs-177: decide what to do with the bot's branch when it has commits
// the main HEAD doesn't. Pure function so the policy can be tested in
// isolation from the cycle orchestration. See DESIGN.md §v5 for the
// design rationale (option (a) — accumulator).
//
// Three outcomes:
//   "reset"             — branch is clean of unmerged work (or doesn't
//                         exist yet). Safe to fast-reset bot/work to
//                         HEAD before the new cycle.
//   "merge-then-reset"  — auto_merge=true and there's unmerged work.
//                         Merge bot/work into HEAD first, then reset
//                         (which is then a no-op anyway).
//   "accumulate"        — auto_merge=false and there's unmerged work.
//                         Skip the reset; let bot/work accumulate
//                         verified-cycle commits across the session.
//                         Master is untouched until human merge.
export type BotBranchHandling =
  | { kind: "reset" }
  | { kind: "merge-then-reset"; unmerged: number }
  | { kind: "accumulate"; unmerged: number };

export function decideBotBranchHandling(
  project: ProjectConfig,
  branchExists: boolean,
  unmerged: number,
): BotBranchHandling {
  if (!branchExists) return { kind: "reset" };
  if (unmerged <= 0) return { kind: "reset" };
  if (project.auto_merge) return { kind: "merge-then-reset", unmerged };
  return { kind: "accumulate", unmerged };
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
  const wt = botWorktreePath(project);
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
  const wt = botWorktreePath(project);
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

// gs-133: cross-reference reviewer-reported hands_off_violations against
// the actual diff. Returns which violations are real (a file in the diff
// matches the violation string as a glob, using matchesHandsOff for
// parity with the cycle's own hands-off gate) and which are hallucinated.
export function crossCheckReviewerHandsOff(
  reviewerViolations: string[],
  changedFiles: string[],
): { real: string[]; dropped: string[] } {
  const real: string[] = [];
  const dropped: string[] = [];
  for (const v of reviewerViolations) {
    const hasMatch = changedFiles.some(
      (f) => matchesHandsOff(f, [v]) !== null,
    );
    if (hasMatch) real.push(v);
    else dropped.push(v);
  }
  return { real, dropped };
}

// gs-133: mutates the reviewer result in place — drops hallucinated
// hands_off_violations and, when the reviewer's only failure reason was
// those hallucinations, flips the verdict from verification_failed to
// verified. Returns the dropped list + whether the verdict was flipped so
// the caller can emit a reviewer_hallucination progress event.
export function applyReviewerSanityCheck(
  reviewerResult: ReviewerResult,
  changedFiles: string[],
): { dropped: string[]; flipped: boolean } {
  const resp = reviewerResult.response;
  if (!resp || resp.hands_off_violations.length === 0) {
    return { dropped: [], flipped: false };
  }
  const { real, dropped } = crossCheckReviewerHandsOff(
    resp.hands_off_violations,
    changedFiles,
  );
  if (dropped.length === 0) {
    return { dropped: [], flipped: false };
  }
  resp.hands_off_violations = real;
  let flipped = false;
  if (
    reviewerResult.verdict === "verification_failed" &&
    real.length === 0 &&
    resp.scope_drift_files.length === 0 &&
    resp.silent_failures.length === 0
  ) {
    reviewerResult.verdict = "verified";
    resp.verdict = "verified";
    resp.reason =
      `verdict flipped: all reported hands_off_violations were hallucinated ` +
      `(${dropped.join(", ")})`;
    flipped = true;
  }
  return { dropped, flipped };
}

// gs-280: JSON syntax gate. Reads every `.json` file in `changedFiles`
// from `cwd` and attempts `JSON.parse`; returns the list of files that
// failed to parse, with the error message truncated. Empty list =
// gate passes. Motivation: bot engineers' line-oriented edits to
// state/<project>/tasks.json have on multiple occasions (2026-04-20)
// dropped the closing `},` between sibling task objects. Verification
// (pytest/ruff/etc.) doesn't parse tasks.json; reviewer eyeballs the
// diff text but not JSON structure. Without this gate, malformed JSON
// lands on bot/work and subsequent cycles' `loadTasks` peek throws —
// the silent try/catch in runCycle then sets nextTask=undefined and
// gs-279's creative-cycle branch routing stops firing.
//
// The gate is exported + async-pure so tests can exercise it against
// tmpdir fixtures without standing up a full cycle.
export async function detectMalformedJsonFiles(
  cwd: string,
  changedFiles: string[],
): Promise<Array<{ file: string; error: string }>> {
  const jsonFiles = changedFiles.filter((f) => f.endsWith(".json"));
  const malformed: Array<{ file: string; error: string }> = [];
  for (const file of jsonFiles) {
    const absPath = join(cwd, file);
    try {
      const content = await readFile(absPath, "utf8");
      JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      malformed.push({ file, error: msg.slice(0, 500) });
    }
  }
  return malformed;
}

// gs-318: anti-state-wipe guard. State-tracking files (tasks.json,
// MISSION.md, PROGRESS.jsonl, STATE.json under state/<id>/, plus
// state/_fleet/PROGRESS.jsonl) are intended to be append-only or
// stable. Deletion of these files indicates corrupt cycle state —
// the cycle is committing a bulk file removal that almost certainly
// came from operating on a stale base or a clean-tree preflight that
// over-cleaned. Block the commit before the reviewer step.
//
// Motivation: 2026-04-24 incident. Home-PC's morning chained
// dispatcher session ran a "verified" cycle that deleted 21 state
// files (-6743 lines net) — every public-state project's tasks.json
// + MISSION.md + PROGRESS.jsonl + STATE.json plus _fleet/
// PROGRESS.jsonl. Reviewer marked it verified_weak; only the
// divergence with work-PC's parallel push surfaced the wipe later.
//
// Pure parsing — no filesystem reads. Returns the deleted-state-file
// paths for surfacing in the failure reason. Empty list = gate
// passes.
export function detectStateFileDeletions(diff: string): string[] {
  if (!diff) return [];
  const STATE_FILE = /^state\/[^/]+\/(tasks\.json|MISSION\.md|PROGRESS\.jsonl|STATE\.json)$/;
  const FLEET_FILE = /^state\/_fleet\/PROGRESS\.jsonl$/;
  const isStateFile = (path: string): boolean =>
    STATE_FILE.test(path) || FLEET_FILE.test(path);

  const deletions: string[] = [];
  // Per-file chunks start with `diff --git `. Split on that boundary
  // (with lookahead so the marker stays at the start of each chunk)
  // and inspect each chunk for the deletion marker.
  const chunks = diff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(.+?) b\/.+$/m);
    if (!header) continue;
    const path = header[1];
    if (!isStateFile(path)) continue;
    if (/^deleted file mode /m.test(chunk)) {
      deletions.push(path);
    }
  }
  return deletions;
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

/**
 * gs-281: peek at the next bot-pickable task for a project, returning
 * `undefined` when there isn't one (or when tasks.json can't be parsed).
 *
 * `loadTasks` returns `[]` silently when `state/<id>/tasks.json` doesn't
 * exist (the common non-greenfield case). So anything thrown from
 * `loadTasks` here means the file exists but failed to parse or validate
 * — in that case we log a `task_peek_failed` progress event with the
 * error message, so operators have a grep-able signal, and fall through
 * to `undefined` so the cycle proceeds on the legacy non-creative path.
 *
 * Exported for unit testing the two branches (missing vs. malformed).
 */
export async function peekNextBotPickableTask(
  project: ProjectConfig,
  cycleId: string,
): Promise<GreenfieldTask | undefined> {
  try {
    const tasks = await loadTasks(project.id);
    return nextBotPickableTask(tasks, project.hands_off, {
      creativeWorkAllowed: project.creative_work_allowed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendProgress(project.id, "task_peek_failed", {
      error: message,
    }, cycleId);
    return undefined;
  }
}

export async function executeCycle(
  project: ProjectConfig,
  config: DispatcherConfig,
  dryRun: boolean = false,
  reviewerProviderOverride?: string,
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

  // gs-279: creative-work cycle state. Set after the nextTask peek below.
  // `branch` is the *effective* branch the cycle operates on — for creative
  // cycles it's overridden to project.creative_work_branch (see guardrail 2
  // of docs/internal/RULE-RELAXATION-2026-04-20.md). `voiceReferencePaths`
  // is the resolved per-cycle list (task override ∪ project default) passed
  // down to the engineer so it can read those files before drafting.
  let isCreative = false;
  let branch = project.branch;
  let voiceReferencePaths: string[] = [];
  let nextTask: GreenfieldTask | undefined;

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

    // 1a. Peek at the next bot-pickable task BEFORE branch handling. For
    //     creative-tagged tasks on opted-in projects, we override the
    //     effective branch to project.creative_work_branch (guardrail 2
    //     of docs/internal/RULE-RELAXATION-2026-04-20.md — keeps drafts
    //     off bot/work so correctness and creative cycles don't
    //     contaminate each other's SHAs). The same peek also resolves
    //     task-level engineer_provider overrides downstream (gs-275).
    //     Non-greenfield projects (catalogdna_bot_tasks etc.) fall
    //     through silently (loadTasks returns [] when the file is
    //     missing); malformed tasks.json logs a task_peek_failed event
    //     (gs-281) so operators have a grep-able signal.
    nextTask = await peekNextBotPickableTask(project, cycleId);

    // 1b. Creative-work detection. Requires BOTH task-level `creative: true`
    //     AND project-level `creative_work_allowed: true` — if only one is
    //     set, the task picker already skipped the task (see tasks.ts
    //     `creative_work_not_allowed_for_project`) so `nextTask` is a
    //     different (non-creative) task and this branch is false.
    if (nextTask?.creative === true && project.creative_work_allowed === true) {
      isCreative = true;
      branch = project.creative_work_branch ?? "bot/creative-drafts";
      voiceReferencePaths =
        nextTask.voice_reference_override ??
        project.voice_reference_paths ??
        [];
      const draftsDirDisplay =
        project.creative_work_drafts_dir ?? "drafts/";
      console.log(
        `\n[WARN] Starting CREATIVE_WORK cycle for ${project.id}:${nextTask.id}.\n` +
        `       Creative work bypasses Hard Rule #1 via project opt-in.\n` +
        `       Bot will draft; human review is MANDATORY before publication.\n` +
        `       Branch: ${branch} — drafts in ${draftsDirDisplay}.\n` +
        `       See docs/internal/RULE-RELAXATION-2026-04-20.md.`,
      );
    }

    // 2. Decide what to do with the bot's branch (gs-177 / DESIGN.md §v5).
    //    Three handling modes:
    //      - "reset"            : branch clean of unmerged or doesn't exist
    //      - "merge-then-reset" : auto_merge=true, fold unmerged into HEAD
    //      - "accumulate"       : auto_merge=false, leave bot/work alone
    //                             (gs-177's new path — eliminates the
    //                              one-cycle-per-session ceiling)
    const branchSha = await getGitSha(project.path, branch);
    const initialBranchExists = branchSha !== "unknown";
    const unmerged = initialBranchExists
      ? await countCommitsAhead(project.path, branch, "HEAD")
      : 0;
    const handling = decideBotBranchHandling(
      project,
      initialBranchExists,
      unmerged,
    );

    let skipReset = false;
    if (handling.kind === "merge-then-reset") {
      // Opt-in: fast-forward-or-merge bot's prior verified work into HEAD
      // before resetting. Use --no-ff so the merge is always legible in
      // the history even when a fast-forward would work.
      console.log(
        `Auto-merging ${handling.unmerged} commit(s) from ${branch} into HEAD...`,
      );
      try {
        const msg = `Merge branch '${branch}' (auto, ${handling.unmerged} cycle-commit(s))`;
        await $`git -C ${project.path} merge --no-ff ${branch} -m ${msg}`.quiet();
        console.log(`Merged ${branch} into HEAD.`);
      } catch {
        result.reason =
          `auto-merge of ${branch} into HEAD failed — ` +
          `manual intervention required (likely a conflict with interactive work on master)`;
        console.log(`\nERROR: ${result.reason}\n`);
        break assemble;
      }
    } else if (handling.kind === "accumulate") {
      // gs-177 / DESIGN.md §v5(a): auto_merge=false with unmerged work.
      // Leave bot/work where it is — the new cycle's worktree will start
      // from the accumulated head, and Cycle N+1 sees Cycle N's
      // tasks.json updates naturally. Master is unchanged; the user
      // reviews bot/work in batch when they're ready.
      console.log(
        `Branch ${branch} has ${handling.unmerged} unmerged commit(s); ` +
          `accumulating (auto_merge=false). Master is untouched — ` +
          `human review then \`git merge --no-ff ${branch}\` when ready.`,
      );
      skipReset = true;
    }

    if (!skipReset) {
      // Either branch was clean of unmerged work, didn't exist, or we just
      // merged it in above (in which case bot/work and HEAD are now equal
      // and the reset is a no-op).
      try {
        await $`git -C ${project.path} branch -f ${branch} HEAD`.quiet();
        console.log(`Branch ${branch} reset to HEAD`);
      } catch {
        // Branch may not exist yet or may be checked out — log and continue
        console.log(`Warning: could not reset ${branch} to HEAD, continuing with current position`);
      }
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
      ...(isCreative
        ? { creative: true, task_id: nextTask?.id }
        : {}),
    }, cycleId);
    console.log(`Start SHA (${branch}): ${cycleStartSha.slice(0, 8)}`);

    // 4. Engineer step
    //
    // gs-275: the task peek happens earlier (step 1a) so creative
    // cycles can route to the creative branch; that same peek also
    // resolves task-level engineer_provider / engineer_model overrides
    // (precedence: task > project > default), so by here `nextTask` is
    // already the bot-pickable task the engineer will work on. Non-
    // greenfield projects (catalogdna_bot_tasks, git_issues,
    // git_unmerged) passed through the peek as `undefined` and engineer
    // resolution falls back to project-level defaults.
    console.log(`Running engineer: ${project.engineer_command}`);
    const engineerResult = await runEngineer(project, cycleId, config, dryRun, nextTask, {
      isCreative,
      effectiveBranch: branch,
      voiceReferencePaths,
      draftsDir: project.creative_work_drafts_dir ?? "drafts/",
    });
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

    // 6c. Check for hands-off violations — skip verification + reviewer if found.
    // Uses the symlink-aware variant so a bot that creates `safe-alias.ts ->
    // src/reviewer.ts` and edits through the alias is caught. baseDir is the
    // bot worktree — the place the diff paths actually resolve against.
    const diffStats = diffSummaryStats(fullDiff);
    const changedFiles = extractChangedFiles(fullDiff);
    const wtBase = botWorktreePath(project);
    const violations: Array<{ file: string; pattern: string }> = [];
    for (const file of changedFiles) {
      const pattern = matchesHandsOffSymlinkAware(
        file,
        project.hands_off,
        wtBase,
      );
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

    // 6d. gs-280: JSON syntax gate. Check that every `.json` file in
    //     the diff still parses. Catches the specific failure mode
    //     where a line-oriented bot edit to tasks.json drops a
    //     closing `},` between sibling objects — verification
    //     (pytest/ruff/etc.) won't parse it, reviewer eyeballs the
    //     diff but not structure, and the malformed file then breaks
    //     the NEXT cycle's task-peek (silent try/catch → nextTask
    //     undefined → creative-cycle routing stops firing). Read
    //     from the bot's worktree when present so we're checking the
    //     exact bytes the engineer committed; fall back to project
    //     path when the worktree isn't there (pre-cycle-6 code path).
    const jsonGateCwd = existsSync(botWorktreePath(project))
      ? botWorktreePath(project)
      : project.path;
    const malformedJson = await detectMalformedJsonFiles(
      jsonGateCwd,
      changedFiles,
    );
    if (malformedJson.length > 0) {
      const summary = malformedJson.map((m) => m.file).join(", ");
      result.final_outcome = "verification_failed";
      result.reason = `malformed JSON in diff: ${summary}`;
      result.verification_outcome = "failed";
      result.reviewer_verdict = "verification_failed";
      result.diff_stats = diffStats;
      console.log(`\nJSON syntax gate failed: ${result.reason}`);
      await appendProgress(project.id, "malformed_json", {
        files: malformedJson,
        changed_files: changedFiles,
      }, cycleId);
      break assemble;
    }

    // 6e. gs-318: anti-state-wipe gate. State-tracking files are
    //     intended to be append-only or stable; bulk deletion is
    //     never a normal cycle outcome. Catches the 2026-04-24
    //     incident where a cycle wiped 21 state files in one commit
    //     (see detectStateFileDeletions for full context).
    const stateDeletions = detectStateFileDeletions(fullDiff);
    if (stateDeletions.length > 0) {
      const list = stateDeletions.join(", ");
      result.final_outcome = "verification_failed";
      result.reason = `state-wipe gate: ${stateDeletions.length} state file(s) deleted: ${list}`;
      result.verification_outcome = "failed";
      result.reviewer_verdict = "verification_failed";
      result.diff_stats = diffStats;
      console.log(`\nState-wipe gate failed: ${result.reason}`);
      await appendProgress(project.id, "state_wipe_blocked", {
        deleted_files: stateDeletions,
      }, cycleId);
      break assemble;
    }

    // 7. Independent verification gate
    //    Run in the worktree if it exists (tests the bot's code, not master)
    const wt = botWorktreePath(project);
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
    //
    // gs-279: creative cycles SKIP the reviewer (RULE-RELAXATION-2026-04-20
    // guardrail 4). The reviewer's scope-drift + hands_off checks don't
    // translate cleanly to prose, and human review is the gate for
    // creative work. Verification still runs above so objective failures
    // (markdown lint, spell check) block the cycle normally. The hands_off
    // check above the verification step also still runs — creative opt-in
    // relaxes Rule #1 only, not Rule #5.
    if (isCreative) {
      console.log("Creative cycle — skipping reviewer (human review is the gate).");
      result.verification_outcome = verResult.outcome;
      result.diff_stats = diffStats;
      if (verResult.outcome === "failed") {
        result.final_outcome = "verification_failed";
        result.reviewer_verdict = "verification_failed";
        result.reason = `Verification gate failed (exit ${verResult.exitCode})`;
      } else if (verResult.outcome === "weak") {
        result.final_outcome = "verified_weak";
        result.reviewer_verdict = "verified_weak";
        result.reason = "Creative cycle — verification weak (human review pending)";
      } else {
        result.final_outcome = "verified";
        result.reviewer_verdict = "verified";
        result.reason = "Creative cycle — draft produced (human review pending)";
      }
    } else {
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

      // gs-306: optional mission-swarm preview. Graceful-skips when
      // the project has no missionswarm config, MISSIONSWARM_ROOT is
      // unset, or the subprocess fails. Never throws into the cycle.
      let missionswarmContext: string | undefined;
      if (nextTask && project.missionswarm) {
        try {
          const preview = await runMissionSwarmPreview(nextTask, project);
          if (preview.summary) {
            missionswarmContext = preview.summary;
            console.log(
              `Mission-swarm preview ${preview.cacheHit ? "cache-hit" : "fresh"} ` +
                `for ${nextTask.id} (${project.missionswarm.default_audience}).`,
            );
          } else if (preview.skipReason) {
            console.log(
              `Mission-swarm preview skipped for ${nextTask.id}: ${preview.skipReason}`,
            );
          }
        } catch (err) {
          console.log(
            `Mission-swarm preview errored (graceful-skip): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
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
          missionswarmContext,
          publicFacing: project.public_facing,
        },
        config,
        dryRun,
        reviewerCwd,
        reviewerProviderOverride ? { provider: reviewerProviderOverride } : undefined,
      );
      console.log(`Reviewer verdict: ${reviewerResult.verdict}`);
      if (reviewerResult.parseError) {
        console.log(`Reviewer parse error: ${reviewerResult.parseError}`);
      }

      // 8a. Sanity-check reviewer hands_off_violations against actual
      //     changed files. Some reviewer models (observed on Ollama
      //     qwen3:8b, 2026-04-17) hallucinate violations naming files
      //     not present in the diff, which then fails cycles that should
      //     pass. See gs-133.
      const sanity = applyReviewerSanityCheck(reviewerResult, changedFiles);
      if (sanity.dropped.length > 0) {
        await appendProgress(project.id, "reviewer_hallucination", {
          dropped_violations: sanity.dropped,
          changed_files: changedFiles,
          verdict_flipped: sanity.flipped,
        }, cycleId);
        if (sanity.flipped) {
          console.log(
            `Reviewer verdict flipped verification_failed → verified ` +
            `(all hands_off_violations hallucinated: ${sanity.dropped.join(", ")})`,
          );
        } else {
          console.log(
            `Dropped ${sanity.dropped.length} hallucinated hands_off_violation(s): ` +
            `${sanity.dropped.join(", ")}`,
          );
        }
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

    // gs-132: when a cycle is verification_failed and the engineer made
    // real commits (non-empty diff), reset the bot branch back to the
    // start SHA so the bad commits are discarded. Without this, the next
    // cycle's auto-merge path — or session-end auto-merge — will
    // fast-forward those rejected commits onto HEAD.
    const canRollback =
      result.cycle_start_sha !== "unknown" &&
      result.cycle_start_sha !== "skipped" &&
      result.cycle_start_sha !== result.cycle_end_sha;
    if (result.final_outcome === "verification_failed" && canRollback) {
      const beforeSha = result.cycle_end_sha;
      try {
        // Use update-ref so the reset works even when the branch is the
        // checked-out ref in a worktree (the typical .bot-worktree
        // setup). `git branch -f` refuses in that case. Rolls back the
        // effective branch — bot/work for correctness cycles, the
        // creative_work_branch for creative cycles (gs-279).
        await $`git -C ${project.path} update-ref refs/heads/${branch} ${result.cycle_start_sha}`.quiet();
        console.log(
          `Rolled back ${branch}: ${beforeSha.slice(0, 8)} → ${result.cycle_start_sha.slice(0, 8)}`,
        );
        result.cycle_end_sha = result.cycle_start_sha;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `Warning: rollback of ${branch} failed: ${msg}`,
        );
      }
      await appendProgress(project.id, "cycle_rollback", {
        branch,
        before_sha: beforeSha,
        after_sha: result.cycle_end_sha,
        reason: result.reason,
      }, cycleId);
    }

    // Field order mirrors the pre-refactor event layout so on-disk JSON
    // line shape is unchanged for downstream consumers. gs-279 adds the
    // `creative` flag (and task_id) for creative cycles so auditors can
    // grep `cycle_end` events by creative/non-creative cleanly.
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
      ...(isCreative ? { creative: true, task_id: nextTask?.id } : {}),
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
