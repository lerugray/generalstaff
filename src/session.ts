// GeneralStaff — session module (build step 14)
// Outer loop: time budget → pick project → cycle → chain or rotate → repeat

import { loadProjectsYaml } from "./projects";
import {
  loadFleetState,
  saveFleetState,
  loadProjectState,
  saveProjectState,
} from "./state";
import { appendProgress } from "./audit";
import { isStopFilePresent } from "./safety";
import { executeCycle } from "./cycle";
import { pickNextProject, shouldChain } from "./dispatcher";
import type { SessionOptions, CycleResult, ProjectConfig } from "./types";

export async function runSession(options: SessionOptions) {
  const { budgetMinutes, dryRun } = options;
  const sessionStart = Date.now();

  console.log(`\n=== GeneralStaff Session ===`);
  console.log(`Budget: ${budgetMinutes} min`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const yaml = await loadProjectsYaml();
  const { projects } = yaml;
  const config = yaml.dispatcher;
  const fleet = await loadFleetState(config);

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

  while (remainingMinutes() > 0) {
    // Check STOP file
    if (await isStopFilePresent()) {
      console.log("\nSTOP file detected — ending session.");
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
      break;
    }

    // Execute cycle
    const result = await executeCycle(currentProject, config, dryRun);
    allResults.push(result);

    // Track cycles per project
    const count = (cyclesPerProject.get(currentProject.id) ?? 0) + 1;
    cyclesPerProject.set(currentProject.id, count);

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
      currentProject = null; // will pick next project
    }
  }

  // Write session summary
  const elapsed = elapsedMinutes();
  console.log(`\n=== Session Complete ===`);
  console.log(`Duration: ${elapsed.toFixed(1)} min`);
  console.log(`Cycles: ${allResults.length}`);

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
    console.log(
      `  ${projectId}: ${count} cycle(s) — ` +
        `${verified} verified, ${failed} failed, ${skipped} skipped`,
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
  content += `**Duration:** ${durationMinutes.toFixed(1)} min\n`;
  content += `**Cycles:** ${results.length}\n\n`;

  for (const r of results) {
    content += `## ${r.project_id} — ${r.cycle_id}\n\n`;
    content += `- **Outcome:** ${r.final_outcome}\n`;
    content += `- **Reason:** ${r.reason}\n`;
    content += `- **SHA:** ${r.cycle_start_sha.slice(0, 8)} → ${r.cycle_end_sha.slice(0, 8)}\n`;
    content += `- **Engineer exit:** ${r.engineer_exit_code}\n`;
    content += `- **Verification:** ${r.verification_outcome}\n`;
    content += `- **Reviewer:** ${r.reviewer_verdict}\n\n`;
  }

  await writeFile(digestPath, content, "utf8");
  console.log(`\nDigest written to: ${digestPath}`);
}
