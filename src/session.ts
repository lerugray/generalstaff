// GeneralStaff — session module (build step 14)
// Outer loop: time budget → pick project → cycle → chain or rotate → repeat

import { $ } from "bun";
import { loadProjectsYaml } from "./projects";
import {
  loadFleetState,
  saveFleetState,
  loadProjectState,
  saveProjectState,
  getRootDir,
} from "./state";
import { appendProgress } from "./audit";
import { isStopFilePresent } from "./safety";
import { executeCycle, countCommitsAhead } from "./cycle";
import { pickNextProject, shouldChain, estimateSessionPlan } from "./dispatcher";
import type { SessionPlanEstimate } from "./dispatcher";
import { formatDuration } from "./format";
import { fetchCommitSubject } from "./git";
import { notifySessionEnd } from "./notify";
import { countRemainingWork } from "./work_detection";
import { categorizeResults } from "./results";
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
    const buckets = categorizeResults(projectResults);
    const project = projects.find((p) => p.id === projectId);
    const remaining = project ? await countRemainingWork(project) : 0;
    console.log(
      `  ${projectId}: ${count} cycle(s) — ` +
        `${buckets.verified.length} verified, ${buckets.failed.length} failed, ${buckets.skipped.length} skipped ` +
        `(${remaining} task(s) remaining)`,
    );
  }

  // Write digest
  await writeDigest(allResults, elapsed, {
    digest_dir: config.digest_dir,
    reviewer_provider: process.env.GENERALSTAFF_REVIEWER_PROVIDER,
    reviewer_model: process.env.GENERALSTAFF_REVIEWER_MODEL,
  });

  // Log session end for each project
  for (const p of projects) {
    const projectResults = allResults.filter((r) => r.project_id === p.id);
    const buckets = categorizeResults(projectResults);
    await appendProgress(p.id, "session_end", {
      duration_minutes: Math.round(elapsed),
      total_cycles: projectResults.length,
      total_verified: buckets.verified.length,
      total_failed: buckets.failed.length,
    });
  }

  // Fleet-level session_complete event. Fires exactly once per session
  // with aggregated stats; written to the "_fleet" pseudo-project log so
  // it isn't tied to any individual project's PROGRESS.jsonl.
  const fleetBuckets = categorizeResults(allResults);
  await appendProgress("_fleet", "session_complete", {
    duration_minutes: Math.round(elapsed),
    total_cycles: allResults.length,
    total_verified: fleetBuckets.verified.length,
    total_failed: fleetBuckets.failed.length,
    stop_reason: stopReason,
  });

  // End-of-session Telegram notification. Moved here from the .bat
  // wrapper because post-bun steps in run_session.bat weren't reliably
  // reached when the .bat was spawned from a detached context. Running
  // it here means any launcher path — .bat, direct `bun src/cli.ts
  // session`, Task Scheduler, whatever — produces the notification.
  // notifySessionEnd silently skips if credentials aren't configured,
  // and all internal failures are swallowed so this can never crash
  // the session.
  if (!dryRun) {
    const tasksDone = fleetBuckets.verified.map(
      (r) => fetchCommitSubject(r.cycle_start_sha, r.cycle_end_sha) || r.cycle_id,
    );
    await notifySessionEnd({
      success: fleetBuckets.failed.length === 0,
      budgetMinutes,
      durationMinutes: elapsed,
      verified: fleetBuckets.verified.length,
      failed: fleetBuckets.failed.length,
      skipped: fleetBuckets.skipped.length,
      tasksDone,
      logPath: process.env.GENERALSTAFF_SESSION_LOG,
    });
  }

  return allResults;
}

