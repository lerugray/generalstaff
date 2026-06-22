// GeneralStaff — autonomous-mode session (gs-332, 2026-06-22, v0.8.0)
//
// GS's opt-in autonomous front-end (wintermute folded in). For each project
// with `autonomous.enabled`, run the pipeline:
//   SURVEY (read MISSION + git log + tasks.json)  → scope.ts
//   SCOPE  (off-cap model proposes N work items)   → scope.ts
//   GATE+CLASSIFY (KEEP/REJECT + BOT-SAFE/DESIGN-FORK, one call) → judgment_gate.ts
//   LEDGER (design-forks / live-held → fork-ledger for Ray)      → fork_ledger.ts
//   DISPATCH (execute mode: BOT-SAFE work → cycle.ts → dispatch-ledger)
//
// Two modes:
//   PREVIEW (default) — scope+gate+fork-ledger only; every BOT-SAFE+KEEP
//     non-live item is reported as a dispatch-candidate but nothing runs.
//   EXECUTE (opts.execute) — additionally dispatch BOT-SAFE+KEEP work through
//     the normal cycle (engineer → verify → reviewer → bot branch), capped, and
//     record each in the dispatch-ledger for Ray's review. NEVER pushes/merges
//     — the work is automated, the MERGE stays gated on Ray. Live/revenue
//     projects only dispatch when opts.liveDispatch is set (separate, tighter
//     cap); otherwise their bot-safe work is held (fork-ledger live-held).
//
// Dispatch reuses cycle.ts (the plan's "Option A") so the reviewer, hands_off
// enforcement, and PROGRESS.jsonl audit trail all apply unchanged. Exact task
// targeting: the synthetic task is added, every pre-existing pending task is
// excluded, so the cycle can only pick the autonomous item.
//
// Default-off — projects without `autonomous.enabled` never run.

import { existsSync } from "fs";
import { join } from "path";
import type {
  ProjectsYaml,
  ProjectConfig,
  DispatcherConfig,
  ClassifiedItem,
  CycleResult,
} from "./types";
import {
  survey,
  scope,
  parseScopedItems,
  DEFAULT_SCOPER_MODEL,
  DEFAULT_SCOPE_COUNT,
} from "./scope";
import { runClassifyGate } from "./judgment_gate";
import { updateForkLedger, type HeldItem } from "./fork_ledger";
import {
  updateDispatchLedger,
  type DispatchedCycle,
} from "./dispatch_ledger";
import { loadTasks, addTask } from "./tasks";
import { executeCycle } from "./cycle";
import { getStateDir } from "./state";

// Phase 2 dispatch defaults (overridable via dispatcher.autonomous).
export const DEFAULT_DISPATCH_CAP = 2;
export const DEFAULT_LIVE_DISPATCH_CAP = 1;

// What happens to each scoped item in the (dry-run) pipeline.
export type ItemDisposition =
  | "dropped" // gate REJECT — slop/premature, not surfaced
  | "design-fork" // KEEP + DESIGN-FORK — needs Ray (taste/scope/$/legal)
  | "live-held" // KEEP + BOT-SAFE on a live project — held for Ray's review
  | "dispatch-candidate" // KEEP + BOT-SAFE, non-live — would auto-fire in Phase 2
  | "unclassified"; // gate error, or a KEEP with no CLASS on a NON-live project — not ledgered (a re-run reclassifies)

/** Bucket one classified item. Pure — the testable core of the dry-run report.
 *  Kept in exact agreement with updateForkLedger's is_decision (a KEEP that is
 *  design-fork, or any KEEP on a live project, is a Ray-decision) so the CLI
 *  summary and the written ledger never disagree. Mirrors wintermute's
 *  held-reason logic. */
export function disposition(
  item: ClassifiedItem,
  isLive: boolean,
): ItemDisposition {
  if (item.verdict === "reject") return "dropped";
  // The gate couldn't even decide KEEP/REJECT — re-run reclassifies.
  if (item.verdict === "error") return "unclassified";
  // verdict === "keep" below.
  if (!item.class) {
    // KEEP but no parseable CLASS. On a live product, hold it for Ray
    // (conservative — never silently drop work on a revenue product); on a
    // non-live project, drop it (low stakes; a re-run reclassifies). This is
    // exactly updateForkLedger's is_decision (keep && (design-fork || live)).
    return isLive ? "live-held" : "unclassified";
  }
  if (item.class === "design-fork") return "design-fork";
  // bot-safe + keep
  return isLive ? "live-held" : "dispatch-candidate";
}

function emptyDisposition(): Record<ItemDisposition, ClassifiedItem[]> {
  return {
    dropped: [],
    "design-fork": [],
    "live-held": [],
    "dispatch-candidate": [],
    unclassified: [],
  };
}

