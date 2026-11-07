import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSpecAudit, checkExitCode, runSpecCli } from "../src/spec_cli";
import {
  type SpecChecker,
  appendSpecCheck,
  cardFromTask,
  evaluateOwnerWords,
  loadSpecPrompt,
  readSpecChecks,
  renderCardText,
  specCacheKey,
  specChecksPath,
} from "../src/spec_gate";
import type { GreenfieldTask, ProjectConfig } from "../src/types";

const ANCHOR = "Players run a solo campaign against the computer.\n\n1. Pick a scenario.\n\nOut of spec:\n- a demo\n";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "build",
    verdict: "ON-SPEC",
    user_can: "Pick a scenario.",
    anchor_step: "1",
    reason: "Matches step 1.",
    owner_words_present: true,
    stand_in: false,
    ...over,
  });
}

const checkerOf = (content: string): SpecChecker & { calls: number } => {
  const fn = (async () => {
    fn.calls++;
    return { model: "fake/model", content, finish_reason: "stop" };
  }) as unknown as SpecChecker & { calls: number };
  fn.calls = 0;
  return fn;
};

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: "p", path: dir, spec_gate: "block", ...over } as ProjectConfig;
}

function task(over: Record<string, unknown> = {}): GreenfieldTask {
  return { id: "p-1", title: "Add scenario list", status: "pending", priority: 1, ...over } as unknown as GreenfieldTask;
}

function run(argv: string[], tasks: GreenfieldTask[], opts: { checker?: SpecChecker; env?: Record<string, string | undefined>; proj?: ProjectConfig } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSpecCli(argv, {
    loadProject: async () => opts.proj ?? project(),
    loadTasks: async () => tasks,
    rootDir: dir,
    checker: opts.checker,
    env: opts.env ?? {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return code.then((c) => ({ code: c, out: out.join("\n"), err: err.join("\n") }));
}

describe("spec check exit codes", () => {
  beforeEach(() => writeFileSync(join(dir, "SPEC.md"), ANCHOR));

  it("maps verdicts to exit codes", () => {
    expect(checkExitCode({ verdict: "on-spec" })).toBe(0);
    expect(checkExitCode({ verdict: "off-spec" })).toBe(3);
    expect(checkExitCode({ verdict: "unclear" })).toBe(4);
    expect(checkExitCode({ verdict: "error" })).toBe(1);
    expect(checkExitCode({ verdict: "error", no_anchor: true })).toBe(0);
  });

  it("exits 0 on ON-SPEC for a task", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1"], [task()], { checker: checkerOf(reply()) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ON-SPEC");
  });

  it("exits 3 on OFF-SPEC and 4 on UNCLEAR", async () => {
    const off = await run(["check", "--project", "p", "--task", "p-1"], [task()], {
      checker: checkerOf(reply({ verdict: "OFF-SPEC", reason: "A demo." })),
    });
    expect(off.code).toBe(3);
    expect(off.out).toContain("OFF-SPEC");
    const unclear = await run(["check", "--project", "p", "--task", "p-2"], [task({ id: "p-2", title: "Something vague" })], {
      checker: checkerOf(reply({ verdict: "UNCLEAR" })),
    });
    expect(unclear.code).toBe(4);
  });

  it("exits 4 for a user-facing task with no owner words, without calling the model", async () => {
    const checker = checkerOf(reply());
    const r = await run(["check", "--project", "p", "--task", "p-1"], [task({ user_facing: true })], { checker });
    expect(r.code).toBe(4);
    expect(r.out).toContain("no owner words for this feature");
    expect(checker.calls).toBe(0);
  });

  it("exits 1 when the check could not be made", async () => {
    const checker: SpecChecker = async () => ({ model: "m", error: "boom" });
    const r = await run(["check", "--project", "p", "--task", "p-1"], [task()], { checker });
    expect(r.code).toBe(1);
  });

  it("exits 1 for an unknown task or a project that will not load", async () => {
    const unknown = await run(["check", "--project", "p", "--task", "nope"], [task()]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("nope");
    const out: string[] = [];
    const code = await runSpecCli(["check", "--project", "x", "--task", "y"], {
      loadProject: async () => {
        throw new Error("no such project");
      },
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code).toBe(1);
  });

  it("exits 0 with a warning when the anchor file does not exist", async () => {
    rmSync(join(dir, "SPEC.md"));
    const checker = checkerOf(reply());
    const r = await run(["check", "--project", "p", "--task", "p-1"], [task()], { checker });
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(checker.calls).toBe(0);
  });

  it("prints a stable JSON shape with --json", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1", "--json"], [task()], { checker: checkerOf(reply()) });
    const j = JSON.parse(r.out);
    expect(j.verdict).toBe("ON-SPEC");
    expect(j.task_id).toBe("p-1");
    expect(j.kind).toBe("build");
    expect(j.exit_code).toBe(0);
    expect(j.no_anchor).toBe(false);
    expect(j.overridden).toBeNull();
  });

  it("uses the verdict cache across runs", async () => {
    const checker = checkerOf(reply());
    await run(["check", "--project", "p", "--task", "p-1"], [task()], { checker });
    await run(["check", "--project", "p", "--task", "p-1"], [task()], { checker });
    expect(checker.calls).toBe(1);
  });

  it("rejects bad usage with exit 2", async () => {
    expect((await run(["check"], [])).code).toBe(2);
    expect((await run(["check", "--project", "p"], [])).code).toBe(2);
    expect((await run(["check", "--project", "p", "--task", "a", "--card", "c"], [])).code).toBe(2);
    expect((await run(["check", "--anchor", "a"], [])).code).toBe(2);
    expect((await run(["bogus"], [])).code).toBe(2);
    expect((await run(["check", "--wat"], [])).code).toBe(2);
    expect((await run([], [])).code).toBe(2);
    expect((await run(["--help"], [])).code).toBe(0);
  });
});

describe("spec check --override", () => {
  beforeEach(() => writeFileSync(join(dir, "SPEC.md"), ANCHOR));
  const off = (stand_in = false) =>
    checkerOf(reply({ verdict: "OFF-SPEC", stand_in, reason: "A demo." }));

  it("lets a blocked card through with a reason and logs it", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1", "--override", "checker is wrong about step 1"], [task()], {
      checker: off(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("OVERRIDDEN");
    const recs = readSpecChecks(specChecksPath(join(dir, "state", "p")));
    expect(recs.some((x) => x.record === "override" && x.override_reason === "checker is wrong about step 1")).toBe(true);
  });

  it("takes the reason from GENERALSTAFF_SPEC_GATE_OVERRIDE", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1"], [task()], {
      checker: off(),
      env: { GENERALSTAFF_SPEC_GATE_OVERRIDE: "checker was down earlier" },
    });
    expect(r.code).toBe(0);
  });

  it("ignores a reason that is too short and keeps the exit code", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1", "--override", "no"], [task()], { checker: off() });
    expect(r.code).toBe(3);
    expect(r.out).toContain("override ignored");
  });

  it("never passes a stand-in verdict", async () => {
    const r = await run(["check", "--project", "p", "--task", "p-1", "--override", "I want this one anyway"], [task()], {
      checker: off(true),
    });
    expect(r.code).toBe(3);
    expect(r.out).toContain("stand-in");
  });
});

