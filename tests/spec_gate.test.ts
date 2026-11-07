import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateProject } from "../src/projects";
import {
  type CheckerReply,
  type SpecCard,
  type SpecChecker,
  appendSpecCheck,
  cardFromTask,
  checkCardAgainstAnchor,
  decideSpecGate,
  evaluateOwnerWords,
  extractOwnerAsk,
  firstScreenExists,
  loadSpecPrompt,
  lookupSpecCache,
  mechanicalChecks,
  parseOverride,
  parseSpecVerdict,
  readSpecChecks,
  recordSpecOverride,
  resolveSpecChecker,
  runSpecGate,
  shouldSpecGateBlock,
  specCacheKey,
  specChecksPath,
  specGateReasonCode,
  verifyOwnerQuote,
} from "../src/spec_gate";
import { isProgressEntry } from "../src/types";
import type { GreenfieldTask } from "../src/types";

const ANCHOR = "Players run a solo campaign against the computer.\n\n1. Pick a scenario.\n\nOut of spec:\n- a demo\n";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function validReply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "build",
    verdict: "ON-SPEC",
    user_can: "Pick a scenario and play it.",
    anchor_step: "1",
    reason: "Matches step 1.",
    owner_words_present: true,
    stand_in: false,
    ...over,
  });
}

function fakeChecker(replies: Array<Partial<CheckerReply> | string>): SpecChecker & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    const r = replies[Math.min(fn.calls - 1, replies.length - 1)]!;
    if (typeof r === "string") return { model: "fake/model", content: r, finish_reason: "stop" };
    return { model: "fake/model", ...r } as CheckerReply;
  }) as unknown as SpecChecker & { calls: number };
  fn.calls = 0;
  return fn;
}

function card(over: Partial<SpecCard> = {}): SpecCard {
  return { id: "t-1", title: "Add scenario list", body: "List scenarios.", ...over };
}

function input(c: SpecCard, project: Record<string, unknown> = {}, anchorText: string | null = ANCHOR) {
  return {
    anchorText,
    anchorLabel: "SPEC.md",
    card: c,
    project: { path: dir, ...project },
  };
}

function rawProject(over: Record<string, unknown> = {}) {
  return {
    id: "ok",
    path: "/tmp/ok",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 30,
    hands_off: ["secret/"],
    ...over,
  };
}

describe("spec gate config validation", () => {
  it("accepts off / flag / block", () => {
    for (const m of ["off", "flag", "block"]) {
      expect(validateProject(rawProject({ spec_gate: m })).spec_gate).toBe(m as "off" | "flag" | "block");
    }
  });

  it("leaves every spec field undefined when absent", () => {
    const p = validateProject(rawProject());
    expect(p.spec_gate).toBeUndefined();
    expect(p.spec_anchor).toBeUndefined();
    expect(p.owner_docs).toBeUndefined();
    expect(p.picture_first).toBeUndefined();
  });

  it("rejects an invalid spec_gate value", () => {
    expect(() => validateProject(rawProject({ spec_gate: "veto" }))).toThrow(/spec_gate/);
  });

  it("accepts a relative spec_anchor and rejects absolute or escaping paths", () => {
    expect(validateProject(rawProject({ spec_anchor: "docs/SPEC.md" })).spec_anchor).toBe("docs/SPEC.md");
    expect(() => validateProject(rawProject({ spec_anchor: "/etc/SPEC.md" }))).toThrow(/spec_anchor/);
    expect(() => validateProject(rawProject({ spec_anchor: "../SPEC.md" }))).toThrow(/spec_anchor/);
    expect(() => validateProject(rawProject({ spec_anchor: 5 }))).toThrow(/spec_anchor/);
  });

  it("validates owner_docs as a list of relative paths", () => {
    expect(validateProject(rawProject({ owner_docs: ["docs/GDD.md"] })).owner_docs).toEqual(["docs/GDD.md"]);
    expect(() => validateProject(rawProject({ owner_docs: "docs/GDD.md" }))).toThrow(/owner_docs/);
    expect(() => validateProject(rawProject({ owner_docs: ["../GDD.md"] }))).toThrow(/owner_docs/);
    expect(() => validateProject(rawProject({ owner_docs: [""] }))).toThrow(/owner_docs/);
  });

  it("validates picture_first as a boolean", () => {
    expect(validateProject(rawProject({ picture_first: true })).picture_first).toBe(true);
    expect(() => validateProject(rawProject({ picture_first: "yes" }))).toThrow(/picture_first/);
  });

  it("registers the new progress events", () => {
    for (const event of ["spec_verdict", "spec_override"]) {
      expect(isProgressEntry({ timestamp: "t", event, data: {} })).toBe(true);
    }
    expect(isProgressEntry({ timestamp: "t", event: "spec_nope", data: {} })).toBe(false);
  });
});

