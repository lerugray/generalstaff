import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  buildSeatContext,
  canonicalJson,
  configPin,
  findSeat,
  missingStateHeadings,
  seatDir,
} from "../../src/co_seat/config";
import { loadProjectsYaml } from "../../src/projects";
import type { CoSeatConfig } from "../../src/types";
import {
  makeSandbox,
  projectEntry,
  seatBlock,
  writeProjectsYaml,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const load = (path: string) => loadProjectsYaml(path, { quiet: true });

function runner(over: Record<string, unknown> = {}) {
  return {
    id: "primary",
    command: ["echo", "{prompt}"],
    meter: { command: ["echo", "10"], max_used_percent: 85 },
    ...over,
  };
}

describe("co_seats config: defaults and shape", () => {
  it("is absent by default", async () => {
    const yaml = await load(writeProjectsYaml(sb.root, undefined));
    expect(yaml.dispatcher.co_seats).toBeUndefined();
  });

  it("fills every default for a minimal seat", async () => {
    const yaml = await load(writeProjectsYaml(sb.root, [seatBlock("main")]));
    const seat = yaml.dispatcher.co_seats![0]!;
    expect(seat.authority).toEqual({ verify: true, land: false, park_per_day: 2, aide_messages_per_day: 0 });
    expect(seat.wake).toEqual({
      heartbeat_seconds: 1800,
      min_gap_seconds: 300,
      cycles: true,
      aide_inboxes: true,
      done_globs: [],
    });
    expect(seat.turn_timeout_seconds).toBe(1800);
    expect(seat.run_days).toBe(7);
    expect(seat.remote_control).toBeUndefined();
  });

  it("keeps explicit values", async () => {
    const yaml = await load(
      writeProjectsYaml(sb.root, [
        seatBlock("main", {
          authority: { verify: false, park_per_day: 5, aide_messages_per_day: 1 },
          wake: { heartbeat_seconds: 900, min_gap_seconds: 60, done_globs: ["../lanes/*/run.done"] },
          extra: { turn_timeout_seconds: 600, run_days: 30 },
        }),
      ]),
    );
    const seat = yaml.dispatcher.co_seats![0]!;
    expect(seat.authority.park_per_day).toBe(5);
    expect(seat.wake.done_globs).toEqual(["../lanes/*/run.done"]);
    expect(seat.run_days).toBe(30);
    expect(seat.turn_timeout_seconds).toBe(600);
  });

  it("rejects co_seats that is not a list", async () => {
    const path = writeProjectsYaml(sb.root, undefined);
    writeFileSync(path, readFileSync(path, "utf8").replace("dispatcher: {}", "dispatcher:\n  co_seats:\n    not: a list"));
    await expect(load(path)).rejects.toThrow(/co_seats — must be a list/);
  });

  it("rejects a seat that is not a mapping and unknown keys (typos in authority should not pass quietly)", async () => {
    await expect(
      load(writeProjectsYaml(sb.root, ["not a mapping"])),
    ).rejects.toThrow(/co_seats\[0\] — must be an object/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { lnad: true } })])),
    ).rejects.toThrow(/co_seats\[0\]\.lnad — is not a known field/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { authority: { lnad: true } })])),
    ).rejects.toThrow(/authority\.lnad — is not a known field/);
  });
});

