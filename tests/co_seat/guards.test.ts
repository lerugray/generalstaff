import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { stringify } from "yaml";
import {
  extractProjectFlags,
  guardAideSay,
  inCoSeat,
  refuseDispatcher,
  refuseGoOrExtend,
  refuseProjectCommand,
  refuseSession,
  refuseStart,
  verifySeatForTurn,
} from "../../src/co_seat/guards";
import { clearGo, localStopPresent } from "../../src/co_seat/control";
import { countersPath } from "../../src/co_seat/park";
import { seatDir } from "../../src/co_seat/config";
import {
  loadCtx,
  makeSandbox,
  runCli,
  seatBlock,
  writeGoFor,
  writeProjectsYaml,
  writeSeatFiles,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const IN = { GS_CO_SEAT: "1", GS_CO_SEAT_ID: "main" };

/** `app` belongs to seat main; `site` is registered but not in the seat. Writes a valid GO for it. */
async function config(authority: Record<string, unknown> = {}) {
  writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app"], authority })], ["app", "site"]);
  writeSeatFiles(sb.root, "main");
  const ctx = await loadCtx("main");
  writeGoFor(ctx);
  return ctx;
}

function aides() {
  writeFileSync(
    join(sb.root, "aides.yaml"),
    stringify({
      aides: [
        {
          name: "Cinder", kind: "fictional bot", owner: "Example Operator", description: "An illustrative Aide",
          door: { type: "file", path: "door.md" }, inbox: "cinder.md", capabilities: ["review"],
          credential_scope: "Own review workspace", hard_lines: ["Record decisions"],
        },
      ],
    }),
  );
  writeFileSync(join(sb.root, "cinder.md"), "");
  writeFileSync(join(sb.root, "door.md"), "");
}

describe("guard predicates", () => {
  it("only GS_CO_SEAT=1 puts a process in a co-seat", () => {
    expect(inCoSeat({})).toBe(false);
    expect(inCoSeat({ GS_CO_SEAT: "0" })).toBe(false);
    expect(inCoSeat({ GS_CO_SEAT: "true" })).toBe(false);
    expect(inCoSeat({ GS_CO_SEAT: "1" })).toBe(true);
  });

  it("start and session refuse in a turn and nowhere else", () => {
    expect(refuseStart({})).toBeNull();
    expect(refuseStart({ GS_CO_SEAT: "1" })).toContain("not allowed inside a co-seat turn");
    expect(refuseSession({})).toBeNull();
    expect(refuseSession({ GS_CO_SEAT: "1" })).toContain("not allowed inside a co-seat turn");
  });

  it("every cycle-dispatching command refuses in a turn: session, autonomous, welcome, engineer-benchmark", () => {
    for (const c of ["session", "autonomous", "welcome", "engineer-benchmark"]) {
      expect(refuseDispatcher(c, {})).toBeNull();
      expect(refuseDispatcher(c, { GS_CO_SEAT: "1" })).toContain(`generalstaff ${c} is not allowed inside a co-seat turn`);
    }
    // The gated, project-scoped commands are governed by refuseProjectCommand, not this list.
    for (const c of ["cycle", "status", "forks", "stop", "start-not-here"]) {
      expect(refuseDispatcher(c, { GS_CO_SEAT: "1" })).toBeNull();
    }
  });

  it("go, extend, run and watchdog refuse in a turn; stop, status, park and init do not", () => {
    for (const sub of ["go", "extend", "run", "watchdog"]) {
      expect(refuseGoOrExtend(sub, {})).toBeNull();
      expect(refuseGoOrExtend(sub, { GS_CO_SEAT: "1" })).toContain(`co-seat ${sub} is not allowed`);
    }
    expect(refuseGoOrExtend("go", { GS_CO_SEAT: "1" })).toContain("cannot lift a stop or extend its own life");
    expect(refuseGoOrExtend("run", { GS_CO_SEAT: "1" })).toContain("cannot start a driver");
    for (const sub of ["stop", "status", "park", "init"]) {
      expect(refuseGoOrExtend(sub, { GS_CO_SEAT: "1" })).toBeNull();
    }
  });

  it("extractProjectFlags returns EVERY --project value in both spellings", () => {
    expect(extractProjectFlags(["--project=app", "--dry-run"])).toEqual(["app"]);
    expect(extractProjectFlags(["verify", "--project", "site"])).toEqual(["site"]);
    expect(extractProjectFlags(["--project=app", "--project=site"])).toEqual(["app", "site"]);
    expect(extractProjectFlags(["--project", "app", "--project=site", "--project", "x"])).toEqual(["app", "site", "x"]);
    expect(extractProjectFlags(["--dry-run"])).toEqual([]);
    expect(extractProjectFlags(["--project"])).toEqual([""]);
    expect(extractProjectFlags(["--project="])).toEqual([""]);
  });
});

describe("refuseProjectCommand", () => {
  it("allows the seat's own project for each command kind", async () => {
    await config();
    for (const kind of ["cycle", "verify", "redo"] as const) {
      expect(await refuseProjectCommand(kind, ["app"], IN)).toBeNull();
    }
    expect(await refuseProjectCommand("cycle", ["app", "app"], IN)).toBeNull(); // the same value twice is one project
  });

  it("refuses a project outside the seat, in every kind", async () => {
    await config();
    for (const kind of ["cycle", "verify", "redo"] as const) {
      expect(await refuseProjectCommand(kind, ["site"], IN)).toContain('may only cycle its own projects (app), not "site"');
    }
    expect(await refuseProjectCommand("cycle", ["ghost"], IN)).toContain("not");
  });

  it("refuses when ANY --project is outside the seat, or when there is more than one distinct value (the parseArgs last-wins bypass)", async () => {
    await config();
    expect(await refuseProjectCommand("verify", ["app", "site"], IN)).toContain("more than one --project value (app, site)");
    expect(await refuseProjectCommand("verify", ["site", "app"], IN)).toContain("more than one --project value");
    expect(await refuseProjectCommand("cycle", ["app", "site", "app"], IN)).toContain("more than one --project value");
    expect(await refuseProjectCommand("cycle", [""], IN)).toBe("--project needs a project id");
  });

  it("not in a co-seat: no guard; no --project: left to the command's own usage error", async () => {
    await config();
    expect(await refuseProjectCommand("cycle", ["site"], {})).toBeNull();
    expect(await refuseProjectCommand("cycle", [], IN)).toBeNull();
  });

  it("refuses an unknown seat id or a missing one", async () => {
    await config();
    expect(await refuseProjectCommand("cycle", ["app"], { GS_CO_SEAT: "1", GS_CO_SEAT_ID: "nope" })).toContain('cannot check co-seat "nope"');
    expect(await refuseProjectCommand("cycle", ["app"], { GS_CO_SEAT: "1" })).toContain("without GS_CO_SEAT_ID");
  });

  it("authority.verify: false refuses cycle verify, and only cycle verify", async () => {
    const ctx = await config({ verify: false });
    writeGoFor(ctx);
    expect(await refuseProjectCommand("verify", ["app"], IN)).toBe('co-seat "main" has authority.verify: false, so it may not run cycle verify');
    expect(await refuseProjectCommand("cycle", ["app"], IN)).toBeNull();
    expect(await refuseProjectCommand("redo", ["app"], IN)).toBeNull();
  });
});

describe("the config pin binds guards for the whole turn", () => {
  it("refuses everything when GO is missing, invalid or expired", async () => {
    const ctx = await config();
    clearGo(ctx.dir);
    expect(await refuseProjectCommand("cycle", ["app"], IN)).toContain("a person must run `generalstaff co-seat go`");
    writeFileSync(join(ctx.dir, "GO"), "{garbage");
    expect(await refuseProjectCommand("cycle", ["app"], IN)).toContain("a person must run `generalstaff co-seat go`");
    writeGoFor(ctx, Date.now() - 8 * 86_400_000, 7); // deadline a day ago
    expect(await refuseProjectCommand("cycle", ["app"], IN)).toContain("past its deadline");
  });

  it("a projects.yaml edit made during a turn gives it no new authority", async () => {
    await config();
    // The turn adds `site` to its own seat; the config still loads and validates.
    writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app", "site"] })], ["app", "site"]);
    const v = await verifySeatForTurn(IN);
    expect(v).toMatchObject({ ok: false });
    expect(await refuseProjectCommand("cycle", ["site"], IN)).toContain("the config changed since go");
    // Even the project it already owned is refused until a person runs go again.
    expect(await refuseProjectCommand("cycle", ["app"], IN)).toContain("the config changed since go");
  });

  it("a caps edit, a brief edit, and a state_dir edit are each caught", async () => {
    const ctx = await config({ aide_messages_per_day: 1 });
    expect((await verifySeatForTurn(IN)).ok).toBe(true);
    // Brief.
    writeFileSync(ctx.briefPath, "# edited\n");
    expect((await verifySeatForTurn(IN)).ok).toBe(false);
    writeFileSync(ctx.briefPath, "# brief\n");
    expect((await verifySeatForTurn(IN)).ok).toBe(true);
    // Caps.
    writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app"], authority: { aide_messages_per_day: 50 } })], ["app", "site"]);
    expect((await verifySeatForTurn(IN)).ok).toBe(false);
    await expect(guardAideSay(IN)).rejects.toThrow(/the config changed since go/);
    expect(existsSync(countersPath(ctx.dir))).toBe(false);
    // state_dir moves the seat directory: refused, and the old one is not consulted.
    writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app"], authority: { aide_messages_per_day: 1 } })], ["app", "site"], {}, { state_dir: "./elsewhere" });
    const moved = await verifySeatForTurn({ ...IN, GS_CO_SEAT_DIR: ctx.dir });
    expect(moved).toMatchObject({ ok: false });
    expect((moved as { refusal: string }).refusal).toContain("different state directory");
  });

  it("the pin is part of GO: state_dir changes the pin even with GS_CO_SEAT_DIR unset", async () => {
    await config();
    writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app"] })], ["app", "site"], {}, { state_dir: "./elsewhere" });
    expect((await verifySeatForTurn(IN)).ok).toBe(false);
  });
});

describe("guardAideSay", () => {
  it("counts against aide_messages_per_day and throws past it", async () => {
    const ctx = await config({ aide_messages_per_day: 2 });
    await guardAideSay({}); // not in a co-seat: nothing counted
    expect(existsSync(countersPath(ctx.dir))).toBe(false);
    await guardAideSay(IN);
    await guardAideSay(IN);
    await expect(guardAideSay(IN)).rejects.toThrow(/sent 2 of 2 Aide messages today/);
    await expect(guardAideSay({ GS_CO_SEAT: "1" })).rejects.toThrow(/without GS_CO_SEAT_ID/);
    await expect(guardAideSay({ GS_CO_SEAT: "1", GS_CO_SEAT_ID: "nope" })).rejects.toThrow(/cannot check co-seat "nope"/);
  });
});

describe("guards through the CLI", () => {
  it("start refuses inside a turn and leaves the fleet STOP alone; outside, it clears it as before", async () => {
    await config();
    writeFileSync(join(sb.root, "STOP"), "STOP\n");
    const refused = await runCli(sb.root, ["start"], IN);
    expect(refused.code).toBe(1);
    expect(refused.stderr.trim()).toBe("Co-seat refused: generalstaff start is not allowed inside a co-seat turn (it clears the fleet STOP).");
    expect(existsSync(join(sb.root, "STOP"))).toBe(true);

    const allowed = await runCli(sb.root, ["start"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("STOP file removed");
    expect(existsSync(join(sb.root, "STOP"))).toBe(false);
  });

  it("session, autonomous, welcome and engineer-benchmark refuse inside a turn (help still works); outside they are untouched", async () => {
    await config();
    for (const argv of [["session", "--dry-run"], ["autonomous"], ["autonomous", "--execute"], ["welcome", "--skip-cycle"], ["engineer-benchmark", "--project=app"]]) {
      const r = await runCli(sb.root, argv, IN);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Co-seat refused: generalstaff ${argv[0]} is not allowed inside a co-seat turn`);
    }
    const help = await runCli(sb.root, ["session", "--help"], IN);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: generalstaff session");
    expect((await runCli(sb.root, ["autonomous", "--help"], IN)).code).toBe(0);
    const bad = await runCli(sb.root, ["session", "--budget=zero"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--budget must be a positive integer");
  });

  it("cycle, cycle verify and cycle-redo refuse a project outside the seat, or an unknown seat", async () => {
    await config();
    const outside = await runCli(sb.root, ["cycle", "--project=site", "--dry-run"], IN);
    expect(outside.code).toBe(1);
    expect(outside.stderr.trim()).toBe('Co-seat refused: co-seat "main" may only cycle its own projects (app), not "site".');
    const verify = await runCli(sb.root, ["cycle", "verify", "--project=site", "--checkout=/x", "--base=abc"], IN);
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain("Co-seat refused");
    const redo = await runCli(sb.root, ["cycle-redo", "--project=site", "--task=t-1"], IN);
    expect(redo.code).toBe(1);
    expect(redo.stderr).toContain('not "site"');
    const unknownSeat = await runCli(sb.root, ["cycle", "--project=app"], { GS_CO_SEAT: "1", GS_CO_SEAT_ID: "ghost" });
    expect(unknownSeat.code).toBe(1);
    expect(unknownSeat.stderr).toContain('cannot check co-seat "ghost"');
    const noId = await runCli(sb.root, ["cycle", "--project=app"], { GS_CO_SEAT: "1" });
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain("without GS_CO_SEAT_ID");
  });

  it("a repeated --project cannot smuggle a project past the guard (cycle, cycle verify, cycle-redo; both spellings; either order)", async () => {
    await config();
    const attempts: string[][] = [
      ["cycle", "verify", "--project=app", "--project=site", "--checkout=/x", "--base=abc"],
      ["cycle", "verify", "--project=site", "--project=app", "--checkout=/x", "--base=abc"],
      ["cycle", "verify", "--project", "app", "--project", "site", "--checkout=/x"],
      ["cycle", "--project=app", "--project=site", "--dry-run"],
      ["cycle", "--project", "app", "--project=site", "--dry-run"],
      ["cycle-redo", "--project=app", "--project=site", "--task=t-1"],
      ["cycle-redo", "--project", "site", "--project", "app", "--task=t-1"],
    ];
    for (const argv of attempts) {
      const r = await runCli(sb.root, argv, IN);
      expect({ argv, code: r.code, refused: r.stderr.includes("Co-seat refused: more than one --project value") }).toEqual({ argv, code: 1, refused: true });
    }
  });

  it("an allowed project passes the guard (cycle-redo then reports its own error); read-only subcommands are not guarded", async () => {
    await config();
    const redo = await runCli(sb.root, ["cycle-redo", "--project=app", "--task=t-1"], IN);
    expect(redo.stderr).not.toContain("Co-seat refused");
    expect(redo.code).toBe(1); // no tasks file for the fixture project
    expect(redo.stderr).toContain("no tasks file for project 'app'");

    const inside = await runCli(sb.root, ["cycle", "show", "no-such-cycle"], IN);
    const outsideTurn = await runCli(sb.root, ["cycle", "show", "no-such-cycle"]);
    expect(inside.stderr).not.toContain("Co-seat refused");
    expect({ out: inside.stdout, err: inside.stderr, code: inside.code }).toEqual({ out: outsideTurn.stdout, err: outsideTurn.stderr, code: outsideTurn.code });
    expect((await runCli(sb.root, ["cycle", "--help"], IN)).stdout).toContain("Usage: generalstaff cycle");
  });

  it("authority.verify: false refuses cycle verify but not cycle", async () => {
    await config({ verify: false });
    const verify = await runCli(sb.root, ["cycle", "verify", "--project=app", "--checkout=/x", "--base=abc"], IN);
    expect(verify.code).toBe(1);
    expect(verify.stderr.trim()).toBe('Co-seat refused: co-seat "main" has authority.verify: false, so it may not run cycle verify.');
    const cycle = await runCli(sb.root, ["cycle-redo", "--project=app", "--task=t-1"], IN);
    expect(cycle.stderr).not.toContain("Co-seat refused");
  });

  it("a turn that edits projects.yaml mid-turn gets no new authority: cycle, aides say and park all refuse", async () => {
    await config({ aide_messages_per_day: 1, park_per_day: 1 });
    aides();
    // The turn adds `site` to its seat and raises both caps.
    writeProjectsYaml(
      sb.root,
      [seatBlock("main", { projects: ["app", "site"], authority: { aide_messages_per_day: 99, park_per_day: 99 } })],
      ["app", "site"],
    );
    const cycle = await runCli(sb.root, ["cycle", "--project=site", "--dry-run"], IN);
    expect(cycle.code).toBe(1);
    expect(cycle.stderr).toContain("the config changed since go");
    const say = await runCli(sb.root, ["aides", "say", "Cinder", "hello"], IN);
    expect(say.code).toBe(1);
    expect(say.stderr).toContain("the config changed since go");
    expect(readFileSync(join(sb.root, "door.md"), "utf8")).toBe("");
    const park = await runCli(sb.root, ["co-seat", "park", "--project=site", "Something to decide"], IN);
    expect(park.code).toBe(1);
    expect(park.stderr).toContain("the config changed since go");
    expect(existsSync(join(sb.root, "state", "fork-ledger.json"))).toBe(false);
  });

  it("aides say counts against aide_messages_per_day: with 0 it refuses, with 1 it sends once", async () => {
    await config({ aide_messages_per_day: 0 });
    aides();
    const none = await runCli(sb.root, ["aides", "say", "Cinder", "first message"], IN);
    expect(none.code).toBe(1);
    expect(none.stderr.trim()).toBe('Aides: co-seat "main" may not message Aides (aide_messages_per_day is 0)');
    expect(readFileSync(join(sb.root, "door.md"), "utf8")).toBe("");

    await config({ aide_messages_per_day: 1 });
    const first = await runCli(sb.root, ["aides", "say", "Cinder", "first message"], IN);
    expect(first.code).toBe(0);
    expect(readFileSync(join(sb.root, "door.md"), "utf8")).toContain("first message");
    const second = await runCli(sb.root, ["aides", "say", "Cinder", "second message"], IN);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("sent 1 of 1 Aide messages today");
    expect(readFileSync(join(sb.root, "door.md"), "utf8")).not.toContain("second message");

    // Outside a co-seat nothing is counted or capped.
    const outside = await runCli(sb.root, ["aides", "say", "Cinder", "third message"]);
    expect(outside.code).toBe(0);
    expect(readFileSync(join(sb.root, "door.md"), "utf8")).toContain("third message");
    expect(JSON.parse(readFileSync(countersPath(seatDir("main")), "utf8")).aide).toBe(1);
  });

  it("co-seat go, extend, run and watchdog refuse inside a turn; stop and park are allowed", async () => {
    const ctx = await config();
    clearGo(ctx.dir);
    for (const argv of [["go", "--id=main"], ["extend", "--id=main", "--days=3"], ["run", "--once"], ["watchdog"]]) {
      const r = await runCli(sb.root, ["co-seat", ...argv], IN);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`co-seat ${argv[0]} is not allowed inside a co-seat turn`);
    }
    expect(existsSync(join(ctx.dir, "GO"))).toBe(false);
    expect(existsSync(join(ctx.dir, "lock"))).toBe(false);
    const stop = await runCli(sb.root, ["co-seat", "stop"], { ...IN, GS_CO_SEAT_DIR: ctx.dir });
    expect(stop.code).toBe(0);
    expect(localStopPresent(ctx.dir)).toBe(true);
  });

  it("inside a turn, park and stop use GS_CO_SEAT_ID and refuse a different --id", async () => {
    writeProjectsYaml(
      sb.root,
      [seatBlock("main", { projects: ["app"] }), seatBlock("other", { projects: ["site"] })],
      ["app", "site"],
    );
    writeSeatFiles(sb.root, "main");
    writeSeatFiles(sb.root, "other");
    const mainCtx = await loadCtx("main");
    writeGoFor(mainCtx);

    const otherPark = await runCli(sb.root, ["co-seat", "park", "--id=other", "--project=site", "Pricing decision"], IN);
    expect(otherPark.code).toBe(1);
    expect(otherPark.stderr).toContain('a co-seat turn may only park its own seat ("main"), not "other"');
    const otherStop = await runCli(sb.root, ["co-seat", "stop", "--id=other"], IN);
    expect(otherStop.code).toBe(1);
    expect(otherStop.stderr).toContain('may only stop its own seat ("main"), not "other"');
    expect(localStopPresent(seatDir("other"))).toBe(false);

    // With no --id (two seats are declared) the turn's own seat is used.
    const park = await runCli(sb.root, ["co-seat", "park", "--project=app", "Pricing decision"], IN);
    expect(park.code).toBe(0);
    expect(park.stdout).toContain("co-seat:main::app::pricing-decision");
    const noId = await runCli(sb.root, ["co-seat", "stop"], { GS_CO_SEAT: "1" });
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain("needs GS_CO_SEAT_ID");
    const stop = await runCli(sb.root, ["co-seat", "stop"], IN);
    expect(stop.code).toBe(0);
    expect(localStopPresent(seatDir("main"))).toBe(true);
    expect(localStopPresent(seatDir("other"))).toBe(false);
  });

  it("a stop from inside a turn lands in the driver's seat directory even if the config now says another", async () => {
    const ctx = await config();
    // The turn moves the seat directory by editing state_dir; stop must still stop the driver.
    writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app"] })], ["app", "site"], {}, { state_dir: "./elsewhere" });
    const stop = await runCli(sb.root, ["co-seat", "stop"], { ...IN, GS_CO_SEAT_DIR: ctx.dir });
    expect(stop.code).toBe(0);
    expect(localStopPresent(ctx.dir)).toBe(true);
    expect(existsSync(join(sb.root, "elsewhere", "_co-seat", "main", "STOP"))).toBe(true);
  });
});
