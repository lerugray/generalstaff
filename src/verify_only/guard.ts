// Verify-only runtime guard.
//
// A verify-only check runs the project's own verification command and the
// reviewer, and nothing else. It must never reach the engineer, the advisor,
// the judgment gate, the mission-swarm preview, or a full cycle. The verify
// modules do not import those modules (a test walks the import graph), and
// this guard is the second wall: while a check is active in this process,
// every entry point that would dispatch an agent refuses to run.
//
// This module has no imports on purpose, so any module can call it without
// creating an import cycle.

let activeChecks = 0;

export class VerifyOnlyGuardError extends Error {
  constructor(public readonly blocked: string) {
    super(
      `verify-only check is active: ${blocked} is not reachable from a verify-only check`,
    );
    this.name = "VerifyOnlyGuardError";
  }
}

/** Mark a verify-only check active. Returns the function that ends it. */
export function enterVerifyOnlyMode(): () => void {
  activeChecks += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeChecks -= 1;
  };
}

export function isVerifyOnlyActive(): boolean {
  return activeChecks > 0;
}

/** Throws while a verify-only check is active. Called at agent entry points. */
export function assertNotVerifyOnly(what: string): void {
  if (activeChecks > 0) {
    throw new VerifyOnlyGuardError(what);
  }
}

/**
 * The project view a verify-only check works from. Everything that could
 * dispatch an agent is turned off, so even a code path that read these fields
 * would find nothing to run. The original project object is not modified.
 */
export function verifyOnlyProjectView<
  T extends {
    engineer_command: string;
    engineer_provider?: unknown;
    engineer_model?: unknown;
    advisor?: unknown;
    judgment_gate?: unknown;
    missionswarm?: unknown;
    creative_work_allowed?: boolean;
  },
>(project: T): T {
  return {
    ...project,
    engineer_command: "",
    engineer_provider: undefined,
    engineer_model: undefined,
    advisor: undefined,
    judgment_gate: "off",
    missionswarm: undefined,
    creative_work_allowed: false,
  } as T;
}
