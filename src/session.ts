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
import { appendProgress, loadProgressEvents, setVerboseMode } from "./audit";
import { isStopFilePresent } from "./safety";
import { join as pathJoin } from "path";
import { executeCycle, countCommitsAhead } from "./cycle";
import { killActiveEngineer } from "./active_engineer";
import { startStopFileWatcher } from "./stop_watcher";
import {
  pickNextProject,
  pickNextProjects,
  shouldChain,
  estimateSessionPlan,
} from "./dispatcher";
import type { SessionPlanEstimate } from "./dispatcher";
import { formatDuration, formatFileCount } from "./format";
import { fetchCommitSubject } from "./git";
import { notifySessionEnd } from "./notify";
import { countRemainingWork } from "./work_detection";
import { categorizeResults } from "./results";
import { checkOllamaReachable } from "./ollama";
import { generateDigestNarrative } from "./digest_llm";
import { loadProviderRegistry, getProviderForRole } from "./providers/registry";
import type { LLMProvider } from "./providers/types";
import type {
  SessionOptions,
  CycleResult,
  ProjectConfig,
  ProjectsYaml,
} from "./types";

// Watchdog threshold multiplier. 2x the per-project cycle budget was picked as
// a conservative "probably stuck, not just slow" signal — normal engineer
// runs that brush against their budget still get through without alarm,
// but a cycle that doubles its budget is almost always stalled on an
// engineer or reviewer step that deserves human eyes.
export const WATCHDOG_MULTIPLIER = 2;

// gs-193: fast-fail backoff thresholds. N consecutive verification_failed
// outcomes within M seconds wall → soft-skip the project for the rest of
// the session. Defaults chosen to catch (a) ~1-sec engineer crashes (82
// retries in 2 min observed on raybrain 2026-04-18) and (b) ~5-min
// verification failures from hands-off scope collisions (5 retries × 5
// min = ~$0.15 OpenRouter spend wasted on the same collision).
export const DEFAULT_SOFT_SKIP_THRESHOLD = 3;
export const DEFAULT_SOFT_SKIP_WINDOW_SECONDS = 600;

export interface FailureStreak {
  count: number;
  windowStartMs: number;
}

export interface FailureStreakUpdate {
  streak: FailureStreak;
  shouldSoftSkip: boolean;
  spanSeconds: number;
}

/**
 * Advance a project's consecutive-failure streak by one cycle outcome.
 *
 * A "failure" here is any `verification_failed` outcome — that bucket
 * covers engineer abnormal exit, hands-off violations, verification-gate
 * failures, and reviewer rejections (all routed through cycle.ts to
 * `final_outcome: "verification_failed"`). `cycle_skipped` is NOT counted
 * as a failure (pre-flight abort, not a progress signal) and should
 * short-circuit before calling this function; `verified` / `verified_weak`
 * are successes that reset the streak.
 *
 * @param prev Previous streak state (omit / undefined for the first call).
 * @param isFailure Whether the cycle just completed was a failure.
 * @param nowMs Current wall-clock time in milliseconds.
 * @param maxFailures Streak length that triggers soft-skip. Default
 *   `DEFAULT_SOFT_SKIP_THRESHOLD` (3).
 * @param windowSeconds Elapsed-seconds ceiling from first-failure-in-streak
 *   to current failure that still triggers soft-skip. Default
 *   `DEFAULT_SOFT_SKIP_WINDOW_SECONDS` (600).
 * @returns The updated streak, whether this cycle crossed the soft-skip
 *   threshold, and the span (seconds) from first failure to now.
 */
// Pure state transition for a project's consecutive-failure streak.
// A "failure" here is any verification_failed outcome — that bucket
// covers engineer abnormal exit, hands-off violations, verification
// gate failures, and reviewer rejections (all routed through
// cycle.ts to final_outcome=verification_failed). cycle_skipped is
// NOT counted as a failure (pre-flight abort, not a progress signal)
// and should short-circuit before calling this function; verified /
// verified_weak are successes that reset the streak.
export function updateFailureStreak(
  prev: FailureStreak | undefined,
  isFailure: boolean,
  nowMs: number,
  maxFailures: number = DEFAULT_SOFT_SKIP_THRESHOLD,
  windowSeconds: number = DEFAULT_SOFT_SKIP_WINDOW_SECONDS,
): FailureStreakUpdate {
  if (!isFailure) {
    return {
      streak: { count: 0, windowStartMs: nowMs },
      shouldSoftSkip: false,
      spanSeconds: 0,
    };
  }
  const windowStartMs =
    prev && prev.count > 0 ? prev.windowStartMs : nowMs;
  const count = (prev?.count ?? 0) + 1;
  const spanSeconds = Math.max(0, (nowMs - windowStartMs) / 1000);
  const shouldSoftSkip = count >= maxFailures && spanSeconds <= windowSeconds;
  return {
    streak: { count, windowStartMs },
    shouldSoftSkip,
    spanSeconds,
  };
}

