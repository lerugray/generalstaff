// GeneralStaff — co-seats: control markers and the per-tick decision (DESIGN.md §v11).
//
// Local markers live in the seat's state directory:
//   GO         JSON {set_at, deadline, pin, days}: the single source of truth
//              for the deadline and the config pin
//   STOP       sticky; `co-seat stop` writes it and removes GO
//   EXIT.json  why the driver last ended
// Remote markers are files on a branch of a control repo the person owns.
// Unreadable control holds turns; it never grants them.

import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { CoSeatRemoteControl } from "../types";
import { resolveSeatPath } from "./config";

// --- Local markers ---

export interface GoMarker {
  version: 1;
  set_at: string;
  /** ISO 8601 */
  deadline: string;
  pin: string;
  days: number;
  extended_at?: string;
}

export type GoRead =
  | { kind: "ok"; go: GoMarker }
  | { kind: "missing" }
  | { kind: "invalid"; detail: string };

export interface ExitRecord {
  reason: string;
  at: string;
  detail?: string;
}

export const goPath = (dir: string) => join(dir, "GO");
export const stopPath = (dir: string) => join(dir, "STOP");
export const exitPath = (dir: string) => join(dir, "EXIT.json");

/** Write a file by temp + rename so a reader never sees half of it. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function readGo(dir: string): GoRead {
  const path = goPath(dir);
  if (!existsSync(path)) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { kind: "invalid", detail: `GO is not valid JSON (${(error as Error).message})` };
  }
  const o = raw as Partial<GoMarker> | null;
  if (
    !o ||
    typeof o !== "object" ||
    typeof o.pin !== "string" ||
    typeof o.deadline !== "string" ||
    Number.isNaN(Date.parse(o.deadline))
  ) {
    return { kind: "invalid", detail: "GO lacks a pin or a valid deadline" };
  }
  return {
    kind: "ok",
    go: {
      version: 1,
      set_at: typeof o.set_at === "string" ? o.set_at : "",
      deadline: o.deadline,
      pin: o.pin,
      days: typeof o.days === "number" ? o.days : 0,
      extended_at: typeof o.extended_at === "string" ? o.extended_at : undefined,
    },
  };
}

export function writeGo(dir: string, go: GoMarker): void {
  writeFileAtomic(goPath(dir), JSON.stringify(go, null, 1) + "\n");
}

export function clearGo(dir: string): void {
  rmSync(goPath(dir), { force: true });
}

export function localStopPresent(dir: string): boolean {
  return existsSync(stopPath(dir));
}

export function writeStop(dir: string, now: number = Date.now(), note = "co-seat stop"): void {
  writeFileAtomic(stopPath(dir), `STOP: ${note} at ${new Date(now).toISOString()}\n`);
}

export function clearStop(dir: string): void {
  rmSync(stopPath(dir), { force: true });
}

export function writeExit(dir: string, record: ExitRecord): void {
  writeFileAtomic(exitPath(dir), JSON.stringify(record, null, 1) + "\n");
}

export function readExit(dir: string): ExitRecord | null {
  try {
    const o = JSON.parse(readFileSync(exitPath(dir), "utf8")) as Partial<ExitRecord>;
    if (typeof o.reason === "string" && typeof o.at === "string") {
      return { reason: o.reason, at: o.at, detail: typeof o.detail === "string" ? o.detail : undefined };
    }
  } catch {
    /* none */
  }
  return null;
}

// --- Remote markers (a git branch of a control repo) ---

export type RemoteState =
  | { state: "ok"; go: boolean; stop: boolean }
  | { state: "unreadable"; detail: string };

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[], timeoutMs?: number) => GitResult;

export const defaultGit: GitRunner = (args, timeoutMs = 60_000) => {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: (r.stderr ?? "") + (r.error ? String(r.error) : ""),
  };
};

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? "";
}

export type GitRunnerAsync = (args: string[], timeoutMs?: number) => Promise<GitResult>;

/** Run `bin` without blocking the event loop, killing it (and its group) at the timeout. */
export function runAsync(bin: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise) => {
    const posix = process.platform !== "win32";
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    try {
      child = spawn(bin, args, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        windowsHide: true,
        detached: posix, // own group, so a timeout kills git's ssh child too
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return resolvePromise({ status: null, stdout: "", stderr: String(error) });
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) {
          if (posix) process.kill(-child.pid, "SIGKILL");
          else child.kill();
        }
      } catch {
        /* already gone */
      }
      finish({ status: null, stdout, stderr: `${stderr}timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", (error) => finish({ status: null, stdout, stderr: stderr + String(error) }));
    child.once("close", (code) => finish({ status: code, stdout, stderr }));
  });
}

/** git without blocking the event loop (the in-turn stop poll must keep its 10 s rhythm). */
export const defaultGitAsync: GitRunnerAsync = (args, timeoutMs = 60_000) => runAsync("git", args, timeoutMs);

/**
 * Fetch the control branch and look for the GO and STOP markers in
 * `<dir>/` on it. A failed or timed-out fetch or a missing branch is
 * `unreadable`. Async with a timeout per git call, so a stalled network cannot
 * hold up the driver's in-flight stop checks.
 */
export async function readRemoteControl(
  rc: CoSeatRemoteControl,
  root: string,
  git: GitRunnerAsync = defaultGitAsync,
): Promise<RemoteState> {
  const repo = resolveSeatPath(root, rc.repo);
  const ref = `refs/remotes/${rc.remote}/${rc.branch}`;
  const fetched = await git(
    ["-C", repo, "fetch", "-q", rc.remote, `+refs/heads/${rc.branch}:${ref}`],
    30_000,
  );
  if (fetched.status !== 0) {
    return { state: "unreadable", detail: `fetch failed: ${lastLine(fetched.stderr) || `exit ${fetched.status}`}` };
  }
  const tip = await git(["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`], 15_000);
  if (tip.status !== 0) {
    return { state: "unreadable", detail: `branch ${rc.remote}/${rc.branch} not found after fetch` };
  }
  const has = async (name: string): Promise<boolean> =>
    (await git(["-C", repo, "cat-file", "-e", `${ref}:${rc.dir}/${name}`], 15_000)).status === 0;
  return { state: "ok", go: await has("GO"), stop: await has("STOP") };
}

