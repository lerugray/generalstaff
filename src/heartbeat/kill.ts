// GeneralStaff — heartbeat escalating kill helper (gs-328)
//
// Bounded two-step kill with grace windows. Extracted from supervisor.ts
// so unit tests can inject fakes without importing the supervisor entrypoint.

export interface EscalatingKillOpts {
  pid: number;
  kill: (pid: number) => void;
  isRunning: (pid: number) => boolean;
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attempt to terminate `pid` with one retry after a grace window.
 * Returns whether the process is gone and whether a second kill was needed.
 */
export async function escalatingKill(
  opts: EscalatingKillOpts,
): Promise<{ killed: boolean; escalated: boolean }> {
  const { pid, kill, isRunning } = opts;
  const graceMs = opts.graceMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((msg: string) => console.log(msg));

  kill(pid);
  await sleep(graceMs);
  if (!isRunning(pid)) {
    return { killed: true, escalated: false };
  }

  log(
    `[GS-HEARTBEAT] ESCALATION: pid ${pid} still running after first kill — retrying`,
  );
  kill(pid);
  await sleep(graceMs);
  if (!isRunning(pid)) {
    return { killed: true, escalated: true };
  }

  log(
    `[GS-HEARTBEAT] FATAL: pid ${pid} could not be terminated after escalated kill — supervisor cannot recover`,
  );
  return { killed: false, escalated: true };
}
