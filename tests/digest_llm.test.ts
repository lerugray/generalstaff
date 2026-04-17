import { describe, expect, it } from "bun:test";
import {
  buildDigestNarrativePrompt,
  generateDigestNarrative,
} from "../src/digest_llm";
import type {
  LLMProvider,
  ProviderInvokeOptions,
  ProviderInvokeResult,
} from "../src/providers/types";
import type { CycleResult } from "../src/types";

function makeCycle(overrides: Partial<CycleResult> = {}): CycleResult {
  return {
    cycle_id: "c1",
    project_id: "generalstaff",
    started_at: "2026-04-17T20:00:00.000Z",
    ended_at: "2026-04-17T20:05:00.000Z",
    // Identical start/end short-circuits fetchCommitSubject so tests don't
    // emit "bad object" warnings; the cycle_id is used as fallback subject.
    cycle_start_sha: "a".repeat(40),
    cycle_end_sha: "a".repeat(40),
    engineer_exit_code: 0,
    verification_outcome: "passed",
    reviewer_verdict: "verified",
    final_outcome: "verified",
    reason: "ok",
    ...overrides,
  };
}

function stubProvider(
  fn: (prompt: string, opts?: ProviderInvokeOptions) => Promise<ProviderInvokeResult>,
): LLMProvider {
  return { name: "stub", invoke: fn };
}

describe("generateDigestNarrative (gs-154)", () => {
  it("returns narrative on happy path", async () => {
    const provider = stubProvider(async () => ({ content: "All verified, no issues." }));
    const res = await generateDigestNarrative([makeCycle()], 15, provider);
    expect(res.fellBack).toBe(false);
    expect(res.narrative).toBe("All verified, no issues.");
    expect(res.error).toBeUndefined();
  });

  it("trims leading and trailing whitespace from the narrative", async () => {
    const provider = stubProvider(async () => ({ content: "   trimmed output\n\n  " }));
    const res = await generateDigestNarrative([makeCycle()], 15, provider);
    expect(res.fellBack).toBe(false);
    expect(res.narrative).toBe("trimmed output");
  });

  it("falls back when provider returns empty content", async () => {
    const provider = stubProvider(async () => ({ content: "   " }));
    const res = await generateDigestNarrative([makeCycle()], 15, provider);
    expect(res.fellBack).toBe(true);
    expect(res.narrative).toBe("");
    expect(res.error).toBeDefined();
  });

  it("falls back when provider returns an error", async () => {
    const provider = stubProvider(async () => ({ content: "", error: "HTTP 500" }));
    const res = await generateDigestNarrative([makeCycle()], 15, provider);
    expect(res.fellBack).toBe(true);
    expect(res.narrative).toBe("");
    expect(res.error).toBe("HTTP 500");
  });

  it("falls back when provider throws", async () => {
    const provider: LLMProvider = {
      name: "throws",
      invoke: async () => {
        throw new Error("boom");
      },
    };
    const res = await generateDigestNarrative([makeCycle()], 15, provider);
    expect(res.fellBack).toBe(true);
    expect(res.error).toContain("boom");
  });

  it("passes maxTokens=200 and temperature=0 to the provider", async () => {
    let capturedOpts: ProviderInvokeOptions | undefined;
    const provider = stubProvider(async (_prompt, opts) => {
      capturedOpts = opts;
      return { content: "ok" };
    });
    await generateDigestNarrative([makeCycle()], 30, provider);
    expect(capturedOpts).toEqual({ maxTokens: 200, temperature: 0 });
  });
});

describe("buildDigestNarrativePrompt (gs-154)", () => {
  it("includes counts, duration, and verified/failed sections", () => {
    const prompt = buildDigestNarrativePrompt(
      [
        makeCycle({ cycle_id: "v1", project_id: "proj_a", final_outcome: "verified" }),
        makeCycle({
          cycle_id: "f1",
          project_id: "proj_b",
          final_outcome: "verification_failed",
          reviewer_verdict: "verification_failed",
          reason: "scope drift",
        }),
      ],
      42,
    );
    expect(prompt).toContain("42 minute(s)");
    expect(prompt).toContain("1 verified cycle(s)");
    expect(prompt).toContain("1 failed cycle(s)");
    expect(prompt).toContain("Verified cycles:");
    expect(prompt).toContain("Failed cycles:");
    expect(prompt).toContain("proj_a");
    expect(prompt).toContain("proj_b");
    expect(prompt).toContain("scope drift");
  });

  it("omits verified/failed sections when those arrays are empty", () => {
    const prompt = buildDigestNarrativePrompt([], 0);
    expect(prompt).not.toContain("Verified cycles:");
    expect(prompt).not.toContain("Failed cycles:");
    expect(prompt).toContain("0 verified cycle(s)");
    expect(prompt).toContain("0 failed cycle(s)");
  });

  it("asks for 2-4 sentence prose with no markdown", () => {
    const prompt = buildDigestNarrativePrompt([makeCycle()], 10);
    expect(prompt).toMatch(/2-4 sentence/);
    expect(prompt.toLowerCase()).toContain("no bullets");
  });
});