describe("owner words", () => {
  it("builds a card from a task and reads OWNER-ASK lines", () => {
    const task = {
      id: "g-1",
      title: "Add mode",
      status: "pending",
      priority: 1,
      description: 'Do it.\nOWNER-ASK: "play every game in normal mode"',
      user_facing: true,
    } as unknown as GreenfieldTask;
    const c = cardFromTask(task);
    expect(c.user_facing).toBe(true);
    expect(extractOwnerAsk(c.body ?? "")).toEqual(["play every game in normal mode"]);
    expect(evaluateOwnerWords(c, { path: dir }).present).toBe(true);
  });

  it("counts the owner_words field as a string or a list, and ignores blanks", () => {
    expect(evaluateOwnerWords(card({ owner_words: "play it normally" }), { path: dir }).present).toBe(true);
    expect(evaluateOwnerWords(card({ owner_words: ["", "play it normally"] }), { path: dir }).words).toEqual([
      "play it normally",
    ]);
    expect(evaluateOwnerWords(card({ owner_words: "  " }), { path: dir }).present).toBe(false);
    expect(evaluateOwnerWords(card(), { path: dir }).present).toBe(false);
  });

  it("needs at least three words for owner words", () => {
    expect(evaluateOwnerWords(card({ owner_words: "yes" }), { path: dir }).present).toBe(false);
    expect(evaluateOwnerWords(card({ owner_words: "yes do it" }), { path: dir }).present).toBe(true);
    expect(evaluateOwnerWords(card({ body: 'OWNER-ASK: "ok"' }), { path: dir }).present).toBe(false);
  });

  it("returns UNCLEAR without a model call for a user-facing build card with no owner words", async () => {
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(input(card({ user_facing: true })), { checker });
    expect(v.verdict).toBe("unclear");
    expect(v.source).toBe("mechanical");
    expect(v.reason).toContain("no owner words for this feature");
    expect(checker.calls).toBe(0);
  });

  it("does not demand owner words from a card that is not user-facing", async () => {
    const checker = fakeChecker([validReply()]);
    const b = await checkCardAgainstAnchor(input(card({ id: "t-2" })), { checker });
    expect(b.verdict).toBe("on-spec");
    expect(checker.calls).toBe(1);
  });

  it("never reads a fix exemption from the title", async () => {
    const checker = fakeChecker([validReply()]);
    const a = await checkCardAgainstAnchor(input(card({ title: "Fix: add a lobby screen", user_facing: true })), { checker });
    expect(a.verdict).toBe("unclear");
    expect(a.reason).toContain("no owner words for this feature");
    expect(checker.calls).toBe(0);
  });

  it("calls the model when owner words are present", async () => {
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(
      input(card({ user_facing: true, owner_words: "play every game in normal mode" })),
      { checker },
    );
    expect(v.verdict).toBe("on-spec");
    expect(v.owner_words_present).toBe(true);
    expect(checker.calls).toBe(1);
  });

  it("computes owner_words_present mechanically, ignoring the model's claim", async () => {
    const checker = fakeChecker([validReply({ owner_words_present: true })]);
    const v = await checkCardAgainstAnchor(input(card()), { checker });
    expect(v.owner_words_present).toBe(false);
  });
});

