import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import {
  buildArgv,
  buildPrompt,
  buildTurnEnv,
  liveTurnPath,
  readLiveTurn,
  reapRecordedTurn,
  runTurn,
  turnDir,
  type LiveTurnRecord,
} from "../../src/co_seat/turn";
import type { SeatContext } from "../../src/co_seat/config";
import type { CoSeatRunnerConfig } from "../../src/types";
import {
  STATE_TEMPLATE,
  loadCtx,
  makeSandbox,
  recordingRunnerSource,
  scriptPath,
  seatBlock,
  writeProjectsYaml,
  writeSeatFiles,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
const orphans: number[] = [];
afterEach(() => {
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  sb.cleanup();
});

/** A long-running process in its own group, standing in for a turn whose driver died. */
function spawnOrphan(opts: { ignoreTerm?: boolean } = {}): number {
  const code = `${opts.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} setTimeout(() => {}, 60000);`;
  const child = spawn(process.execPath, ["-e", code], { detached: process.platform !== "win32", stdio: "ignore" });
  child.unref();
  orphans.push(child.pid!);
  return child.pid!;
}

function record(pid: number, over: Partial<LiveTurnRecord> = {}): LiveTurnRecord {
  return { pid, pgid: process.platform === "win32" ? null : pid, host: hostname(), started: new Date().toISOString(), n: 1, exe: process.execPath, ...over };
}

interface Fixture {
  ctx: SeatContext;
  runner: CoSeatRunnerConfig;
  log: string;
  calls: () => Array<Record<string, any>>;
}

async function fixture(
  source: Parameters<typeof recordingRunnerSource>[0] extends infer O ? Partial<O> : never = {},
  opts: { stdin?: boolean; command?: string[]; env?: Record<string, string>; env_unset?: string[]; extraSeat?: Record<string, unknown> } = {},
): Promise<Fixture> {
  const log = join(sb.root, "runner-calls.jsonl");
  const statePath = join(sb.root, "co-seat", "main", "STATE.md");
  const script = scriptPath(sb.root, "runner.mjs", recordingRunnerSource({ logPath: log, statePath, ...source }));
  const command = opts.command ?? [process.execPath, script, ...(opts.stdin ? [] : ["{prompt}"])];
  const runner: Record<string, unknown> = {
    id: "primary",
    command,
    meter: { command: ["echo", "10"], max_used_percent: 85 },
  };
  if (opts.env) runner.env = opts.env;
  if (opts.env_unset) runner.env_unset = opts.env_unset;
  writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner], extra: opts.extraSeat })]);
  writeSeatFiles(sb.root, "main");
  const ctx = await loadCtx("main");
  return {
    ctx,
    runner: ctx.seat.runners[0]!,
    log,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const FAST = { stopCheckMs: 40, remoteCheckMs: 80, killGraceMs: 300 };

describe("runTurn: spawning", () => {
  it("substitutes {prompt}, writes PROMPT.md and EVENTS.md, snapshots state, and logs output under turns/<n>/", async () => {
    const f = await fixture();
    const r = await runTurn(
      { ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 12, eventLines: ["cycle ended: app c1 outcome=verified"] },
      { ...FAST },
    );
    expect(r).toMatchObject({ n: 1, runner: "primary", meterPercent: 12, exitCode: 0, endReason: "exit", stateRestored: false });
    const [call] = f.calls();
    const prompt = readFileSync(r.promptPath, "utf8");
    expect(call!.argv).toEqual([prompt]);
    expect(prompt).toContain('co-seat "main", turn 1');
    expect(prompt).toContain(f.ctx.briefPath);
    expect(prompt).toContain(f.ctx.statePath);
    expect(prompt).toContain(r.eventsPath);
    expect(prompt).toContain("Projects you may cycle: app.");
    expect(readFileSync(r.eventsPath, "utf8")).toContain("- cycle ended: app c1 outcome=verified");
    const dir = turnDir(f.ctx.dir, 1);
    expect(existsSync(join(dir, "run.log"))).toBe(true);
    expect(existsSync(join(dir, "run.err"))).toBe(true);
    expect(readFileSync(join(dir, "STATE.before.md"), "utf8")).toBe(STATE_TEMPLATE);
    expect(readFileSync(f.ctx.statePath, "utf8")).toContain("ran turn 1");
    expect(call!.cwd).toBe(sb.root);
  });

  it("puts the prompt on stdin when the command has no {prompt}", async () => {
    const f = await fixture({}, { stdin: true });
    const r = await runTurn({ ctx: f.ctx, n: 2, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r.endReason).toBe("exit");
    const [call] = f.calls();
    expect(call!.argv).toEqual([]);
    expect(call!.stdin).toBe(readFileSync(r.promptPath, "utf8"));
  });

  it("maps env from parent variable names, removes env_unset, and sets GS_CO_SEAT_* last", async () => {
    const f = await fixture({}, { env: { CHILD_TOKEN: "PARENT_TOKEN" }, env_unset: ["ANTHROPIC_API_KEY"] });
    await runTurn(
      { ctx: f.ctx, n: 7, runner: f.runner, meterPercent: 1, eventLines: [] },
      { ...FAST, env: { ...process.env, PARENT_TOKEN: "tok-123", ANTHROPIC_API_KEY: "leak", GS_CO_SEAT: "0", GS_CO_SEAT_ID: "evil" } },
    );
    const [call] = f.calls();
    expect(call).toMatchObject({ token: "tok-123", key: null, seat: "1", id: "main", turn: "7", dir: f.ctx.dir });
  });

  it("reports a non-zero exit code", async () => {
    const f = await fixture({ exit: 3 });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r).toMatchObject({ endReason: "exit", exitCode: 3 });
  });

  it("a runner that cannot start is a spawn_error and leaves the state file alone", async () => {
    const f = await fixture({}, { command: ["definitely-not-a-real-binary-xyz", "{prompt}"] });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r.endReason).toBe("spawn_error");
    expect(r.error).toContain("executable not found");
    expect(readFileSync(join(turnDir(f.ctx.dir, 1), "run.err"), "utf8")).toContain("executable not found");
    expect(readFileSync(f.ctx.statePath, "utf8")).toBe(STATE_TEMPLATE);
    expect(r.stateRestored).toBe(false);
  });

  it("calls onPoll while the turn runs", async () => {
    const f = await fixture({ sleepMs: 400 });
    let polls = 0;
    await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, onPoll: () => polls++ });
    expect(polls).toBeGreaterThan(2);
  });
});

