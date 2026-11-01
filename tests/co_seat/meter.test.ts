import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { pickRunner, parseMeterOutput, readMeter, type MeterReading } from "../../src/co_seat/meter";
import type { CoSeatRunnerConfig } from "../../src/types";
import { makeSandbox, meterScript, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const FAIL = { percent: 100, ok: false };

describe("readMeter fails closed", () => {
  it("reads a bare number and JSON {used_percent}", async () => {
    const bare = await readMeter(meterScript(sb.root, "m1.mjs", 'console.log("42")'), { cwd: sb.root });
    expect(bare).toMatchObject({ percent: 42, ok: true });
    const json = await readMeter(meterScript(sb.root, "m2.mjs", 'console.log(JSON.stringify({ used_percent: 12.5 }))'), { cwd: sb.root });
    expect(json).toMatchObject({ percent: 12.5, ok: true });
    const zero = await readMeter(meterScript(sb.root, "m3.mjs", 'console.log(" 0 \\n")'), { cwd: sb.root });
    expect(zero).toMatchObject({ percent: 0, ok: true });
  });

  it("reads 100 for a non-zero exit, even with a good number on stdout", async () => {
    const r = await readMeter(meterScript(sb.root, "m.mjs", 'console.log("5"); process.exit(1)'), { cwd: sb.root });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain("exited 1");
  });

  it("reads 100 for a timeout, and returns promptly", async () => {
    const started = Date.now();
    const r = await readMeter(meterScript(sb.root, "m.mjs", "setTimeout(() => console.log('1'), 30000)"), {
      cwd: sb.root,
      timeoutMs: 300,
    });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads 100 for garbage, an out-of-range value, empty output and a missing executable", async () => {
    const run = (name: string, body: string) => readMeter(meterScript(sb.root, name, body), { cwd: sb.root });
    expect(await run("g.mjs", 'console.log("fifty percent")')).toMatchObject(FAIL);
    expect(await run("g2.mjs", 'console.log("12%")')).toMatchObject(FAIL);
    expect(await run("g3.mjs", 'console.log("NaN")')).toMatchObject(FAIL);
    expect(await run("g4.mjs", 'console.log("{not json")')).toMatchObject(FAIL);
    expect(await run("g5.mjs", 'console.log(JSON.stringify({ used: 5 }))')).toMatchObject(FAIL);
    expect(await run("g6.mjs", 'console.log("1\\n2")')).toMatchObject(FAIL);
    const high = await run("h.mjs", 'console.log("101")');
    expect(high).toMatchObject(FAIL);
    expect(high.detail).toContain("outside 0-100");
    expect(await run("n.mjs", 'console.log("-1")')).toMatchObject(FAIL);
    expect(await run("e.mjs", "")).toMatchObject(FAIL);
    expect(await readMeter(["definitely-not-a-real-binary-xyz"], { cwd: sb.root })).toMatchObject(FAIL);
    expect(await readMeter([], { cwd: sb.root })).toMatchObject(FAIL);
  });

  it("parseMeterOutput accepts the boundaries", () => {
    expect(parseMeterOutput("0")).toMatchObject({ percent: 0, ok: true });
    expect(parseMeterOutput("100")).toMatchObject({ percent: 100, ok: true });
    expect(parseMeterOutput("100.5")).toMatchObject(FAIL);
  });
});

function runner(id: string, over: Partial<CoSeatRunnerConfig> = {}, max = 85): CoSeatRunnerConfig {
  return { id, command: ["x"], meter: { command: [id], max_used_percent: max }, ...over };
}

function stubReader(readings: Record<string, MeterReading>, called: string[] = []) {
  return async (argv: string[]): Promise<MeterReading> => {
    called.push(argv[0]!);
    return readings[argv[0]!] ?? { percent: 100, ok: false, detail: "no stub" };
  };
}
const ok = (percent: number): MeterReading => ({ percent, ok: true, detail: `used ${percent}%` });

describe("pickRunner", () => {
  it("takes the first runner under its limit", async () => {
    const r = await pickRunner([runner("primary"), runner("fallback")], stubReader({ primary: ok(40), fallback: ok(5) }), {});
    expect(r.runner?.id).toBe("primary");
  });

  it("falls to the next runner when the first is at or over its limit, and hands back when it recovers", async () => {
    const runners = [runner("primary", {}, 85), runner("fallback", {}, 95)];
    const over = await pickRunner(runners, stubReader({ primary: ok(85), fallback: ok(50) }), {});
    expect(over.runner?.id).toBe("fallback"); // 85 is not under 85
    const back = await pickRunner(runners, stubReader({ primary: ok(60), fallback: ok(50) }), {});
    expect(back.runner?.id).toBe("primary");
  });

  it("a failed meter (read as 100) never grants a turn, even at max 100", async () => {
    const failed: MeterReading = { percent: 100, ok: false, detail: "timed out" };
    const r = await pickRunner([runner("primary", {}, 100)], stubReader({ primary: failed }), {});
    expect(r.runner).toBeNull();
    expect(r.readings[0]!.reading).toMatchObject({ ok: false });
  });

  it("no runner available returns every reading", async () => {
    const r = await pickRunner([runner("a"), runner("b")], stubReader({ a: ok(99), b: ok(90) }), {});
    expect(r.runner).toBeNull();
    expect(r.readings.map((x) => x.runner)).toEqual(["a", "b"]);
  });

  it("skips a runner whose env source variable is unset or empty, without reading its meter", async () => {
    const called: string[] = [];
    const runners = [
      runner("primary", { env: { CLAUDE_CODE_OAUTH_TOKEN: "MY_PRIMARY_TOKEN" } }),
      runner("fallback", { env: { CLAUDE_CODE_OAUTH_TOKEN: "MY_FALLBACK_TOKEN" } }),
    ];
    const reader = stubReader({ primary: ok(1), fallback: ok(1) }, called);
    const unset = await pickRunner(runners, reader, { MY_FALLBACK_TOKEN: "x" });
    expect(unset.runner?.id).toBe("fallback");
    expect(called).toEqual(["fallback"]);
    expect(unset.readings[0]).toMatchObject({ runner: "primary", skipped: expect.stringContaining("MY_PRIMARY_TOKEN") });
    called.length = 0;
    const empty = await pickRunner(runners, reader, { MY_PRIMARY_TOKEN: "", MY_FALLBACK_TOKEN: "" });
    expect(empty.runner).toBeNull();
    expect(called).toEqual([]);
    // All source variables set: the first wins.
    const both = await pickRunner(runners, reader, { MY_PRIMARY_TOKEN: "a", MY_FALLBACK_TOKEN: "b" });
    expect(both.runner?.id).toBe("primary");
  });
});