describe("owner_quote verification", () => {
  const doc = "# Design\n\n## Modes\n\nThe player   can play\nevery game in the normal mode.\n";

  beforeEach(() => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "GDD.md"), doc);
  });

  it("accepts a quote that occurs verbatim, ignoring whitespace differences", () => {
    const r = verifyOwnerQuote(
      { text: "can play every game in the normal mode.", source: "docs/GDD.md#Modes" },
      dir,
      ["docs/GDD.md"],
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a paraphrase", () => {
    const r = verifyOwnerQuote(
      { text: "the player is able to play all games normally", source: "docs/GDD.md#Modes" },
      dir,
      ["docs/GDD.md"],
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found verbatim");
  });

  it("rejects a file that is not listed in owner_docs", () => {
    const r = verifyOwnerQuote(
      { text: "can play every game in the normal mode.", source: "docs/GDD.md#Modes" },
      dir,
      ["docs/OTHER.md"],
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not listed in owner_docs");
  });

  it("rejects a missing file, a too-short quote and a malformed quote", () => {
    expect(verifyOwnerQuote({ text: "some long enough text", source: "docs/NOPE.md" }, dir, ["docs/NOPE.md"]).ok).toBe(
      false,
    );
    expect(verifyOwnerQuote({ text: "normal", source: "docs/GDD.md" }, dir, ["docs/GDD.md"]).reason).toContain(
      "shorter",
    );
    expect(verifyOwnerQuote("text", dir, ["docs/GDD.md"]).ok).toBe(false);
    expect(verifyOwnerQuote({ text: "x".repeat(20), source: "#only-section" }, dir, []).ok).toBe(false);
  });

  it("rejects an owner doc that is outside the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "spec-outside-"));
    try {
      writeFileSync(join(outside, "GDD.md"), doc);
      const r = verifyOwnerQuote(
        { text: "can play every game in the normal mode.", source: "../x/GDD.md" },
        dir,
        ["../x/GDD.md"],
      );
      expect(r.ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("counts a verified owner_quote as owner words and ignores one that fails", () => {
    const good = evaluateOwnerWords(
      card({ owner_quote: { text: "can play every game in the normal mode.", source: "docs/GDD.md#Modes" } }),
      { path: dir, owner_docs: ["docs/GDD.md"] },
    );
    expect(good.present).toBe(true);
    expect(good.quote?.source).toBe("docs/GDD.md#Modes");
    const bad = evaluateOwnerWords(
      card({ owner_quote: { text: "a made up sentence here", source: "docs/GDD.md#Modes" } }),
      { path: dir, owner_docs: ["docs/GDD.md"] },
    );
    expect(bad.present).toBe(false);
    expect(bad.quoteProblem).toContain("not found verbatim");
  });

  it("returns UNCLEAR mentioning why when the only owner words are an unverified quote", async () => {
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(
      input(
        card({ user_facing: true, owner_quote: { text: "a made up sentence here", source: "docs/GDD.md#Modes" } }),
        { owner_docs: ["docs/GDD.md"] },
      ),
      { checker },
    );
    expect(v.verdict).toBe("unclear");
    expect(v.reason).toContain("owner_quote does not count");
    expect(checker.calls).toBe(0);
  });
});

describe("picture_first", () => {
  const owned = { owner_words: "play every game in normal mode", user_facing: true as const };

  it("accepts an existing image or html file", () => {
    writeFileSync(join(dir, "first.png"), "x");
    writeFileSync(join(dir, "first.html"), "<p>x</p>");
    expect(firstScreenExists(dir, "first.png")).toBe(true);
    expect(firstScreenExists(dir, "first.html")).toBe(true);
  });

  it("rejects a missing path, a non-picture file, an absolute path and an escaping path", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(firstScreenExists(dir, undefined)).toBe(false);
    expect(firstScreenExists(dir, "gone.png")).toBe(false);
    expect(firstScreenExists(dir, "notes.txt")).toBe(false);
    expect(firstScreenExists(dir, join(dir, "notes.txt"))).toBe(false);
    expect(firstScreenExists(dir, "../first.png")).toBe(false);
  });

  it("refuses a user-facing build card with no first screen, without a model call", async () => {
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(input(card(owned), { picture_first: true }), { checker });
    expect(v.verdict).toBe("unclear");
    expect(v.reason).toContain("no first-screen picture");
    expect(checker.calls).toBe(0);
  });

  it("refuses a first_screen path that does not exist", async () => {
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(input(card({ ...owned, first_screen: "gone.png" }), { picture_first: true }), {
      checker,
    });
    expect(v.reason).toContain("no first-screen picture");
  });

  it("goes on to the model when the picture exists", async () => {
    writeFileSync(join(dir, "first.png"), "x");
    const checker = fakeChecker([validReply()]);
    const v = await checkCardAgainstAnchor(input(card({ ...owned, first_screen: "first.png" }), { picture_first: true }), {
      checker,
    });
    expect(v.verdict).toBe("on-spec");
  });

  it("skips cards that are not user-facing, and does nothing when picture_first is off", () => {
    expect(
      mechanicalChecks(card({ ...owned, title: "Fix the list" }), { path: dir, picture_first: true }).problems,
    ).toEqual(["no first-screen picture"]);
    expect(mechanicalChecks(card({ owner_words: "x y z" }), { path: dir, picture_first: true }).problems).toEqual([]);
    expect(mechanicalChecks(card(owned), { path: dir }).problems).toEqual([]);
  });
});

describe("verdict parsing and schema validation", () => {
  it("parses a valid reply, with or without a code fence", () => {
    const ok = parseSpecVerdict(validReply());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.verdict).toBe("on-spec");
    const fenced = parseSpecVerdict("```json\n" + validReply({ verdict: "OFF-SPEC" }) + "\n```");
    expect(fenced.ok).toBe(true);
    if (fenced.ok) expect(fenced.value.verdict).toBe("off-spec");
  });

  it("rejects empty, non-JSON, prose-wrapped and non-object replies", () => {
    expect(parseSpecVerdict("").ok).toBe(false);
    expect(parseSpecVerdict("looks fine to me").ok).toBe(false);
    expect(parseSpecVerdict("Sure: " + validReply()).ok).toBe(false);
    expect(parseSpecVerdict("[1,2]").ok).toBe(false);
  });

  it("rejects an unknown kind or verdict", () => {
    expect(parseSpecVerdict(validReply({ kind: "plan" })).ok).toBe(false);
    expect(parseSpecVerdict(validReply({ verdict: "MAYBE" })).ok).toBe(false);
  });

  it("rejects a missing or mistyped field", () => {
    for (const key of ["user_can", "anchor_step", "reason", "owner_words_present", "stand_in", "kind", "verdict"]) {
      const o = JSON.parse(validReply());
      delete o[key];
      expect(parseSpecVerdict(JSON.stringify(o)).ok).toBe(false);
    }
    expect(parseSpecVerdict(validReply({ owner_words_present: "yes" })).ok).toBe(false);
    expect(parseSpecVerdict(validReply({ reason: "  " })).ok).toBe(false);
  });

  it("rejects stand_in true on a verdict that is not OFF-SPEC", () => {
    expect(parseSpecVerdict(validReply({ stand_in: true })).ok).toBe(false);
    expect(parseSpecVerdict(validReply({ verdict: "OFF-SPEC", stand_in: true })).ok).toBe(true);
  });

  it("loads the bundled prompt with a version and only the marked text", () => {
    const p = loadSpecPrompt();
    expect(p.version).toBeGreaterThan(0);
    expect(p.text.toLowerCase()).toContain("assume the card has drifted");
    expect(p.text).not.toContain("BEGIN SYSTEM PROMPT");
  });
});

describe("completion discipline", () => {
  const cases: Array<[string, Partial<CheckerReply> | string]> = [
    ["a checker error", { error: "boom" }],
    ["a non-stop finish reason", { content: validReply(), finish_reason: "length" }],
    ["an empty reply", { content: "   ", finish_reason: "stop" }],
    ["a missing reply", { finish_reason: "stop" }],
    ["a malformed reply", "not json"],
  ];
  for (const [name, reply] of cases) {
    it(`treats ${name} as an error verdict`, async () => {
      const v = await checkCardAgainstAnchor(input(card()), { checker: fakeChecker([reply]) });
      expect(v.verdict).toBe("error");
      expect(v.stand_in).toBe(false);
    });
  }

  it("accepts a reply with no finish reason reported", async () => {
    const v = await checkCardAgainstAnchor(input(card()), {
      checker: fakeChecker([{ content: validReply(), finish_reason: undefined }]),
    });
    expect(v.verdict).toBe("on-spec");
  });

  it("treats a checker that throws as an error verdict", async () => {
    const checker: SpecChecker = async () => {
      throw new Error("network down");
    };
    const v = await checkCardAgainstAnchor(input(card()), { checker });
    expect(v.verdict).toBe("error");
    expect(v.reason).toContain("network down");
  });
});

describe("modes and no-anchor", () => {
  const v = (verdict: string, extra: Record<string, unknown> = {}) =>
    ({ verdict, reason: "r", owner_words_present: true, stand_in: false, source: "model", duration_sec: 0, ...extra }) as never;

  it("off and flag never block", () => {
    for (const verdict of ["on-spec", "off-spec", "unclear", "error"]) {
      expect(shouldSpecGateBlock("off", v(verdict))).toBe(false);
      expect(shouldSpecGateBlock("flag", v(verdict))).toBe(false);
    }
  });

  it("block proceeds only on on-spec and fails closed on everything else", () => {
    expect(shouldSpecGateBlock("block", v("on-spec"))).toBe(false);
    expect(shouldSpecGateBlock("block", v("off-spec"))).toBe(true);
    expect(shouldSpecGateBlock("block", v("unclear"))).toBe(true);
    expect(shouldSpecGateBlock("block", v("error"))).toBe(true);
  });

  it("names the refusal reason spec_gate_<verdict>", () => {
    expect(specGateReasonCode("off-spec")).toBe("spec_gate_off_spec");
    expect(specGateReasonCode("unclear")).toBe("spec_gate_unclear");
    expect(specGateReasonCode("error")).toBe("spec_gate_error");
    expect(decideSpecGate("block", v("off-spec"))).toEqual({ proceed: false, reasonCode: "spec_gate_off_spec" });
    expect(decideSpecGate("flag", v("off-spec")).proceed).toBe(true);
  });

  it("proceeds with a warning when there is no anchor, in block mode too", async () => {
    const checker = fakeChecker([validReply()]);
    for (const text of [null, "", "  \n"]) {
      const r = await checkCardAgainstAnchor(input(card(), {}, text), { checker });
      expect(r.no_anchor).toBe(true);
      expect(r.reason).toContain("no anchor");
      expect(shouldSpecGateBlock("block", r)).toBe(false);
      expect(decideSpecGate("block", r).proceed).toBe(true);
    }
    expect(checker.calls).toBe(0);
  });

  it("reads the anchor from the project path and spec_anchor", async () => {
    writeFileSync(join(dir, "SPEC.md"), ANCHOR);
    const checker = fakeChecker([validReply()]);
    const task = { id: "g-1", title: "Add scenario list", status: "pending", priority: 1 } as unknown as GreenfieldTask;
    expect((await runSpecGate({ id: "p", path: dir }, task, { checker })).verdict).toBe("on-spec");
    const missing = await runSpecGate({ id: "p", path: dir, spec_anchor: "docs/OTHER.md" }, task, { checker });
    expect(missing.no_anchor).toBe(true);
  });

  it("sends the checker only the anchor and the card", async () => {
    let seen = "";
    const checker: SpecChecker = async (_s, user) => {
      seen = user;
      return { model: "m", content: validReply(), finish_reason: "stop" };
    };
    await checkCardAgainstAnchor(input(card({ title: "Add scenario list" })), { checker });
    expect(seen).toContain("Players run a solo campaign");
    expect(seen).toContain("Add scenario list");
  });
});

describe("cache", () => {
  it("reuses a valid verdict for the same card and anchor without a second call", async () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    const checker = fakeChecker([validReply()]);
    const a = await checkCardAgainstAnchor(input(card()), { checker, checksPath });
    const b = await checkCardAgainstAnchor(input(card()), { checker, checksPath });
    expect(a.source).toBe("model");
    expect(b.source).toBe("cache");
    expect(b.verdict).toBe("on-spec");
    expect(checker.calls).toBe(1);
    const lines = readFileSync(checksPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.task_id).toBe("t-1");
    expect(rec.model).toBe("fake/model");
    expect(rec.key).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rec.ts).toBe("string");
  });

  it("misses when the card, the anchor or the prompt version changes", async () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    const checker = fakeChecker([validReply()]);
    await checkCardAgainstAnchor(input(card()), { checker, checksPath });
    await checkCardAgainstAnchor(input(card({ body: "Different body." })), { checker, checksPath });
    await checkCardAgainstAnchor(input(card(), {}, ANCHOR + "\n- another rule\n"), { checker, checksPath });
    expect(checker.calls).toBe(3);
    expect(specCacheKey(1, "a", "c")).not.toBe(specCacheKey(2, "a", "c"));
    expect(specCacheKey(1, "a", "c")).toBe(specCacheKey(1, "a", "c"));
  });

  it("never caches an error verdict", async () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    const checker = fakeChecker([{ error: "boom" }, validReply()]);
    const a = await checkCardAgainstAnchor(input(card()), { checker, checksPath });
    expect(a.verdict).toBe("error");
    expect(readSpecChecks(checksPath)).toHaveLength(0);
    const b = await checkCardAgainstAnchor(input(card()), { checker, checksPath });
    expect(b.verdict).toBe("on-spec");
    expect(checker.calls).toBe(2);
  });

  it("does not treat mechanical verdicts or overrides as cache hits", () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    appendSpecCheck(checksPath, {
      ts: "t", task_id: "a", key: "k1", verdict: "unclear", source: "mechanical", reason: "r",
    });
    appendSpecCheck(checksPath, {
      ts: "t", task_id: "a", key: "k2", verdict: "on-spec", reason: "r", record: "override", override_reason: "x y z",
    });
    appendSpecCheck(checksPath, { ts: "t", task_id: "a", key: "k3", verdict: "error", reason: "r" });
    expect(lookupSpecCache(checksPath, "k1")).toBeUndefined();
    expect(lookupSpecCache(checksPath, "k2")).toBeUndefined();
    expect(lookupSpecCache(checksPath, "k3")).toBeUndefined();
  });

  it("skips damaged lines when reading the log", () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    mkdirSync(join(dir, "state", "p"), { recursive: true });
    writeFileSync(checksPath, 'not json\n{"task_id":"a","verdict":"on-spec","reason":"r","key":"k","ts":"t"}\n{"x":1}\n');
    expect(readSpecChecks(checksPath)).toHaveLength(1);
  });

  it("logs mechanical verdicts so the audit can see them", async () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    await checkCardAgainstAnchor(input(card({ user_facing: true })), { checker: fakeChecker([validReply()]), checksPath });
    const recs = readSpecChecks(checksPath);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.source).toBe("mechanical");
  });
});

