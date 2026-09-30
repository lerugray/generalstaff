// Shared Windows ownership for pinned Git and the verification shell. The
// launcher joins a private job before starting the target; descendants inherit
// membership even if an intermediate parent exits before we observe it.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "child_process";
import { join } from "path";
import { createWindowsJob, type WindowsJob } from "./windows_job";

const REAP_MS = 3000;
export interface ReapResult { reaped: boolean; error?: string }

export class WindowsOwnershipError extends Error {}

export class WindowsOwnedProcess {
  readonly child: ChildProcess;
  spawnError?: string;
  private setupError?: string;
  private stopError?: string;
  private taskkillDetail?: string;
  private stopped = false;
  private released = false;
  private releaseResult?: ReapResult;
  private readonly job: WindowsJob;

  constructor(command: string, args: readonly string[], options: SpawnOptions) {
    try { this.job = createWindowsJob(); }
    catch (error) { throw new WindowsOwnershipError(error instanceof Error ? error.message : String(error)); }
    try {
      // Bun 1.3 supports explicit env files, but not --no-env-file. A
      // whitespace-only explicit entry suppresses defaults and is ignored by
      // its loader (no file opened). Preserve it as one argv element.
      this.child = spawn(process.execPath, ["--env-file", " ", join(import.meta.dir, "windows_job_child.ts"),
        this.job.name, options.cwd?.toString() ?? process.cwd(), command, ...args], {
        ...options,
        // Never let a checked-out tree supply Bun startup configuration.
        cwd: import.meta.dir,
        // Bun/Node preload options must not execute before job assignment.
        // The target receives its exact environment over IPC after joining.
        env: Object.fromEntries(Object.entries(options.env ?? process.env)
          .filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/i.test(key))),
        stdio: [Array.isArray(options.stdio) ? options.stdio[0]! : "ignore", "pipe", "pipe", "ipc"],
      });
      this.child.on("message", (message: unknown) => {
        const m = message as { type?: string; message?: string } | null;
        if (m?.type === "ready") {
          try {
            this.child.send({ type: "targetEnv", env: options.env ?? process.env }, (error: Error | null) => {
              if (error) { this.setupError = `Windows job environment handoff failed: ${error.message}`; this.stop(); }
            });
          } catch (error) {
            this.setupError = `Windows job environment handoff failed: ${error instanceof Error ? error.message : String(error)}`;
            this.stop();
          }
          return;
        }
        if (!m || typeof m.message !== "string") return;
        if (m.type === "spawnError") this.spawnError = m.message;
        if (m.type === "reapError") this.setupError = m.message;
      });
    } catch (error) {
      this.job.close();
      throw error;
    }
  }

  /** Bounded synchronous stop for terminal/second-signal cleanup. */
  stop(): void {
    if (this.released) return;
    if (this.stopped) {
      // The launcher may be stuck BEFORE joining the job. Kill its owned
      // child handle directly on retry; an empty job cannot terminate it.
      // Never signal a launcher whose exit we have already observed.
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          if (!this.child.kill("SIGKILL")) throw new Error("launcher termination could not be delivered");
        } catch (error) {
          this.stopError = [this.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(": ");
        }
      }
      try { this.job.terminate(); }
      catch (error) { this.stopError = error instanceof Error ? error.message : String(error); }
      return;
    }
    this.stopped = true;
    const pid = this.child.pid;
    // Never target a recycled launcher PID after its exit is observed.
    if (pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
      const taskkill = root ? join(root, "System32", "taskkill.exe") : "taskkill.exe";
      try {
        const r = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          timeout: REAP_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        });
        this.taskkillDetail = `taskkill exited ${r.status}${r.signal ? ` (${r.signal})` : ""}` +
          [r.error?.message, r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).map(s => `: ${s}`).join("");
        // 128 includes "process not found". It is only harmless if the JOB
        // and launcher are subsequently proven empty; never trust status alone.
        if (r.error || (r.status !== 0 && r.status !== 128)) this.stopError = this.taskkillDetail;
      } catch (error) {
        this.stopError = `taskkill failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try { this.job.terminate(); }
    catch (error) {
      this.stopError = [this.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(": ");
    }
  }

  private empty(): boolean {
    // The launcher can still be starting, before it joins the job. It cannot
    // spawn the target yet, but an empty job alone is not proof it has exited.
    const launcherExited = this.child.pid === undefined ||
      this.child.exitCode !== null || this.child.signalCode !== null;
    return this.job.activeProcesses() === 0 && launcherExited;
  }

  async release(): Promise<ReapResult> {
    if (this.released) return this.releaseResult!;
    try {
      if (!this.empty()) this.stop();
      const deadline = Date.now() + REAP_MS;
      while (!this.empty() && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      if (!this.empty()) this.stop(); // Retry direct launcher termination too.
      if (!this.empty()) return { reaped: false,
        error: `Windows process job was not proven reaped: ${this.stopError ?? this.taskkillDetail ?? "live processes remain"}` };
      this.job.close();
      this.released = true;
      const error = this.setupError ?? this.stopError;
      return this.releaseResult = { reaped: error === undefined, error };
    } catch (error) {
      this.stop(); // A failed query is not a reason to leave owned work running.
      return { reaped: false, error: [this.setupError, this.stopError ?? this.taskkillDetail,
        error instanceof Error ? error.message : String(error)].filter(Boolean).join(": ") };
    }
  }
}
