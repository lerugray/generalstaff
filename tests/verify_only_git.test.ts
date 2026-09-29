import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
