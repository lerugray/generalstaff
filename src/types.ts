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

// --- Quorum review config (multi-reviewer; gs quorum-review 2026-06-02) ---
// Opt-in per project. Absent `review` or a single-entry `reviewers` list ==
// today's single-reviewer behavior (backward compatible). Two or more
// reviewers => parallel-independent voices synthesized into one verdict with
// an honest-error + min-real-reviews contract.
// See docs/quorum-review-design-2026-06-02.md.

export type QuorumPolicy = "conservative" | "majority";

export interface ReviewerEntry {
  // Provider invoker: "claude" | "openrouter" | "ollama" | (custom name
  // falls through to claude). Same routing space as
  // GENERALSTAFF_REVIEWER_PROVIDER.
  provider: string;
  // Per-reviewer model override. When unset, the provider's own default
  // (or GENERALSTAFF_REVIEWER_MODEL) is used. Threaded per-call — env is
  // never mutated — so parallel voices stay genuinely independent.
  model?: string;
  // Optional per-reviewer fallback provider if this voice errors.
  fallback?: string;
  // Display label for audit output; defaults to provider (or provider:model).
  label?: string;
}

export interface ReviewConfig {
  reviewers: ReviewerEntry[];
  // Aggregate-verdict policy. Default "conservative" (any blocker from any
  // reviewer holds the merge — safest when auto_merge is on).
  quorum_policy?: QuorumPolicy;
  // Minimum number of *real* (non-errored) reviews for a genuine quorum.
  // Below this, synthesis transparently falls back to single-reviewer and
  // says so — it never presents one survivor as if vetted by many. Default 2.
  min_real_reviews?: number;
}

// --- Cycle outcome (three-state from Phase 1 plan §8) ---

export type CycleOutcome = ReviewerVerdict | "cycle_skipped";

// --- Advisor (gs-327, 2026-05-14) ---
// Optional pre-cycle advisor layer (Hammerstein CLI by default). Calls an
// external advisor with the task plan + bounded recent-cycle history; the
// verdict is logged to PROGRESS.jsonl as an `advisor_verdict` event. By
// default purely advisory (logged but doesn't block); per-project `gate:
// true` flips block-verdicts into `cycle_skipped` with reason
// `advisor_gated`. Latency: ~60s typical (synchronous; bounded by
// `timeout_seconds`). Hammerstein-audit-reviewed.

export type AdvisorProvider = "hammerstein";
export const VALID_ADVISOR_PROVIDERS: readonly AdvisorProvider[] = [
  "hammerstein",
];

export interface AdvisorConfig {
  // When true, advisor runs pre-cycle (after pick, before engineer).
  // Default: false (advisor entirely disabled, zero overhead).
  enabled: boolean;
  // When true AND advisor returns verdict "block", the cycle skips with
  // outcome `cycle_skipped` + reason `advisor_gated`. Default: false
  // (advisory-only — verdict logged, cycle proceeds regardless).
  gate?: boolean;
  // Which advisor backend. v1 only supports "hammerstein" (calls the
  // `h` CLI from github.com/lerugray/hammerstein). v2+ may add direct
  // OpenRouter/Claude/Ollama routing inside GS.
  provider?: AdvisorProvider;
  // Wall-clock timeout for the advisor call. Defaults to 90s — the
  // hammerstein audit-this-plan template runs ~60s on OpenRouter
  // qwen3.6-plus. On timeout: verdict = "timeout", proceed (or skip
  // if gate=true with block-on-timeout policy — not implemented in v1;
  // timeout always proceeds).
  timeout_seconds?: number;
  // How many recent cycles to include in the plan context. Per the
  // Hammerstein audit recommendation (2026-05-14): cap at 3 to bound
  // advisor context size and prevent signal dilution.
  history_cycles?: number;
}

export type AdvisorVerdictKind =
  | "proceed"
  | "block"
  | "revise"
  | "timeout"
  | "error";

export interface AdvisorVerdict {
  verdict: AdvisorVerdictKind;
  reason: string;
  raw_output?: string;
  duration_sec: number;
  provider: AdvisorProvider;
  ts: string;
}

