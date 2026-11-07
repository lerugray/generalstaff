// v0.18.1: date-bomb guard. A test that pins a fixed date (`const NOW =
// Date.parse(...)`) and also hands code the real clock (`now: () =>
// Date.now()`) passes until the real date drifts past whatever deadline the
// fixed date set up, then fails forever. Two co-seat tests did exactly that
// and turned CI red the day after release. Use the fixed clock plus offsets.
// A line that must use the real clock (it compares against file times, say)
// carries a `// real clock:` comment on the line above, giving the reason.

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const TESTS = import.meta.dir;
const FIXED = /const NOW = (Date\.parse\(|new Date\(["'`]|Date\.UTC\()/;
const REAL = /now:\s*\(\)\s*=>\s*Date\.now\(\)/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "fixtures" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (name.endsWith(".test.ts") && p !== import.meta.path) out.push(p);
  }
  return out;
}

export function clockViolations(source: string): number[] {
  if (!FIXED.test(source)) return [];
  const lines = source.split("\n");
  const bad: number[] = [];
  lines.forEach((line, i) => {
    if (REAL.test(line) && !/\/\/ real clock:/.test(lines[i - 1] ?? "")) bad.push(i + 1);
  });
  return bad;
}

describe("clock discipline", () => {
  it("flags a fixed NOW mixed with the real clock, and honours a real-clock note", () => {
    const fixed = 'const NOW = Date.parse("2026-11-01T12:00:00Z");\n';
    expect(clockViolations(fixed + "run({ now: () => Date.now() });\n")).toEqual([2]);
    expect(clockViolations(fixed + "// real clock: file times\nrun({ now: () => Date.now() });\n")).toEqual([]);
    expect(clockViolations("run({ now: () => Date.now() });\n")).toEqual([]);
  });

  it("no test file pins a fixed date and also hands code the real clock", () => {
    const found = testFiles(TESTS)
      .map((f) => ({ f: relative(TESTS, f), lines: clockViolations(readFileSync(f, "utf8")) }))
      .filter((x) => x.lines.length > 0)
      .map((x) => `${x.f}:${x.lines.join(",")}`);
    expect(found).toEqual([]);
  });
});
