import { describe, expect, it } from "bun:test";
import {
  buildCycleDescriptionPrompt,
  generateCycleDescription,
} from "../src/cycle_summary_llm";
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
    cycle_start_sha: "a".repeat(40),
    cycle_end_sha: "b".repeat(40),
    engineer_exit_code: 0,
    verification_outcome: "passed",
    reviewer_verdict: "verified",
    final_outcome: "verified",
    reason: "ok",
    diff_stats: { files_changed: 2, insertions: 10, deletions: 3 },
    ...overrides,
  };
}

function stubProvider(
  fn: (prompt: string, opts?: ProviderInvokeOptions) => Promise<ProviderInvokeResult>,
): LLMProvider {
  return { name: "stub", invoke: fn };
}

describe("generateCycleDescription (gs-155)", () => {
  it("returns description on happy path", async () => {
    const provider = stubProvider(async () => ({
      content: "Added digest narrative generator with fallback.",
    }));
    const res = await generateCycleDescription(makeCycle(), " src/foo.ts | 5 +", provider);
    expect(res.fellBack).toBe(false);
    expect(res.description).toBe("Added digest narrative generator with fallback.");
    expect(res.error).toBeUndefined();
  });

  it("strips internal newlines and collapses whitespace", async () => {
    const provider = stubProvider(async () => ({
      content: "Refactored\n  reviewer\nprompt   loader.\n",
    }));
    const res = await generateCycleDescription(makeCycle(), "", provider);
    expect(res.fellBack).toBe(false);
    expect(res.description).toBe("Refactored reviewer prompt loader.");
    expect(res.description).not.toContain("\n");
  });

  it("truncates oversize output with ellipsis", async () => {
    const longContent = "x".repeat(200);
    const provider = stubProvider(async () => ({ content: longContent }));
    const res = await generateCycleDescription(makeCycle(), "", provider);
    expect(res.fellBack).toBe(false);
    expect(res.description.length).toBe(120);
    expect(res.description.endsWith("…")).toBe(true);
  });

  it("falls back when provider returns an error", async () => {
    const provider = stubProvider(async () => ({ content: "", error: "HTTP 503" }));
    const res = await generateCycleDescription(makeCycle(), "", provider);
    expect(res.fellBack).toBe(true);
    expect(res.description).toBe("");
    expect(res.error).toBe("HTTP 503");
  });

  it("falls back when provider returns empty content", async () => {
    const provider = stubProvider(async () => ({ content: "   \n  " }));
    const res = await generateCycleDescription(makeCycle(), "", provider);
    expect(res.fellBack).toBe(true);
    expect(res.description).toBe("");
    expect(res.error).toBeDefined();
  });

  it("falls back when provider throws", async () => {
    const provider: LLMProvider = {
      name: "throws",
      invoke: async () => {
        throw new Error("network down");
      },
    };
    const res = await generateCycleDescription(makeCycle(), "", provider);
    expect(res.fellBack).toBe(true);
    expect(res.error).toContain("network down");
  });

  it("passes maxTokens=80 and temperature=0 to the provider", async () => {
    let captured: ProviderInvokeOptions | undefined;
    const provider = stubProvider(async (_prompt, opts) => {
      captured = opts;
      return { content: "ok" };
    });
    await generateCycleDescription(makeCycle(), "", provider);
    expect(captured).toEqual({ maxTokens: 80, temperature: 0 });
  });
});

describe("buildCycleDescriptionPrompt (gs-155)", () => {
  it("includes cycle_id, project_id, and final_outcome", () => {
    const prompt = buildCycleDescriptionPrompt(
      makeCycle({ cycle_id: "cycle-42", project_id: "proj_x", final_outcome: "verified" }),
      "",
    );
    expect(prompt).toContain("cycle-42");
    expect(prompt).toContain("proj_x");
    expect(prompt).toContain("verified");
  });

  it("includes diff_stats when present", () => {
    const prompt = buildCycleDescriptionPrompt(
      makeCycle({ diff_stats: { files_changed: 5, insertions: 120, deletions: 7 } }),
      "",
    );
    expect(prompt).toContain("5 file(s)");
    expect(prompt).toContain("+120");
    expect(prompt).toContain("-7");
  });

  it("omits diff_stats line when absent", () => {
    const cycle = makeCycle();
    delete (cycle as Partial<CycleResult>).diff_stats;
    const prompt = buildCycleDescriptionPrompt(cycle, "");
    expect(prompt).not.toContain("Diff:");
  });

  it("includes diff stat summary when non-empty", () => {
    const prompt = buildCycleDescriptionPrompt(makeCycle(), "src/foo.ts | 10 +++");
    expect(prompt).toContain("Diff stat summary:");
    expect(prompt).toContain("src/foo.ts | 10 +++");
  });

  it("omits diff stat summary when empty or whitespace", () => {
    const prompt = buildCycleDescriptionPrompt(makeCycle(), "   \n  ");
    expect(prompt).not.toContain("Diff stat summary:");
  });

  it("asks for a single-line response with no markdown", () => {
    const prompt = buildCycleDescriptionPrompt(makeCycle(), "");
    expect(prompt).toMatch(/single-line/);
    expect(prompt.toLowerCase()).toContain("no newlines");
  });
});