/** Resolve the scoper model for a project: per-project override → fleet default
 *  → env override → built-in default. */
export function resolveScoperModel(
  project: ProjectConfig,
  config: ProjectsYaml,
): string {
  return (
    project.autonomous?.scoper_model ??
    config.dispatcher.autonomous?.scoper_model ??
    process.env.GENERALSTAFF_SCOPER_MODEL ??
    DEFAULT_SCOPER_MODEL
  );
}

/** Resolve how many items to scope for a project. */
export function resolveScopeCount(
  project: ProjectConfig,
  config: ProjectsYaml,
): number {
  return (
    project.autonomous?.scope_count ??
    config.dispatcher.autonomous?.scope_count ??
    DEFAULT_SCOPE_COUNT
  );
}

export interface AutonomousRunOptions {
  // PREVIEW (default false) vs EXECUTE. When false, scope+gate+fork-ledger run
  // but nothing dispatches (the safe default — bot-safe items are reported as
  // candidates). When true, BOT-SAFE+KEEP work is dispatched through cycle.ts.
  execute?: boolean;
  // Also branch-dispatch on live/revenue projects (separate, tighter cap).
  // Default false — live products' bot-safe work is held for Ray otherwise.
  liveDispatch?: boolean;
  // Run the dispatched cycles with the engineer in dry-run (no-op) — exercises
  // the full dispatch path (task targeting, cycle, ledger) without spending
  // engineer tokens or editing code. For safe trials of the dispatch wiring.
  cycleDryRun?: boolean;
  // Restrict to a subset of the autonomous-enabled projects (CLI --project=).
  projectFilter?: string[];
  // BYOK; defaults to process.env.OPENROUTER_API_KEY.
  apiKey?: string;
  // Override the git-log window survey() reads.
  logWindow?: number;
  // Reviewer provider override threaded into dispatched cycles.
  reviewerProviderOverride?: string;
  // Run timestamp for ledger entries; defaults to now (ISO 8601).
  ts?: string;
}

export interface ProjectAutonomousResult {
  project: string;
  scopedCount: number;
  classified: ClassifiedItem[];
  byDisposition: Record<ItemDisposition, ClassifiedItem[]>;
  // Survey/scope/classify failure for this project (the run continues with the
  // rest — one project's failure never aborts the fleet pass).
  error?: string;
}

export interface AutonomousRunResult {
  // True in preview mode (no dispatch); false when execute dispatched work.
  dryRun: boolean;
  ledgerPath: string;
  newLedgerDecisions: number;
  projects: ProjectAutonomousResult[];
  // autonomous-enabled but repo absent on this host (skipped, not an error).
  skipped: string[];
  // EXECUTE-mode dispatch results (empty in preview).
  dispatchLedgerPath: string;
  newDispatches: number;
  dispatched: DispatchedCycle[];
}

/** Resolve the non-live dispatch cap (per-run, fleet-wide). */
export function resolveDispatchCap(config: ProjectsYaml): number {
  return config.dispatcher.autonomous?.dispatch_cap ?? DEFAULT_DISPATCH_CAP;
}

/** Resolve the live dispatch cap (per-run, fleet-wide). */
export function resolveLiveDispatchCap(config: ProjectsYaml): number {
  return config.dispatcher.autonomous?.live_dispatch_cap ?? DEFAULT_LIVE_DISPATCH_CAP;
}

/** Dispatch ONE bot-safe item through cycle.ts. Adds a synthetic task, excludes
 *  every pre-existing task so the cycle can only pick the new one, runs the full
 *  cycle (engineer → verify → reviewer → bot branch), and returns a
 *  DispatchedCycle when the cycle left reviewable work (verified / verified_weak)
 *  — null otherwise (skipped, failed-and-rolled-back, or no diff). NEVER pushes
 *  or merges: that's cycle.ts's auto_merge gate (kept false on dispatched
 *  projects), and the merge stays Ray's call. */
export async function dispatchItem(
  project: ProjectConfig,
  config: DispatcherConfig,
  item: ClassifiedItem,
  opts: {
    live: boolean;
    cycleDryRun?: boolean;
    reviewerProviderOverride?: string;
  },
): Promise<DispatchedCycle | null> {
  // Exclude every existing task so the picker can ONLY land on the synthetic
  // one (exact targeting via the existing sessionExcludedTaskIds mechanism).
  const existing = await loadTasks(project.id);
  const excludeIds = new Set(existing.map((t) => t.id));

  // Synthetic task — high priority (it's the only pickable one anyway). Left
  // pending in tasks.json after the cycle: the next survey sees its title and
  // won't re-propose the work (dedup), and the dispatch-ledger is the source of
  // truth for "awaiting review". A normal `gs session` would skip it only if
  // re-flagged; autonomous-managed projects aren't typically in blind rotation.
  await addTask(project.id, item.title, 1);

  const result: CycleResult = await executeCycle(
    project,
    config,
    opts.cycleDryRun ?? false,
    opts.reviewerProviderOverride,
    excludeIds,
  );

  return dispatchRecordFromResult(result, project, item.title, opts.live);
}

