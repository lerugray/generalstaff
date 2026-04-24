// gs-306: types shared across the mission-swarm integration module.

export interface MissionSwarmConfig {
  default_audience: string;
  n_agents?: number;
  n_rounds?: number;
}

export interface MissionSwarmPreview {
  summary: string | null;
  simDir: string | null;
  cacheHit: boolean;
  skipped: boolean;
  skipReason?: MissionSwarmSkipReason;
}

export type MissionSwarmSkipReason =
  | "no_config"
  | "missionswarm_root_not_found"
  | "subprocess_failed"
  | "summary_missing"
  | "cache_write_failed";

export interface MissionSwarmInvocation {
  taskId: string;
  taskDescription: string;
  projectId: string;
  audience: string;
  nAgents: number;
  nRounds: number;
}

export const DEFAULT_N_AGENTS = 12;
export const DEFAULT_N_ROUNDS = 5;
