// GeneralStaff — heartbeat types
// Shared types for the heartbeat supervisor + hook + dispatcher.

export type HeartbeatAction =
  | "run_cycle"
  | "run_session"
  | "digest"
  | "status"
  | "manual";

export interface InboxMessage {
  ts?: string;
  channel?: string;
  author?: string;
  content: string;
  action?: HeartbeatAction;
  project?: string;
}

export interface OutboxMessage {
  ts: string;
  action: string;
  project?: string;
  exit?: number;
  summary?: string;
  duration_sec?: number;
  session_dir?: string;
  content?: string;
}

export interface HookDecision {
  decision: "block";
  reason: string;
}