/** Map a finished cycle to a dispatch-ledger record — or null when there's
 *  nothing to review. Pure, so every outcome is deterministically testable
 *  without driving a real cycle. Records ONLY cycles that left REVIEWABLE work
 *  on the bot branch:
 *    - outcome verified / verified_weak (verification_failed rolls back;
 *      cycle_skipped never ran — both have nothing committed), AND
 *    - the branch actually moved (start SHA != end SHA) — an empty-diff
 *      verified_weak (a no-op engineer under --cycle-dry-run, or an engineer
 *      that changed nothing) has an empty branch, nothing to review. */
export function dispatchRecordFromResult(
  result: CycleResult,
  project: ProjectConfig,
  title: string,
  live: boolean,
): DispatchedCycle | null {
  const landed =
    (result.final_outcome === "verified" ||
      result.final_outcome === "verified_weak") &&
    result.cycle_start_sha !== result.cycle_end_sha &&
    result.cycle_end_sha !== "skipped";
  if (!landed) return null;
  return {
    project: project.id,
    title,
    branch: project.branch,
    cycle_id: result.cycle_id,
    sha: result.cycle_end_sha,
    live,
    status: result.final_outcome,
  };
}

/** Run the autonomous-mode pipeline across all autonomous-enabled projects in
 *  `config`. In PREVIEW mode (default) the only write is the fork-ledger; in
 *  EXECUTE mode it additionally dispatches BOT-SAFE work through cycle.ts and
 *  writes the dispatch-ledger (never pushing/merging). One project's failure is
 *  captured in its result and does not abort the rest. */