// --- Judgment gate (gs-330, 2026-06-16, v0.7.0) ---
// Optional lightweight pre-cycle gate. After the picker resolves the next
// task and before the engineer spends tokens, the canonical Hammerstein
// system-prompt judges whether the task is LOAD-BEARING toward its goal or
// STUPID-INDUSTRIOUS slop (effort that pattern-matches progress but doesn't
// advance it). Verdict KEEP / REJECT, logged to PROGRESS.jsonl as a
// `judgment_verdict` event.
//
// Distinct from the advisor (gs-327): the advisor shells out to the external
// Hammerstein `h` CLI for a broad free-text audit; this gate calls OpenRouter
// inline (no external binary — just OPENROUTER_API_KEY, which the reviewer
// path already uses) for a focused KEEP/REJECT slop screen. They compose.
//
// Modes:
//   - "off"  : disabled, zero overhead (the global default; the gate never runs).
//   - "flag" : run the gate, log the verdict, PROCEED regardless (advisory).
//   - "skip" : run the gate; on REJECT skip the cycle (cycle_skipped, reason
//              `judged_stupid_industrious`). KEEP / error / no-key PROCEED.
// Flag-first by design — the framework calls itself "not a veto" and the
// boundary is contestable on borderline tasks, so the default never blocks
// legitimate work; `skip` is an opt-in for autonomous / auto-generated task
// pipelines. Graceful no-op on missing key / fetch failure / malformed
// verdict (verdict "error" → proceed; never blocks on gate infrastructure).
export type JudgmentGateMode = "off" | "flag" | "skip";
export const VALID_JUDGMENT_GATE_MODES: readonly JudgmentGateMode[] = [
  "off",
  "flag",
  "skip",
];

export type JudgmentVerdictKind = "keep" | "reject" | "error";

// --- Autonomous-mode item class (gs-332, 2026-06-22, v0.8.0) ---
// Alongside KEEP/REJECT, the gate classifies a proposed work item as either
// safe to auto-dispatch (mechanical, bounded) or needing a human taste/scope/
// revenue/legal call. Ported from wintermute's gate_classify BOT-SAFE /
// DESIGN-FORK split. BOT-SAFE+KEEP items are the only ones an autonomous
// session may dispatch (Phase 2); DESIGN-FORK (and live-held bot-safe) items
// route to the fork-ledger for Ray. Absent on a verdict means the gate didn't
// emit a parseable CLASS line — treated as needs-human, never auto-dispatched.
export type JudgmentClass = "bot-safe" | "design-fork";
export const VALID_JUDGMENT_CLASSES: readonly JudgmentClass[] = [
  "bot-safe",
  "design-fork",
];

export interface JudgmentVerdict {
  verdict: JudgmentVerdictKind;
  reason: string;
  quadrant?: string;
  // gs-332: BOT-SAFE / DESIGN-FORK classification when the gate runs in
  // classify mode (autonomous scoping). Undefined for the plain KEEP/REJECT
  // slop screen (the v0.7.0 pre-cycle gate path).
  class?: JudgmentClass;
  raw_output?: string;
  duration_sec: number;
  model: string;
  ts: string;
}

// --- Autonomous mode (gs-332, 2026-06-22, v0.8.0) ---
// GS's opt-in autonomous front-end (wintermute folded in). For each project
// with `autonomous.enabled`, a session runs SURVEY (read MISSION + git log +
// tasks.json) → SCOPE (an off-cap model proposes work items) → GATE+CLASSIFY
// (one Hammerstein call returns KEEP/REJECT + BOT-SAFE/DESIGN-FORK per item)
// → LEDGER (design-forks / live-held → fork-ledger for Ray). Phase 1 is the
// dry-run: scope-quality validation only, no dispatch. Default-off — existing
// GS users see zero change. BYOK per Hard Rule 8 (the scoper + gate models
// run on the operator's OPENROUTER_API_KEY).

