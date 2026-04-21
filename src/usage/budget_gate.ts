// GeneralStaff — usage-budget evaluation (gs-298).
//
// Pure function that takes a reader + project + dispatcher config
// and returns a structured outcome the session loop can dispatch on.
// No side effects — no console, no appendProgress, no mutation.
// Event emission + loop-flow decisions stay in session.ts so this
// module is trivially unit-testable with synchronous assertions.
//
// Checking order is **per-project first, fleet-wide second**. A
// per-project cap is tighter by construction (gs-297 validation
// enforces per-project ≤ fleet when both set with the same unit);
// reporting the project hit lets the session loop pick the narrower
// action (skip-project vs break-session) where it would otherwise
// have to default to breaking on a fleet hit. Projects with no
// per-project block fall through to the fleet check naturally.

import type { ConsumptionReader, ConsumptionSnapshot } from "./types";
import type {
  BudgetEnforcement,
  BudgetOnExhausted,
  DispatcherConfig,
  ProjectConfig,
  SessionBudget,
} from "../types";

export type BudgetUnit = "max_usd" | "max_tokens" | "max_cycles";

export interface BudgetHit {
  kind: "hit";
  scope: "fleet" | "project";
  unit: BudgetUnit;
  budget: number;
  consumed: number;
  source: string;
  enforcement: BudgetEnforcement;
  // Only meaningful when scope="project"; fleet hits always break.
  on_exhausted: BudgetOnExhausted;
}

export type BudgetOutcome =
  | { kind: "ok" }
  | { kind: "unavailable" }
  | BudgetHit;

// Compares a snapshot against a single SessionBudget block and
// returns the first unit that's at-or-over. Returns null when the
// block isn't hit. The at-or-over (not strictly-greater) semantics
// match the design doc's "stop when we've spent the allotted
// budget" framing — at exactly the cap, the NEXT cycle would push
// us over, so we stop first.
function evaluateBlock(
  budget: SessionBudget,
  snap: ConsumptionSnapshot,
): Pick<BudgetHit, "unit" | "budget" | "consumed"> | null {
  if (budget.max_usd !== undefined && snap.total_usd >= budget.max_usd) {
    return { unit: "max_usd", budget: budget.max_usd, consumed: snap.total_usd };
  }
  if (
    budget.max_tokens !== undefined &&
    snap.total_tokens >= budget.max_tokens
  ) {
    return {
      unit: "max_tokens",
      budget: budget.max_tokens,
      consumed: snap.total_tokens,
    };
  }
  if (
    budget.max_cycles !== undefined &&
    snap.cycles_used >= budget.max_cycles
  ) {
    return {
      unit: "max_cycles",
      budget: budget.max_cycles,
      consumed: snap.cycles_used,
    };
  }
  return null;
}

export async function evaluateUsageBudget(
  reader: ConsumptionReader | null,
  project: ProjectConfig,
  config: DispatcherConfig,
): Promise<BudgetOutcome> {
  // No budget configured anywhere = nothing to check. This is the
  // hot path — we early-return before even calling the reader so
  // sessions without usage-budget enabled pay zero overhead.
  const projectBudget = project.session_budget;
  const fleetBudget = config.session_budget;
  if (!projectBudget && !fleetBudget) return { kind: "ok" };

  if (!reader) return { kind: "unavailable" };
  const snap = await reader.readCurrentWindow();
  if (!snap) return { kind: "unavailable" };

  if (projectBudget) {
    const hit = evaluateBlock(projectBudget, snap);
    if (hit) {
      return {
        kind: "hit",
        scope: "project",
        ...hit,
        source: snap.source,
        enforcement: projectBudget.enforcement ?? "hard",
        on_exhausted: projectBudget.on_exhausted ?? "break-session",
      };
    }
  }

  if (fleetBudget) {
    const hit = evaluateBlock(fleetBudget, snap);
    if (hit) {
      return {
        kind: "hit",
        scope: "fleet",
        ...hit,
        source: snap.source,
        enforcement: fleetBudget.enforcement ?? "hard",
        on_exhausted: "break-session",
      };
    }
  }

  return { kind: "ok" };
}

// Maps an outcome to the action the session loop should take. Pure
// function (no side effects, no flag mutation) so the four-branch
// truth table is trivially unit-testable; session.ts still handles
// the event emission + console warnings + flag bookkeeping around
// this call.
//
// Branches:
//   ok                       → proceed (cycle runs)
//   unavailable              → proceed (fail-open)
//   hit + advisory           → proceed (warning logged, cycle runs)
//   hit + hard + project +
//     on_exhausted=skip-project → skip (project dropped, session continues)
//   hit + hard + <everything else> → stop (session breaks)
export type BudgetDecision = "proceed" | "skip" | "stop";

export function decideBudgetAction(outcome: BudgetOutcome): BudgetDecision {
  if (outcome.kind === "ok") return "proceed";
  if (outcome.kind === "unavailable") return "proceed";
  if (outcome.enforcement === "advisory") return "proceed";
  if (
    outcome.scope === "project" &&
    outcome.on_exhausted === "skip-project"
  ) {
    return "skip";
  }
  return "stop";
}

// Picks the provider_source to use for the session's reader.
// Precedence: fleet-wide > first per-project with provider_source
// set > default "claude_code". Returns undefined if no session_budget
// is configured anywhere — caller should skip reader construction.
export function resolveProviderSource(
  projects: ProjectConfig[],
  config: DispatcherConfig,
): "claude_code" | "openrouter" | "anthropic_api" | "ollama" | undefined {
  const hasAnyBudget =
    config.session_budget !== undefined ||
    projects.some((p) => p.session_budget !== undefined);
  if (!hasAnyBudget) return undefined;
  if (config.session_budget?.provider_source) {
    return config.session_budget.provider_source;
  }
  for (const p of projects) {
    if (p.session_budget?.provider_source) {
      return p.session_budget.provider_source;
    }
  }
  return "claude_code";
}
