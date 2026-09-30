import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function probe(source: string) {
  scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "gs-process-tree-test-")));
  // Bun can inline native fs calls past mock.module. Change only the fs import
  // in a temporary copy so both the old and fixed source use our injected /proc.
  const sourceDir = join(import.meta.dir, "..", "src", "verify_only");
  const tree = join(scratch, "process_tree.ts");
  const git = join(scratch, "git.ts");
  writeFileSync(tree, readFileSync(join(sourceDir, "process_tree.ts"), "utf8").replace('from "fs"', 'from "s188-proc-fs"'));
  writeFileSync(git, readFileSync(join(sourceDir, "git.ts"), "utf8"));
  const helper = join(scratch, "probe.ts");
  writeFileSync(helper, source.replace("__PROCESS_TREE__", JSON.stringify(tree)).replace("__GIT__", JSON.stringify(git)));
  const proc = Bun.spawn([process.execPath, helper], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 12_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

/** Exercise Linux enumeration and its pre-signal recheck on every host. */
async function linuxProbe(body: string) {
  return probe(`
import { mock } from "bun:test";
Object.defineProperty(process, "platform", { value: "linux" });
const own = process.pid;
const child = own + 100;
const other = own + 200;
const records = new Map<number, string | Error>();
const stat = (pid: number, comm: string, state: string, group: number) =>
  pid + " (" + comm + ") " + state + " 1 " + group + " 0 0 0\\n";
records.set(own, stat(own, "cli", "S", own));
let entries = [String(own), String(child), "self", "thread-self"];
mock.module("s188-proc-fs", () => ({
  readFileSync: (path: string) => {
    const pid = Number(path.split("/")[2]);
    const record = records.get(pid);
    if (record instanceof Error) throw record;
    if (record === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return record;
  },
  readdirSync: () => entries,
}));
const { verificationTreeId, verificationGroupMembers, signalVerificationMembers } =
  await import(__PROCESS_TREE__);
const sent: number[] = [];
process.kill = ((pid: number) => { sent.push(pid); return true; }) as typeof process.kill;
${body}
`);
}

async function inheritedProbe(mode: "abort" | "timeout" | "survivor" | "missing-live-child" | "unproven-exit") {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-inherited-git-test-")));
  const marker = join(scratch, "pid");
  const shim = join(scratch, "git");
  writeFileSync(shim, `#!/bin/sh\necho $$ > '${marker}'\n${mode === "unproven-exit" ? "exit 0" : "exec sleep 120"}\n`);
  chmodSync(shim, 0o755);
  try {
    return await probe(`
import { mock } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
const realRead = readFileSync;
const realReaddir = readdirSync;
Object.defineProperty(process, "platform", { value: "linux" });
const mode = ${JSON.stringify(mode)};
let unproven = mode !== "missing-live-child";
mock.module("s188-proc-fs", () => ({
  readFileSync: (path: string, ...args: any[]) => path === "/proc/" + process.pid + "/stat"
    ? process.pid + " (cli) S 1 " + process.pid + " 0 0 0\\n"
    : (realRead as any)(path, ...args),
  readdirSync: (path: string, ...args: any[]) => {
    if (path !== "/proc") return (realReaddir as any)(path, ...args);
    if (unproven) throw Object.assign(new Error("unproven"), { code: "EIO" });
    return [];
  },
}));
const { runGitRaw, withInheritedGitGroup, signalLiveGitGroups, killAndReapLiveGitGroups } =
  await import(__GIT__);
const originalKill = process.kill.bind(process);
const sent: { pid: number; signal: string | number | undefined }[] = [];
const controller = new AbortController();
process.kill = ((pid: number, signal?: string | number) => {
  if (signal !== 0) {
    sent.push({ pid, signal });
    // Never allow a regression to signal this helper or its parent group.
    if (pid <= 0 || pid === process.pid) throw new Error("unsafe signal target");
    if (mode === "survivor" || mode === "missing-live-child") return true;
  }
  return originalKill(pid, signal as NodeJS.Signals);
}) as typeof process.kill;
const work = withInheritedGitGroup(() => runGitRaw([], {
  cwd: ${JSON.stringify(scratch)}, env: { PATH: ${JSON.stringify(`${scratch}:${process.env.PATH ?? ""}`)} },
  signal: controller.signal, timeoutMs: mode === "timeout" ? 300 : 10000,
}));
let pid: number | undefined;
let observation;
let proofTimer: ReturnType<typeof setInterval> | undefined;
try {
  const until = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(marker)}) && Date.now() < until) await Bun.sleep(10);
  if (!existsSync(${JSON.stringify(marker)})) throw new Error("git shim did not start");
  pid = Number(realRead(${JSON.stringify(marker)}, "utf8").trim());
  if (mode === "abort" || mode === "timeout") {
    proofTimer = setInterval(() => {
      try { originalKill(pid!, 0); } catch { unproven = false; }
    }, 10);
  }
  if (mode === "abort" || mode === "survivor" || mode === "missing-live-child") controller.abort();
  const result = await work;
  let survivor = false;
  try { originalKill(pid, 0); survivor = true; } catch { /* gone */ }
  const after = sent.length;
  unproven = true;
  signalLiveGitGroups("SIGTERM");
  observation = { result, sent, survivor, retained: sent.slice(after), own: process.pid, pid };
} finally {
  if (proofTimer) clearInterval(proofTimer);
  process.kill = originalKill;
  if (pid !== undefined) { try { originalKill(pid, "SIGKILL"); } catch { /* gone */ } }
  unproven = false;
  killAndReapLiveGitGroups();
  await work;
}
console.log(JSON.stringify(observation));
`);
  } finally {
    // A failed helper must not leave its real child running after its timeout.
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, "utf8").trim());
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

describe("verify-only process-group fix round s188", () => {
  for (const state of ["S", "R", "t", "x"]) {
    it(`enumerates and signals an owned child in state ${state} with spaces, parentheses and digits in comm`, async () => {
      const result = await linuxProbe(`
records.set(child, stat(child, "worker (123) ) S 99 456 (tail)", ${JSON.stringify(state)}, own));
const members = verificationGroupMembers();
signalVerificationMembers("SIGKILL");
console.log(JSON.stringify({ members, sent, child }));
`);
      expect(result.members).toEqual([result.child]);
      expect(result.sent).toEqual([result.child]);
    });
  }

  it("never counts or signals a lowercase-state comm impostor as an owned member", async () => {
    const result = await linuxProbe(`
records.set(child, stat(child, "x " + own + " y", "t", other));
const members = verificationGroupMembers();
signalVerificationMembers("SIGKILL");
console.log(JSON.stringify({ members, sent }));
`);
    expect(result.members).toEqual([]);
    expect(result.sent).toEqual([]);
  });

  it("rechecks the positional pgrp before signalling a PID that left our group", async () => {
    const result = await linuxProbe(`
let reads = 0;
records.set(child, stat(child, "x " + own + " y", "S", own));
const get = records.get.bind(records);
records.get = ((pid: number) => pid === child && ++reads > 1
  ? stat(child, "x " + own + " y", "t", other) : get(pid));
signalVerificationMembers("SIGKILL");
console.log(JSON.stringify({ sent }));
`);
    expect(result.sent).toEqual([]);
  });

  for (const tail of ["S 1", "S nope 123", "S 1 1e3", "SS 1 123", "S 1 9007199254740992"]) {
    it(`rejects a malformed stat record (${tail}) instead of guessing`, async () => {
      const result = await linuxProbe(`
records.set(own, own + " (cli) " + ${JSON.stringify(tail)});
let rejected = false;
try { verificationTreeId(); } catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`);
      expect(result.rejected).toBe(true);
    });
  }

  it("reports unproven enumeration for a malformed child record", async () => {
    const result = await linuxProbe(`
records.set(child, child + " (broken) S 1 nope");
console.log(JSON.stringify({ members: verificationGroupMembers() }));
`);
    expect(result.members).toBeNull();
  });

  for (const code of ["EACCES", "EPERM", "ENOENT", "ESRCH"]) {
    it(`keeps enumerating past a ${code} entry`, async () => {
      const result = await linuxProbe(`
entries.push(String(other));
records.set(child, Object.assign(new Error("unreadable"), { code: ${JSON.stringify(code)} }));
records.set(other, stat(other, "owned", "S", own));
const members = verificationGroupMembers();
signalVerificationMembers("SIGKILL");
console.log(JSON.stringify({ members, sent, other }));
`);
      expect(result.members).toEqual([result.other]);
      expect(result.sent).toEqual([result.other]);
    });
  }

  it("reports unproven enumeration for unexpected entry errors", async () => {
    const result = await linuxProbe(`
records.set(child, Object.assign(new Error("bad read"), { code: "EIO" }));
console.log(JSON.stringify({ members: verificationGroupMembers() }));
`);
    expect(result.members).toBeNull();
  });

  for (const mode of ["abort", "timeout"] as const) {
    it(`signals the known direct git child on ${mode} when enumeration is null`, async () => {
      if (process.platform === "win32") return;
      const result = await inheritedProbe(mode);
      expect(result.sent.some((entry: { pid: number; signal: string }) => entry.pid === result.pid && entry.signal === "SIGKILL")).toBe(true);
      expect(result.sent.every((entry: { pid: number }) => entry.pid > 0 && entry.pid !== result.own)).toBe(true);
      expect(result.survivor).toBe(false);
      expect(result.result[mode === "abort" ? "aborted" : "timedOut"]).toBe(true);
      expect(result.result.reaped).toBe(true);
      expect(result.retained).toEqual([]);
    }, 15_000);
  }

  it("retains ownership and reports not-reaped after the reap cap with a live child", async () => {
    if (process.platform === "win32") return;
    const result = await inheritedProbe("survivor");
    expect(result.survivor).toBe(true);
    expect(result.result.reaped).toBe(false);
    expect(result.result.code).toBeNull();
    expect(result.result.stderr).toContain("not proven reaped");
    expect(result.retained).toEqual([{ pid: result.pid, signal: "SIGTERM" }]);
    expect(result.sent.every((entry: { pid: number }) => entry.pid > 0 && entry.pid !== result.own)).toBe(true);
  }, 15_000);

  it("cannot report success when git exited but its group remains unproven", async () => {
    if (process.platform === "win32") return;
    const result = await inheritedProbe("unproven-exit");
    expect(result.survivor).toBe(false);
    expect(result.result.reaped).toBe(false);
    expect(result.result.code).toBe(0);
    expect(result.result.reapError).toContain("not proven reaped");
    expect(result.result.stderr).toContain("not proven reaped");
    // Keep the unproven reap result without signalling an exited/reusable PID.
    expect(result.retained).toEqual([]);
  }, 15_000);

  it("does not release a live direct child just because enumeration is empty", async () => {
    if (process.platform === "win32") return;
    const result = await inheritedProbe("missing-live-child");
    expect(result.survivor).toBe(true);
    expect(result.result.reaped).toBe(false);
    expect(result.result.code).toBeNull();
    expect(result.retained).toEqual([{ pid: result.pid, signal: "SIGTERM" }]);
  }, 15_000);
});