// Per-project autonomous opt-in. Absent / `{enabled:false}` => the project is
// never surveyed/scoped (zero overhead).
export interface AutonomousConfig {
  // Master switch. Default false. When true the project participates in
  // `gs autonomous` survey+scope+gate+ledger.
  enabled: boolean;
  // Model the SCOPE step routes to (proposes the work items). Overrides the
  // fleet default. Public default: "openrouter/qwen3.6-plus" (same provider
  // the judgment gate already uses — one OPENROUTER_API_KEY).
  scoper_model?: string;
  // How many work items SCOPE proposes for this project. Overrides the fleet
  // default (3, matching wintermute).
  scope_count?: number;
  // Revenue / live product. When true, even BOT-SAFE+KEEP items are HELD for
  // Ray's review (ledgered as `live-held`) rather than auto-dispatched — the
  // higher-stakes rail. Default false (pre-revenue: bot-safe may auto-dispatch
  // in Phase 2). Private data (Ray's roster) — not a public default.
  live?: boolean;
  // Phase 2+ opt-in: a shell command an operator wires to advise on design-
  // forks (e.g. Weiss). Inert in Phase 1. Public users leave it unset.
  design_fork_advisor_command?: string;
}

// Fleet-wide autonomous defaults on the dispatcher. Per-project AutonomousConfig
// fields override these. Caps are Phase 2 (dispatch) — inert in the Phase 1
// dry-run, but the schema lands now to avoid a later migration.
export interface AutonomousDispatcherConfig {
  // Fleet default scoper model. Public default "openrouter/qwen3.6-plus".
  scoper_model?: string;
  // Fleet default items proposed per project. Default 3.
  scope_count?: number;
  // Phase 2: cap on NON-live (pre-revenue) auto-dispatches per run. Default 2.
  dispatch_cap?: number;
  // Phase 2: also branch-dispatch on live/revenue projects (never pushed/
  // merged — the merge stays gated on Ray). Default false.
  live_dispatch?: boolean;
  // Phase 2: separate, conservative cap on live-project dispatches per run.
  // Default 1.
  live_dispatch_cap?: number;
}

// One work item the SCOPE step proposed for a project.
export interface ScopedItem {
  // The one-line title (markdown/numbering/tag stripped).
  title: string;
  // The scoper's self-tag, parsed from a trailing [MECHANICAL] / [DESIGN]
  // marker. Advisory only — the GATE's CLASS is authoritative. null when the
  // scoper omitted the tag.
  tag: "mechanical" | "design" | null;
}

// The result of SURVEY+SCOPE for one project.
export interface ProjectScope {
  project: string;
  // The compact state digest fed to the scoper (MISSION + git log + queued).
  digest: string;
  items: ScopedItem[];
}

// One scoped item after the GATE+CLASSIFY pass, joined by (project, order).
export interface ClassifiedItem {
  title: string;
  verdict: JudgmentVerdictKind;
  class?: JudgmentClass;
  // Why the gate ruled this way (one line), when emitted.
  reason?: string;
}

// --- Autonomous-mode ledgers (gs-332) ---
// Durable, deduped, cross-run JSON state. Both are gitignored, per-host
// (Ray's private decision/branch data) — the machinery is public, the DATA
// is not. Surfaced at the next interactive session's catch-up.

export type ForkKind = "design-fork" | "live-held";
export type LedgerStatus = "pending" | "resolved";

// A decision that needs Ray (a design-fork, or a bot-safe item held because
// the project is live/revenue). Resolved entries are KEPT (status="resolved")
// so they never re-surface. Mirrors wintermute's fork-ledger schema.
export interface ForkEntry {
  id: string;           // `${project}::${slug(title)}` — the dedup key
  project: string;
  title: string;
  kind: ForkKind;
  status: LedgerStatus;
  first_seen: string;   // ISO 8601 / run timestamp
  last_seen: string;
  resolution: string | null;
}

export interface ForkLedger {
  forks: ForkEntry[];
  updated?: string;
}