describe("spec check --anchor --card", () => {
  it("checks a card file against an anchor file", async () => {
    writeFileSync(join(dir, "anchor.md"), ANCHOR);
    writeFileSync(join(dir, "card.md"), '# Build a scenario picker\nOWNER-ASK: "pick a scenario from pictures"\n');
    let seenUser = "";
    const checker: SpecChecker = async (_s, user) => {
      seenUser = user;
      return { model: "m", content: reply({ verdict: "OFF-SPEC", reason: "demo" }), finish_reason: "stop" };
    };
    const r = await run(["check", "--anchor", join(dir, "anchor.md"), "--card", join(dir, "card.md"), "--json"], [], { checker });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).verdict).toBe("OFF-SPEC");
    expect(seenUser).toContain("Build a scenario picker");
    expect(seenUser).toContain("pick a scenario from pictures");
  });

  it("exits 0 with a warning when the anchor file is missing", async () => {
    writeFileSync(join(dir, "card.md"), "# Something\n");
    const r = await run(["check", "--anchor", join(dir, "nope.md"), "--card", join(dir, "card.md")], []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
  });

  it("exits 1 when the card file is missing", async () => {
    writeFileSync(join(dir, "anchor.md"), ANCHOR);
    const r = await run(["check", "--anchor", join(dir, "anchor.md"), "--card", join(dir, "gone.md")], []);
    expect(r.code).toBe(1);
  });
});