describe("co_seats config: validation rules", () => {
  it("ids are unique slugs", async () => {
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main"), seatBlock("main", { projects: ["site"] })], ["app", "site"])),
    ).rejects.toThrow(/duplicate co-seat id "main"/);
    await expect(load(writeProjectsYaml(sb.root, [seatBlock("Main Seat")]))).rejects.toThrow(/must be a slug/);
    await expect(load(writeProjectsYaml(sb.root, [seatBlock("-x")]))).rejects.toThrow(/must be a slug/);
  });

  it("every project entry is registered", async () => {
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app", "ghost"] })])),
    ).rejects.toThrow(/project "ghost" is not registered/);
  });

  it("projects must be a non-empty list without repeats", async () => {
    await expect(load(writeProjectsYaml(sb.root, [seatBlock("main", { projects: [] })]))).rejects.toThrow(
      /projects — must not be empty/,
    );
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { projects: ["app", "app"] })])),
    ).rejects.toThrow(/lists "app" twice/);
  });

  it("no project belongs to two co-seats", async () => {
    await expect(
      load(
        writeProjectsYaml(
          sb.root,
          [seatBlock("a", { projects: ["app", "site"] }), seatBlock("b", { projects: ["site"] })],
          ["app", "site"],
        ),
      ),
    ).rejects.toThrow(/project "site" belongs to two co-seats \("a" and "b"\)/);
    // Disjoint seats are fine.
    const ok = await load(
      writeProjectsYaml(sb.root, [seatBlock("a"), seatBlock("b", { projects: ["site"] })], ["app", "site"]),
    );
    expect(ok.dispatcher.co_seats!.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("an auto_merge project needs authority.land: true", async () => {
    const extra = { app: { auto_merge: true } };
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main")], ["app"], extra)),
    ).rejects.toThrow(/project "app" has auto_merge: true.*needs authority\.land: true/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { authority: { land: false } })], ["app"], extra)),
    ).rejects.toThrow(/authority\.land: true/);
    const ok = await load(
      writeProjectsYaml(sb.root, [seatBlock("main", { authority: { land: true } })], ["app"], extra),
    );
    expect(ok.dispatcher.co_seats![0]!.authority.land).toBe(true);
  });

  it("needs at least one runner, and every runner has a meter", async () => {
    await expect(load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [] })]))).rejects.toThrow(
      /runners — must be a list with at least one runner/,
    );
    const noMeter = runner();
    delete (noMeter as Record<string, unknown>).meter;
    await expect(load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [noMeter] })]))).rejects.toThrow(
      /runners\[0\]\.meter — is required/,
    );
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner(), runner()] })])),
    ).rejects.toThrow(/runner id "primary" appears twice/);
  });

  it("meter max_used_percent is a number above 0 and at most 100", async () => {
    for (const bad of [0, 101, "85", -5]) {
      await expect(
        load(
          writeProjectsYaml(sb.root, [
            seatBlock("main", { runners: [runner({ meter: { command: ["echo", "1"], max_used_percent: bad } })] }),
          ]),
        ),
      ).rejects.toThrow(/max_used_percent — must be a number above 0 and at most 100/);
    }
    const ok = await load(
      writeProjectsYaml(sb.root, [
        seatBlock("main", { runners: [runner({ meter: { command: ["echo", "1"], max_used_percent: 100 } })] }),
      ]),
    );
    expect(ok.dispatcher.co_seats![0]!.runners[0]!.meter.max_used_percent).toBe(100);
  });

  it("env values are variable names, never values", async () => {
    const secret = "sk-ant-api03-" + "a".repeat(40);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env: { CLAUDE_CODE_OAUTH_TOKEN: secret } })] })])),
    ).rejects.toThrow(/looks like a secret value/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env: { TOKEN: "has a space" } })] })])),
    ).rejects.toThrow(/is not an environment variable name/);
    const ok = await load(
      writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env: { CLAUDE_CODE_OAUTH_TOKEN: "MY_PRIMARY_TOKEN" } })] })]),
    );
    expect(ok.dispatcher.co_seats![0]!.runners[0]!.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "MY_PRIMARY_TOKEN" });
  });

  it("env and env_unset keys do not overlap, and GS_CO_SEAT_* is the driver's", async () => {
    await expect(
      load(
        writeProjectsYaml(sb.root, [
          seatBlock("main", { runners: [runner({ env: { A_KEY: "SRC_KEY" }, env_unset: ["A_KEY"] })] }),
        ]),
      ),
    ).rejects.toThrow(/"A_KEY" is both mapped in env and listed in env_unset/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env: { GS_CO_SEAT: "X" } })] })])),
    ).rejects.toThrow(/GS_CO_SEAT\* variables are set by the driver/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env_unset: ["GS_CO_SEAT_ID"] })] })])),
    ).rejects.toThrow(/GS_CO_SEAT\* variables are set by the driver/);
    const ok = await load(
      writeProjectsYaml(sb.root, [seatBlock("main", { runners: [runner({ env_unset: ["ANTHROPIC_API_KEY"] })] })]),
    );
    expect(ok.dispatcher.co_seats![0]!.runners[0]!.env_unset).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("run_days is 1 to 30", async () => {
    for (const bad of [0, 31, 1.5, "7"]) {
      await expect(
        load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { run_days: bad } })])),
      ).rejects.toThrow(/run_days — must be an integer from 1 to 30/);
    }
    for (const good of [1, 30]) {
      const ok = await load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { run_days: good } })]));
      expect(ok.dispatcher.co_seats![0]!.run_days).toBe(good);
    }
  });

  it("wake values are whole numbers and done_globs a list of strings", async () => {
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { wake: { heartbeat_seconds: 0 } })])),
    ).rejects.toThrow(/heartbeat_seconds — must be an integer >= 1/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { wake: { min_gap_seconds: -1 } })])),
    ).rejects.toThrow(/min_gap_seconds — must be an integer >= 0/);
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { wake: { done_globs: "x" } })])),
    ).rejects.toThrow(/done_globs — must be a list/);
  });

  it("turn_timeout_seconds is 1 to 7200", async () => {
    for (const bad of [0, 7201, 1.5, "60"]) {
      await expect(
        load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { turn_timeout_seconds: bad } })])),
      ).rejects.toThrow(/turn_timeout_seconds — must be an integer from 1 to 7200/);
    }
    for (const good of [1, 7200]) {
      const ok = await load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { turn_timeout_seconds: good } })]));
      expect(ok.dispatcher.co_seats![0]!.turn_timeout_seconds).toBe(good);
    }
  });
});

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  expect(r.status).toBe(0);
}