describe("runTurn: stopping", () => {
  it("kills the process at turn_timeout_seconds", async () => {
    const f = await fixture({ sleepMs: 30_000 });
    const started = Date.now();
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, timeoutMs: 500 });
    expect(r.endReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8000);
    expect(alive(f.calls()[0]!.pid)).toBe(false);
  });

  it("kills the process when the in-flight stop check says stop", async () => {
    const f = await fixture({ sleepMs: 30_000 });
    const t0 = Date.now();
    const r = await runTurn(
      { ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] },
      { ...FAST, checkStop: () => (Date.now() - t0 > 600 ? "stop" : null) },
    );
    expect(r).toMatchObject({ endReason: "stop", stopDetail: "stop" });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(alive(f.calls()[0]!.pid)).toBe(false);
  });

  it("kills the process on a remote stop, checked less often than the local one", async () => {
    const f = await fixture({ sleepMs: 30_000 });
    let remoteChecks = 0;
    let localChecks = 0;
    const r = await runTurn(
      { ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] },
      {
        ...FAST,
        checkStop: () => (localChecks++, null),
        checkRemote: () => (++remoteChecks >= 2 ? "remote-stop" : null),
      },
    );
    expect(r).toMatchObject({ endReason: "stop", stopDetail: "remote-stop" });
    expect(localChecks).toBeGreaterThan(remoteChecks);
  });

  it("a failing stop check does not end the turn; the timeout still bounds it", async () => {
    const f = await fixture({ sleepMs: 30_000 });
    const r = await runTurn(
      { ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] },
      { ...FAST, timeoutMs: 500, checkStop: () => { throw new Error("boom"); } },
    );
    expect(r.endReason).toBe("timeout");
  });

  it("follows TERM with KILL after the grace period when the turn ignores TERM", async () => {
    if (process.platform === "win32") return; // taskkill /f is already forceful
    const f = await fixture({ sleepMs: 30_000, ignoreTerm: true });
    const started = Date.now();
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, timeoutMs: 400, killGraceMs: 400 });
    expect(r.endReason).toBe("timeout");
    expect(r.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(8000);
    expect(alive(f.calls()[0]!.pid)).toBe(false);
  });

  it("kills the whole process tree, not just the runner", async () => {
    const pidFile = join(sb.root, "grandchild.pid");
    const tree = scriptPath(
      sb.root,
      "tree.mjs",
      `
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => {}, 30000);
`,
    );
    const f = await fixture({}, { command: [process.execPath, tree, "{prompt}"] });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, timeoutMs: 1200 });
    expect(r.endReason).toBe("timeout");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(grandchild)).toBe(false);
  });
});