describe("spec audit", () => {
  const userFacing = (id: string, over: Record<string, unknown> = {}) =>
    task({ id, title: `Feature ${id}`, user_facing: true, ...over });

  function logVerdict(taskObj: GreenfieldTask, verdict: string, proj: ProjectConfig = project(), stale = false) {
    const c = cardFromTask(taskObj);
    const owner = evaluateOwnerWords(c, proj);
    const key = specCacheKey(loadSpecPrompt().version, stale ? "OLD ANCHOR" : ANCHOR, renderCardText(c, owner, undefined));
    appendSpecCheck(specChecksPath(join(dir, "state", proj.id)), {
      ts: "2026-11-01T00:00:00.000Z",
      task_id: taskObj.id,
      key,
      model: "fake/model",
      verdict: verdict as never,
      source: "model",
      reason: `reason for ${verdict}`,
      stand_in: false,
    });
  }

  beforeEach(() => writeFileSync(join(dir, "SPEC.md"), ANCHOR));

  it("lists only user-facing tasks, with owner words, verdict and overrides", () => {
    const a = userFacing("a", { status: "done", owner_words: "play it in normal mode" });
    const b = userFacing("b", { status: "pending", owner_words: "see the map first" });
    const c = task({ id: "c", title: "Refactor storage", status: "done" });
    logVerdict(a, "on-spec");
    appendSpecCheck(specChecksPath(join(dir, "state", "p")), {
      ts: "2026-11-02T00:00:00.000Z", record: "override", task_id: "b", key: null, verdict: "off-spec",
      reason: "r", override_reason: "checker was down",
    });
    const res = buildSpecAudit(project(), [a, b, c], readSpecChecks(specChecksPath(join(dir, "state", "p"))));
    expect(res.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.problems).toBe(0);
    expect(res.markdown).toContain("play it in normal mode");
    expect(res.markdown).toContain("ON-SPEC");
    expect(res.markdown).toContain("not checked");
    expect(res.markdown).toContain("checker was down");
    expect(res.markdown).toContain("What a user sees now");
    expect(res.markdown).not.toContain("Refactor storage");
  });

  it("flags a done user-facing task with no owner words as MISSING and exits 2", async () => {
    const r = await run(["audit", "--project", "p"], [userFacing("a", { status: "done" })]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("MISSING");
    expect(r.out).toContain("a: done without owner words");
  });

  it("does not fail for a pending task with no owner words", async () => {
    const r = await run(["audit", "--project", "p"], [userFacing("a", { status: "pending" })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("MISSING");
  });

  it("exits 2 when a done task's latest verdict is OFF-SPEC or UNCLEAR", async () => {
    const a = userFacing("a", { status: "done", owner_words: "play it in normal mode" });
    logVerdict(a, "off-spec");
    expect((await run(["audit", "--project", "p"], [a])).code).toBe(2);
    const b = userFacing("b", { status: "done", owner_words: "play it in normal mode" });
    logVerdict(b, "unclear");
    expect((await run(["audit", "--project", "p"], [b])).code).toBe(2);
  });

  it("uses the latest verdict, so a later ON-SPEC clears an earlier OFF-SPEC", async () => {
    const a = userFacing("a", { status: "done", owner_words: "play it in normal mode" });
    logVerdict(a, "off-spec");
    logVerdict(a, "on-spec");
    const r = await run(["audit", "--project", "p"], [a]);
    expect(r.code).toBe(0);
  });

  it("marks a verdict stale when the anchor changed since", () => {
    const a = userFacing("a", { status: "done", owner_words: "play it in normal mode" });
    logVerdict(a, "on-spec", project(), true);
    const res = buildSpecAudit(project(), [a], readSpecChecks(specChecksPath(join(dir, "state", "p"))));
    expect(res.markdown).toContain("stale");
  });

  it("does not exempt a user-facing card because its title says fix", async () => {
    const r = await run(["audit", "--project", "p"], [userFacing("a", { title: "Fix scenario list", status: "done" })]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("MISSING");
  });

  it("writes the report to --out", async () => {
    const out = join(dir, "drift.md");
    const r = await run(["audit", "--project", "p", "--out", out], [userFacing("a", { status: "pending", owner_words: "x y z" })]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# Drift audit: p");
    expect(r.out).toContain("drift.md");
  });

  it("needs --project, and reports an empty list cleanly", async () => {
    expect((await run(["audit"], [])).code).toBe(2);
    const r = await run(["audit", "--project", "p"], []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no user-facing tasks");
  });

  it("warns when the anchor is missing", async () => {
    rmSync(join(dir, "SPEC.md"));
    const r = await run(["audit", "--project", "p"], [userFacing("a", { status: "pending", owner_words: "x y z" })]);
    expect(r.err).toContain("no anchor");
    expect(r.out).toContain("NOT FOUND");
  });
});