export async function writeDigest(
  results: CycleResult[],
  durationMinutes: number,
  config: {
    digest_dir: string;
    reviewer_provider?: string;
    reviewer_model?: string;
  },
) {
  const { mkdirSync, existsSync } = require("fs");
  const { writeFile } = require("fs/promises");
  const { join } = require("path");

  const digestDir = join(getRootDir(), config.digest_dir);
  if (!existsSync(digestDir)) {
    mkdirSync(digestDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "_").replace(/\.\d+Z$/, "");
  const digestPath = join(digestDir, `digest_${ts}.md`);

  const buckets = categorizeResults(results);
  const verified = buckets.verified;
  // Digest "Issues" lumps skipped and failed together as anything-not-verified.
  // Filter on the original results to preserve cycle order.
  const failed = results.filter(
    (r) => r.final_outcome !== "verified" && r.final_outcome !== "verified_weak",
  );

  const reviewerProvider = (
    config.reviewer_provider ?? "claude"
  ).toLowerCase();
  const reviewerLabel = config.reviewer_model
    ? `${reviewerProvider} (${config.reviewer_model})`
    : reviewerProvider;

  let content = `# GeneralStaff Session Digest\n\n`;
  content += `**Date:** ${new Date().toISOString()}\n`;
  content += `**Duration:** ${formatDuration(durationMinutes * 60)}\n`;
  content += `**Cycles:** ${results.length}\n`;
  content += `**Reviewer:** ${reviewerLabel}\n`;
  if (results.length > 0) {
    content += `**Summary:** ${verified.length} verified, ${failed.length} failed\n`;
  }
  content += `\n`;

  if (results.length > 0) {
    content += `## What got done\n\n`;
    if (verified.length === 0) {
      content += `_No cycles passed verification this session._\n\n`;
    } else {
      verified.forEach((r, i) => {
        const subject = fetchCommitSubject(r.cycle_start_sha, r.cycle_end_sha) || r.cycle_id;
        const diff = r.diff_stats
          ? `  _(${r.diff_stats.files_changed} file(s), +${r.diff_stats.insertions}/-${r.diff_stats.deletions})_`
          : "";
        content += `${i + 1}. ${subject}${diff}\n`;
      });
      content += `\n`;
    }

    content += `## Issues\n\n`;
    if (failed.length === 0) {
      content += `_None — all cycles passed verification._\n\n`;
    } else {
      for (const r of failed) {
        const subject = fetchCommitSubject(r.cycle_start_sha, r.cycle_end_sha) || r.cycle_id;
        content += `- **${subject}** — ${r.final_outcome}: ${r.reason}\n`;
      }
      content += `\n`;
    }

    content += `---\n\n`;
    content += `## Details\n\n`;
    content += `_Per-cycle technical detail (SHAs, reviewer verdicts) below._\n\n`;
  }

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

export interface ParsedDigestCycle {
  project_id: string;
  cycle_id: string;
  outcome: string | null;
  reason: string | null;
  sha_start: string | null;
  sha_end: string | null;
  diff_stats: { files_changed: number; insertions: number; deletions: number } | null;
  engineer_exit: number | null;
  verification: string | null;
  reviewer: string | null;
}

export interface ParsedDigest {
  date: string | null;
  duration: string | null;
  cycle_count: number | null;
  cycles: ParsedDigestCycle[];
}

export function parseDigest(markdown: string): ParsedDigest {
  const dateMatch = markdown.match(/\*\*Date:\*\*\s*(.+)/);
  const durationMatch = markdown.match(/\*\*Duration:\*\*\s*(.+)/);
  const cyclesMatch = markdown.match(/\*\*Cycles:\*\*\s*(\d+)/);

  const cycles: ParsedDigestCycle[] = [];
  const sectionRe = /^## (.+?) — (.+?)$/gm;
  const sections: { project_id: string; cycle_id: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(markdown)) !== null) {
    sections.push({
      project_id: m[1].trim(),
      cycle_id: m[2].trim(),
      start: m.index + m[0].length,
    });
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1].start : markdown.length;
    const body = markdown.slice(s.start, end);
    const outcome = body.match(/\*\*Outcome:\*\*\s*(.+)/);
    const reason = body.match(/\*\*Reason:\*\*\s*(.+)/);
    const sha = body.match(/\*\*SHA:\*\*\s*(\S+)\s*(?:→|->)\s*(\S+)/);
    const diff = body.match(/\*\*Diff:\*\*\s*(\d+)\s*file.*?,\s*\+(\d+)\/-(\d+)/);
    const engineer = body.match(/\*\*Engineer exit:\*\*\s*(-?\d+)/);
    const verification = body.match(/\*\*Verification:\*\*\s*(.+)/);
    const reviewer = body.match(/\*\*Reviewer:\*\*\s*(.+)/);
    cycles.push({
      project_id: s.project_id,
      cycle_id: s.cycle_id,
      outcome: outcome ? outcome[1].trim() : null,
      reason: reason ? reason[1].trim() : null,
      sha_start: sha ? sha[1] : null,
      sha_end: sha ? sha[2] : null,
      diff_stats: diff
        ? {
            files_changed: Number(diff[1]),
            insertions: Number(diff[2]),
            deletions: Number(diff[3]),
          }
        : null,
      engineer_exit: engineer ? Number(engineer[1]) : null,
      verification: verification ? verification[1].trim() : null,
      reviewer: reviewer ? reviewer[1].trim() : null,
    });
  }

  return {
    date: dateMatch ? dateMatch[1].trim() : null,
    duration: durationMatch ? durationMatch[1].trim() : null,
    cycle_count: cyclesMatch ? Number(cyclesMatch[1]) : null,
    cycles,
  };
}
