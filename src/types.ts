// GeneralStaff — shared type definitions
// Lock JSON contracts before logic (build step 2)

// --- Reviewer verdict ---

export type ReviewerVerdict = "verified" | "verified_weak" | "verification_failed";

export type VerificationOutcome = "passed" | "failed" | "weak";

// --- Reviewer response (JSON from claude -p) ---

export interface ReviewerResponse {
  verdict: ReviewerVerdict;
  reason: string;
  scope_drift_files: string[];
  hands_off_violations: string[];
  task_evidence: Array<{
    task: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
  }>;
  silent_failures: string[];
  notes: string;
}

// --- Cycle outcome (three-state from Phase 1 plan §8) ---

export type CycleOutcome = ReviewerVerdict | "cycle_skipped";

// --- projects.yaml schema ---

export type WorkDetectionMode =
  | "catalogdna_bot_tasks"
  | "tasks_json"
  | "git_issues"
  | "git_unmerged";
export type ConcurrencyDetectionMode = "catalogdna" | "worktree" | "none";

// gs-270: Phase 7 engineer-swap. Projects opt into an alternative engineer
// provider (aider on OpenRouter, etc.) to keep subscription-quota pressure
// off the default `claude -p` engineer. Default is "claude" (current
// behavior: run `engineer_command` verbatim). Non-claude providers have GS
// generate the full bash invocation internally — worktree setup, deps,
// provider CLI, prompt — so projects don't need a per-provider wrapper.
export type EngineerProvider = "claude" | "aider";
export const VALID_ENGINEER_PROVIDERS: readonly EngineerProvider[] = [
  "claude",
  "aider",
];

// gs-297: Session usage budget. Caps how much of the user's LLM
// subscription/quota/credit a GS session can consume. See
// docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md. The whole
// session_budget block is optional; the default (unset) preserves
// current unlimited behavior. When set, exactly one of
// max_usd/max_tokens/max_cycles must be chosen — mixing units in a
// single scope is a validation error. A session_budget can sit on
// the dispatcher (fleet-wide cap) and/or on a per-project override;
// per-project values must be ≤ fleet-wide when both are set with
// the same unit. Enforcement and provider_source are optional with
// runtime defaults ("hard" / "claude_code").
export type BudgetEnforcement = "hard" | "advisory";
export const VALID_BUDGET_ENFORCEMENTS: readonly BudgetEnforcement[] = [
  "hard",
  "advisory",
];

export type BudgetProviderSource =
  | "claude_code"
  | "openrouter"
  | "anthropic_api"
  | "ollama";
export const VALID_BUDGET_PROVIDER_SOURCES: readonly BudgetProviderSource[] = [
  "claude_code",
  "openrouter",
  "anthropic_api",
  "ollama",
];

export interface SessionBudget {
  max_usd?: number;
  max_tokens?: number;
  max_cycles?: number;
  enforcement?: BudgetEnforcement;
  provider_source?: BudgetProviderSource;
}

export interface ProjectConfig {
  id: string;
  path: string;
  priority: number;
  engineer_command: string;
  verification_command: string;
  cycle_budget_minutes: number;
  work_detection: WorkDetectionMode;
  concurrency_detection: ConcurrencyDetectionMode;
  branch: string;
  auto_merge: boolean;
  hands_off: string[];
  notes?: string;
  // gs-270: optional alternative engineer. Unset or "claude" preserves
  // current behavior — `engineer_command` is run as-is. Any other value
  // has GS generate the engineer invocation internally; `engineer_command`
  // is then ignored. BYOK per Hard Rule 8 — operator supplies the API key
  // (OPENROUTER_API_KEY for aider, etc.).
  engineer_provider?: EngineerProvider;
  engineer_model?: string;
  // gs-278: creative-work opt-in (Hard Rule #1's "opt-in plugins with
  // explicit warnings" clause). When true AND a picked task has
  // `creative: true`, the dispatcher routes the cycle to the creative
  // branch, prepends voice-reference context to the engineer prompt,
  // skips the reviewer gate, and writes outputs to the drafts dir.
  // When false/unset, creative-tagged tasks are skipped with reason
  // `creative_work_not_allowed_for_project`.
  // See docs/internal/RULE-RELAXATION-2026-04-20.md for the policy.
  creative_work_allowed?: boolean;
  creative_work_branch?: string;
  creative_work_drafts_dir?: string;
  voice_reference_paths?: string[];
  // gs-297: optional per-project usage budget. When set, caps this
  // project's share of the session's LLM consumption; the session
  // loop (gs-298) reads this alongside the fleet-wide cap and
  // applies whichever binds first. Must fit within the fleet-wide
  // dispatcher.session_budget when both are set with the same unit
  // (validated at config load).
  session_budget?: SessionBudget;
}

