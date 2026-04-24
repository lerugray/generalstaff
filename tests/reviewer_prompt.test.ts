import { describe, expect, it } from "bun:test";
import {
  buildReviewerPrompt,
  type ReviewerPromptParams,
} from "../src/prompts/reviewer";

function makeParams(
  overrides: Partial<ReviewerPromptParams> = {}
): ReviewerPromptParams {
  return {
    projectId: "test-proj",
    markedDoneTasks: "- [x] Fix widget alignment",
    sessionNoteOrNone: "Fixed CSS margin issue in widget component",
    fullDiff: "diff --git a/widget.css\n- margin: 10px\n+ margin: 0",
    diffStat: " 1 file changed, 1 insertion(+), 1 deletion(-)",
    verificationCommand: "bun test",
    verificationExitCode: 0,
    verificationOutputTruncated: "3 tests passed",
    handsOffList: ["CLAUDE.md", "run_bot*.sh"],
    ...overrides,
  };
}

describe("reviewer prompt template", () => {
  describe("placeholder substitution", () => {
    it("includes project ID in the prompt", () => {
      const prompt = buildReviewerPrompt(makeParams({ projectId: "catalogdna" }));
      expect(prompt).toContain("catalogdna");
    });

    it("includes marked-done tasks", () => {
      const tasks = "- [x] Add login page\n- [x] Write tests for auth";
      const prompt = buildReviewerPrompt(makeParams({ markedDoneTasks: tasks }));
      expect(prompt).toContain("Add login page");
      expect(prompt).toContain("Write tests for auth");
    });

    it("includes session note", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ sessionNoteOrNone: "Refactored the auth module" })
      );
      expect(prompt).toContain("Refactored the auth module");
    });

    it("includes the full diff", () => {
      const diff = "diff --git a/src/main.ts\n+console.log('hello')";
      const prompt = buildReviewerPrompt(makeParams({ fullDiff: diff }));
      expect(prompt).toContain(diff);
    });

    it("includes diff stat", () => {
      const stat = " 3 files changed, 42 insertions(+), 7 deletions(-)";
      const prompt = buildReviewerPrompt(makeParams({ diffStat: stat }));
      expect(prompt).toContain(stat);
    });

    it("includes verification command and exit code", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ verificationCommand: "npm test", verificationExitCode: 1 })
      );
      expect(prompt).toContain("`npm test`");
      expect(prompt).toContain("Exit code: 1");
    });

    it("includes verification output", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ verificationOutputTruncated: "FAIL src/auth.test.ts" })
      );
      expect(prompt).toContain("FAIL src/auth.test.ts");
    });

    it("formats hands-off list as markdown bullets", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ handsOffList: ["CLAUDE.md", "run_bot*.sh", "secrets/**"] })
      );
      expect(prompt).toContain("- `CLAUDE.md`");
      expect(prompt).toContain("- `run_bot*.sh`");
      expect(prompt).toContain("- `secrets/**`");
    });

    it("handles null verification exit code", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ verificationExitCode: null })
      );
      expect(prompt).toContain("Exit code: unknown");
    });
  });

  describe("empty field fallbacks", () => {
    it("shows fallback when no tasks are marked done", () => {
      const prompt = buildReviewerPrompt(makeParams({ markedDoneTasks: "" }));
      expect(prompt).toContain("(No tasks explicitly marked done)");
    });

    it("shows fallback when session note is empty", () => {
      const prompt = buildReviewerPrompt(makeParams({ sessionNoteOrNone: "" }));
      expect(prompt).toContain("(No session note found)");
    });

    it("shows fallback when diff is empty", () => {
      const prompt = buildReviewerPrompt(makeParams({ fullDiff: "" }));
      expect(prompt).toContain("(Empty diff — no changes detected)");
    });

    it("shows fallback when diff stat is empty", () => {
      const prompt = buildReviewerPrompt(makeParams({ diffStat: "" }));
      expect(prompt).toContain("(no stat available)");
    });

    it("shows fallback when verification output is empty", () => {
      const prompt = buildReviewerPrompt(
        makeParams({ verificationOutputTruncated: "" })
      );
      expect(prompt).toContain("(No output captured)");
    });
  });

  describe("truncation", () => {
    it("truncates diff beyond 50KB", () => {
      const longDiff = "x".repeat(60_000);
      const prompt = buildReviewerPrompt(makeParams({ fullDiff: longDiff }));

      expect(prompt).not.toContain("x".repeat(60_000));
      expect(prompt).toContain("[... truncated at 50000 chars");
      expect(prompt).toContain("full diff in cycle directory");
    });

    it("does not truncate diff at exactly 50KB", () => {
      const exactDiff = "y".repeat(50_000);
      const prompt = buildReviewerPrompt(makeParams({ fullDiff: exactDiff }));

      expect(prompt).toContain(exactDiff);
      expect(prompt).not.toContain("truncated at 50000");
    });

    it("truncates verification output beyond 10KB", () => {
      const longOutput = "z".repeat(15_000);
      const prompt = buildReviewerPrompt(
        makeParams({ verificationOutputTruncated: longOutput })
      );

      expect(prompt).not.toContain("z".repeat(15_000));
      expect(prompt).toContain("[... truncated at 10000 chars]");
    });

    it("does not truncate verification output at exactly 10KB", () => {
      const exactOutput = "w".repeat(10_000);
      const prompt = buildReviewerPrompt(
        makeParams({ verificationOutputTruncated: exactOutput })
      );

      expect(prompt).toContain(exactOutput);
      expect(prompt).not.toContain("truncated at 10000");
    });
  });

  describe("structural integrity", () => {
    it("contains required section headers", () => {
      const prompt = buildReviewerPrompt(makeParams());

      expect(prompt).toContain("## The cycle's claimed work");
      expect(prompt).toContain("## The diff");
      expect(prompt).toContain("## Independent verification output");
      expect(prompt).toContain("## Hands-off list");
      expect(prompt).toContain("## Your task");
      expect(prompt).toContain("## Verdict format");
      expect(prompt).toContain("## Verdict rules");
    });

    it("specifies all three verdict options", () => {
      const prompt = buildReviewerPrompt(makeParams());

      expect(prompt).toContain("verified");
      expect(prompt).toContain("verified_weak");
      expect(prompt).toContain("verification_failed");
    });

    it("instructs JSON-only response", () => {
      const prompt = buildReviewerPrompt(makeParams());

      expect(prompt).toContain("Respond with a JSON object only");
    });

    // gs-172: belt-and-braces alongside gs-171's parser hardening.
    // The prompt must explicitly forbid the Qwen failure mode where
    // string values contained an unescaped inner colon
    // (`"task": "status": "done"`), and must ask for bare task IDs
    // in task_evidence so that complex inner content can't even arise.
    it("forbids the unescaped-inner-colon pattern explicitly (gs-172)", () => {
      const prompt = buildReviewerPrompt(makeParams());

      expect(prompt).toContain("STRICT FORMATTING RULES");
      // The exact pathological example must appear as a NEVER:
      expect(prompt).toContain('"task": "status": "done"');
      expect(prompt).toMatch(/NEVER\s+emit/);
    });

    it("asks for bare task IDs in task_evidence (gs-172)", () => {
      const prompt = buildReviewerPrompt(makeParams());

      expect(prompt).toContain("bare task identifier");
      expect(prompt).toContain('NOT a natural-language summary');
    });
  });

  describe("public_facing soft cue (gs-315)", () => {
    it("omits the customer-facing section when publicFacing is unset", () => {
      const prompt = buildReviewerPrompt(makeParams());
      expect(prompt).not.toContain("Customer-facing surface");
      expect(prompt).not.toContain("end-to-end user journey");
    });

    it("omits the customer-facing section when publicFacing is false", () => {
      const prompt = buildReviewerPrompt(makeParams({ publicFacing: false }));
      expect(prompt).not.toContain("Customer-facing surface");
    });

    it("includes the customer-facing section when publicFacing is true", () => {
      const prompt = buildReviewerPrompt(makeParams({ publicFacing: true }));
      expect(prompt).toContain("## Customer-facing surface");
      expect(prompt).toContain("end-to-end user journey");
      expect(prompt).toContain("verified_weak");
    });

    it("instructs the verified_weak downgrade with explicit notes phrasing", () => {
      const prompt = buildReviewerPrompt(makeParams({ publicFacing: true }));
      expect(prompt).toContain("downgrade your verdict to `verified_weak`");
      expect(prompt).toContain("customer-facing surface untested");
    });

    it("explicitly frames the section as informational, not a hard rule", () => {
      const prompt = buildReviewerPrompt(makeParams({ publicFacing: true }));
      // Informational framing protects the existing verdict rules
      // (scope match, hands-off, evidence) from being overridden.
      expect(prompt).toMatch(/informational guidance, not a hard rule/i);
    });

    it("places the customer-facing section after hands-off and missionswarm", () => {
      const prompt = buildReviewerPrompt(
        makeParams({
          publicFacing: true,
          missionswarmContext: "audience-summary-marker",
        })
      );
      const handsOffIdx = prompt.indexOf("## Hands-off list");
      const msIdx = prompt.indexOf("audience-summary-marker");
      const pfIdx = prompt.indexOf("## Customer-facing surface");
      expect(handsOffIdx).toBeGreaterThan(-1);
      expect(msIdx).toBeGreaterThan(handsOffIdx);
      expect(pfIdx).toBeGreaterThan(msIdx);
    });
  });
});
