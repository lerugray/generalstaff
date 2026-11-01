// Shared fixtures for the co-seat tests: a temp GeneralStaff root, a
// projects.yaml builder, and fake runners and meters that are Bun scripts run
// as [process.execPath, script] (never sh scripts: CI also runs Windows).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import { loadSeatContext } from "../../src/co_seat/context";
import { pinOfContext, type SeatContext } from "../../src/co_seat/config";
import { writeGo } from "../../src/co_seat/control";
import { getRootDir, setRootDir } from "../../src/state";

export const STATE_TEMPLATE = [
  "# Co-seat state",
  "",
  "## Open items",
  "- none",
  "## Owned work",
  "- none",
  "## Waiting on",
  "- none",
  "## Held by a person",
  "- none",
  "## Parked",
  "- none",
  "## Last turn",
  "- none yet",
  "",
].join("\n");

export interface Sandbox {
  root: string;
  previousRoot: string;
  cleanup: () => void;
}

export function makeSandbox(prefix = "gs-coseat-test-"): Sandbox {
  const previousRoot = getRootDir();
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  setRootDir(root);
  return {
    root,
    previousRoot,
    cleanup: () => {
      setRootDir(previousRoot);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function projectEntry(root: string, id: string, extra: Record<string, unknown> = {}) {
  const path = join(root, "projects-src", id);
  mkdirSync(path, { recursive: true });
  return {
    id,
    path,
    priority: 1,
    engineer_command: "echo hi",
    verification_command: "echo ok",
    cycle_budget_minutes: 30,
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["CLAUDE.md"],
    ...extra,
  };
}

/** A runner command: a Bun script that does what `script` says. */
export function scriptPath(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

export function meterScript(root: string, name: string, body: string): string[] {
  return [process.execPath, scriptPath(root, name, body)];
}

/** A runner that records what it saw, then rewrites (or breaks) the state file. */
export function recordingRunnerSource(opts: {
  statePath?: string;
  logPath: string;
  exit?: number;
  breakState?: boolean;
  deleteState?: boolean;
  sleepMs?: number;
  ignoreTerm?: boolean;
}): string {
  const write = opts.statePath
    ? opts.deleteState
      ? `rmSync(${JSON.stringify(opts.statePath)});`
      : opts.breakState
      ? `writeFileSync(${JSON.stringify(opts.statePath)}, "I forgot the headings\\n");`
      : `writeFileSync(${JSON.stringify(opts.statePath)}, readFileSync(${JSON.stringify(opts.statePath)}, "utf8") + "\\n- ran turn " + process.env.GS_CO_SEAT_TURN + "\\n");`
    : "";
  return `
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "fs";
${opts.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
const rec = {
  pid: process.pid,
  argv: process.argv.slice(2),
  seat: process.env.GS_CO_SEAT ?? null, id: process.env.GS_CO_SEAT_ID ?? null,
  turn: process.env.GS_CO_SEAT_TURN ?? null, dir: process.env.GS_CO_SEAT_DIR ?? null,
  token: process.env.CHILD_TOKEN ?? null, key: process.env.ANTHROPIC_API_KEY ?? null,
  cwd: process.cwd(), stdin: "",
};
if (process.argv.length <= 2) { rec.stdin = await new Response(Bun.stdin.stream()).text(); }
appendFileSync(${JSON.stringify(opts.logPath)}, JSON.stringify(rec) + "\\n");
${opts.sleepMs ? `await new Promise((r) => setTimeout(r, ${opts.sleepMs}));` : ""}
${write}
process.exit(${opts.exit ?? 0});
`;
}

export interface SeatYamlOptions {
  projects?: string[];
  runners?: unknown[];
  authority?: Record<string, unknown>;
  wake?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function seatBlock(id: string, opts: SeatYamlOptions = {}): Record<string, unknown> {
  return {
    id,
    brief: `./co-seat/${id}/BRIEF.md`,
    state_file: `./co-seat/${id}/STATE.md`,
    projects: opts.projects ?? ["app"],
    authority: opts.authority ?? {},
    runners: opts.runners ?? [
      {
        id: "primary",
        command: ["echo", "{prompt}"],
        meter: { command: ["echo", "10"], max_used_percent: 85 },
      },
    ],
    ...(opts.wake ? { wake: opts.wake } : {}),
    ...(opts.extra ?? {}),
  };
}

export function writeProjectsYaml(
  root: string,
  seats: unknown[] | undefined,
  projectIds: string[] = ["app"],
  projectExtra: Record<string, Record<string, unknown>> = {},
  dispatcherExtra: Record<string, unknown> = {},
): string {
  const doc: Record<string, unknown> = {
    projects: projectIds.map((id) => projectEntry(root, id, projectExtra[id] ?? {})),
    dispatcher: { ...(seats === undefined ? {} : { co_seats: seats }), ...dispatcherExtra },
  };
  const path = join(root, "projects.yaml");
  writeFileSync(path, stringify(doc));
  return path;
}

/** Write brief + state files for a seat id under the sandbox root. */
export function writeSeatFiles(root: string, id: string, brief = "# brief\n"): void {
  mkdirSync(join(root, "co-seat", id), { recursive: true });
  writeFileSync(join(root, "co-seat", id, "BRIEF.md"), brief);
  writeFileSync(join(root, "co-seat", id, "STATE.md"), STATE_TEMPLATE);
}

export async function loadCtx(id?: string): Promise<SeatContext> {
  return loadSeatContext(id, { quiet: true });
}

// --- git control repo fixture (remote_control tests) ---

import { spawnSync } from "child_process";

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin plus a checkout on `main` with one commit, pushed. */
export function makeControlRepo(root: string): { origin: string; repo: string } {
  const origin = join(root, "origin.git");
  const repo = join(root, "control");
  mkdirSync(origin, { recursive: true });
  git(root, "init", "-q", "--bare", origin);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "checkout", "-q", "-B", "main");
  writeFileSync(join(repo, "README.md"), "control\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  return { origin, repo };
}

// --- CLI runner (the guards and commands are tested through the real entry point) ---

export const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

export async function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const merged: Record<string, string | undefined> = { ...process.env, GS_CO_SEAT: undefined, GS_CO_SEAT_ID: undefined, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: clean });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** Write a valid GO (pin of the config as it is now) so guards see a seat that has been `go`ed. */
export function writeGoFor(ctx: SeatContext, nowMs: number = Date.now(), days = 7): void {
  writeGo(ctx.dir, {
    version: 1,
    set_at: new Date(nowMs).toISOString(),
    deadline: new Date(nowMs + days * 86_400_000).toISOString(),
    pin: pinOfContext(ctx),
    days,
  });
}