export interface DispatcherConfig {
  state_dir: string;
  fleet_state_file: string;
  stop_file: string;
  override_file: string;
  picker: string;
  max_cycles_per_project_per_session: number;
  log_dir: string;
  digest_dir: string;
  // gs-186: Phase 4 concurrency control. Default 1 keeps the sequential
  // loop bit-for-bit identical to Phase 1-3 behaviour — no surprise
  // doubling of reviewer API calls on upgrade (Hard Rule 8 / BYOK).
  // Opt in per-fleet by setting this > 1 in projects.yaml.
  max_parallel_slots: number;
  // gs-297: optional fleet-wide usage budget. Applies across all
  // projects in a session. Per-project overrides (on ProjectConfig)
  // carve out tighter caps for individual projects and must fit
  // within this cap when both are set with the same unit.
  session_budget?: SessionBudget;
}

export interface ProjectsYaml {
  projects: ProjectConfig[];
  dispatcher: DispatcherConfig;
}

// --- Fleet state (fleet_state.json) ---

export interface ProjectFleetState {
  last_cycle_at: string | null;
  last_cycle_outcome: CycleOutcome | null;
  total_cycles: number;
  total_verified: number;
  total_failed: number;
  accumulated_minutes: number;
}

export interface FleetState {
  version: 1;
  updated_at: string;
  projects: Record<string, ProjectFleetState>;
}

// --- Per-project state (state/<id>/STATE.json) ---

export interface ProjectState {
  project_id: string;
  current_cycle_id: string | null;
  last_cycle_id: string | null;
  last_cycle_outcome: CycleOutcome | null;
  last_cycle_at: string | null;
  cycles_this_session: number;
}

// --- Cycle ---

export interface DiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface CycleResult {
  cycle_id: string;
  project_id: string;
  started_at: string;
  ended_at: string;
  cycle_start_sha: string;
  cycle_end_sha: string;
  engineer_exit_code: number | null;
  verification_outcome: VerificationOutcome;
  reviewer_verdict: ReviewerVerdict;
  final_outcome: CycleOutcome;
  reason: string;
  diff_stats?: DiffStats;
}

// --- PROGRESS.jsonl entry types ---

export type ProgressEventType =
  | "cycle_start"
  | "cycle_skipped"
  | "engineer_invoked"
  | "engineer_completed"
  | "verification_run"
  | "verification_outcome"
  | "diff_summary"
  | "reviewer_invoked"
  | "reviewer_response"
  | "reviewer_verdict"
  | "reviewer_fallback"
  | "reviewer_hallucination"
  | "worktree_preflight"
  | "cycle_rollback"
  | "provider_invoked"
  | "provider_fallback"
  | "cycle_end"
  | "cycle_watchdog"
  | "project_soft_skipped"
  | "session_start"
  | "session_end"
  | "session_complete"
  | "session_end_auto_merge"
  // gs-280: emitted when the JSON syntax gate catches a malformed
  // `.json` file in the cycle's diff before verification runs. The
  // cycle short-circuits to verification_failed; the event preserves
  // the parse error + file list for post-hoc grep.
  | "malformed_json"
  // gs-281: the pre-cycle `loadTasks` peek (cycle.ts step 1a) found
  // a `state/<id>/tasks.json` that exists but can't be parsed or
  // validated. The cycle proceeds with nextTask=undefined so the
  // legacy non-creative path still runs, but the event preserves
  // the error for post-hoc grep so operators can spot the breakage
  // instead of it silently masking downstream creative-cycle routing.
  | "task_peek_failed";

export interface ProgressEntry {
  timestamp: string;
  event: ProgressEventType;
  cycle_id?: string;
  project_id?: string;
  data: Record<string, unknown>;
}

// --- Session ---

export interface SessionOptions {
  budgetMinutes: number;
  dryRun: boolean;
  maxCycles?: number;
  excludeProjects?: string[];
  verbose?: boolean;
  // gs-249: CLI --provider override. Takes precedence over
  // GENERALSTAFF_REVIEWER_PROVIDER env var for the duration of this
  // session only. Not mutated into process.env.
  reviewerProviderOverride?: string;
}

