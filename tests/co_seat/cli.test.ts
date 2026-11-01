import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { pinOfContext, seatDir } from "../../src/co_seat/config";
import { writeGo } from "../../src/co_seat/control";
import { acquireLock, type LockHandle } from "../../src/co_seat/lock";
import {
  loadCtx,
  makeSandbox,
  meterScript,
  recordingRunnerSource,
  runCli,
  scriptPath,
  seatBlock,
  writeProjectsYaml,
  writeSeatFiles,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;
let held: LockHandle | undefined;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  held?.release();
  held = undefined;
  sb.cleanup();
});

function config(authority: Record<string, unknown> = {}, runner = true) {
  const log = join(sb.root, "runner-calls.jsonl");
  const statePath = join(sb.root, "co-seat", "main", "STATE.md");
  const script = scriptPath(sb.root, "runner.mjs", recordingRunnerSource({ logPath: log, statePath }));
  writeProjectsYaml(
    sb.root,
    [
      seatBlock("main", {
        projects: ["app"],
        authority,
        runners: runner
          ? [
              {
                id: "primary",
                command: [process.execPath, script, "{prompt}"],
                meter: { command: meterScript(sb.root, "meter.mjs", 'console.log("10")'), max_used_percent: 85 },
              },
            ]
          : undefined,
      }),
    ],
    ["app", "site"],
  );
}

/** Pretend a driver is running so `go`'s watchdog pass does not start a real one. */
function pretendDriver() {
  const got = acquireLock(seatDir("main"), { host: hostname() });
  if (!got.ok) throw new Error(got.reason);
  held = got.handle;
}

