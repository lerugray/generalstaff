// Shared test fixtures for DispatcherConfig / ProjectConfig / FleetState
// construction. Extracted 2026-04-18 after gs-186 required adding
// `max_parallel_slots: 1` to ~9 separate literals across tests/helpers/*
// and tests/dispatcher.test.ts — one shared factory makes future type
// additions a single-site change.
//
// Every factory takes an optional Partial<T> spread on top of sensible
// defaults so each test only writes the fields that matter to its
// assertion. Defaults mirror the "reasonable for a local dogfood test"
// shape: no real paths, no auto_merge, no hands_off patterns, sequential
// (max_parallel_slots: 1).

import type {
  DispatcherConfig,
  FleetState,
  ProjectConfig,
} from "../../src/types";

export function makeDispatcherConfig(
  overrides: Partial<DispatcherConfig> = {},
): DispatcherConfig {
  return {
    state_dir: "state",
    fleet_state_file: "fleet_state.json",
    stop_file: "STOP",
    override_file: "OVERRIDE",
    picker: "priority_staleness",
    max_cycles_per_project_per_session: 3,
    log_dir: "logs",
    digest_dir: "digests",
    max_parallel_slots: 1,
    ...overrides,
  };
}

export function makeProjectConfig(
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    id: "test-proj",
    path: "/tmp/test",
    priority: 1,
    engineer_command: "echo ok",
    verification_command: "echo ok",
    cycle_budget_minutes: 25,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: [],
    ...overrides,
  };
}

export function makeFleetState(
  overrides: Partial<FleetState> = {},
): FleetState {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
    ...overrides,
  };
}