export interface SingleCycleOptions {
  projectId: string;
  dryRun: boolean;
}

// --- Greenfield tasks.json ---

export interface GreenfieldTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  priority: number;
  // gs-195: optional bot-pickability guards. When a task's engineer
  // scope will touch files under the project's hands_off patterns, the
  // queuer should either:
  //   - set `interactive_only: true` (bot picker will skip entirely), or
  //   - list the paths in `expected_touches`; the picker will skip the
  //     task if any of those paths matches a hands_off pattern.
  // Legacy tasks without either field are bot-pickable by default
  // (same behaviour as before gs-195).
  expected_touches?: string[];
  interactive_only?: boolean;
  interactive_only_reason?: string;
  // gs-275: per-task engineer override. When set, the dispatcher
  // peeks at the next bot-pickable task's provider before spawning
  // the engineer; the task's override wins over the project-level
  // engineer_provider default. Motivation — the gs-274 benchmark
  // revealed aider+Qwen3 Coder works well for type/fixture/e2e/CSS
  // tasks and fails on React component scaffolding; per-task
  // routing lets a project use aider on the subset where it works
  // while keeping claude for the subset where it doesn't.
  engineer_provider?: EngineerProvider;
  engineer_model?: string;
  // gs-278: creative-work opt-in (Hard Rule #1 carve-out). Creative
  // tasks produce drafts in the project's creative_work_drafts_dir,
  // on the project's creative_work_branch, with reviewer gate
  // skipped. Only honored when the project has
  // creative_work_allowed=true — otherwise the task is skipped with
  // reason `creative_work_not_allowed_for_project`. Per-task
  // voice_reference_override supplements project-level
  // voice_reference_paths when the task needs a different voice
  // corpus (e.g. a tweet uses different source material than a
  // README section).
  creative?: boolean;
  voice_reference_override?: string[];
}

// --- gs-279: creative-work cycle context ---

// Computed in cycle.ts after the nextTask peek and passed down through
// runEngineer so both the aider path (prompt prepend + branch override
// baked into the generated bash) and the claude path (env vars for the
// project's engineer_command.sh) can honor it. Default behavior when
// undefined / isCreative=false is byte-identical to pre-gs-279.
export interface CycleCreativeContext {
  isCreative: boolean;
  // The branch this cycle operates on. Equals project.branch for
  // correctness cycles and project.creative_work_branch for creative
  // cycles. Aider uses this to set up its worktree; the claude path
  // exposes it as GENERALSTAFF_BOT_BRANCH.
  effectiveBranch: string;
  // Resolved voice-reference paths (task.voice_reference_override ∪
  // project.voice_reference_paths). Empty for non-creative cycles.
  voiceReferencePaths: string[];
  // Where creative drafts should land inside the managed project.
  // Default "drafts/". Exposed as GENERALSTAFF_DRAFTS_DIR for the
  // claude path; aider's creative prompt embeds it directly.
  draftsDir: string;
}

// --- Concurrency detection ---

export interface BotRunningResult {
  running: boolean;
  reason?: string;
}

// --- Type guards for parse boundaries ---

const VALID_VERDICTS: readonly string[] = ["verified", "verified_weak", "verification_failed"];
const VALID_EVENTS: readonly string[] = [
  "cycle_start", "cycle_skipped", "engineer_invoked", "engineer_completed",
  "verification_run", "verification_outcome", "diff_summary",
  "reviewer_invoked", "reviewer_response", "reviewer_verdict",
  "reviewer_fallback", "reviewer_hallucination",
  "worktree_preflight", "cycle_rollback",
  "provider_invoked", "provider_fallback",
  "cycle_end", "cycle_watchdog", "project_soft_skipped",
  "session_start", "session_end", "session_complete",
  "session_end_auto_merge",
  "malformed_json",
];

export function isReviewerResponse(v: unknown): v is ReviewerResponse {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.verdict === "string" && VALID_VERDICTS.includes(o.verdict) &&
    typeof o.reason === "string" &&
    Array.isArray(o.scope_drift_files) &&
    Array.isArray(o.hands_off_violations) &&
    Array.isArray(o.task_evidence) &&
    Array.isArray(o.silent_failures) &&
    typeof o.notes === "string"
  );
}

export function isProgressEntry(v: unknown): v is ProgressEntry {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.timestamp === "string" &&
    typeof o.event === "string" && VALID_EVENTS.includes(o.event) &&
    (o.data != null && typeof o.data === "object" && !Array.isArray(o.data))
  );
}