// gs-191: hot-reload the projects list between cycles so projects
// registered mid-session (e.g. raybrain registered ~30 min into a
// running session 2026-04-18) are visible to the picker. Only the
// projects list is hot-reloaded — dispatcher config (state paths,
// cycle caps, digest dir) stays frozen at session start because
// changing those mid-flight could corrupt in-flight cycle state.
//
// If loadProjectsYaml throws (yaml transiently invalid while the
// operator edits the file), return the cached list and the error
// so the session can warn + continue rather than crashing on a
// typo.
export interface HotReloadResult {
  projects: ProjectConfig[];
  added: string[];
  removed: string[];
  error?: string;
}

/**
 * Re-read `projects.yaml` and diff against the cached list.
 *
 * Called between cycles so mid-session edits to `projects.yaml` are visible
 * to the picker. Only the projects list is refreshed; dispatcher config
 * stays frozen at session start to avoid in-flight state corruption.
 *
 * If the loader throws (invalid YAML mid-edit), the cached list is returned
 * with `error` populated — callers warn and continue rather than crashing.
 *
 * @param cached The projects list currently in use by the session loop.
 * @param loader Injection point for tests; defaults to `loadProjectsYaml`.
 * @returns `{projects, added, removed}` on success; `{projects: cached,
 *   added: [], removed: [], error: string}` on loader failure.
 */
export async function hotReloadProjects(
  cached: ProjectConfig[],
  loader: () => Promise<ProjectsYaml> = loadProjectsYaml,
): Promise<HotReloadResult> {
  let yaml: ProjectsYaml;
  try {
    yaml = await loader();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { projects: cached, added: [], removed: [], error: msg };
  }
  const cachedIds = new Set(cached.map((p) => p.id));
  const newIds = new Set(yaml.projects.map((p) => p.id));
  const added = [...newIds].filter((id) => !cachedIds.has(id));
  const removed = [...cachedIds].filter((id) => !newIds.has(id));
  return { projects: yaml.projects, added, removed };
}

