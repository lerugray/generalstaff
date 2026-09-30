import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolated subprocesses prevent module mocks and the synthetic Windows platform
// from leaking into other tests. Only OS calls are replaced, in copied source.
async function probe(mode: string, target = "git") {
  const dir = mkdtempSync(join(tmpdir(), "gs-win-reap-"));
  const source = join(import.meta.dir, "../src/verify_only");
  cpSync(source, dir, { recursive: true });
  for (const file of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
    const path = join(dir, file);
    writeFileSync(path, readFileSync(path, "utf8")
      .replaceAll('from "child_process"', 'from "s189-child-process"')
      .replaceAll('from "./windows_job"', 'from "s189-windows-job"')
      .replace("\nfunction gitFailure(", "\nexport function gitFailure("));
  }
  writeFileSync(join(dir, "probe.ts"), `
import { mock } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
const mode = ${JSON.stringify(mode)};
const target = ${JSON.stringify(target)};
Object.defineProperty(process, "platform", { value: "win32" });
const controller = new AbortController();
let active = mode === "normal" || mode === "spawn" || mode === "setup" ? 0 : 1;
let killed = 0, closed = 0, now = 0;
// Advance the deadline deterministically; surviving-tree cases never sleep.
Date.now = () => now += 4000;
let child: any;
let launch: any, envHandoff: any;
const calls: any[] = [];
process.kill = (() => true) as any;
mock.module("s189-windows-job", () => ({
  createWindowsJob: () => {
    if (mode === "create") throw new Error("CreateJobObjectW failed (Win32 error 5)");
    return ({
    name: "job-test",
    activeProcesses: () => {
      if (mode === "query") throw new Error("QueryInformationJobObject failed (Win32 error 5)");
      return active;
    },
    terminate: () => { if (!mode.startsWith("survivor")) active = 0; },
    close: () => { closed++; },
  }); },
}));
mock.module("s189-child-process", () => ({
  spawn: (command: string, args: string[], options: any) => {
    launch = { command, args, options };
    child = new EventEmitter();
    Object.assign(child, { pid: 12345, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
      send: (message: any, cb: any) => { envHandoff = message; cb(null); } });
    queueMicrotask(() => {
      child.emit("message", { type: "ready" });
      child.exitCode = ["missing", "abort", "denied", "timeout", "survivor-missing"].includes(mode) ? null : 0;
      if (mode === "spawn") child.emit("message", { type: "spawnError", message: "spawn git ENOENT" });
      if (mode === "setup") child.emit("message", { type: "reapError", message: "AssignProcessToJobObject failed (Win32 error 5)" });
      if (["missing", "abort", "denied", "timeout", "survivor-missing"].includes(mode)) controller.abort();
      child.exitCode = 0;
      child.stdout.emit("data", Buffer.from("answer"));
      child.emit("close", 0);
    });
    return child;
  },
  spawnSync: (command: string, args: string[], options: any) => {
    killed++;
    child.exitCode = 0;
    calls.push({ command, args, timeout: options.timeout, capture: options.stdio });
    const status = mode === "normal" || mode === "missing" || mode === "abort" || mode === "survivor-missing" ? 128
      : mode === "denied" ? 1 : mode === "timeout" ? null : 0;
    return { status, signal: mode === "timeout" ? "SIGKILL" : null,
      error: mode === "timeout" ? new Error("spawnSync taskkill ETIMEDOUT") : undefined,
      stderr: status === 128 ? "ERROR: process 12345 not found." : status === 1 ? "ERROR: Access is denied." : "",
      stdout: "" };
  },
}));
const git = await import("./git.ts");
if (target === "excludes" || target === "base" || target === "checkout" || target === "review") {
  let error: any;
  try {
    if (target === "excludes") await git.withGitAbort(controller.signal, () => (async () => await (await import("./excludes.ts")).resolveGlobalExcludes())());
    else {
      const m = await import("./materialize.ts");
      if (target === "base") await git.withGitAbort(controller.signal, () => m.baseIsCommit(process.cwd(), "abc"));
      if (target === "checkout") await git.withGitAbort(controller.signal, () => m.isGitTopLevel(process.cwd(), p => p));
      if (target === "review") await git.withGitAbort(controller.signal, () => m.renderReviewDiff(process.cwd(), "abc"));
    }
  } catch (e) { error = e; }
  console.log(JSON.stringify({code:error?.code, message:error?.message}));
  process.exit(0);
}
let result;
if (target === "runner") {
  const { runOwnedShell } = await import("./runner.ts");
  result = await runOwnedShell({command:"echo ok",cwd:process.cwd(),env:{},timeoutMs:1000,signal:controller.signal});
} else result = await git.runGitRaw(["status"], { cwd:process.cwd(), signal:controller.signal, env: { PATH: "target-path", BUN_OPTIONS: "--preload evil", NODE_OPTIONS: "--require evil", MARKER: "exact" } });
const { gitFailure } = await import("./digest.ts");
const failure = gitFailure("status", target === "runner" ? { ...result, code: result.exitCode, stderr: result.output } : result);
const { toRefusal } = await import("./refusal.ts");
const refusal = toRefusal(failure);
console.log(JSON.stringify({result, failure:{code:failure.code,message:failure.message},
  refusal:{code:refusal.code,message:refusal.message}, killed, closed, calls, launch, envHandoff}));
`);
  try {
    const child = Bun.spawn([process.execPath, join(dir, "probe.ts")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return JSON.parse(stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("Windows Git reap proof (deterministic on every OS)", () => {
  it("an already exited empty job succeeds without taskkill", async () => {
    const r = await probe("normal");
    expect(r.result.code).toBe(0);
    expect(r.result.reaped).toBe(true);
    expect(r.result.spawnError).toBeUndefined();
    expect(r.killed).toBe(0);
    expect(r.closed).toBe(1);
  });
  it("keeps target preload settings out of launcher startup and hands them over after ready", async () => {
    const r = await probe("normal");
    expect(r.launch.options.env).toEqual({ PATH: "target-path" });
    expect(r.launch.args.slice(0, 2)).toEqual(["--env-file", " "]);
    expect(r.envHandoff).toEqual({ type: "targetEnv", env: {
      PATH: "target-path", BUN_OPTIONS: "--preload evil", NODE_OPTIONS: "--require evil", MARKER: "exact",
    } });
  });
  it("reaps orphaned job members without signalling a potentially reused leader PID", async () => {
    const r = await probe("exited-descendant");
    expect(r.result.reaped).toBe(true);
    expect(r.killed).toBe(0);
    expect(r.closed).toBe(1);
  });
  for (const mode of ["missing", "abort"]) it(`taskkill process-not-found is harmless only after job proof (${mode})`, async () => {
    const r = await probe(mode);
    expect(r.killed).toBe(1);
    expect(r.result.reaped).toBe(true);
    expect(r.result.spawnError).toBeUndefined();
    expect(r.result.reapError).toBeUndefined();
  });
  for (const mode of ["denied", "timeout"]) it(`cleanup ${mode} never becomes git_missing and preserves its cause`, async () => {
    const r = await probe(mode);
    expect(r.result.reaped).toBe(false);
    expect(r.result.code).toBeNull();
    expect(r.result.spawnError).toBeUndefined();
    expect(r.failure.code).toBe("git_reap_failed");
    expect(r.refusal.code).toBe("git_reap_failed");
    expect(r.refusal.message).toContain(mode === "denied" ? "Access is denied" : "ETIMEDOUT");
    expect(r.result.reapError).toContain(mode === "denied" ? "taskkill exited 1" : "taskkill exited null");
    expect(r.calls[0].timeout).toBe(3000);
    expect(r.calls[0].capture).toEqual(["ignore", "pipe", "pipe"]);
  });
  for (const mode of ["survivor", "survivor-missing", "query", "setup", "create"]) it(`fails closed on ${mode}, even after exit 0`, async () => {
    const r = await probe(mode);
    expect(r.result.reaped).toBe(false);
    expect(r.result.spawnError).toBeUndefined();
    expect(r.failure.code).toBe("git_reap_failed");
    if (!mode.startsWith("survivor")) expect(r.failure.message).toContain("Win32 error 5");
  });
  it("a real target launch error remains git_missing with the original cause", async () => {
    const r = await probe("spawn");
    expect(r.result.spawnError).toBe("spawn git ENOENT");
    expect(r.failure.code).toBe("git_missing");
    expect(r.failure.message).toContain("spawn git ENOENT");
  });
  for (const target of ["excludes", "base", "checkout", "review"]) it(`preserves cleanup classification and cause through ${target}`, async () => {
    const r = await probe("denied", target);
    expect(r.code).toBe("git_reap_failed");
    expect(r.message).toContain("taskkill exited 1");
    expect(r.message).toContain("Access is denied");
  });
  for (const mode of ["normal", "denied", "survivor", "query"]) it(`shell runner applies the same reap contract (${mode})`, async () => {
    const r = await probe(mode, "runner");
    expect(r.result.reaped).toBe(mode === "normal");
    expect(r.result.spawnError).toBeUndefined();
    if (mode !== "normal") expect(r.result.reapError).toBeTruthy();
  });
});

async function launcherProbe(mode: "ok" | "setup" | "spawn") {
  const dir = mkdtempSync(join(tmpdir(), "gs-win-launcher-"));
  try {
    writeFileSync(join(dir, "wrapper.ts"), readFileSync(join(import.meta.dir, "../src/verify_only/windows_job_child.ts"), "utf8")
      .replace('from "child_process"', 'from "s189-wrapper-spawn"')
      .replace('from "./windows_job"', 'from "s189-wrapper-job"'));
    writeFileSync(join(dir, "probe.ts"), `
import { mock } from "bun:test";
import { EventEmitter } from "events";
const events: any[] = [];
const mode = ${JSON.stringify(mode)};
const targetEnv = { PATH: "target-path", BUN_OPTIONS: "target-only-preload", TEST_MARKER: "exact" };
mock.module("s189-wrapper-job", () => ({ assignCurrentProcessToWindowsJob: (name: string) => {
  events.push(["assigned", name]);
  if (mode === "setup") throw new Error("AssignProcessToJobObject failed (Win32 error 5)");
} }));
mock.module("s189-wrapper-spawn", () => ({ spawn: (command: string, args: string[], options: any) => {
  events.push(["spawn", command, args, options]);
  const child = new EventEmitter();
  queueMicrotask(() => mode === "spawn" ? child.emit("error", new Error("spawn git ENOENT")) : child.emit("exit", 0, null));
  return child;
} }));
Object.defineProperty(process, "connected", { value: true });
process.disconnect = () => events.push(["disconnect"]);
process.send = ((message: any, callback: any) => {
  events.push(["ipc", message]);
  queueMicrotask(() => {
    if (message.type === "ready") process.emit("message", { type:"targetEnv", env:targetEnv });
    callback(null);
  });
  return true;
}) as any;
process.argv = [process.execPath, "wrapper.ts", "job-test", "target-cwd", "git", "status", "--short"];
process.on("exit", () => console.log(JSON.stringify(events)));
await import("./wrapper.ts");
`);
    const child = Bun.spawn([process.execPath, join(dir, "probe.ts")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(mode === "ok" ? 0 : 1);
    return JSON.parse(stdout) as any[];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("Windows launcher containment before target execution", () => {
  it("joins the job before receiving the exact environment and spawning the target", async () => {
    const events = await launcherProbe("ok");
    expect(events[0]).toEqual(["assigned", "job-test"]);
    expect(events[1]).toEqual(["ipc", { type: "ready" }]);
    expect(events[2]).toEqual(["spawn", "git", ["status", "--short"], {
      cwd: "target-cwd", stdio: "inherit", windowsHide: true,
      env: { PATH: "target-path", BUN_OPTIONS: "target-only-preload", TEST_MARKER: "exact" },
    }]);
  });
  it("failed job assignment never starts the target and delivers the native cause", async () => {
    const events = await launcherProbe("setup");
    expect(events.some(e => e[0] === "spawn")).toBe(false);
    expect(events[1]).toEqual(["ipc", { type: "reapError", message: "AssignProcessToJobObject failed (Win32 error 5)" }]);
  });
  it("a missing target executable reports a launch error over IPC before exit", async () => {
    const events = await launcherProbe("spawn");
    expect(events[3]).toEqual(["ipc", { type: "spawnError", message: "spawn git ENOENT" }]);
    expect(events[4]).toEqual(["disconnect"]);
  });
});
