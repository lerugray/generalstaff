import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { minimalChildEnv, runGitRaw } from "../src/verify_only/git";
import { installTestCli } from "./helpers/test_cli";

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** Isolate the live-group registry and the process.kill spy in a subprocess. */
async function groupProbe(mode: "second-signal" | "release-cap") {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-git-group-test-")));
  const marker = join(scratch, "pid");
  const shim = join(scratch, "git");
  writeFileSync(shim, mode === "second-signal"
    ? `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 120\n`
    : `#!/bin/sh\nsleep 120 </dev/null >/dev/null 2>&1 &\necho $! > '${marker}'\nexit 0\n`);
  chmodSync(shim, 0o755);
  const helper = join(scratch, "probe.ts");
  writeFileSync(helper, `
import { existsSync, readFileSync } from "fs";
import { runGitRaw, killAndReapLiveGitGroups, signalLiveGitGroups } from ${JSON.stringify(join(import.meta.dir, "..", "src", "verify_only", "git.ts"))};
const work = runGitRaw([], { cwd: ${JSON.stringify(scratch)}, env: { PATH: ${JSON.stringify(`${scratch}:${process.env.PATH ?? ""}`)} }, timeoutMs: 10000 });
const marker = ${JSON.stringify(marker)};
const until = Date.now() + 5000;
while (!existsSync(marker) && Date.now() < until) await Bun.sleep(20);
if (!existsSync(marker)) throw new Error("git shim did not start");
const pid = Number(readFileSync(marker, "utf8").trim());
let observation;
const originalKill = process.kill.bind(process);
try {
  if (${JSON.stringify(mode)} === "second-signal") {
    const started = performance.now();
    killAndReapLiveGitGroups();
    observation = { elapsed: performance.now() - started };
    await work;
  } else {
    await work;
    await Bun.sleep(4000);
    let survivor = false;
    try { originalKill(pid, 0); survivor = true; } catch { /* gone */ }
    const sent: number[] = [];
    process.kill = ((target: number, signal?: string | number) => {
      if (signal === "SIGTERM") sent.push(target);
      return originalKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    signalLiveGitGroups("SIGTERM");
    observation = { survivor, sent };
  }
} finally {
  process.kill = originalKill;
  try { originalKill(pid, "SIGKILL"); } catch { /* gone */ }
  killAndReapLiveGitGroups();
  await work;
}
console.log(JSON.stringify(observation));
`);
  const proc = Bun.spawn(["bun", helper], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout) as { elapsed?: number; survivor?: boolean; sent?: number[] };
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

describe("hardening fix round 5 git groups", () => {
  for (const stop of ["timeout", "abort"] as const) {
    it(`${stop} waits for the native Git leader and descendant to stop`, async () => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-git-tree-test-")));
      const marker = join(scratch, "pids.json");
      const sleeper = join(scratch, "sleeper.mjs");
      writeFileSync(sleeper, "setInterval(() => {}, 1000);\n");
      installTestCli(scratch, "git", `
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(sleeper)}], { stdio: "inherit" });
child.on("spawn", () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])));
setInterval(() => {}, 1000);
`);
      const controller = new AbortController();
      const work = runGitRaw([], {
        cwd: scratch,
        env: minimalChildEnv({ PATH: `${scratch}${delimiter}${process.env.PATH ?? ""}` }),
        timeoutMs: stop === "timeout" ? 2500 : 10_000,
        signal: controller.signal,
      });
      let pids: number[] = [];
      try {
        const readyBy = Date.now() + 2000;
        while (!existsSync(marker) && Date.now() < readyBy) await Bun.sleep(20);
        expect(existsSync(marker)).toBe(true);
        pids = JSON.parse(readFileSync(marker, "utf8"));
        expect(pids).toHaveLength(2);
        if (stop === "abort") controller.abort();
        const result = await work;
        expect(stop === "abort" ? result.aborted : result.timedOut).toBe(true);
        expect(result.spawnError).toBeUndefined();
        // No polling after return: callers can remove the working tree immediately.
        for (const pid of pids) {
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch { /* reaped */ }
          expect(alive).toBe(false);
        }
      } finally {
        controller.abort();
        await work;
        for (const pid of pids) {
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }
      }
    }, 20_000);
  }

  it("finding 3: the second-signal SIGKILL returns without blocking child reaping", async () => {
    if (process.platform === "win32") return; // POSIX process-group regression
    const result = await groupProbe("second-signal");
    expect(result.elapsed!).toBeLessThan(1000);
  }, 20_000);

  it("finding 4: the release cap kills leftover members and retires their group", async () => {
    if (process.platform === "win32") return;
    const result = await groupProbe("release-cap");
    expect(result.survivor).toBe(false);
    expect(result.sent).toEqual([]);
  }, 20_000);
});
