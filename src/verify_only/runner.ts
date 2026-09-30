// Owned, bounded shell runner for the verification command.
//
// The command inherits the caller-owned CLI group on Unix. The CLI must be
// its group leader; it enumerates and signals members without signalling itself:
// on a timeout or an abort it signals the group, waits a grace period, then
// force-kills it, and after the command ends it sweeps the group so nothing
// the command left running survives. Output is captured with a head and a
// tail so a noisy command cannot use unbounded memory.

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { signalVerificationMembers, verificationGroupMembers } from "./process_tree";

export interface RunnerOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Time between the polite signal and the force kill. Default 10 s. */
  graceMs?: number;
  headBytes?: number;
  tailBytes?: number;
  signal?: AbortSignal;
}

export interface RunnerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationSeconds: number;
  /** Head, an omission marker when needed, and tail, decoded as UTF-8. */
  output: string;
  omittedBytes: number;
  /** True once no process of the command's group remained. */
  reaped: boolean;
  pid: number | null;
}

const isWindows = process.platform === "win32";

/** Process groups currently owned by this process (for signal cleanup). */
const activeGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      signalVerificationMembers(signal);
    }
  } catch {
    /* group already gone */
  }
}

function groupAlive(pid: number): boolean {
  if (isWindows) return false;
  const members = verificationGroupMembers();
  return members === null || members.length > 0;
}

/** Force-kill every group this process still owns. Used on signals. */
export function killAllOwnedGroups(): void {
  for (const pid of activeGroups) killGroup(pid, "SIGKILL");
}

class HeadTailCapture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  omitted = 0;

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailLen += rest.length;
    while (this.tailLen > this.tailMax * 2 && this.tail.length > 1) {
      const dropped = this.tail.shift()!;
      this.tailLen -= dropped.length;
      this.omitted += dropped.length;
    }
  }

  text(): string {
    let tail = Buffer.concat(this.tail);
    if (tail.length > this.tailMax) {
      this.omitted += tail.length - this.tailMax;
      tail = tail.subarray(tail.length - this.tailMax);
    }
    const head = Buffer.concat(this.head).toString("utf8");
    if (this.omitted === 0) return head + tail.toString("utf8");
    return `${head}\n[... ${this.omitted} bytes omitted ...]\n${tail.toString("utf8")}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runOwnedShell(opts: RunnerOptions): Promise<RunnerResult> {
  const graceMs = opts.graceMs ?? 10_000;
  if (!isWindows && verificationGroupMembers() === null) {
    return { exitCode: null, signal: null, timedOut: false, aborted: false,
      spawnError: "verification requires a caller-owned process group led by the CLI", durationSeconds: 0,
      output: "", omittedBytes: 0, reaped: false, pid: null };
  }
  const capture = new HeadTailCapture(
    opts.headBytes ?? 1024 * 1024,
    opts.tailBytes ?? 1024 * 1024,
  );
  const started = performance.now();

  return new Promise<RunnerResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("bash", ["-c", opts.command], {
        cwd: opts.cwd,
        env: opts.env,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: err instanceof Error ? err.message : String(err),
        durationSeconds: 0,
        output: "",
        omittedBytes: 0,
        reaped: true,
        pid: null,
      });
      return;
    }

    const pid = child.pid ?? null;
    if (pid !== null) activeGroups.add(pid);
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: string | undefined;
    let done = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let politeUntil: number | undefined;

    child.stdout?.on("data", (c: Buffer) => capture.push(c));
    child.stderr?.on("data", (c: Buffer) => capture.push(c));

    const stopGroup = () => {
      if (pid === null || politeUntil !== undefined) return;
      politeUntil = performance.now() + graceMs;
      killGroup(pid, "SIGTERM");
      escalation = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      stopGroup();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let closeFallback: ReturnType<typeof setTimeout> | undefined;

    const finish = async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (closeFallback) clearTimeout(closeFallback);
      opts.signal?.removeEventListener("abort", onAbort);
      let reaped = true;
      if (pid !== null) {
        // Sweep anything the command left running in its group: a polite
        // signal, a short wait, then a force kill, then proof it is gone.
        if (groupAlive(pid)) {
          killGroup(pid, "SIGTERM");
          politeUntil ??= performance.now() + graceMs;
          while (groupAlive(pid) && performance.now() < politeUntil) {
            await sleep(25);
          }
        }
        killGroup(pid, "SIGKILL");
        const deadline = performance.now() + 3000;
        while (groupAlive(pid) && performance.now() < deadline) {
          await sleep(25);
        }
        reaped = !groupAlive(pid);
        activeGroups.delete(pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        spawnError,
        durationSeconds: (performance.now() - started) / 1000,
        output: capture.text(),
        omittedBytes: capture.omitted,
        reaped,
        pid,
      });
    };

    child.on("error", (err) => {
      spawnError = err.message;
      exited = true;
      void finish();
    });
    child.on("exit", (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      // Output normally drains and 'close' follows at once. A descendant that
      // holds the pipes open must not hold the result hostage.
      closeFallback = setTimeout(() => void finish(), 1500);
    });
    child.on("close", () => {
      void finish();
    });
  });
}