describe("override", () => {
  const blocked = (extra: Record<string, unknown> = {}) =>
    ({
      verdict: "off-spec", reason: "r", owner_words_present: true, stand_in: false, source: "model", duration_sec: 0, ...extra,
    }) as never;

  it("needs a reason of a few words", () => {
    expect(parseOverride(undefined).status).toBe("none");
    expect(parseOverride(null).status).toBe("none");
    expect(parseOverride("").status).toBe("invalid");
    expect(parseOverride("   ").status).toBe("invalid");
    expect(parseOverride("ok").status).toBe("invalid");
    expect(parseOverride("two words").status).toBe("invalid");
    expect(parseOverride("checker was down").status).toBe("valid");
  });

  it("lets a blocked card proceed with a valid reason", () => {
    const d = decideSpecGate("block", blocked(), parseOverride("verdict is plainly wrong here"));
    expect(d.proceed).toBe(true);
    expect(d.overridden?.reason).toBe("verdict is plainly wrong here");
  });

  it("lets an UNCLEAR or error verdict be overridden", () => {
    for (const verdict of ["unclear", "error"]) {
      expect(decideSpecGate("block", blocked({ verdict }), parseOverride("checker was down")).proceed).toBe(true);
    }
  });

  it("refuses an invalid reason and says why", () => {
    const d = decideSpecGate("block", blocked(), parseOverride("no"));
    expect(d.proceed).toBe(false);
    expect(d.reasonCode).toBe("spec_gate_off_spec");
    expect(d.overrideNote).toContain("at least");
  });

  it("never passes a stand-in verdict", () => {
    const d = decideSpecGate("block", blocked({ stand_in: true }), parseOverride("I really want this one"));
    expect(d.proceed).toBe(false);
    expect(d.overridden).toBeUndefined();
    expect(d.overrideNote).toContain("stand-in");
  });

  it("does nothing when the card is not blocked", () => {
    const d = decideSpecGate("block", blocked({ verdict: "on-spec" }), parseOverride("a reason here"));
    expect(d).toEqual({ proceed: true });
  });

  it("logs an override record next to the verdicts", () => {
    const checksPath = specChecksPath(join(dir, "state", "p"));
    recordSpecOverride(checksPath, "t-1", blocked(), "checker was down");
    const rec = readSpecChecks(checksPath)[0]!;
    expect(rec.record).toBe("override");
    expect(rec.override_reason).toBe("checker was down");
    expect(rec.task_id).toBe("t-1");
  });
});

