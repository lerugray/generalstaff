// gs-330: judgment gate unit tests. Covers the pure decision (shouldGateSkipCycle),
// verdict parsing, prompt extraction (incl. the prose-mention skip), the goal/user
// prompt framing, and the graceful no-key no-op. The OpenRouter call itself is not
// exercised here (no network in unit tests); its failure paths funnel through the
// same "error verdict → proceed" contract that the no-key test pins.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import {
  shouldGateSkipCycle,
  parseGateVerdict,
  buildGateGoal,
  buildGateUserPrompt,
  loadGatePrompt,
  runJudgmentGate,
  _resetGatePromptCacheForTests,
  DEFAULT_GATE_MODEL,
} from "../src/judgment_gate";
import type { JudgmentGateMode, JudgmentVerdictKind } from "../src/types";

describe("shouldGateSkipCycle — only skip+reject blocks", () => {
  const modes: JudgmentGateMode[] = ["off", "flag", "skip"];
  const verdicts: JudgmentVerdictKind[] = ["keep", "reject", "error"];
  for (const mode of modes) {
    for (const verdict of verdicts) {
      const expected = mode === "skip" && verdict === "reject";
      it(`mode=${mode} verdict=${verdict} → ${expected ? "skip" : "proceed"}`, () => {
        expect(shouldGateSkipCycle(mode, verdict)).toBe(expected);
      });
    }
  }
});

describe("parseGateVerdict", () => {
  it("parses a clean KEEP", () => {
    const r = parseGateVerdict(
      "VERDICT: KEEP\nQUADRANT: clever-lazy\nWHY: Reproduce-fix-verify is the minimal path.",
    );
    expect(r.verdict).toBe("keep");
    expect(r.quadrant).toBe("clever-lazy");
    expect(r.reason).toContain("Reproduce-fix-verify");
  });

  it("parses a clean REJECT", () => {
    const r = parseGateVerdict(
      "VERDICT: REJECT\nQUADRANT: stupid-industrious\nWHY: A discipline fix masquerading as a gate.",
    );
    expect(r.verdict).toBe("reject");
    expect(r.quadrant).toBe("stupid-industrious");
    expect(r.reason).toContain("discipline fix");
  });

  it("tolerates markdown bold around the verdict", () => {
    const r = parseGateVerdict("**VERDICT:** **REJECT**\n**WHY:** slop.");
    expect(r.verdict).toBe("reject");
  });

  it("is case-insensitive on the verdict token", () => {
    expect(parseGateVerdict("verdict: keep\nwhy: fine").verdict).toBe("keep");
  });

  it("strips a <think> reasoning block before parsing", () => {
    const r = parseGateVerdict(
      "<think>Let me weigh this... it advances the goal.</think>\nVERDICT: KEEP\nWHY: advances the goal.",
    );
    expect(r.verdict).toBe("keep");
    expect(r.reason).toContain("advances the goal");
  });

  it("returns 'error' when there is no parseable VERDICT line", () => {
    const r = parseGateVerdict("I am not sure how to answer this question.");
    expect(r.verdict).toBe("error");
  });

  it("falls back to a non-label line for the reason when WHY is absent", () => {
    const r = parseGateVerdict("VERDICT: KEEP\nThis task is genuinely load-bearing.");
    expect(r.verdict).toBe("keep");
    expect(r.reason).toContain("load-bearing");
  });
});

describe("buildGateGoal / buildGateUserPrompt", () => {
  it("builds a goal from the project id", () => {
    const g = buildGateGoal({ id: "retrogaze" });
    expect(g).toContain("retrogaze");
    expect(g).not.toContain("Project intent");
  });

  it("folds project notes into the goal when present", () => {
    const g = buildGateGoal({ id: "retrogaze", notes: "ship the CRT shader." });
    expect(g).toContain("Project intent: ship the CRT shader.");
  });

  it("frames goal + action + the required answer format", () => {
    const u = buildGateUserPrompt("GOAL TEXT", "do the thing");
    expect(u).toContain("GOAL TEXT");
    expect(u).toContain("do the thing");
    expect(u).toContain("VERDICT: KEEP or REJECT");
    expect(u).toContain("stupid-industrious");
  });
});

describe("loadGatePrompt — marker extraction", () => {
  let dir: string;
  beforeEach(() => {
    _resetGatePromptCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "gs-gate-prompt-"));
  });
  afterEach(() => {
    _resetGatePromptCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts only the body between the real heading markers, skipping prose mentions", async () => {
    // The vendored prompt's own header MENTIONS the markers in prose; the
    // extractor must anchor on the real `^## === ... ===` heading lines and
    // ignore the prose. Replicate both here.
    const file = join(dir, "p.md");
    writeFileSync(
      file,
      [
        "  `## === BEGIN SYSTEM PROMPT ===` is mentioned here in an indented note.",
        "Preamble: between BEGIN SYSTEM PROMPT === and END SYSTEM PROMPT === markers, blah.",
        "## === BEGIN SYSTEM PROMPT ===",
        "REAL BODY LINE ONE",
        "REAL BODY LINE TWO",
        "## === END SYSTEM PROMPT ===",
        "trailer that must not appear",
      ].join("\n"),
      "utf8",
    );
    const text = await loadGatePrompt(file);
    expect(text).toBe("REAL BODY LINE ONE\nREAL BODY LINE TWO");
    expect(text).not.toContain("Preamble");
    expect(text).not.toContain("trailer");
    expect(text).not.toContain("BEGIN SYSTEM PROMPT");
  });

  it("throws when the markers are missing", async () => {
    const file = join(dir, "nomarkers.md");
    writeFileSync(file, "just some text, no markers", "utf8");
    await expect(loadGatePrompt(file)).rejects.toThrow(/markers/);
  });

  it("throws when the body between markers is empty", async () => {
    const file = join(dir, "empty.md");
    writeFileSync(
      file,
      "## === BEGIN SYSTEM PROMPT ===\n\n## === END SYSTEM PROMPT ===\n",
      "utf8",
    );
    await expect(loadGatePrompt(file)).rejects.toThrow(/empty/);
  });

  it("loads the real vendored prompt and returns a non-empty body", async () => {
    const real = join(import.meta.dir, "..", "src", "prompts", "hammerstein_gate.md");
    const text = await loadGatePrompt(real);
    expect(text.length).toBeGreaterThan(500);
    expect(text).not.toMatch(/^## === BEGIN SYSTEM PROMPT ===/);
  });
});

describe("runJudgmentGate — graceful no-op without a key", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  it("returns an 'error' verdict (which proceeds) when OPENROUTER_API_KEY is unset", async () => {
    const v = await runJudgmentGate(
      { id: "demo" },
      { id: "demo-1", title: "do a thing" },
    );
    expect(v.verdict).toBe("error");
    expect(v.reason).toContain("OPENROUTER_API_KEY");
    // error is never a reject → never blocks, even under skip mode
    expect(shouldGateSkipCycle("skip", v.verdict)).toBe(false);
    expect(v.model).toBe(DEFAULT_GATE_MODEL);
  });
});