// An auto-dispatched cycle awaiting review+merge. The loop never pushes/merges,
// so without this the work strands on the host's local clone. Unlike
// wintermute (one unique branch per dispatch), GS dispatches reuse cycle.ts,
// which lands every cycle on the project's shared bot branch — so the dedup key
// is the cycle_id (unique per dispatch), and `sha` pins the exact reviewable
// commit for the gs-bot-diff-review "cherry-pick the cycle SHA" flow.
export interface DispatchEntry {
  id: string;           // `${project}::${cycle_id}` — the dedup key
  project: string;
  title: string;
  branch: string;       // the shared bot branch the cycle landed on
  cycle_id?: string;    // the dispatching cycle
  sha?: string;         // the cycle's end SHA — the precise reviewable commit
  live: boolean;
  status: string;       // cycle outcome (verified / verified_weak / failed)
  review_status: LedgerStatus;
  first_seen: string;
  last_seen: string;
  resolution: string | null;
}

export interface DispatchLedger {
  dispatches: DispatchEntry[];
  updated?: string;
}

// --- projects.yaml schema ---

export type WorkDetectionMode =
  | "catalogdna_bot_tasks"
  | "tasks_json"
  | "git_issues"
  | "git_unmerged";
export type ConcurrencyDetectionMode = "catalogdna" | "worktree" | "none";