describe("runTurn: the state file", () => {
  it("restores the snapshot when a turn leaves the state file without a heading", async () => {
    const f = await fixture({ breakState: true });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r.stateRestored).toBe(true);
    expect(r.stateIssue).toContain("missing headings");
    expect(readFileSync(f.ctx.statePath, "utf8")).toBe(STATE_TEMPLATE);
  });

  it("restores the snapshot when a turn deletes the state file", async () => {
    const f = await fixture({ deleteState: true });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r).toMatchObject({ stateRestored: true, stateIssue: "state file was deleted" });
    expect(readFileSync(f.ctx.statePath, "utf8")).toBe(STATE_TEMPLATE);
  });

  it("keeps a state file that still has every heading, and also restores after a killed turn", async () => {
    const good = await fixture();
    const ok = await runTurn({ ctx: good.ctx, n: 1, runner: good.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(ok.stateRestored).toBe(false);
    expect(readFileSync(good.ctx.statePath, "utf8")).toContain("ran turn 1");
    // A runner killed mid-write leaves a torn file; the restore covers killed turns too.
    writeFileSync(good.ctx.statePath, STATE_TEMPLATE);
    const torn = scriptPath(
      sb.root,
      "torn.mjs",
      `import { writeFileSync } from "fs"; writeFileSync(${JSON.stringify(good.ctx.statePath)}, "## Open items\\n"); setTimeout(() => {}, 30000);`,
    );
    const runner = { ...good.runner, command: [process.execPath, torn, "{prompt}"] };
    const killed = await runTurn({ ctx: good.ctx, n: 2, runner, meterPercent: 1, eventLines: [] }, { ...FAST, timeoutMs: 600 });
    expect(killed).toMatchObject({ endReason: "timeout", stateRestored: true });
    expect(readFileSync(good.ctx.statePath, "utf8")).toBe(STATE_TEMPLATE);
  });
});

describe("turn helpers", () => {
  it("buildArgv substitutes {prompt} inside any argument", () => {
    expect(buildArgv(["claude", "-p", "{prompt}", "--x"], "hello")).toEqual({ argv: ["claude", "-p", "hello", "--x"], viaStdin: false });
    expect(buildArgv(["tool", "--prompt={prompt}"], "a b")).toEqual({ argv: ["tool", "--prompt=a b"], viaStdin: false });
    expect(buildArgv(["tool", "--flag"], "hello")).toEqual({ argv: ["tool", "--flag"], viaStdin: true });
  });

  it("buildTurnEnv leaves the parent environment alone and skips a runner variable whose source is unset", () => {
    const parent = { A: "1", SRC: "s" } as NodeJS.ProcessEnv;
    const runner: CoSeatRunnerConfig = {
      id: "r",
      command: ["x"],
      env: { CHILD: "SRC", ABSENT: "NOPE" },
      env_unset: ["A"],
      meter: { command: ["m"], max_used_percent: 85 },
    };
    const env = buildTurnEnv(parent, runner, "main", 4, "/dir");
    expect(env).toMatchObject({ CHILD: "s", GS_CO_SEAT: "1", GS_CO_SEAT_ID: "main", GS_CO_SEAT_TURN: "4", GS_CO_SEAT_DIR: "/dir" });
    expect(env.A).toBeUndefined();
    expect("ABSENT" in env).toBe(false);
    expect(parent.A).toBe("1");
  });

  it("buildPrompt is short and plain", async () => {
    const f = await fixture();
    const prompt = buildPrompt(f.ctx, 9, "/x/EVENTS.md");
    expect(prompt.split("\n").length).toBeLessThan(20);
    expect(prompt).toContain("turn 9");
    expect(prompt).toContain("30 minutes");
  });
});

