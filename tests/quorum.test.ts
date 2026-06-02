// gs quorum-review (2026-06-02) — tests for the multi-reviewer synthesis
// contract. The three load-bearing properties are exercised here against the
// PURE functions (no real reviewers spawned):
//   - honest-error: an errored voice is dropped, never fabricated, never
//     counted toward the quorum; below min_real_reviews it falls back and says so.
//   - synthesis-not-pick-best: findings are unioned and tagged by agreement.
//   - aggregate verdict by policy (conservative / majority).

import { describe, expect, it } from "bun:test";
import {
  aggregateVerdict,
  synthesizeQuorum,
  unionFindings,
  voiceErrored,
  type QuorumVoice,
} from "../src/reviewer";
import type { ReviewerResponse, ReviewerVerdict } from "../src/types";

function mkResponse(
  verdict: ReviewerVerdict,
  opts: Partial<ReviewerResponse> = {},
): ReviewerResponse {
  return {
    verdict,
    reason: opts.reason ?? `${verdict} from a reviewer`,
    scope_drift_files: opts.scope_drift_files ?? [],
    hands_off_violations: opts.hands_off_violations ?? [],
    task_evidence: opts.task_evidence ?? [],
    silent_failures: opts.silent_failures ?? [],
    notes: opts.notes ?? "",
  };
}

function realVoice(
  label: string,
  verdict: ReviewerVerdict,
  opts: Partial<ReviewerResponse> = {},
): QuorumVoice {
  const response = mkResponse(verdict, opts);
  return {
    label,
    provider: "claude",
    verdict,
    response,
    rawResponse: JSON.stringify(response),
    parseError: null,
    errored: false,
  };
}

// An errored voice carries a fail-safe response (as parseReviewerResponse
// would produce) but is flagged errored. Synthesis must ignore it entirely —
// including any findings it happens to carry.
function erroredVoice(
  label: string,
  carriedResponse?: ReviewerResponse,
): QuorumVoice {
  return {
    label,
    provider: "openrouter",
    verdict: "verification_failed",
    response: carriedResponse ?? mkResponse("verification_failed"),
    rawResponse: "[REVIEWER ERROR] OpenRouter 429 rate limited",
    parseError: "Could not parse reviewer response as JSON",
    errored: true,
    errorDetail: "[REVIEWER ERROR] OpenRouter 429 rate limited",
  };
}

describe("voiceErrored", () => {
  it("flags the [REVIEWER ERROR] sentinel", () => {
    expect(voiceErrored("[REVIEWER ERROR] boom", null)).toBe(true);
    expect(voiceErrored("  [REVIEWER ERROR] boom", null)).toBe(true);
  });
  it("flags an unparseable response (parseError set)", () => {
    expect(voiceErrored("not json", "Could not parse")).toBe(true);
  });
  it("does NOT flag a genuine verification_failed verdict", () => {
    expect(voiceErrored('{"verdict":"verification_failed"}', null)).toBe(false);
  });
});

describe("aggregateVerdict — conservative", () => {
  it("all verified → verified", () => {
    expect(aggregateVerdict(["verified", "verified"], "conservative")).toBe("verified");
  });
  it("any weak holds it to verified_weak", () => {
    expect(aggregateVerdict(["verified", "verified_weak"], "conservative")).toBe("verified_weak");
  });
  it("any real failure holds the merge (verification_failed)", () => {
    expect(aggregateVerdict(["verified", "verification_failed"], "conservative")).toBe(
      "verification_failed",
    );
  });
});

describe("aggregateVerdict — majority", () => {
  it("strict majority verified wins", () => {
    expect(aggregateVerdict(["verified", "verified", "verified_weak"], "majority")).toBe("verified");
  });
  it("majority weak wins", () => {
    expect(aggregateVerdict(["verified_weak", "verified_weak", "verified"], "majority")).toBe(
      "verified_weak",
    );
  });
  it("a three-way split (no majority) falls to most-conservative", () => {
    expect(
      aggregateVerdict(["verified", "verified_weak", "verification_failed"], "majority"),
    ).toBe("verification_failed");
  });
});