export function checkCycleWatchdog(
  durationSeconds: number,
  cycleBudgetMinutes: number,
): string | null {
  if (cycleBudgetMinutes <= 0) return null;
  const thresholdSeconds = cycleBudgetMinutes * 60 * WATCHDOG_MULTIPLIER;
  if (durationSeconds <= thresholdSeconds) return null;
  return (
    `[WATCHDOG] cycle took ${formatDuration(durationSeconds)}, ` +
    `${WATCHDOG_MULTIPLIER}x the ${cycleBudgetMinutes}-min budget — ` +
    `consider investigating`
  );
}

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
  const { budgetMinutes, dryRun, maxCycles, excludeProjects, verbose } = options;
  const sessionStart = Date.now();

  // Streams every appendProgress() call to stdout for the duration of this
  // session. Reset on exit so subsequent non-verbose sessions in the same
  // process (tests, repls) don't inherit the flag.
  setVerboseMode(Boolean(verbose));

  console.log(`\n=== GeneralStaff Session ===`);
  console.log(`Budget: ${budgetMinutes} min`);
  if (maxCycles !== undefined) {
    console.log(`Max cycles: ${maxCycles}`);
  }
  console.log(`Dry run: ${dryRun}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const yaml = await loadProjectsYaml();
  // gs-191: mutable so the main loop can swap in a fresh list between
  // cycles when projects.yaml is edited mid-session.
  let projects = yaml.projects;
  const config = yaml.dispatcher;
  const fleet = await loadFleetState(config);

  // Validate and initialize exclude set. Unknown ids warn but don't abort —
  // the operator likely has a stale project list in their head and shouldn't
  // lose the rest of the session over a typo.
  const excludeSet = new Set<string>();
  if (excludeProjects && excludeProjects.length > 0) {
    const known = new Set(projects.map((p) => p.id));
    for (const id of excludeProjects) {
      if (!known.has(id)) {
        console.warn(
          `Warning: --exclude-project="${id}" does not match any registered project (ignored)`,
        );
        continue;
      }
      excludeSet.add(id);
    }
    if (excludeSet.size > 0) {
      console.log(`Excluding: ${[...excludeSet].join(", ")}\n`);
    }
  }

  const eligibleProjects = projects.filter((p) => !excludeSet.has(p.id));

  if (!dryRun && eligibleProjects.length > 0) {
    const plan = estimateSessionPlan(
      eligibleProjects,
      fleet,
      budgetMinutes,
      config.max_cycles_per_project_per_session,
    );
    console.log(formatSessionPlanPreview(plan));
  }

  // Pre-flight Ollama reachability check. When the reviewer provider is
  // Ollama, a down server causes every cycle to fail-safe to
  // verification_failed — the warning here gives clearer error attribution
  // than discovering it cycle-by-cycle. Non-fatal: the session proceeds,
  // and the per-cycle fallback chain (GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER)
  // is the real safety net.
  if (
    !dryRun &&
    (process.env.GENERALSTAFF_REVIEWER_PROVIDER ?? "").toLowerCase() ===
      "ollama"
  ) {
    const check = await checkOllamaReachable();
    if (!check.reachable) {
      console.warn(
        `Warning: Ollama unreachable at ${check.host} (${check.error ?? "unknown"}).\n` +
          `  Start the server with 'ollama serve', or set\n` +
          `  GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER=openrouter to auto-fall-back.`,
      );
    }
  }

  // Reset per-session cycle counts
  for (const p of projects) {
    const state = await loadProjectState(p.id, config);
    state.cycles_this_session = 0;
    await saveProjectState(state, config);
  }

  const allResults: CycleResult[] = [];
  const cyclesPerProject = new Map<string, number>();
  const skippedProjects = new Set<string>(excludeSet);
  const failureStreaks = new Map<string, FailureStreak>();

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

  // gs-186: total wall-clock minutes during which at least one parallel
  // slot was waiting for a slower sibling cycle. Only non-zero when
  // max_parallel_slots > 1; tracked so the user / DESIGN.md §v6
  // open-question #3 can make the round-based-wait vs early-start
  // decision from real data, not guesses.
  let slotIdleTotalSeconds = 0;
  let parallelRounds = 0;
  // gs-196: per-round cycle arrays, accumulated only in parallel mode so
  // writeDigest can group the `## Details` section under `### Round N`
  // headers. Left empty in sequential mode — the digest falls back to the
  // flat rendering unchanged.
  const cycleRoundsAccumulator: CycleResult[][] = [];

  // gs-131: mid-cycle STOP file detection. isStopFilePresent() is only
  // checked at cycle boundaries; this fs.watch on the STOP path kills the
  // live engineer subprocess the moment the STOP file is created, so the
  // bot doesn't keep working for 30+ minutes after an operator asked it
  // to stop. Wrapped in try/catch because mocked/partial safety modules
  // (in subprocess test helpers) may not expose stopFilePath — the outer
  // cycle-boundary check is still a safety net in that case.
  let stopWatcher: { close(): void } = { close: () => {} };
  try {
    // Compute the STOP path directly rather than importing stopFilePath
    // from safety.ts — several subprocess test helpers mock safety.ts
    // with only `isStopFilePresent`, and a named import would fail
    // module resolution in those fixtures.
    const path = pathJoin(getRootDir(), "STOP");
    stopWatcher = startStopFileWatcher(path, () => {
      console.log("\nSTOP file detected mid-cycle — killing active engineer.");
      killActiveEngineer();
    });
  } catch {
    /* watcher is optional; continue with the cycle-boundary check */
  }

  const isParallelMode = config.max_parallel_slots > 1;
  if (isParallelMode) {
    console.log(
      `Parallel mode: max_parallel_slots = ${config.max_parallel_slots} ` +
        `(strict round-based wait; chaining disabled — each round picks ` +
        `fresh projects).`,
    );
  }

  // gs-186: parallel path. Round-based strict-wait — pick up to N
  // eligible projects, Promise.all their cycles, then process each
  // result sequentially (no races since single-threaded JS). Chaining
  // is disabled in this mode; the simpler round-picker is DESIGN.md
  // §v6 option (a). Slot idle time accumulates across rounds so the
  // §v6 open question #3 can be answered from observed data.
  if (isParallelMode) {
    const MAX_ALL_EMPTY_ROUNDS = 3;
    let consecutiveAllEmptyRounds = 0;

    parallelLoop: while (remainingMinutes() > 0) {
      if (maxCycles !== undefined && allResults.length >= maxCycles) {
        console.log(`\nMax-cycles limit reached (${maxCycles}) — ending session.`);
        stopReason = "max-cycles";
        break;
      }
      if (await isStopFilePresent()) {
        console.log("\nSTOP file detected — ending session.");
        stopReason = "stop-file";
        break;
      }

      // Hot-reload projects.yaml (gs-191) between rounds.
      const reload = await hotReloadProjects(projects);
      projects = reload.projects;
      if (reload.error) {
        console.warn(
          `[projects.yaml] reload failed (using cached list): ${reload.error}`,
        );
      } else {
        if (reload.added.length > 0) {
          console.log(
            `[projects.yaml] newly registered: ${reload.added.join(", ")}`,
          );
        }
        if (reload.removed.length > 0) {
          console.log(
            `[projects.yaml] unregistered: ${reload.removed.join(", ")}`,
          );
        }
      }

      const updatedFleet = await loadFleetState(config);
      const picks = await pickNextProjects(
        projects,
        config,
        updatedFleet,
        skippedProjects,
        config.max_parallel_slots,
      );
      if (picks.length === 0) {
        console.log("\nNo eligible project — ending session.");
        stopReason = "no-project";
        break;
      }

      // Per-slot budget check: exclude candidates whose cycle budget
      // won't fit in the remaining wall clock. In parallel mode the
      // slots share wall clock (Promise.all), so each is checked
      // independently — we don't sum budgets.
      const eligible = picks.filter(
        (p) => remainingMinutes() >= p.project.cycle_budget_minutes + 5,
      );
      if (eligible.length === 0) {
        console.log(
          `\nInsufficient budget for any candidate — ending session.`,
        );
        stopReason = "insufficient-budget";
        break;
      }

      parallelRounds++;
      console.log(`\n=== Round ${parallelRounds}: ${eligible.length} parallel cycle(s) ===`);
      for (const p of eligible) {
        console.log(`  slot → ${p.project.id} (${p.reason})`);
      }

      const roundStartMs = Date.now();
      const roundResults = await Promise.all(
        eligible.map((p) => executeCycle(p.project, config, dryRun)),
      );
      const roundWallMs = Date.now() - roundStartMs;
      cycleRoundsAccumulator.push([...roundResults]);

      // slot_idle accounting: per-slot idle is roundWall - cycleDuration;
      // total idle across the round is the sum (an approximation of
      // "compute we could have done in parallel but didn't").
      for (const r of roundResults) {
        const cycleMs =
          new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
        slotIdleTotalSeconds += Math.max(0, roundWallMs - cycleMs) / 1000;
      }

      // Process each result — same post-cycle logic as the sequential
      // loop except for chaining (dropped in parallel mode).
      let allEmptyThisRound = true;
      for (let i = 0; i < eligible.length; i++) {
        const project = eligible[i].project;
        const result = roundResults[i];

        allResults.push(result);
        const count = (cyclesPerProject.get(project.id) ?? 0) + 1;
        cyclesPerProject.set(project.id, count);

        const cycleDurationSec = Math.max(
          0,
          (new Date(result.ended_at).getTime() -
            new Date(result.started_at).getTime()) /
            1000,
        );
        console.log(
          `  Cycle ${allResults.length}: ${project.id} — ${result.final_outcome} ` +
            `(took ${formatDuration(cycleDurationSec)})`,
        );

        const watchdogWarning = checkCycleWatchdog(
          cycleDurationSec,
          project.cycle_budget_minutes,
        );
        if (watchdogWarning) console.error(watchdogWarning);

        if (result.final_outcome === "verification_failed") {
          console.error(
            `  [FAILED] ${project.id} cycle ${result.cycle_id.slice(0, 12)}: ${result.reason}`,
          );
        }

        // Empty-round tracking (mirrors sequential consecutiveEmptyCycles).
        // Only "verified_weak + empty diff" qualifies; cycle_skipped and
        // anything failing is NOT counted as empty (those are signals
        // with their own handling).
        const isEmpty =
          result.final_outcome === "verified_weak" &&
          result.reason?.includes("empty diff");
        if (!isEmpty) allEmptyThisRound = false;

        if (result.final_outcome === "cycle_skipped") {
          skippedProjects.add(project.id);
          continue;
        }

        // gs-193 fast-fail applies per project, irrespective of parallelism.
        const isFailure = result.final_outcome === "verification_failed";
        const streakUpdate = updateFailureStreak(
          failureStreaks.get(project.id),
          isFailure,
          Date.now(),
        );
        failureStreaks.set(project.id, streakUpdate.streak);
        if (streakUpdate.shouldSoftSkip) {
          const span = Math.round(streakUpdate.spanSeconds);
          const reason =
            `${streakUpdate.streak.count} consecutive failures in ${span}s ` +
            `(threshold ${DEFAULT_SOFT_SKIP_THRESHOLD} / ${DEFAULT_SOFT_SKIP_WINDOW_SECONDS}s)`;
          console.log(
            `  [SOFT-SKIP] ${project.id}: ${reason} — dropping for rest of session.`,
          );
          skippedProjects.add(project.id);
          await appendProgress(project.id, "project_soft_skipped", {
            reason,
            consecutive_failures: streakUpdate.streak.count,
            span_seconds: span,
            threshold_failures: DEFAULT_SOFT_SKIP_THRESHOLD,
            threshold_seconds: DEFAULT_SOFT_SKIP_WINDOW_SECONDS,
          });
          continue;
        }

        // Per-project cycle cap. Sequential mode handles this via
        // shouldChain; in parallel mode we check directly so a hot
        // project doesn't get re-picked endlessly.
        if (count >= config.max_cycles_per_project_per_session) {
          skippedProjects.add(project.id);
        }
      }

      if (allEmptyThisRound) {
        consecutiveAllEmptyRounds++;
        if (consecutiveAllEmptyRounds >= MAX_ALL_EMPTY_ROUNDS) {
          console.log(
            `\n${MAX_ALL_EMPTY_ROUNDS} consecutive all-empty rounds — ending session.`,
          );
          stopReason = "empty-cycles";
          break parallelLoop;
        }
      } else {
        consecutiveAllEmptyRounds = 0;
      }
    }
  } else while (remainingMinutes() > 0) {
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
      // gs-191: refresh projects.yaml so mid-session registrations are
      // picked up. Warn on reload errors but don't crash — transient
      // invalid-yaml during an operator edit shouldn't kill the session.
      const reload = await hotReloadProjects(projects);
      projects = reload.projects;
      if (reload.error) {
        console.warn(
          `[projects.yaml] reload failed (using cached list): ${reload.error}`,
        );
      } else {
        if (reload.added.length > 0) {
          console.log(
            `[projects.yaml] newly registered: ${reload.added.join(", ")}`,
          );
        }
        if (reload.removed.length > 0) {
          console.log(
            `[projects.yaml] unregistered: ${reload.removed.join(", ")}`,
          );
        }
      }

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
    const cycleDurationSec = Math.max(
      0,
      (new Date(result.ended_at).getTime() - new Date(result.started_at).getTime()) / 1000,
    );
    const cycleDurationStr = formatDuration(cycleDurationSec);
    // ETA: project the session's natural end using the avg cycle duration
    // observed so far. Need ≥2 cycles for a meaningful sample; a single
    // data point would swing wildly on any cycle that happens to be fast
    // or slow.
    let etaStr = "";
    if (allResults.length >= 2) {
      const totalCycleMs = allResults.reduce((sum, r) => {
        const d = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
        return sum + Math.max(0, d);
      }, 0);
      const avgCycleMs = totalCycleMs / allResults.length;
      const remainingBudgetMs = Math.max(0, remainingMinutes() * 60_000);
      const estRemainingCycles =
        avgCycleMs > 0 ? Math.floor(remainingBudgetMs / avgCycleMs) : 0;
      const projectedEnd = new Date(Date.now() + estRemainingCycles * avgCycleMs);
      const hh = String(projectedEnd.getHours()).padStart(2, "0");
      const mm = String(projectedEnd.getMinutes()).padStart(2, "0");
      etaStr = `, projected end: ${hh}:${mm}`;
    }
    console.log(
      `Cycle ${allResults.length} completed: ${currentProject.id} — ` +
        `${result.final_outcome} (took ${cycleDurationStr}, ${remainingStr} remaining${etaStr})`,
    );

    const watchdogWarning = checkCycleWatchdog(
      cycleDurationSec,
      currentProject.cycle_budget_minutes,
    );
    if (watchdogWarning) {
      console.error(watchdogWarning);
    }

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

    // gs-193: fast-fail backoff. Accumulate consecutive verification_failed
    // outcomes per project; if the streak reaches the threshold inside the
    // window, drop the project from the session. Prevents retry-spin when
    // a project's engineer_command is broken (case a: 82 cycles in 2 min)
    // or when queued tasks collide with hands_off patterns (case b: 5
    // cycles × 5 min each, ~$0.15 of OpenRouter spend wasted).
    const isFailure = result.final_outcome === "verification_failed";
    const streakUpdate = updateFailureStreak(
      failureStreaks.get(currentProject.id),
      isFailure,
      Date.now(),
    );
    failureStreaks.set(currentProject.id, streakUpdate.streak);

    if (streakUpdate.shouldSoftSkip) {
      const span = Math.round(streakUpdate.spanSeconds);
      const reason =
        `${streakUpdate.streak.count} consecutive failures in ${span}s ` +
        `(threshold ${DEFAULT_SOFT_SKIP_THRESHOLD} failures / ` +
        `${DEFAULT_SOFT_SKIP_WINDOW_SECONDS}s window)`;
      console.log(
        `\n[SOFT-SKIP] ${currentProject.id}: ${reason} — ` +
          `dropping project for rest of session.`,
      );
      skippedProjects.add(currentProject.id);
      await appendProgress(currentProject.id, "project_soft_skipped", {
        reason,
        consecutive_failures: streakUpdate.streak.count,
        span_seconds: span,
        threshold_failures: DEFAULT_SOFT_SKIP_THRESHOLD,
        threshold_seconds: DEFAULT_SOFT_SKIP_WINDOW_SECONDS,
      });
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
  // master only reflects N-1. Safe because gs-132 guarantees it:
  // verification_failed cycles roll their commits off bot/work before
  // cycle_end, so anything reachable here has passed the gate.
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

  // gs-188: compute parallel efficiency once for both the digest and
  // the session_complete event. elapsed is minutes; convert to seconds
  // for the formula which matches slot_idle_seconds' unit.
  const parallelEfficiency = computeParallelEfficiency(
    slotIdleTotalSeconds,
    elapsed * 60,
    config.max_parallel_slots,
  );
  const parallelMetricsForDigest: DigestParallelMetrics | undefined = isParallelMode
    ? {
        max_parallel_slots: config.max_parallel_slots,
        parallel_rounds: parallelRounds,
        slot_idle_seconds: Math.round(slotIdleTotalSeconds),
        parallel_efficiency: parallelEfficiency,
      }
    : undefined;

  // Write digest
  await writeDigest(allResults, elapsed, {
    digest_dir: config.digest_dir,
    reviewer_provider: process.env.GENERALSTAFF_REVIEWER_PROVIDER,
    reviewer_model: process.env.GENERALSTAFF_REVIEWER_MODEL,
    parallel_metrics: parallelMetricsForDigest,
    cycle_rounds: isParallelMode ? cycleRoundsAccumulator : undefined,
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
  const reviewerProvider = process.env.GENERALSTAFF_REVIEWER_PROVIDER || "claude";
  const reviewerModel = process.env.GENERALSTAFF_REVIEWER_MODEL;
  const reviewerLabel = reviewerModel
    ? `${reviewerProvider} (${reviewerModel})`
    : reviewerProvider;
  // gs-186: parallel mode reports rounds + cumulative slot idle. Left
  // unset in sequential mode so the event shape is unchanged for
  // existing consumers. parallel_efficiency = 1 - idle / (rounds *
  // slots * max-possible-round-wall); we don't compute it here because
  // "max-possible" needs the budget distribution — leave that to the
  // digest renderer or a later observability pass (gs-188).
  const parallelMetrics = isParallelMode
    ? {
        parallel_rounds: parallelRounds,
        max_parallel_slots: config.max_parallel_slots,
        slot_idle_seconds: Math.round(slotIdleTotalSeconds),
        parallel_efficiency: Math.round(parallelEfficiency * 1000) / 1000,
      }
    : {};
  await appendProgress("_fleet", "session_complete", {
    duration_minutes: Math.round(elapsed),
    total_cycles: allResults.length,
    total_verified: fleetBuckets.verified.length,
    total_failed: fleetBuckets.failed.length,
    stop_reason: stopReason,
    reviewer: reviewerLabel,
    ...parallelMetrics,
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

  stopWatcher.close();
  setVerboseMode(false);
  return allResults;
}

// gs-126: run N back-to-back sessions. Each child session does its own
// setup/digest/teardown; there is no shared state other than the on-disk
// project state that runSession already persists. The runner parameter
// is injected for unit tests so we can exercise the loop without spinning
// up a real fleet.
export async function runSessionChain(
  options: SessionOptions,
  chain: number,
  runner: (opts: SessionOptions) => Promise<CycleResult[]> = runSession,
): Promise<CycleResult[][]> {
  if (!Number.isInteger(chain) || chain < 1) {
    throw new Error(`--chain must be a positive integer (got ${chain})`);
  }
  const runs: CycleResult[][] = [];
  for (let i = 0; i < chain; i++) {
    if (chain > 1) {
      console.log(`\n=== Chained session ${i + 1} of ${chain} ===`);
    }
    const r = await runner(options);
    runs.push(r);
  }
  return runs;
}

async function resolveDigestNarrative(
  results: CycleResult[],
  durationMinutes: number,
  override: LLMProvider | undefined,
): Promise<string | null> {
  if (results.length === 0) return null;
  const providerId = process.env.GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER;
  if (!providerId || providerId.length === 0) return null;

  let provider: LLMProvider | null = override ?? null;
  if (!provider) {
    const { existsSync } = require("fs");
    const { join } = require("path");
    const configPath = join(getRootDir(), "provider_config.yaml");
    if (!existsSync(configPath)) return null;
    try {
      const registry = await loadProviderRegistry(configPath);
      if (
        registry.providers.has(providerId) &&
        registry.routes.digest === providerId
      ) {
        provider = getProviderForRole(registry, "digest");
      }
    } catch (err) {
      console.log(
        `digest narrative: registry load failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!provider) return null;
  }

  try {
    const result = await generateDigestNarrative(
      results,
      durationMinutes,
      provider,
    );
    if (result.fellBack) {
      console.log(
        `digest narrative: fell back — ${result.error ?? "unknown"}`,
      );
      return null;
    }
    return result.narrative;
  } catch (err) {
    console.log(
      `digest narrative: provider error — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface WriteDigestDeps {
  // gs-158 test seam. When set AND env var
  // GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER is non-empty, this overrides
  // the registry-based resolution so tests can inject a stub without
  // standing up a real provider_config.yaml + live ollama.
  narrativeProvider?: LLMProvider;
}

// gs-188: optional parallel-mode metrics rendered into the digest when
// the session ran with max_parallel_slots > 1. Skipped entirely in
// sequential mode (undefined / omitted) so the digest shape stays
// identical for the common case.
export interface DigestParallelMetrics {
  max_parallel_slots: number;
  parallel_rounds: number;
  slot_idle_seconds: number;
  parallel_efficiency: number; // 0..1
}

/**
 * Compute `parallel_efficiency` for a session.
 *
 * Definition: `1 - slotIdleSeconds / (elapsedSeconds × maxParallelSlots)`.
 * 1.0 means every slot-second was occupied by a cycle; 0.0 means every
 * slot-second was idle. Result is clamped to `[0, 1]` because rounding in
 * the input numbers can push the raw expression marginally outside range.
 *
 * Returns 1 when the session was sequential (`maxParallelSlots <= 1`) or
 * when `elapsedSeconds` is non-positive (degenerate divide-by-zero guard).
 *
 * @param slotIdleSeconds Cumulative slot-idle seconds reported by the
 *   parallel loop.
 * @param elapsedSeconds Session wall-clock elapsed, in seconds.
 * @param maxParallelSlots Configured slot count (`dispatcher.max_parallel_slots`).
 * @returns Efficiency in `[0, 1]`.
 */
// gs-188: compute parallel_efficiency from cumulative slot idle and
// the session's wall-clock elapsed × slot count. 1.0 = every slot
// fully utilized; lower = some slots waited idle for slower siblings.
// Clamped to [0, 1] because rounding in elapsed/slot_idle can push it
// marginally outside the range.
export function computeParallelEfficiency(
  slotIdleSeconds: number,
  elapsedSeconds: number,
  maxParallelSlots: number,
): number {
  if (maxParallelSlots <= 1 || elapsedSeconds <= 0) return 1;
  const totalSlotSeconds = elapsedSeconds * maxParallelSlots;
  if (totalSlotSeconds <= 0) return 1;
  const efficiency = 1 - slotIdleSeconds / totalSlotSeconds;
  if (efficiency < 0) return 0;
  if (efficiency > 1) return 1;
  return efficiency;
}

export async function writeDigest(
  results: CycleResult[],
  durationMinutes: number,
  config: {
    digest_dir: string;
    reviewer_provider?: string;
    reviewer_model?: string;
    parallel_metrics?: DigestParallelMetrics;
    // gs-196: when supplied with at least one round of size > 1, the
    // `## Details` section is grouped under per-round `### Round N`
    // headers so parallel-mode digests don't interleave cycles
    // confusingly. Absent or all-size-1 → flat rendering (no regression
    // for sequential sessions).
    cycle_rounds?: CycleResult[][];
  },
  deps?: WriteDigestDeps,
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

  // gs-158: optional LLM-backed narrative. Default OFF — only runs when the
  // operator opts in via GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER AND the
  // registry routes the digest role at that same id (safety: a typo'd env
  // var shouldn't silently pick the wrong provider). Any failure falls back
  // to a narrative-less digest so this path can never block the session end.
  const narrative = await resolveDigestNarrative(
    results,
    durationMinutes,
    deps?.narrativeProvider,
  );

  let content = `# GeneralStaff Session Digest\n\n`;
  content += `**Date:** ${new Date().toISOString()}\n`;
  content += `**Duration:** ${formatDuration(durationMinutes * 60)}\n`;
  content += `**Cycles:** ${results.length}\n`;
  content += `**Reviewer:** ${reviewerLabel}\n`;
  if (results.length > 0) {
    content += `**Summary:** ${verified.length} verified, ${failed.length} failed\n`;
    if (narrative) {
      content += `**Narrative:** ${narrative}\n`;
    }
  }
  // gs-188: parallel-mode summary. Only rendered when the session
  // actually ran with max_parallel_slots > 1 — sequential sessions
  // show an unchanged digest header.
  if (config.parallel_metrics && config.parallel_metrics.max_parallel_slots > 1) {
    const pm = config.parallel_metrics;
    const effPct = (pm.parallel_efficiency * 100).toFixed(1);
    content +=
      `**Parallel:** ${pm.max_parallel_slots} slots, ` +
      `${pm.parallel_rounds} round(s), ` +
      `${formatDuration(pm.slot_idle_seconds)} slot-idle, ` +
      `${effPct}% efficiency\n`;
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
          ? `  _(${formatFileCount(r.diff_stats.files_changed)}, +${r.diff_stats.insertions}/-${r.diff_stats.deletions})_`
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

  // gs-196: group by round if any round has >1 cycle. Otherwise use flat
  // rendering (matches sequential sessions, no regression).
  const useRoundHeaders =
    !!config.cycle_rounds && config.cycle_rounds.some((rd) => rd.length > 1);

  const renderCycleBlock = (r: CycleResult) => {
    let block = `## ${r.project_id} — ${r.cycle_id}\n\n`;
    block += `- **Outcome:** ${r.final_outcome}\n`;
    block += `- **Reason:** ${r.reason}\n`;
    block += `- **SHA:** ${r.cycle_start_sha.slice(0, 8)} → ${r.cycle_end_sha.slice(0, 8)}\n`;
    if (r.diff_stats) {
      const s = r.diff_stats;
      block += `- **Diff:** ${s.files_changed} file(s), +${s.insertions}/-${s.deletions}\n`;
    }
    block += `- **Engineer exit:** ${r.engineer_exit_code}\n`;
    block += `- **Verification:** ${r.verification_outcome}\n`;
    block += `- **Reviewer:** ${r.reviewer_verdict}\n\n`;
    return block;
  };

  if (useRoundHeaders && config.cycle_rounds) {
    config.cycle_rounds.forEach((round, idx) => {
      const maxCycleMs = round.reduce((acc, r) => {
        const d =
          new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
        return d > acc ? d : acc;
      }, 0);
      const roundWallSec = Math.max(0, Math.round(maxCycleMs / 1000));
      content +=
        `### Round ${idx + 1} (${formatDuration(roundWallSec)} wall, ` +
        `${round.length} cycle(s))\n\n`;
      for (const r of round) {
        content += renderCycleBlock(r);
      }
    });
  } else {
    for (const r of results) {
      content += renderCycleBlock(r);
    }
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

// Reverse formatDuration: "1h15m" / "2m30s" / "45s" → fractional minutes.
// Returns 0 for unparseable input (regen still produces output, just with
// an unknown duration line).
export function parseFormattedDuration(s: string): number {
  const m = s.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  return h * 60 + min + sec / 60;
}

// gs-113: rebuild a digest from PROGRESS.jsonl cycle_end events. Reads the
// source digest to learn the cycle list (project_id + cycle_id pairs) and
// reviewer/duration metadata, then loads the matching cycle_end entries and
// hands them to writeDigest. writeDigest uses a fresh timestamp so the new
// file never overwrites the source.
export async function regenerateDigest(
  sourceDigestPath: string,
  config: { digest_dir: string },
): Promise<{ results: CycleResult[]; missing: Array<{ project_id: string; cycle_id: string }> }> {
  const { readFileSync } = require("fs");
  const markdown = readFileSync(sourceDigestPath, "utf8");
  const parsed = parseDigest(markdown);

  // Reviewer line: "**Reviewer:** provider" or "**Reviewer:** provider (model)".
  // Keeping the model optional matches writeDigest's own conditional.
  const reviewerMatch = markdown.match(/\*\*Reviewer:\*\*\s*(\S+)(?:\s*\(([^)]+)\))?/);
  const reviewerProvider = reviewerMatch ? reviewerMatch[1] : undefined;
  const reviewerModel = reviewerMatch && reviewerMatch[2] ? reviewerMatch[2] : undefined;

  const results: CycleResult[] = [];
  const missing: Array<{ project_id: string; cycle_id: string }> = [];

  for (const c of parsed.cycles) {
    const events = await loadProgressEvents(
      c.project_id,
      (e) => e.event === "cycle_end" && e.cycle_id === c.cycle_id,
    );
    if (events.length === 0) {
      missing.push({ project_id: c.project_id, cycle_id: c.cycle_id });
      const fallback = resultFromDigestCycle(c);
      if (fallback) results.push(fallback);
      continue;
    }
    results.push(resultFromProgressEntry(events[0], c));
  }

  const durationMinutes = parsed.duration ? parseFormattedDuration(parsed.duration) : 0;

  await writeDigest(results, durationMinutes, {
    digest_dir: config.digest_dir,
    reviewer_provider: reviewerProvider,
    reviewer_model: reviewerModel,
  });

  return { results, missing };
}

function resultFromProgressEntry(
  entry: { timestamp: string; data: Record<string, unknown> },
  c: ParsedDigestCycle,
): CycleResult {
  const d = entry.data;
  const endedAt = entry.timestamp;
  const durSec = typeof d.duration_seconds === "number" ? d.duration_seconds : 0;
  const startedAt = new Date(new Date(endedAt).getTime() - durSec * 1000).toISOString();
  const diff = d.diff_stats as { files_changed: number; insertions: number; deletions: number } | undefined;
  return {
    cycle_id: c.cycle_id,
    project_id: c.project_id,
    started_at: startedAt,
    ended_at: endedAt,
    cycle_start_sha: typeof d.start_sha === "string" ? d.start_sha : "",
    cycle_end_sha: typeof d.end_sha === "string" ? d.end_sha : "",
    engineer_exit_code:
      typeof d.engineer_exit_code === "number" ? d.engineer_exit_code : null,
    verification_outcome: (d.verification_outcome ?? "failed") as CycleResult["verification_outcome"],
    reviewer_verdict: (d.reviewer_verdict ?? "verification_failed") as CycleResult["reviewer_verdict"],
    final_outcome: (d.outcome ?? "verification_failed") as CycleResult["final_outcome"],
    reason: typeof d.reason === "string" ? d.reason : "",
    diff_stats: diff && typeof diff === "object"
      ? {
          files_changed: Number(diff.files_changed) || 0,
          insertions: Number(diff.insertions) || 0,
          deletions: Number(diff.deletions) || 0,
        }
      : undefined,
  };
}

function resultFromDigestCycle(c: ParsedDigestCycle): CycleResult | null {
  if (!c.outcome) return null;
  const now = new Date().toISOString();
  return {
    cycle_id: c.cycle_id,
    project_id: c.project_id,
    started_at: now,
    ended_at: now,
    cycle_start_sha: c.sha_start ?? "",
    cycle_end_sha: c.sha_end ?? "",
    engineer_exit_code: c.engineer_exit,
    verification_outcome: (c.verification ?? "failed") as CycleResult["verification_outcome"],
    reviewer_verdict: (c.reviewer ?? "verification_failed") as CycleResult["reviewer_verdict"],
    final_outcome: c.outcome as CycleResult["final_outcome"],
    reason: c.reason ?? "",
    diff_stats: c.diff_stats ?? undefined,
  };
}