describe("generalstaff co-seat", () => {
  it("prints its own help, and is listed in the global usage", async () => {
    const help = await runCli(sb.root, ["co-seat", "--help"]);
    expect(help.code).toBe(0);
    for (const word of ["init", "go [--days=N] [--remote]", "extend", "stop [--remote]", "status [--json]", "watchdog", "run [--once]", "park --project=<id>"]) {
      expect(help.stdout).toContain(word);
    }
    const bare = await runCli(sb.root, ["co-seat"]);
    expect(bare.stdout).toContain("Usage: generalstaff co-seat");
    const global = await runCli(sb.root, ["--help"]);
    expect(global.stdout).toContain("generalstaff co-seat init|go|extend|stop|status|watchdog|run|park");
  });

  it("explains itself in one line when there is nothing to act on", async () => {
    const noFile = await runCli(sb.root, ["co-seat", "status"]);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr.trim().split("\n")).toHaveLength(1);
    expect(noFile.stderr).toContain("Co-seat: projects.yaml not found");

    writeProjectsYaml(sb.root, undefined);
    const none = await runCli(sb.root, ["co-seat", "status"]);
    expect(none.code).toBe(1);
    // (The loader may warn first about a project path that is not a git repo; the refusal is the last line.)
    expect(none.stderr.trim().split("\n").pop()).toBe("Co-seat: no co-seats are declared under dispatcher.co_seats in projects.yaml");

    config();
    expect((await runCli(sb.root, ["co-seat", "status", "--id=ghost"])).stderr).toContain('co-seat "ghost" is not declared');
    expect((await runCli(sb.root, ["co-seat", "bogus"])).stderr.trim()).toBe("Co-seat: Unknown co-seat command: bogus (try: generalstaff co-seat --help)");
    expect((await runCli(sb.root, ["co-seat", "status", "--bogus"])).code).toBe(1);
    expect((await runCli(sb.root, ["co-seat", "go", "--days=abc"])).stderr).toContain("--days must be a whole number of days");
  });

  it("init, go, status, extend and stop work end to end (id optional with one seat)", async () => {
    config();
    const shipped = existsSync(join(import.meta.dir, "..", "..", "examples", "co-seat", "BRIEF.md"));
    if (shipped) {
      const init = await runCli(sb.root, ["co-seat", "init"]);
      expect(init.code).toBe(0);
      expect(init.stdout).toContain(`Wrote ${join(sb.root, "co-seat", "main", "BRIEF.md")}`);
      expect((await runCli(sb.root, ["co-seat", "init"])).stdout).toContain("Kept existing");
    } else {
      writeSeatFiles(sb.root, "main");
    }
    pretendDriver();

    const go = await runCli(sb.root, ["co-seat", "go", "--days=3"]);
    expect(go.code).toBe(0);
    expect(go.stdout).toMatch(/Co-seat main: GO set, deadline \S+ \(3 days\), pin [0-9a-f]{12}/);
    expect(go.stdout).toContain("watchdog running");

    const status = await runCli(sb.root, ["co-seat", "status", "--json"]);
    const parsed = JSON.parse(status.stdout);
    expect(parsed).toMatchObject({ seat: "main", live: true, markers: { go: "ok", stop: false }, pin: { matches: true } });
    expect((await runCli(sb.root, ["co-seat", "status"])).stdout).toContain("Co-seat main: LIVE");

    const tooLong = await runCli(sb.root, ["co-seat", "extend", "--days=40"]);
    expect(tooLong.code).toBe(1);
    expect(tooLong.stderr).toContain("at most 30");
    const extended = await runCli(sb.root, ["co-seat", "extend", "--days=10"]);
    expect(extended.code).toBe(0);
    expect(extended.stdout).toContain("deadline moved to");

    const stop = await runCli(sb.root, ["co-seat", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("STOP written, GO removed");
    const after = JSON.parse((await runCli(sb.root, ["co-seat", "status", "--json"])).stdout);
    expect(after.markers).toMatchObject({ go: "missing", stop: true });
  });

  it("a stop lands even when projects.yaml cannot be validated, by id, and says exactly where", async () => {
    config();
    writeSeatFiles(sb.root, "main");
    // No file at all: the default directory, said plainly.
    rmSync(join(sb.root, "projects.yaml"));
    const none = await runCli(sb.root, ["co-seat", "stop", "--id=main"]);
    const defaultDir = join(sb.root, "state", "_co-seat", "main");
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("projects.yaml could not be validated");
    expect(none.stdout).toContain(`wrote STOP and removed GO at ${defaultDir}`);
    expect(none.stdout).toContain("the default ./state (projects.yaml could not be read at all)");
    expect(existsSync(join(defaultDir, "STOP"))).toBe(true);
    // Without an id there is nothing to name.
    expect((await runCli(sb.root, ["co-seat", "stop"])).code).toBe(1);
  });

  it("the stop fallback honours a custom dispatcher.state_dir read from the raw file", async () => {
    // Valid YAML, invalid config (the seat has no runners), custom state_dir.
    writeProjectsYaml(sb.root, [seatBlock("main", { runners: [] })], ["app"], {}, { state_dir: "./custom-state" });
    const custom = join(sb.root, "custom-state", "_co-seat", "main");
    const r = await runCli(sb.root, ["co-seat", "stop", "--id=main"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("projects.yaml could not be validated");
    expect(r.stdout).toContain(`wrote STOP and removed GO at ${custom}`);
    expect(r.stdout).toContain('dispatcher.state_dir "./custom-state" read from the raw projects.yaml');
    expect(existsSync(join(custom, "STOP"))).toBe(true);
    // The default directory was not touched.
    expect(existsSync(join(sb.root, "state", "_co-seat", "main", "STOP"))).toBe(false);
  });

  it("the stop fallback uses ./state and says so when the raw file sets no state_dir, or is not even YAML", async () => {
    writeProjectsYaml(sb.root, [seatBlock("main", { runners: [] })], ["app"]);
    const noDir = await runCli(sb.root, ["co-seat", "stop", "--id=main"]);
    expect(noDir.stdout).toContain("the default ./state (projects.yaml sets no state_dir)");
    rmSync(join(sb.root, "state"), { recursive: true, force: true });
    writeFileSync(join(sb.root, "projects.yaml"), "projects: [oops\n  dispatcher: {");
    const garbled = await runCli(sb.root, ["co-seat", "stop", "--id=main"]);
    expect(garbled.code).toBe(0);
    expect(garbled.stdout).toContain("could not be read at all");
    expect(existsSync(join(sb.root, "state", "_co-seat", "main", "STOP"))).toBe(true);
  });

  it("watchdog does nothing without GO", async () => {
    config();
    const r = await runCli(sb.root, ["co-seat", "watchdog"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("Co-seat main: watchdog skipped: no GO marker");
  });

  it("run --once runs one turn through the real entry point", async () => {
    config();
    writeSeatFiles(sb.root, "main");
    const ctx = await loadCtx("main");
    writeGo(ctx.dir, {
      version: 1,
      set_at: new Date().toISOString(),
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      pin: pinOfContext(ctx),
      days: 1,
    });
    const r = await runCli(sb.root, ["co-seat", "run", "--once"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("Co-seat main: driver ended: once; turns run: 1");
    expect(readFileSync(join(ctx.dir, "turns.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(ctx.dir, "lock"))).toBe(false);
    expect(readFileSync(ctx.statePath, "utf8")).toContain("ran turn 1");
    // A second driver while one holds the seat exits 1 without a turn.
    pretendDriver();
    const second = await runCli(sb.root, ["co-seat", "run", "--once"]);
    expect(second.code).toBe(1);
    expect(second.stdout).toContain("driver ended: lock-held");
  });

  it("park writes the fork-ledger entry that `forks` lists, refreshes without cost, and refuses past the cap", async () => {
    config({ park_per_day: 1 });
    const parked = await runCli(sb.root, ["co-seat", "park", "--project=app", "Decide the pricing copy", "--evidence=docs/x.md"]);
    expect(parked.code).toBe(0);
    expect(parked.stdout).toContain("parked: co-seat:main::app::decide-the-pricing-copy (1 of 1 today)");
    const forks = await runCli(sb.root, ["forks"]);
    expect(forks.stdout).toContain("[app] (co-seat) Decide the pricing copy");

    const again = await runCli(sb.root, ["co-seat", "park", "--project", "app", "Decide the pricing copy"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already parked, refreshed");

    const over = await runCli(sb.root, ["co-seat", "park", "--project=app", "A second decision"]);
    expect(over.code).toBe(1);
    expect(over.stderr).toContain("park_per_day is reached");
    const outside = await runCli(sb.root, ["co-seat", "park", "--project=site", "Something"]);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('may only park for its own projects (app), not "site"');
    expect((await runCli(sb.root, ["co-seat", "park", "Missing project flag"])).stderr).toContain("Usage: generalstaff co-seat park");
    expect((await runCli(sb.root, ["co-seat", "park", "--project=app"])).stderr).toContain("needs one quoted description");
  });
});