describe("co_seats config: remote_control", () => {
  it("requires a git checkout outside every project path", async () => {
    const repo = join(sb.root, "control");
    const rc = { repo, remote: "origin", branch: "main", dir: "co-seat/main" };
    // Not a git checkout (does not exist).
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { remote_control: rc } })])),
    ).rejects.toThrow(/remote_control\.repo — "[^"]+" is not a git checkout/);
    // A directory that is not a git checkout.
    mkdirSync(repo, { recursive: true });
    await expect(
      load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { remote_control: rc } })])),
    ).rejects.toThrow(/is not a git checkout/);
    // A real checkout outside the projects.
    gitInit(repo);
    const ok = await load(writeProjectsYaml(sb.root, [seatBlock("main", { extra: { remote_control: rc } })]));
    expect(ok.dispatcher.co_seats![0]!.remote_control).toEqual(rc);
  });

  it("refuses a control repo that is, or contains, a project path", async () => {
    const inside = join(sb.root, "projects-src", "app", "ctl");
    gitInit(inside);
    await expect(
      load(
        writeProjectsYaml(sb.root, [
          seatBlock("main", { extra: { remote_control: { repo: inside, branch: "main", dir: "m" } } }),
        ]),
      ),
    ).rejects.toThrow(/overlaps project "app"/);
    // The project directory itself (a git repo) is also refused.
    const projectDir = join(sb.root, "projects-src", "app");
    gitInit(projectDir);
    await expect(
      load(
        writeProjectsYaml(sb.root, [
          seatBlock("main", { extra: { remote_control: { repo: projectDir, branch: "main", dir: "m" } } }),
        ]),
      ),
    ).rejects.toThrow(/overlaps project "app"/);
    // A control repo that contains the project path is refused too.
    const parent = join(sb.root, "parent");
    gitInit(parent);
    mkdirSync(join(parent, "app"), { recursive: true });
    const doc = writeProjectsYaml(sb.root, [seatBlock("main", { extra: { remote_control: { repo: parent, branch: "main", dir: "m" } } })]);
    writeFileSync(doc, readFileSync(doc, "utf8").replace(join(sb.root, "projects-src", "app"), join(parent, "app")));
    await expect(load(doc)).rejects.toThrow(/overlaps project "app"/);
  });

  it("keeps remote, branch and dir plain", async () => {
    const repo = join(sb.root, "control");
    gitInit(repo);
    const block = (rc: Record<string, unknown>) =>
      writeProjectsYaml(sb.root, [seatBlock("main", { extra: { remote_control: { repo, ...rc } } })]);
    await expect(load(block({ branch: "-evil", dir: "m" }))).rejects.toThrow(/branch — "-evil" is not a plain git branch name/);
    await expect(load(block({ branch: "main", remote: "--upload-pack=x", dir: "m" }))).rejects.toThrow(/is not a plain git remote name/);
    await expect(load(block({ branch: "main", dir: "../escape" }))).rejects.toThrow(/relative directory inside the control repo/);
    await expect(load(block({ branch: "main", dir: "/abs" }))).rejects.toThrow(/relative directory inside the control repo/);
    const ok = await load(block({ branch: "main", dir: "co-seat/main/" }));
    // remote defaults to origin; a trailing slash is trimmed.
    expect(ok.dispatcher.co_seats![0]!.remote_control).toEqual({ repo, remote: "origin", branch: "main", dir: "co-seat/main" });
  });
});

