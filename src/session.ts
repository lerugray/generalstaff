// GeneralStaff — session module (build step 14)
// Outer loop: time budget → pick project → cycle → chain or rotate → repeat

import { $ } from "bun";
import { loadProjectsYaml } from "./projects";
import {
  loadFleetState,
  saveFleetState,
  loadProjectState,
  saveProjectState,
} from "./state";
import { appendProgress } from "./audit";
import { isStopFilePresent } from "./safety";
import { executeCycle, countCommitsAhead } from "./cycle";
import { pickNextProject, shouldChain, estimateSessionPlan } from "./dispatcher";
import type { SessionPlanEstimate } from "./dispatcher";
import { formatDuration } from "./format";
import { countRemainingWork } from "./work_detection";
import type { SessionOptions, CycleResult, ProjectConfig } from "./types";

export function formatSessionPlanPreview(plan: SessionPlanEstimate): string {
  const lines: string[] = [];
  lines.push("=== Session Plan Preview ===");
  if (plan.total_cycles === 0) {
    lines.push("No cycles fit in the budget.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    `Total: ${plan.total_cycles} cycle(s), ` +
      `${plan.budget_used_minutes} min used, ` +
      `${plan.budget_remaining_minutes} min remaining`,
  );
  const maxIdLen = Math.max(
    7, // "Project".length
    ...plan.per_project.map((p) => p.project_id.length),
  );
  lines.push(`  ${"Project".padEnd(maxIdLen)}  Cycles`);
  lines.push(`  ${"-".repeat(maxIdLen)}  ------`);
  for (const p of plan.per_project) {
    lines.push(`  ${p.project_id.padEnd(maxIdLen)}  ${p.cycle_count}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function runSession(options: SessionOptions) {
  const { budgetMinutes, dryRun, maxCycles } = options;
  const sessionStart = Date.now();

  console.log(`\n=== GeneralStaff Session ===`);
  console.log(`Budget: ${budgetMinutes} min`);
  if (maxCycles !== undefined) {
    console.log(`Max cycles: ${maxCycles}`);
  }
  console.log(`Dry run: ${dryRun}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const yaml = await loadProjectsYaml();
  const { projects } = yaml;
  const config = yaml.dispatcher;
  const fleet = await loadFleetState(config);

  if (!dryRun && projects.length > 0) {
    const plan = estimateSessionPlan(
      projects,
      fleet,
      budgetMinutes,
      config.max_cycles_per_project_per_session,
    );
    console.log(formatSessionPlanPreview(plan));
  }

  // Reset per-session cycle counts
  for (const p of projects) {
    const state = await loadProjectState(p.id, config);
    state.cycles_this_session = 0;
    await saveProjectState(state, config);
  }

  const allResults: CycleResult[] = [];
  const cyclesPerProject = new Map<string, number>();
  const skippedProjects = new Set<string>();

  function elapsedMinutes(): number {
    return (Date.now() - sessionStart) / 60_000;
  }

  function remainingMinutes(): number {
    return budgetMinutes - elapsedMinutes();
  }

  // Log session start for each project
  for (const p of projects) {
    await appendProgress(p.id, "session_start", {
      budget_minutes: budgetMinutes,
      dry_run: dryRun,
      registered_projects: projects.map((pr) => pr.id),
    });
  }

  // Auto-commit session initialization so the tree is clean for cycle checks
  // (matters for dogfooding where the project IS the GeneralStaff repo)
  try {
    const root = (await import("./state")).getRootDir();
    await import("bun").then(({ $ }) =>
      $`git -C ${root} add --ignore-errors state/`.quiet().nothrow()
    );
    const hasStagedChanges = await import("bun").then(({ $ }) =>
      $`git -C ${root} diff --cached --quiet`.quiet().nothrow().then((r) => r.exitCode !== 0)
    );
    if (hasStagedChanges) {
      await import("bun").then(({ $ }) =>
        $`git -C ${root} commit -m ${"state: session init"}`.quiet()
      );
    }
  } catch { /* non-fatal */ }

  let currentProject: ProjectConfig | null = null;
  let pickReason: string = "";
  let consecutiveEmptyCycles = 0;
  const MAX_CONSECUTIVE_EMPTY = 3;

  let stopReason: "budget" | "max-cycles" | "stop-file" | "no-project" | "insufficient-budget" | "empty-cycles" = "budget";

  while (remainingMinutes() > 0) {
    // Max-cycles cap — stops before running another cycle
    if (maxCycles !== undefined && allResults.length >= maxCycles) {
      console.log(`\nMax-cycles limit reached (${maxCycles}) — ending session.`);
      stopReason = "max-cycles";
      break;
    }

    // Check STOP file
    if (await isStopFilePresent()) {
      console.log("\nSTOP file detected — ending session.");
      stopReason = "stop-file";
      break;
    }

    // Pick next project (or continue chaining)
    if (!currentProject) {
      const updatedFleet = await loadFleetState(config);
      const pick = await pickNextProject(
        projects,
        config,
        updatedFleet,
        skippedProjects,
      );
      if (!pick) {
        console.log("\nNo eligible project — ending session.");
        stopReason = "no-project";
        break;
      }
      currentProject = pick.project;
      pickReason = pick.reason;
      console.log(
        `\nPicked: ${currentProject.id} (${pickReason})`,
      );
    }

    // Check budget
    const needed = currentProject.cycle_budget_minutes + 5;
    if (remainingMinutes() < needed) {
      console.log(
        `\nInsufficient budget for ${currentProject.id} ` +
          `(need ${needed} min, have ${remainingMinutes().toFixed(0)} min)`,
      );
      stopReason = "insufficient-budget";
      break;
    }

    // Execute cycle
    const result = await executeCycle(currentProject, config, dryRun);
    allResults.push(result);

    // Track cycles per project
    const count = (cyclesPerProject.get(currentProject.id) ?? 0) + 1;
    cyclesPerProject.set(currentProject.id, count);

    // Live progress between cycles — makes long sessions readable
    const remainingStr = formatDuration(Math.max(0, remainingMinutes()) * 60);
    console.log(
      `Cycle ${allResults.length} completed: ${currentProject.id} — ` +
        `${result.final_outcome} (${remainingStr} remaining)`,
    );

    // Guard against runaway empty cycles
    if (result.final_outcome === "verified_weak" &&
        result.reason?.includes("empty diff")) {
      consecutiveEmptyCycles++;
      if (consecutiveEmptyCycles >= MAX_CONSECUTIVE_EMPTY) {
        console.log(
          `\n${MAX_CONSECUTIVE_EMPTY} consecutive empty cycles — ending session.`,
        );
        stopReason = "empty-cycles";
        break;
      }
    } else {
      consecutiveEmptyCycles = 0;
    }

    // Alert on verification failure
    if (result.final_outcome === "verification_failed") {
      console.error(
        `[FAILED] ${currentProject.id} cycle ${result.cycle_id.slice(0, 12)}: ${result.reason}`,
      );
    }

    // Handle skipped cycles
    if (result.final_outcome === "cycle_skipped") {
      skippedProjects.add(currentProject.id);
      currentProject = null;
      continue;
    }

    // Chaining decision
    const chainDecision = await shouldChain(
      result,
      currentProject,
      count,
      config.max_cycles_per_project_per_session,
      remainingMinutes(),
    );

    if (chainDecision.chain) {
      console.log(`Chaining: ${chainDecision.reason}`);
      // Stay on same project
    } else {
      console.log(`Not chaining: ${chainDecision.reason}`);
      // If cap reached, skip this project for the rest of the session
      if (chainDecision.reason === "per-project cycle cap reached") {
        skippedProjects.add(currentProject.id);
      }
      currentProject = null; // will pick next project
    }
  }

  // Session-end merge: for any project with auto_merge=true that has
  // verified work sitting on its bot branch, merge it into HEAD now.
  // Without this, the final cycle's work waits on bot/work until the
  // next session's first cycle picks it up via the cycle.ts path —
  // cosmetically confusing because the digest says N verified while
  // master only reflects N-1. Safe: anything on bot/work here has
  // already passed the per-cycle verification gate.
  for (const p of projects) {
    if (!p.auto_merge) continue;
    if (!cyclesPerProject.has(p.id)) continue;
    try {
      const unmerged = await countCommitsAhead(p.path, p.branch, "HEAD");
      if (unmerged > 0) {
        console.log(
          `Session end: auto-merging ${unmerged} commit(s) from ${p.branch} into HEAD (${p.id})...`,
        );
        const msg = `Merge branch '${p.branch}' (session-end auto, ${unmerged} cycle-commit(s))`;
        await $`git -C ${p.path} merge --no-ff ${p.branch} -m ${msg}`.quiet();
        console.log(`Merged ${p.branch} into HEAD.`);
      }
    } catch {
      console.log(
        `Warning: session-end merge of ${p.branch} failed for ${p.id} — manual merge required`,
      );
    }
  }

  // Write session summary
  const elapsed = elapsedMinutes();
  console.log(`\n=== Session Complete ===`);
  console.log(`Duration: ${elapsed.toFixed(1)} min`);
  console.log(`Cycles: ${allResults.length}`);
  console.log(`Stop reason: ${stopReason}`);

  for (const [projectId, count] of cyclesPerProject) {
    const projectResults = allResults.filter(
      (r) => r.project_id === projectId,
    );
    const verified = projectResults.filter(
      (r) =>
        r.final_outcome === "verified" ||
        r.final_outcome === "verified_weak",
    ).length;
    const failed = projectResults.filter(
      (r) => r.final_outcome === "verification_failed",
    ).length;
    const skipped = projectResults.filter(
      (r) => r.final_outcome === "cycle_skipped",
    ).length;
    const project = projects.find((p) => p.id === projectId);
    const remaining = project ? await countRemainingWork(project) : 0;
    console.log(
      `  ${projectId}: ${count} cycle(s) — ` +
        `${verified} verified, ${failed} failed, ${skipped} skipped ` +
        `(${remaining} task(s) remaining)`,
    );
  }

  // Write digest
  await writeDigest(allResults, elapsed, config);

  // Log session end for each project
  for (const p of projects) {
    const projectResults = allResults.filter((r) => r.project_id === p.id);
    await appendProgress(p.id, "session_end", {
      duration_minutes: Math.round(elapsed),
      total_cycles: projectResults.length,
      total_verified: projectResults.filter(
        (r) => r.final_outcome === "verified" || r.final_outcome === "verified_weak",
      ).length,
      total_failed: projectResults.filter(
        (r) => r.final_outcome === "verification_failed",
      ).length,
    });
  }

  return allResults;
}

export async function writeDigest(
  results: CycleResult[],
  durationMinutes: number,
  config: { digest_dir: string },
) {
  const { mkdirSync, existsSync } = require("fs");
  const { writeFile } = require("fs/promises");
  const { join } = require("path");
  const { getRootDir } = require("./state");

  const digestDir = join(getRootDir(), config.digest_dir);
  if (!existsSync(digestDir)) {
    mkdirSync(digestDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "_").replace(/\.\d+Z$/, "");
  const digestPath = join(digestDir, `digest_${ts}.md`);

  let content = `# GeneralStaff Session Digest\n\n`;
  content += `**Date:** ${new Date().toISOString()}\n`;
  content += `**Duration:** ${formatDuration(durationMinutes * 60)}\n`;
  content += `**Cycles:** ${results.length}\n\n`;

  for (const r of results) {
    content += `## ${r.project_id} — ${r.cycle_id}\n\n`;
    content += `- **Outcome:** ${r.final_outcome}\n`;
    content += `- **Reason:** ${r.reason}\n`;
    content += `- **SHA:** ${r.cycle_start_sha.slice(0, 8)} → ${r.cycle_end_sha.slice(0, 8)}\n`;
    if (r.diff_stats) {
      const s = r.diff_stats;
      content += `- **Diff:** ${s.files_changed} file(s), +${s.insertions}/-${s.deletions}\n`;
    }
    content += `- **Engineer exit:** ${r.engineer_exit_code}\n`;
    content += `- **Verification:** ${r.verification_outcome}\n`;
    content += `- **Reviewer:** ${r.reviewer_verdict}\n\n`;
  }

  await writeFile(digestPath, content, "utf8");
  console.log(`\nDigest written to: ${digestPath}`);
}
