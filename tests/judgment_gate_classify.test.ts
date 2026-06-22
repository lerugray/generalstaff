// gs-332: autonomous-mode GATE+CLASSIFY extension to the judgment gate —
// CLASS extraction, the classify prompt, and per-item verdict+class parsing.
// (The plain KEEP/REJECT slop-screen path is covered by judgment_gate.test.ts;
// these assert the additive CLASS behavior leaves it untouched.)

import { describe, expect, it } from "bun:test";
import {
  parseGateClass,
  parseGateVerdict,
  buildClassifyUserPrompt,
  parseClassifiedItems,
} from "../src/judgment_gate";

describe("parseGateClass", () => {
  it("parses BOT-SAFE and DESIGN-FORK (with/without hyphen, any case)", () => {
    expect(parseGateClass("CLASS: BOT-SAFE")).toBe("bot-safe");
    expect(parseGateClass("class: design-fork")).toBe("design-fork");
    expect(parseGateClass("CLASS: BOTSAFE")).toBe("bot-safe");
    expect(parseGateClass("**CLASS:** **DESIGN-FORK**")).toBe("design-fork");
  });

  it("returns undefined when there is no CLASS line", () => {
    expect(parseGateClass("VERDICT: KEEP\nWHY: good")).toBeUndefined();
  });
});

describe("parseGateVerdict — class is additive, never breaks the slop screen", () => {
  it("leaves class undefined for the single-task VERDICT/QUADRANT/WHY shape", () => {
    const r = parseGateVerdict(
      "VERDICT: KEEP\nQUADRANT: clever-lazy\nWHY: load-bearing",
    );
    expect(r.verdict).toBe("keep");
    expect(r.class).toBeUndefined();
  });

  it("extracts class when the gate also emits a CLASS line", () => {
    const r = parseGateVerdict("VERDICT: KEEP\nCLASS: DESIGN-FORK\nWHY: taste call");
    expect(r.verdict).toBe("keep");
    expect(r.class).toBe("design-fork");
  });
});

describe("buildClassifyUserPrompt", () => {
  it("includes the project header + the RAW scope text (why+tag) + the VERDICT/WHY/CLASS format", () => {
    const scopeText =
      "1. Add retry [MECHANICAL]\n2. Pick hero copy — needs taste [DESIGN]";
    const p = buildClassifyUserPrompt({ id: "demo", notes: "a thing" }, scopeText);
    expect(p).toContain("Project: demo");
    expect(p).toContain("a thing"); // notes folded into the header
    expect(p).toContain("Add retry [MECHANICAL]"); // raw why+tag preserved for the gate
    expect(p).toContain("needs taste [DESIGN]");
    expect(p).toContain("VERDICT:");
    expect(p).toContain("WHY:");
    expect(p).toContain("CLASS:");
    expect(p).toContain("BOT-SAFE");
    expect(p).toContain("DESIGN-FORK");
  });

  it("omits the dash-notes suffix when notes are absent", () => {
    const p = buildClassifyUserPrompt({ id: "demo" }, "1. x");
    expect(p).toContain("Project: demo");
    expect(p).not.toContain("demo —");
  });
});

describe("parseClassifiedItems — pairs each CLASS with its preceding VERDICT", () => {
  it("parses an in-order two-item response", () => {
    const raw = [
      "1.",
      "VERDICT: KEEP — bounded and load-bearing",
      "CLASS: BOT-SAFE",
      "2.",
      "VERDICT: REJECT — premature",
      "CLASS: DESIGN-FORK",
    ].join("\n");
    const out = parseClassifiedItems(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      verdict: "keep",
      class: "bot-safe",
      reason: "bounded and load-bearing",
    });
    expect(out[1].verdict).toBe("reject");
    expect(out[1].class).toBe("design-fork");
    expect(out[1].reason).toBe("premature");
  });

  it("captures the reason from a standalone WHY line (3-line format)", () => {
    const raw = "VERDICT: KEEP\nWHY: bounded and load-bearing\nCLASS: BOT-SAFE";
    const out = parseClassifiedItems(raw);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("keep");
    expect(out[0].class).toBe("bot-safe");
    expect(out[0].reason).toBe("bounded and load-bearing");
  });

  it("tolerates markdown bold and a hyphen reason separator", () => {
    const raw = "**VERDICT:** **KEEP** - solid\n**CLASS:** **BOT-SAFE**";
    const out = parseClassifiedItems(raw);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("keep");
    expect(out[0].class).toBe("bot-safe");
  });

  it("strips a <think> block before parsing", () => {
    const raw =
      "<think>weighing it</think>\nVERDICT: KEEP\nCLASS: DESIGN-FORK";
    const out = parseClassifiedItems(raw);
    expect(out).toHaveLength(1);
    expect(out[0].class).toBe("design-fork");
  });

  it("only emits an item once its CLASS line is seen", () => {
    // A dangling VERDICT with no CLASS is not emitted.
    const raw = "VERDICT: KEEP\n(no class given)";
    expect(parseClassifiedItems(raw)).toHaveLength(0);
  });
});