export async function runAutonomousSession(
  config: ProjectsYaml,
  opts: AutonomousRunOptions = {},
): Promise<AutonomousRunResult> {
  const ts = opts.ts ?? new Date().toISOString();
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  // Hard precondition for the whole run — no project can scope/gate without it.
  // Fail fast with a clear message rather than degrading every project to error.
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set — autonomous scope+gate require it (BYOK, Hard Rule 8).",
    );
  }
  const ledgerPath = join(getStateDir(config.dispatcher), "fork-ledger.json");

  let enabled = config.projects.filter((p) => p.autonomous?.enabled);
  if (opts.projectFilter && opts.projectFilter.length > 0) {
    const want = new Set(opts.projectFilter);
    enabled = enabled.filter((p) => want.has(p.id));
  }
  // Skip projects whose repo isn't cloned on THIS host (so the same roster runs
  // on Mac or home-PC without erroring on a machine missing one of the clones).
  const present = enabled.filter((p) => existsSync(p.path));
  const skipped = enabled
    .filter((p) => !existsSync(p.path))
    .map((p) => p.id);

  const liveProjects = new Set(
    present.filter((p) => p.autonomous?.live).map((p) => p.id),
  );

  const projects: ProjectAutonomousResult[] = [];
  const allHeld: HeldItem[] = [];

  for (const project of present) {
    const result: ProjectAutonomousResult = {
      project: project.id,
      scopedCount: 0,
      classified: [],
      byDisposition: emptyDisposition(),
    };
    try {
      const digest = survey(project, config.dispatcher, {
        logWindow: opts.logWindow,
      });
      const count = resolveScopeCount(project, config);
      const rawScope = await scope(
        digest,
        resolveScoperModel(project, config),
        apiKey,
        { count },
      );
      const items = parseScopedItems(rawScope, count);
      result.scopedCount = items.length;
      if (items.length > 0) {
        const classified = await runClassifyGate(project, items, rawScope, {
          apiKey,
        });
        result.classified = classified;
        const isLive = liveProjects.has(project.id);
        for (const c of classified) {
          result.byDisposition[disposition(c, isLive)].push(c);
          allHeld.push({
            project: project.id,
            title: c.title,
            verdict: c.verdict,
            cls: c.class,
          });
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    projects.push(result);
  }

  // LEDGER — updateForkLedger filters to genuine Ray-decisions (KEEP +
  // DESIGN-FORK, or KEEP + bot-safe on a live project) and dedups across runs.
  // Written in both modes: surfacing decisions to Ray is always a deliverable.
  let newLedgerDecisions = 0;
  if (allHeld.length > 0) {
    newLedgerDecisions = updateForkLedger(ledgerPath, allHeld, liveProjects, ts);
  }

  // DISPATCH (execute mode only) — BOT-SAFE+KEEP work runs through cycle.ts,
  // fleet-wide capped, recorded in the dispatch-ledger for Ray's review. Live
  // products only dispatch when opts.liveDispatch (or dispatcher config) is on.
  const dispatchLedgerPath = join(
    getStateDir(config.dispatcher),
    "dispatch-ledger.json",
  );
  const dispatched: DispatchedCycle[] = [];
  let newDispatches = 0;
  const execute = opts.execute ?? false;
  if (execute) {
    const liveDispatch =
      opts.liveDispatch ?? config.dispatcher.autonomous?.live_dispatch ?? false;
    const dispatchCap = resolveDispatchCap(config);
    const liveCap = resolveLiveDispatchCap(config);
    const byId = new Map(present.map((p) => [p.id, p]));
    let firedNonLive = 0;
    let firedLive = 0;

    for (const pr of projects) {
      const project = byId.get(pr.project);
      if (!project || pr.error) continue;
      const isLive = liveProjects.has(pr.project);
      // Only BOT-SAFE + KEEP items are dispatchable — exactly the gate's
      // auto-dispatch class. Everything else is held/dropped (already ledgered).
      const candidates = pr.classified.filter(
        (c) => c.verdict === "keep" && c.class === "bot-safe",
      );
      for (const item of candidates) {
        const nonLiveGo = !isLive && firedNonLive < dispatchCap;
        const liveGo = isLive && liveDispatch && firedLive < liveCap;
        if (!nonLiveGo && !liveGo) continue;
        try {
          const rec = await dispatchItem(project, config.dispatcher, item, {
            live: isLive,
            cycleDryRun: opts.cycleDryRun,
            reviewerProviderOverride: opts.reviewerProviderOverride,
          });
          if (rec) dispatched.push(rec);
          if (liveGo) firedLive++;
          else firedNonLive++;
        } catch {
          // A single dispatch failing must not abort the rest of the run.
          if (liveGo) firedLive++;
          else firedNonLive++;
        }
      }
    }
    if (dispatched.length > 0) {
      newDispatches = updateDispatchLedger(dispatchLedgerPath, dispatched, ts);
    }
  }

  return {
    dryRun: !execute,
    ledgerPath,
    newLedgerDecisions,
    projects,
    skipped,
    dispatchLedgerPath,
    newDispatches,
    dispatched,
  };
}

/** A plain-English summary of a run for the CLI (Ray reads no diffs). */
export function formatRunSummary(result: AutonomousRunResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? "PREVIEW (no dispatch)" : "EXECUTE";
  lines.push(
    `Autonomous ${mode} — ${result.projects.length} project(s)` +
      (result.skipped.length
        ? `, skipped (repo absent here): ${result.skipped.join(", ")}`
        : ""),
  );
  for (const p of result.projects) {
    if (p.error) {
      lines.push(`\n• ${p.project}: ERROR — ${p.error}`);
      continue;
    }
    const d = p.byDisposition;
    const dispatchLabel = result.dryRun ? "would-dispatch" : "dispatchable";
    lines.push(
      `\n• ${p.project}: scoped ${p.scopedCount} → ` +
        `${d["dispatch-candidate"].length} ${dispatchLabel}, ` +
        `${d["design-fork"].length} design-fork, ` +
        `${d["live-held"].length} live-held, ` +
        `${d.dropped.length} dropped(slop)` +
        (d.unclassified.length ? `, ${d.unclassified.length} unclassified` : ""),
    );
    for (const c of d["design-fork"])
      lines.push(`    ⑂ DESIGN-FORK → Ray: ${c.title}`);
    for (const c of d["live-held"])
      lines.push(`    ⑂ LIVE-HELD → Ray: ${c.title}`);
    for (const c of d["dispatch-candidate"])
      lines.push(
        `    ▸ ${result.dryRun ? "would auto-fire (run --execute)" : "dispatchable"}: ${c.title}`,
      );
  }
  lines.push(
    `\nfork-ledger: ${result.newLedgerDecisions} new decision(s) → ${result.ledgerPath}`,
  );
  if (!result.dryRun) {
    lines.push(
      `dispatch-ledger: ${result.newDispatches} branch(es) awaiting review → ${result.dispatchLedgerPath}`,
    );
    for (const d of result.dispatched)
      lines.push(
        `    ⎇ ${d.project} [${d.status}${d.live ? ", LIVE" : ""}] ${d.branch}@${(d.sha ?? "").slice(0, 8)}: ${d.title}`,
      );
  }
  return lines.join("\n");
}