describe("the live turn record (turn.json)", () => {
  it("is written at spawn with pid, group, host, start and turn number, and removed when the turn ends", async () => {
    const f = await fixture({ sleepMs: 500 });
    let seen: LiveTurnRecord | null = null;
    await runTurn(
      { ctx: f.ctx, n: 5, runner: f.runner, meterPercent: 1, eventLines: [] },
      { ...FAST, onPoll: () => { seen ??= readLiveTurn(f.ctx.dir); } },
    );
    expect(seen).not.toBeNull();
    expect(seen!).toMatchObject({ host: hostname(), n: 5, exe: process.execPath });
    expect(seen!.pid).toBe(f.calls()[0]!.pid);
    expect(seen!.pgid).toBe(process.platform === "win32" ? null : seen!.pid);
    expect(Date.parse(seen!.started)).not.toBeNaN();
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
  });

  it("is removed after a timeout, a stop and a spawn error too", async () => {
    const f = await fixture({ sleepMs: 30_000 });
    await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, timeoutMs: 400 });
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
    const t0 = Date.now();
    await runTurn({ ctx: f.ctx, n: 2, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST, checkStop: () => (Date.now() - t0 > 300 ? "stop" : null) });
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
    const bad = await fixture({}, { command: ["definitely-not-a-real-binary-xyz", "{prompt}"] });
    await runTurn({ ctx: bad.ctx, n: 3, runner: bad.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(existsSync(liveTurnPath(bad.ctx.dir))).toBe(false);
  });

  it("whatever the turn left running in its process group dies when the turn exits normally (POSIX)", async () => {
    if (process.platform === "win32") return;
    const pidFile = join(sb.root, "straggler.pid");
    const script = scriptPath(
      sb.root,
      "straggler.mjs",
      `
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.exit(0);
`,
    );
    const f = await fixture({}, { command: [process.execPath, script, "{prompt}"] });
    const r = await runTurn({ ctx: f.ctx, n: 1, runner: f.runner, meterPercent: 1, eventLines: [] }, { ...FAST });
    expect(r).toMatchObject({ endReason: "exit", exitCode: 0 });
    const straggler = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(straggler)).toBe(false);
  });
});

describe("reapRecordedTurn", () => {
  const writeRecord = (dir: string, rec: LiveTurnRecord) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(liveTurnPath(dir), JSON.stringify(rec));
  };

  it("does nothing without a record, and clears an unreadable one", async () => {
    const f = await fixture();
    expect(await reapRecordedTurn(f.ctx.dir)).toEqual({ state: "none" });
    mkdirSync(f.ctx.dir, { recursive: true });
    writeFileSync(liveTurnPath(f.ctx.dir), "{nope");
    expect(await reapRecordedTurn(f.ctx.dir)).toEqual({ state: "none" });
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
  });

  it("kills a recorded same-host turn that is still alive and removes the record", async () => {
    const f = await fixture();
    const pid = spawnOrphan();
    writeRecord(f.ctx.dir, record(pid));
    const r = await reapRecordedTurn(f.ctx.dir, { graceMs: 400 });
    expect(r.state).toBe("killed");
    expect(alive(pid)).toBe(false);
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
  });

  it("follows TERM with KILL when the turn ignores TERM (POSIX)", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const pid = spawnOrphan({ ignoreTerm: true });
    writeRecord(f.ctx.dir, record(pid));
    const started = Date.now();
    const r = await reapRecordedTurn(f.ctx.dir, { graceMs: 300 });
    expect(r.state).toBe("killed");
    expect(alive(pid)).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("removes the record of a turn that is already gone", async () => {
    const f = await fixture();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeRecord(f.ctx.dir, record(gone));
    expect((await reapRecordedTurn(f.ctx.dir)).state).toBe("stale");
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
  });

  it("leaves a record from another host alone, and says so", async () => {
    const f = await fixture();
    const pid = spawnOrphan();
    writeRecord(f.ctx.dir, record(pid, { host: "some-other-host" }));
    const r = await reapRecordedTurn(f.ctx.dir, { graceMs: 200 });
    expect(r.state).toBe("elsewhere");
    expect(alive(pid)).toBe(true);
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(true);
  });

  it("does not kill a process that merely reused the recorded pid (POSIX: its command line is not the turn's)", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    // This test process is alive and is not "/no/such/runner".
    writeRecord(f.ctx.dir, record(process.pid, { exe: "/no/such/runner-binary" }));
    const r = await reapRecordedTurn(f.ctx.dir, { graceMs: 200 });
    expect(r.state).toBe("stale");
    expect(alive(process.pid)).toBe(true);
  });
});
