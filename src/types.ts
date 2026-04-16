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

export type WorkDetectionMode = "catalogdna_bot_tasks" | "tasks_json";
export type ConcurrencyDetectionMode = "catalogdna" | "none";

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
  | "cycle_end"
  | "session_start"
  | "session_end";

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
}

// --- Concurrency detection ---

export interface BotRunningResult {
  running: boolean;
  reason?: string;
}