describe("findSeat / seatDir / buildSeatContext", () => {
  it("id is optional only when exactly one seat is declared", async () => {
    const one = await load(writeProjectsYaml(sb.root, [seatBlock("main")]));
    expect(findSeat(one).id).toBe("main");
    expect(findSeat(one, "main").id).toBe("main");
    expect(() => findSeat(one, "nope")).toThrow(/co-seat "nope" is not declared/);

    const two = await load(
      writeProjectsYaml(sb.root, [seatBlock("a"), seatBlock("b", { projects: ["site"] })], ["app", "site"]),
    );
    expect(() => findSeat(two)).toThrow(/several co-seats are declared \(a, b\); pass --id/);
    expect(findSeat(two, "b").projects).toEqual(["site"]);

    const none = await load(writeProjectsYaml(sb.root, undefined));
    expect(() => findSeat(none)).toThrow(/no co-seats are declared/);
  });

  it("the seat dir is <stateDir>/_co-seat/<id>", async () => {
    const yaml = await load(writeProjectsYaml(sb.root, [seatBlock("main")]));
    expect(seatDir("main", yaml.dispatcher)).toBe(join(sb.root, "state", "_co-seat", "main"));
    const ctx = buildSeatContext(yaml, yaml.dispatcher.co_seats![0]!, sb.root);
    expect(ctx.dir).toBe(join(sb.root, "state", "_co-seat", "main"));
    expect(ctx.briefPath).toBe(join(sb.root, "co-seat", "main", "BRIEF.md"));
    expect(ctx.projects.map((p) => p.id)).toEqual(["app"]);
  });
});

describe("configPin", () => {
  const seat = (over: Partial<CoSeatConfig> = {}): CoSeatConfig => ({
    id: "main",
    brief: "./b.md",
    state_file: "./s.md",
    projects: ["app"],
    authority: { verify: true, land: false, park_per_day: 2, aide_messages_per_day: 0 },
    runners: [{ id: "p", command: ["x"], meter: { command: ["m"], max_used_percent: 85 } }],
    wake: { heartbeat_seconds: 1800, min_gap_seconds: 300, cycles: true, aide_inboxes: true, done_globs: [] },
    turn_timeout_seconds: 1800,
    run_days: 7,
    ...over,
  });
  const project = (extra: Record<string, unknown> = {}) =>
    ({ ...projectEntry(sb.root, "app"), ...extra }) as unknown as Parameters<typeof configPin>[1][number];

  it("is a stable sha256 and ignores key order", () => {
    const a = configPin(seat(), [project()], "brief");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(configPin(seat(), [project()], "brief")).toBe(a);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const reordered = reverseKeys(seat()) as CoSeatConfig;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(seat())[0]);
    expect(configPin(reordered, [project()], "brief")).toBe(a);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] })).toBe('{"a":[{"d":1}],"b":1}');
  });

  it("changes with the seat block, each project's config, and the brief", () => {
    const base = configPin(seat(), [project()], "brief");
    expect(configPin(seat({ authority: { verify: true, land: true, park_per_day: 2, aide_messages_per_day: 0 } }), [project()], "brief")).not.toBe(base);
    expect(configPin(seat({ turn_timeout_seconds: 60 }), [project()], "brief")).not.toBe(base);
    expect(configPin(seat(), [project({ auto_merge: true })], "brief")).not.toBe(base);
    expect(configPin(seat(), [project({ hands_off: ["src/"] })], "brief")).not.toBe(base);
    expect(configPin(seat(), [project()], "brief edited")).not.toBe(base);
    expect(configPin(seat(), [project()], new TextEncoder().encode("brief"))).toBe(base);
    // dispatcher.state_dir is pinned too, so the seat directory cannot move under a running seat.
    expect(configPin(seat(), [project()], "brief", "./state")).not.toBe(base);
    expect(configPin(seat(), [project()], "brief", "./elsewhere")).not.toBe(configPin(seat(), [project()], "brief", "./state"));
  });
});

describe("missingStateHeadings", () => {
  it("lists the required headings a state file lacks", () => {
    expect(missingStateHeadings("")).toHaveLength(6);
    const full = "## Open items\n## Owned work\n## Waiting on\n## Held by a person\n## Parked\n## Last turn\n";
    expect(missingStateHeadings(full)).toEqual([]);
    expect(missingStateHeadings(full.replace("## Parked\n", ""))).toEqual(["Parked"]);
    // CRLF and trailing spaces are fine; a deeper heading level is not the heading.
    expect(missingStateHeadings(full.replace(/\n/g, "  \r\n"))).toEqual([]);
    expect(missingStateHeadings(full.replace("## Parked", "### Parked"))).toEqual(["Parked"]);
  });
});