describe("spec_checker provider routing", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.GENERALSTAFF_SPEC_GATE_MODEL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.GENERALSTAFF_SPEC_GATE_MODEL;
    else process.env.GENERALSTAFF_SPEC_GATE_MODEL = originalModel;
  });

  function writeConfig(body: string): string {
    const p = join(dir, "provider_config.yaml");
    writeFileSync(p, body);
    return p;
  }

  it("uses the routed provider and passes its finish reason through", async () => {
    const cfg = writeConfig(
      "providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  spec_checker: local\n",
    );
    let url = "";
    globalThis.fetch = (async (u: string | URL | Request) => {
      url = String(u);
      return new Response(JSON.stringify({ message: { content: validReply() }, done_reason: "stop" }), { status: 200 });
    }) as unknown as typeof fetch;
    const reply = await resolveSpecChecker({ providerConfigPath: cfg })("sys", "user", { timeoutMs: 5000 });
    expect(url).toContain("/api/chat");
    expect(reply.model).toBe("llama3:8b");
    expect(reply.finish_reason).toBe("stop");
    expect(parseSpecVerdict(reply.content ?? "").ok).toBe(true);
  });

  it("turns a routed truncated reply into an error verdict", async () => {
    const cfg = writeConfig(
      "providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  spec_checker: local\n",
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: { content: validReply() }, done_reason: "length" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const v = await checkCardAgainstAnchor(input(card()), {
      checker: resolveSpecChecker({ providerConfigPath: cfg }),
    });
    expect(v.verdict).toBe("error");
    expect(v.reason).toContain("finish_reason=length");
  });

  it("reports a failing routed provider as an error and does not fall back", async () => {
    const cfg = writeConfig(
      "providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  spec_checker: local\n",
    );
    process.env.OPENROUTER_API_KEY = "sk-test";
    const urls: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const reply = await resolveSpecChecker({ providerConfigPath: cfg })("s", "u", { timeoutMs: 5000 });
    expect(reply.error).toBeDefined();
    expect(urls.every((u) => u.includes("/api/chat"))).toBe(true);
  });

  it("falls back to inline OpenRouter when the role is unrouted, using the env model", async () => {
    const cfg = writeConfig("providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  digest: local\n");
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.GENERALSTAFF_SPEC_GATE_MODEL = "vendor/spec-model";
    let url = "";
    let body: { model?: string; messages?: Array<{ role: string }> } = {};
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: validReply() }, finish_reason: "stop" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const reply = await resolveSpecChecker({ providerConfigPath: cfg })("sys", "user", { timeoutMs: 5000 });
    expect(url).toContain("openrouter.ai");
    expect(body.model).toBe("vendor/spec-model");
    expect(body.messages?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(reply.finish_reason).toBe("stop");
  });

  it("fails closed with a clear error when unrouted and no key is set", async () => {
    const cfg = writeConfig("providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  digest: local\n");
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const reply = await resolveSpecChecker({ providerConfigPath: cfg })("s", "u", { timeoutMs: 5000 });
    expect(reply.error).toContain("OPENROUTER_API_KEY");
  });

  it("treats an inline OpenRouter reply cut off by the output limit as an error verdict", async () => {
    const cfg = writeConfig("providers:\n  - id: local\n    kind: ollama\n    model: llama3:8b\nroutes:\n  digest: local\n");
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: validReply() }, finish_reason: "length" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const v = await checkCardAgainstAnchor(input(card()), { checker: resolveSpecChecker({ providerConfigPath: cfg }) });
    expect(v.verdict).toBe("error");
  });

  it("reports an unreadable provider config as an error instead of using another backend", async () => {
    const cfg = writeConfig("providers: [not valid\n");
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const reply = await resolveSpecChecker({ providerConfigPath: cfg })("s", "u", { timeoutMs: 5000 });
    expect(reply.error).toContain("provider_config.yaml");
  });
});
