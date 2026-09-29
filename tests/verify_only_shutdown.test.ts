import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runGitRaw } from "../src/verify_only/git";
import { git, makeVerifyFixture, type VerifyFixture } from "./helpers/verify_only_fixture";

let fx: VerifyFixture | undefined;
let pids: number[] = [];
afterEach(() => {
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  pids = [];
  fx?.cleanup();
  fx = undefined;
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPids(file: string): number[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
}

function shim(f: VerifyFixture, script: string): void {
  const path = join(f.binDir, "git");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

function descendants(marker: string): string {
  // Closed descriptors make Git's close event fire while descendants live.
  return [
    `sleep 120 </dev/null >/dev/null 2>&1 &`,
    `echo $! >> '${marker}'`,
    `sleep 120 </dev/null >/dev/null 2>&1 &`,
    `echo $! >> '${marker}'`,
  ].join("\n");
}

describe("hardening fix round 7 shutdown", () => {
  for (const code of [0, 7]) {
    it(`R1: Git exit ${code} awaits descendant termination before resolving`, async () => {
      if (process.platform === "win32") return;
      fx = makeVerifyFixture();
      const marker = join(fx.scratch, "git.pids");
      shim(fx, `${descendants(marker)}\nexit ${code}`);
      try {
        const result = await runGitRaw([], { cwd: fx.checkout, env: fx.env() });
        pids = readPids(marker);
        expect(result.code).toBe(code);
        expect(pids).toHaveLength(2);
        for (const pid of pids) expect(alive(pid)).toBe(false);
      } finally {
        pids = readPids(marker);
      }
    }, 10_000);
  }

  for (const refuse of [false, true]) {
    it(`R1: cycle ${refuse ? "refusal" : "success"} exits after prune descendants terminate`, async () => {
      if (process.platform === "win32") return;
      fx = makeVerifyFixture();
      writeFileSync(join(fx.checkout, "a.txt"), "changed\n");
      const bundled = await fx.runCli([
        "changeset", "bundle", `--checkout=${fx.checkout}`, `--base=${fx.base}`,
        `--out=${join(fx.scratch, "bundle")}`, "--json",
      ]);
      expect(bundled.exitCode).toBe(0);
      const bundle = JSON.parse(bundled.stdout);
      const realGit = Bun.which("git")!;
      const marker = join(fx.scratch, "prune.pids");
      shim(fx, [
        'case " $* " in',
        '  *" worktree prune "*)',
        descendants(marker),
        '    ;;',
        'esac',
        `exec '${realGit}' "$@"`,
      ].join("\n"));
      try {
        const result = await fx.runCli([
          "cycle", "verify", `--project=${fx.projectId}`, `--checkout=${fx.checkout}`,
          `--base=${fx.base}`, "--branch=main", `--bundle=${bundle.bundlePath}`,
          `--digest=${refuse ? `sha256:${"0".repeat(64)}` : bundle.digest}`,
          "--digest-algorithm=gs-patch-digest/v1", "--json",
        ], { timeoutMs: 15_000 });
        pids = readPids(marker);
        expect(result.exitCode).toBe(refuse ? 3 : 0);
        expect(pids.length).toBeGreaterThanOrEqual(2);
        for (const pid of pids) expect(alive(pid)).toBe(false);
        expect(git(fx.checkout, ["worktree", "list"]).split("\n")).toHaveLength(1);
      } finally {
        pids = readPids(marker);
      }
    }, 20_000);
  }

  for (const [signal, num, stage] of [
    ["SIGINT", 2, "excludes"],
    ["SIGTERM", 15, "excludes"],
    ["SIGHUP", 1, "excludes"],
    ["SIGTERM", 15, "snapshot"],
  ] as const) {
    it(`R2: bundle ${signal} during ${stage} awaits owned Git termination`, async () => {
      if (process.platform === "win32") return;
      fx = makeVerifyFixture();
      writeFileSync(join(fx.checkout, "a.txt"), "changed\n");
      const marker = join(fx.scratch, "bundle-git.pids");
      const realGit = Bun.which("git")!;
      const match = stage === "excludes" ? "config --global --path --get core.excludesFile" : "diff";
      shim(fx, [
        'case " $* " in',
        `  *" ${match} "*)`,
        "    trap '' INT TERM HUP",
        descendants(marker),
        `    echo $$ >> '${marker}'`,
        "    wait; exit 1 ;;",
        "esac",
        `exec '${realGit}' "$@"`,
      ].join("\n"));
      const out = join(fx.scratch, "interrupted-bundle");
      const { proc, result } = fx.spawnCli([
        "changeset", "bundle", `--checkout=${fx.checkout}`, `--base=${fx.base}`,
        `--out=${out}`, "--json",
      ]);
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      try {
        const deadline = Date.now() + 5000;
        while (readPids(marker).length < 3 && Date.now() < deadline) await Bun.sleep(20);
        pids = readPids(marker);
        expect(pids).toHaveLength(3);
        for (const pid of pids) expect(alive(pid)).toBe(true);
        proc.kill(signal);
        const r = await result;
        expect(r.exitCode).toBe(128 + num);
        for (const pid of pids) expect(alive(pid)).toBe(false);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("interrupted");
        expect(existsSync(out)).toBe(false);
      } finally {
        clearTimeout(timer);
        proc.kill("SIGKILL");
        await result;
        pids = readPids(marker);
      }
    }, 15_000);
  }
});
