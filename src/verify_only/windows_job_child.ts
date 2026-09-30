// Invoked by the owned runner as: bun windows_job_child.ts JOB CWD EXE [ARGS...].
// IPC carries setup/launch diagnostics; target output remains byte-for-byte
// on the inherited standard streams.
import { spawn } from "child_process";
import { constants } from "os";
import { assignCurrentProcessToWindowsJob } from "./windows_job";

type Diagnostic = { type: "spawnError" | "reapError"; message: string };

async function finish(code: number, diagnostic?: Diagnostic): Promise<never> {
  if (diagnostic) {
    if (process.send && process.connected) {
      await new Promise<void>((resolve) => {
        try {
          process.send!(diagnostic, (error: Error | null) => {
            if (error) process.stderr.write(`${diagnostic.message}; IPC: ${error.message}\n`);
            resolve();
          });
        } catch (error) {
          process.stderr.write(`${diagnostic.message}; IPC: ${String(error)}\n`);
          resolve();
        }
      });
    } else {
      process.stderr.write(`${diagnostic.message}\n`);
    }
  }
  if (process.connected) process.disconnect?.();
  process.exit(code);
}

const [name, cwd, executable, ...args] = process.argv.slice(2);
if (!name || !cwd || !executable) {
  await finish(1, { type: "reapError", message: "Windows job wrapper requires a job name, working directory and executable" });
}
try {
  assignCurrentProcessToWindowsJob(name);
} catch (error) {
  await finish(1, { type: "reapError", message: error instanceof Error ? error.message : String(error) });
}

// Only accept target startup settings once this launcher is inside the job.
// Nothing from the checked-out tree or caller's preload options runs earlier.
let targetEnv: NodeJS.ProcessEnv;
try {
  targetEnv = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error("Windows job launcher requires IPC")); return; }
    process.once("disconnect", () => reject(new Error("Windows job parent disconnected before environment handoff")));
    process.once("message", (message: unknown) => {
      const m = message as { type?: string; env?: unknown } | null;
      if (!m || m.type !== "targetEnv" || !m.env || typeof m.env !== "object" ||
          Array.isArray(m.env) || Object.values(m.env).some(value => typeof value !== "string")) {
        reject(new Error("Invalid Windows job target environment"));
      } else resolve(m.env as NodeJS.ProcessEnv);
    });
    process.send({ type: "ready" }, (error: Error | null) => { if (error) reject(error); });
  });
} catch (error) {
  await finish(1, { type: "reapError", message: error instanceof Error ? error.message : String(error) });
}

let ending = false;
try {
  const child = spawn(executable, args, { cwd, env: targetEnv!, stdio: "inherit", windowsHide: true });
  child.once("error", (error) => {
    if (ending) return;
    ending = true;
    void finish(1, { type: "spawnError", message: error.message });
  });
  child.once("exit", (code, signal) => {
    if (ending) return;
    ending = true;
    void finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
  });
} catch (error) {
  await finish(1, { type: "spawnError", message: error instanceof Error ? error.message : String(error) });
}