describe("unionFindings — synthesis, not pick-best", () => {
  it("unions across voices and tags by agreement count", () => {
    const voices = [
      realVoice("a", "verified_weak", { scope_drift_files: ["src/x.ts", "src/y.ts"] }),
      realVoice("b", "verified_weak", { scope_drift_files: ["src/x.ts"] }),
      realVoice("c", "verified", { hands_off_violations: ["src/safety.ts"] }),
    ];
    const tagged = unionFindings(voices);
    const x = tagged.find((t) => t.finding === "src/x.ts");
    const y = tagged.find((t) => t.finding === "src/y.ts");
    const safety = tagged.find((t) => t.finding === "src/safety.ts");
    expect(x?.agree).toBe(2);
    expect(x?.kind).toBe("scope_drift");
    expect(y?.agree).toBe(1);
    expect(safety?.kind).toBe("hands_off");
    // High-agreement first.
    expect(tagged[0].finding).toBe("src/x.ts");
  });
  it("dedups case-insensitively and counts a single voice once", () => {
    const voices = [
      realVoice("a", "verified_weak", { silent_failures: ["Build STEP skipped", "build step skipped"] }),
    ];
    const tagged = unionFindings(voices);
    expect(tagged.length).toBe(1);
    expect(tagged[0].agree).toBe(1);
  });
});

describe("synthesizeQuorum — honest-error contract", () => {
  it("drops an errored voice but reaches quorum on the real ones", () => {
    const voices = [
      realVoice("claude", "verified"),
      realVoice("qwen", "verified"),
      erroredVoice("ollama"),
    ];
    const s = synthesizeQuorum(voices, "conservative", 2);
    expect(s.realCount).toBe(2);
    expect(s.droppedCount).toBe(1);
    expect(s.quorumReached).toBe(true);
    expect(s.verdict).toBe("verified");
    expect(s.perVoice.find((p) => p.label === "ollama")?.verdict).toBe("errored");
    expect(s.response.notes).toContain("dropped");
  });

  it("a real verification_failed holds the merge (conservative)", () => {
    const voices = [realVoice("claude", "verified"), realVoice("qwen", "verification_failed")];
    const s = synthesizeQuorum(voices, "conservative", 2);
    expect(s.verdict).toBe("verification_failed");
    expect(s.quorumReached).toBe(true);
  });

  it("falls back to single-reviewer (and says so) below min_real_reviews", () => {
    const voices = [
      realVoice("claude", "verified_weak"),
      erroredVoice("qwen"),
      erroredVoice("ollama"),
    ];
    const s = synthesizeQuorum(voices, "conservative", 2);
    expect(s.realCount).toBe(1);
    expect(s.quorumReached).toBe(false);
    expect(s.verdict).toBe("verified_weak"); // the survivor's verdict, not elevated
    expect(s.response.notes).toContain("Quorum NOT reached");
    expect(s.response.reason).toContain("single-reviewer fallback");
  });

  it("zero real reviews fails safe — never fabricates a pass", () => {
    const voices = [erroredVoice("a"), erroredVoice("b")];
    const s = synthesizeQuorum(voices, "conservative", 2);
    expect(s.verdict).toBe("verification_failed");
    expect(s.realCount).toBe(0);
    expect(s.response.scope_drift_files).toEqual([]);
    expect(s.response.hands_off_violations).toEqual([]);
  });

  it("does NOT count findings carried by an errored voice", () => {
    // An errored voice whose (ignored) fail-safe response carries a finding.
    const ghost = erroredVoice(
      "ghost",
      mkResponse("verification_failed", { hands_off_violations: ["src/should-not-appear.ts"] }),
    );
    const voices = [realVoice("claude", "verified"), realVoice("qwen", "verified"), ghost];
    const s = synthesizeQuorum(voices, "conservative", 2);
    expect(s.response.hands_off_violations).not.toContain("src/should-not-appear.ts");
    expect(s.verdict).toBe("verified");
  });

  it("tags merged findings by agreement in the synthesized response", () => {
    const voices = [
      realVoice("a", "verified_weak", { scope_drift_files: ["drift.ts"] }),
      realVoice("b", "verified_weak", { scope_drift_files: ["drift.ts"] }),
      realVoice("c", "verified"),
    ];
    const s = synthesizeQuorum(voices, "conservative", 2);
    const drift = s.taggedFindings.find((t) => t.finding === "drift.ts");
    expect(drift?.agree).toBe(2);
    expect(s.response.scope_drift_files).toContain("drift.ts");
    expect(s.response.notes).toContain("[2x]");
    // conservative: a weak vote present → verified_weak.
    expect(s.verdict).toBe("verified_weak");
  });
});