// gs-270: Phase 7 engineer-swap. Projects opt into an alternative engineer
// provider (aider on OpenRouter, grok on the xAI subscription, etc.) to keep
// subscription-quota pressure off the default `claude -p` engineer. Default is
// "claude" (current behavior: run `engineer_command` verbatim). Non-claude
// providers have GS generate the full bash invocation internally — worktree
// setup, deps, provider CLI, prompt — so projects don't need a per-provider
// wrapper. gs-331 (v0.7.1): "grok" runs xAI's Grok CLI headlessly, auth'd by
// the operator's flat-rate grok.com sub login (no per-token key).
export type EngineerProvider = "claude" | "aider" | "grok";
export const VALID_ENGINEER_PROVIDERS: readonly EngineerProvider[] = [
  "claude",
  "aider",
  "grok",
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

// What to do when a per-project session_budget cap binds.
// "break-session" (default) ends the whole session — matches the
// fleet-wide cap behavior and is the simplest mental model.
// "skip-project" removes only the over-budget project from picker
// eligibility and lets the session keep running other projects
// within the fleet-wide cap (if any). Only meaningful on per-project
// blocks; fleet-wide caps always break the session (no per-project
// machinery to fall back to).
export type BudgetOnExhausted = "break-session" | "skip-project";
export const VALID_BUDGET_ON_EXHAUSTED: readonly BudgetOnExhausted[] = [
  "break-session",
  "skip-project",
];

export interface SessionBudget {
  max_usd?: number;
  max_tokens?: number;
  max_cycles?: number;
  enforcement?: BudgetEnforcement;
  provider_source?: BudgetProviderSource;
  on_exhausted?: BudgetOnExhausted;
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
  // gs-306: optional mission-swarm reviewer-preview integration.
  // When set, the reviewer runs a cached simulation of the picked
  // task against the named audience before verdict and includes the
  // summary in the reviewer's context. See
  // docs/internal/INTEGRATIONS-DESIGN-2026-04-24.md §1. Graceful-
  // skips on any failure — never blocks the cycle. Invocation goes
  // through $MISSIONSWARM_ROOT/src/index.ts; if that env is unset
  // the integration silently no-ops.
  missionswarm?: MissionSwarmProjectConfig;
  // gs-292: optional per-project override for the empty-diff streak
  // guard. When set, wins over dispatcher.max_consecutive_empty for
  // cycles on this project (sequential) and contributes the per-round
  // maximum in parallel mode.
  max_consecutive_empty?: number;
  // gs-330: optional pre-cycle judgment gate. "off" (default) / "flag"
  // (advisory) / "skip" (REJECT skips the cycle). See JudgmentGateMode
  // above. BYOK per Hard Rule 8 — needs OPENROUTER_API_KEY; graceful
  // no-op (proceeds) when the key is unset. Composes with `advisor`.
  judgment_gate?: JudgmentGateMode;
  // gs-302: optional early-kill when the engineer prints no task-claim
  // line (GENERALSTAFF_TASK_CLAIM_JSON) within this many minutes.
  // Fractions allowed (e.g. 0.05 ≈ 3s). Unset disables the timer;
  // existing projects keep the budget-only watchdog unchanged.
  engineer_claim_timeout_minutes?: number;
  // gs-311: optional journal-source integration. When set, GS knows
  // where to find the user's mission-bullet-oss journal tree; inert
  // until jr-003 (scan library) lands. See
  // docs/internal/INTEGRATIONS-DESIGN-2026-04-24.md §2.
  // `reviewer_context: true` is opt-in — journal text only reaches the
  // reviewer's context window when that flag is true AND the reviewer
  // is using a provider Ray has explicitly allow-listed for journal
  // data (enforcement lives in jr-005).
  journal?: JournalProjectConfig;
  // gs-315: customer-facing project flag. When true, the reviewer
  // prompt receives an extra section asking it to confirm that the
  // verification step exercises at least one end-to-end user journey
  // (not just unit tests). If only unit tests are exercised, the
  // reviewer is asked to downgrade to verified_weak with an explicit
  // note that the customer-facing surface is untested. Motivated by
  // the rg-017 incident (2026-04-24): window.supabase shadow bug
  // broke retrogazeai.com login from launch; zero unit tests caught
  // it because none loaded the page in a browser. Reviewer-prompt
  // enrichment is informational — does NOT block cycles, just
  // surfaces the gap. The harder verification gate is gs-316's
  // customer_facing_smoke below.
  public_facing?: boolean;
  // gs-316: optional shell command run after verification_command on
  // public_facing projects when main verification passed. Non-zero exit
  // fails the cycle. Unset — no smoke step (existing behavior unchanged).
  customer_facing_smoke?: string;
  // Phase B+ followup: project lifecycle stage. Drives the
  // `lifecycle_transition` phase-completion criterion + (in future) the
  // dev-mode vs live-mode dashboard split documented in
  // docs/internal/UI-VISION-2026-04-19.md. Read-only as far as GS is
  // concerned — operators flip the value via projects.yaml edit + commit
  // (no `gs lifecycle flip` CLI yet). Absent / "dev" reads as in-development;
  // "live" means the project has shipped (live URL, real users, etc.).
  // The `lifecycle_transition: "<from> -> <to>"` ROADMAP criterion passes
  // when this field equals the target.
  lifecycle?: ProjectLifecycle;
  // gs-327 (2026-05-14): optional pre-cycle advisor layer (Hammerstein
  // CLI by default, see AdvisorConfig). Unset / `{enabled: false}` is
  // zero-overhead and preserves current behavior. See docs/ADVISOR.md.
  advisor?: AdvisorConfig;
  // gs quorum-review (2026-06-02): optional multi-reviewer quorum. Absent or
  // a single-entry `reviewers` list => current single-reviewer behavior
  // (backward compatible). Two or more reviewers => parallel-independent
  // voices, synthesized into one verdict with an honest-error +
  // min_real_reviews contract. Opt-in because it multiplies reviewer spend
  // N× (Hard Rule 8 — operator pays per reviewer).
  // See docs/quorum-review-design-2026-06-02.md.
  review?: ReviewConfig;
  // gs-332 (2026-06-22, v0.8.0): optional autonomous-mode opt-in. Absent /
  // `{enabled:false}` => the project is never surveyed/scoped (zero overhead,
  // existing behavior). When enabled, `gs autonomous` runs SURVEY→SCOPE→
  // GATE+CLASSIFY→LEDGER for it. Per-project fields override the dispatcher's
  // `autonomous` fleet defaults. BYOK per Hard Rule 8. See AutonomousConfig.
  autonomous?: AutonomousConfig;
}

// gs-322 / Phase B+ followup. Two stages today; intentionally narrow.
// Adding a third value (e.g. "sunset" for archived projects, or
// "beta" between dev and live) is a deliberate extension point —
// don't expand this enum casually. Each new stage needs a story for
// what dashboard mode it maps to + how transitions are gated.
export type ProjectLifecycle = "dev" | "live";

export interface MissionSwarmProjectConfig {
  default_audience: string;
  n_agents?: number;
  n_rounds?: number;
}

export interface JournalProjectConfig {
  mission_bullet_root: string;   // absolute path to the journal tree
  scan_days?: number;             // default 7 (consumer-applied)
  reviewer_context?: boolean;     // default false
  /** Optional extra strings (jr-003) matched case-insensitively against bullet text + #tags. */
  affinity_aliases?: string[];
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
  // gs-292: consecutive verified_weak + empty-diff cycles (sequential)
  // or all-empty parallel rounds before the session stops with
  // stopReason empty-cycles. Default 3 when omitted from projects.yaml.
  max_consecutive_empty: number;
  // gs-323: consecutive verified_weak (empty-diff) outcomes across the
  // fleet before the session halts with stopReason weak-streak +
  // inventory-audit suggestion. Distinct from max_consecutive_empty in
  // that this is fleet-scoped (any project can produce the weak cycle)
  // and the halt message explicitly suggests running 'gs inventory-audit'.
  // Default 3; set to 0 to disable. Count resets on any non-weak outcome
  // (verified, verification_failed). cycle_skipped does NOT increment and
  // does NOT reset — it's a pre-flight abort, not a progress signal.
  weak_streak_threshold?: number;
  // gs-297: optional fleet-wide usage budget. Applies across all
  // projects in a session. Per-project overrides (on ProjectConfig)
  // carve out tighter caps for individual projects and must fit
  // within this cap when both are set with the same unit.
  session_budget?: SessionBudget;
  // gs-332 (2026-06-22, v0.8.0): fleet-wide autonomous-mode defaults
  // (scoper model, items-per-project, Phase 2 dispatch caps). Per-project
  // ProjectConfig.autonomous fields override these. Absent => built-in
  // defaults (scoper "openrouter/qwen3.6-plus", scope_count 3).
  autonomous?: AutonomousDispatcherConfig;
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
  /** gs-291 / gs-290: task id the engineer claimed (or peeked); set on full cycle_end paths. */
  attempted_task_id?: string;
  /** Safety-critical failure requires the dispatcher to exclude this project for the session. */
  blocked_for_session?: boolean;
}

// --- PROGRESS.jsonl entry types ---

export type ProgressEventType =
  | "cycle_start"
  | "cycle_skipped"
  | "engineer_invoked"
  | "engineer_completed"
  | "verification_run"
  | "verification_outcome"
  | "customer_facing_smoke_run"
  | "customer_facing_smoke_outcome"
  | "diff_summary"
  | "reviewer_invoked"
  | "reviewer_response"
  | "reviewer_verdict"
  | "reviewer_fallback"
  | "reviewer_hallucination"
  | "worktree_preflight"
  | "cycle_rollback"
  | "secret_redaction"
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
  // gs-318: anti-state-wipe gate fired. The cycle's diff included
  // deletions of one or more tracked state files (state/<id>/
  // {tasks.json,MISSION.md,PROGRESS.jsonl,STATE.json} or
  // state/_fleet/PROGRESS.jsonl). Cycle short-circuits to
  // verification_failed; data carries deleted_files (string[]) for
  // post-hoc grep + audit. Catches the 2026-04-24 incident shape.
  | "state_wipe_blocked"
  // gs-281: the pre-cycle `loadTasks` peek (cycle.ts step 1a) found
  // a `state/<id>/tasks.json` that exists but can't be parsed or
  // validated. The cycle proceeds with nextTask=undefined so the
  // legacy non-creative path still runs, but the event preserves
  // the error for post-hoc grep so operators can spot the breakage
  // instead of it silently masking downstream creative-cycle routing.
  | "task_peek_failed"
  // gs-298: usage-budget gate fired at a cycle boundary with
  // enforcement=hard. The session is about to end with
  // stopReason="usage-budget"; data carries {unit, budget, consumed,
  // source, scope: "fleet" | "project"}.
  | "session_budget_exceeded"
  // gs-298: usage-budget gate fired with enforcement=advisory. Warns
  // but does not break; emitted every cycle the cap is exceeded so
  // gs-299's reporting can compute dwell-over-budget. Same data
  // shape as session_budget_exceeded.
  | "session_budget_advisory"
  // gs-298: the ConsumptionReader returned null or threw (source
  // unavailable — no data dir, no API key, etc.). Session continues
  // without gating (fail-open). Emitted once per session only; the
  // null condition is usually persistent.
  | "session_budget_reader_unavailable"
  // gs-298: per-project cap hit with on_exhausted="skip-project".
  // Project is removed from picker eligibility for the rest of the
  // session; the session continues with other projects. Data carries
  // the same {unit, budget, consumed, source} as session_budget_exceeded.
  | "session_budget_project_skipped"
  // Phase A (FUTURE-DIRECTIONS-2026-04-19): emitted when the
  // commander runs `gs phase advance` and the current phase's
  // completion criteria all pass. Data carries
  // {phase_id, criteria_results: [{kind, passed, detail}]}.
  | "phase_complete"
  // Phase A: emitted when `gs phase advance` seeds the next phase's
  // tasks into tasks.json. Data carries
  // {from_phase, to_phase, seeded_task_ids: string[]}.
  | "phase_advanced"
  // Phase B: emitted at session start when the dispatcher's
  // phase-progression check finds a project's current phase has
  // all criteria passing AND a non-terminal next_phase. The
  // commander still must run `gs phase advance` to actually
  // transition. Data carries {from_phase, to_phase,
  // criteria_results}. Sentinel file at state/<project>/PHASE_READY.json
  // records the same info on disk for view modules.
  | "phase_ready_for_advance"
  // Phase B+ (2026-05-04): emitted at session start when a project
  // declares `auto_advance: true` in ROADMAP.yaml AND the current
  // phase's criteria all pass. The detector calls executePhaseAdvance
  // directly (no PHASE_READY.json sentinel). Data carries
  // {from_phase, to_phase, seeded_task_ids: string[]}.
  | "phase_auto_advanced"
  // Phase B+ (2026-05-04): emitted by `gs phase rollback` when the
  // commander reverses one or more phase advances. Data carries
  // {from_phase, to_phase, undone_phases: string[], forced: boolean}.
  | "phase_rolled_back"
  // gs-327 (2026-05-14): pre-cycle advisor returned a verdict. Data
  // carries {task_id, verdict, reason, provider, duration_sec,
  // raw_output (truncated)}. Logged for every advisor run; gates a
  // cycle only when project.advisor.gate=true AND verdict==="block"
  // (in which case a sibling cycle_skipped event records the gating).
  | "advisor_verdict"
  // gs-330 (2026-06-16): pre-cycle judgment gate returned a verdict. Data
  // carries {task_id, verdict, reason, quadrant?, model, duration_sec,
  // raw_output (truncated)}. Logged for every gate run; gates a cycle only
  // when project.judgment_gate==="skip" AND verdict==="reject" (in which
  // case a sibling cycle_skipped event records the gating).
  | "judgment_verdict";

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
  status: "pending" | "in_progress" | "done" | "skipped" | "superseded";
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

// --- Phased roadmap (FUTURE-DIRECTIONS-2026-04-19, Phase A) ---

// Each completion-criterion is one of these shapes. v1 supports
// `all_tasks_done` and `custom_check`; the other kinds are listed
// here so the schema has a stable shape but the evaluator returns
// "not yet supported" for them.
export type RoadmapCriterion =
  | { all_tasks_done: true }
  | { custom_check: string }  // bash one-liner, exit 0 = pass
  | { launch_gate: string }  // not evaluated in v1
  | { git_tag: string }  // not evaluated in v1
  | { lifecycle_transition: string };  // not evaluated in v1

// Literal task entries seeded when a phase advances. Mirrors the
// shape of GreenfieldTask but without the runtime fields the
// dispatcher computes (id is auto-assigned, status starts as
// "pending").
export interface RoadmapLiteralTask {
  title: string;
  priority?: number;
  interactive_only?: boolean;
  interactive_only_reason?: string;
  expected_touches?: string[];
}

// Templated task entries — same shape as RoadmapLiteralTask, but
// string fields can contain placeholders like {phase_id}, {prev_phase},
// {project_id}, {date}, {datetime}. Resolved on phase advance via
// expandTaskTemplates(). Lets a single roadmap declare boilerplate
// tasks that adapt to the phase being entered (e.g. "Cut the
// {phase_id} release tag", "Post {phase_id} announcement on {date}").
//
// Phase B+ (2026-05-04). Pre-Phase B+ schemas that didn't declare
// tasks_template continue to load unchanged.
export type RoadmapTemplateTask = RoadmapLiteralTask;

export interface RoadmapPhase {
  id: string;
  goal: string;
  depends_on?: string;
  tasks?: RoadmapLiteralTask[];
  tasks_template?: RoadmapTemplateTask[];
  completion_criteria: RoadmapCriterion[];
  next_phase?: string;
}

export interface Roadmap {
  project_id: string;
  current_phase: string;
  phases: RoadmapPhase[];
  // Opt-in auto-advance. When true, the session-start phase detector
  // calls executePhaseAdvance() instead of writing PHASE_READY.json
  // when the current phase's criteria all pass. Default false (the
  // human-gate design from FUTURE-DIRECTIONS-2026-04-19 §2). The
  // commander still has to set this explicitly per project — there
  // is no fleet-wide auto_advance flag.
  auto_advance?: boolean;
}

// Per-project state file written to state/<project>/PHASE_STATE.json.
// Tracks the runtime view that ROADMAP.yaml itself doesn't carry:
// which phases the commander has marked complete, and when.
export interface PhaseStateEntry {
  phase_id: string;
  completed_at: string;  // ISO 8601
  criteria_results: PhaseCriterionResult[];
}

export interface PhaseCriterionResult {
  kind: "all_tasks_done" | "custom_check" | "launch_gate" | "git_tag" | "lifecycle_transition";
  passed: boolean;
  detail: string;
}

export interface PhaseState {
  project_id: string;
  current_phase: string;
  completed_phases: PhaseStateEntry[];
}

// Sentinel file written by the Phase B dispatcher detector at
// state/<project>/PHASE_READY.json when a project's current phase
// has all criteria passing AND a non-terminal next_phase. Read by
// the phase-ready view module + status.
export interface PhaseReadySentinel {
  project_id: string;
  from_phase: string;
  to_phase: string;
  detected_at: string;  // ISO 8601
  criteria_results: PhaseCriterionResult[];
}

// --- Type guards for parse boundaries ---

const VALID_VERDICTS: readonly string[] = ["verified", "verified_weak", "verification_failed"];
const VALID_EVENTS: readonly string[] = [
  "cycle_start", "cycle_skipped", "engineer_invoked", "engineer_completed",
  "verification_run", "verification_outcome",
  "customer_facing_smoke_run", "customer_facing_smoke_outcome",
  "diff_summary",
  "reviewer_invoked", "reviewer_response", "reviewer_verdict",
  "reviewer_fallback", "reviewer_hallucination",
  "worktree_preflight", "cycle_rollback", "secret_redaction",
  "provider_invoked", "provider_fallback",
  "cycle_end", "cycle_watchdog", "project_soft_skipped",
  "session_start", "session_end", "session_complete",
  "session_end_auto_merge",
  "malformed_json",
  // gs-318: anti-state-wipe gate event
  "state_wipe_blocked",
  // gs-298: usage-budget gate event types
  "session_budget_exceeded", "session_budget_advisory",
  "session_budget_reader_unavailable", "session_budget_project_skipped",
  // Phase A (FUTURE-DIRECTIONS-2026-04-19)
  "phase_complete", "phase_advanced",
  // Phase B (FUTURE-DIRECTIONS-2026-04-19 §2)
  "phase_ready_for_advance",
  // Phase B+ (2026-05-04): opt-in auto-advance + multi-phase rollback
  "phase_auto_advanced",
  "phase_rolled_back",
  // gs-327 (2026-05-14): pre-cycle advisor verdict (Hammerstein etc.)
  "advisor_verdict",
  // gs-330 (2026-06-16): pre-cycle judgment-gate verdict (KEEP/REJECT slop screen)
  "judgment_verdict",
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