/**
 * Commit marker changes on the control branch and push. `go: true` writes the
 * GO marker, `go: false` removes it; the same for `stop`. Refuses unless the
 * control repo is already on the configured branch (it never switches
 * branches). Throws one plain-line Error on any git failure.
 */
export function setRemoteMarkers(
  rc: CoSeatRemoteControl,
  root: string,
  changes: { go?: boolean; stop?: boolean },
  message: string,
  git: GitRunner = defaultGit,
): void {
  const repo = resolveSeatPath(root, rc.repo);
  const run = (args: string[], timeoutMs?: number): GitResult => git(["-C", repo, ...args], timeoutMs);
  const must = (what: string, r: GitResult): GitResult => {
    if (r.status !== 0) {
      throw new Error(`remote control: ${what} failed: ${lastLine(r.stderr) || `exit ${r.status}`}`);
    }
    return r;
  };

  const head = must("reading the control repo's branch", run(["rev-parse", "--abbrev-ref", "HEAD"], 15_000));
  if (head.stdout.trim() !== rc.branch) {
    throw new Error(
      `remote control: control repo is on branch "${head.stdout.trim()}", expected "${rc.branch}"; check it out yourself`,
    );
  }
  must("pull --rebase", run(["pull", "--rebase", "-q", rc.remote, rc.branch], 60_000));

  const paths: string[] = [];
  for (const [name, want] of [["GO", changes.go], ["STOP", changes.stop]] as const) {
    if (want === undefined) continue;
    const rel = `${rc.dir}/${name}`;
    const abs = join(repo, ...rel.split("/"));
    paths.push(rel);
    if (want) {
      mkdirSync(dirname(abs), { recursive: true });
      // Fixed content, so setting an already-set marker changes nothing and makes no commit.
      writeFileSync(abs, `${name}\n`);
      must(`git add ${rel}`, run(["add", "--", rel], 15_000));
    } else {
      rmSync(abs, { force: true });
      must(`git rm ${rel}`, run(["rm", "-q", "--cached", "--ignore-unmatch", "--", rel], 15_000));
    }
  }
  if (paths.length === 0) return;

  // Commit only the markers that actually changed.
  const changed = must("diff", run(["diff", "--cached", "--name-only", "--", ...paths], 15_000))
    .stdout.split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (changed.length > 0) {
    must("commit", run(["commit", "-q", "-m", message, "--", ...changed], 30_000));
  }
  must("push", run(["push", "-q", rc.remote, rc.branch], 60_000));
}

// --- The per-tick decision (pure) ---

export interface TickInputs {
  now: number;
  go: GoRead;
  localStop: boolean;
  fleetStop: boolean;
  /** Undefined when the seat has no remote_control. */
  remote?: RemoteState;
  /** The pin of the config as it is now; null when it could not be loaded. */
  pinNow: string | null;
}

export type TickDecision =
  | { kind: "exit"; reason: string }
  | { kind: "idle"; reason: string }
  | { kind: "active" };

/**
 * DESIGN.md §v11 driver steps 1-2. Ends past the deadline or on the seat's own
 * STOP; idles on the fleet STOP, an unreadable or stopping remote, a missing
 * remote GO, or a changed pin. Nothing unreadable ever grants a turn.
 */
export function decideTick(inputs: TickInputs): TickDecision {
  const { go } = inputs;
  if (go.kind === "ok" && inputs.now >= Date.parse(go.go.deadline)) {
    return { kind: "exit", reason: "deadline" };
  }
  if (inputs.localStop) return { kind: "exit", reason: "stop" };
  if (go.kind === "missing") return { kind: "exit", reason: "no-go" };
  if (go.kind === "invalid") return { kind: "exit", reason: "go-invalid" };

  if (inputs.fleetStop) return { kind: "idle", reason: "fleet-stop" };
  if (inputs.remote) {
    if (inputs.remote.state === "unreadable") return { kind: "idle", reason: "remote-unreadable" };
    if (inputs.remote.stop) return { kind: "idle", reason: "remote-stop" };
    if (!inputs.remote.go) return { kind: "idle", reason: "remote-no-go" };
  }
  if (inputs.pinNow === null) return { kind: "idle", reason: "config-unreadable" };
  if (inputs.pinNow !== go.go.pin) return { kind: "idle", reason: "config-changed" };
  return { kind: "active" };
}
