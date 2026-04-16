import { describe, expect, it } from "bun:test";
import { parseReviewerResponse } from "../src/reviewer";

const VALID_RESPONSE = {
  verdict: "verified" as const,
  reason: "All tasks completed correctly",
  scope_drift_files: [],
  hands_off_violations: [],
  task_evidence: [{ task: "Fix login", evidence: "Updated auth.ts", result: "pass" }],
  silent_failures: [],
  notes: "Clean cycle",
};

describe("parseReviewerResponse", () => {
  it("parses raw JSON", () => {
    const raw = JSON.stringify(VALID_RESPONSE);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON in markdown fences", () => {
    const raw = "```json\n" + JSON.stringify(VALID_RESPONSE, null, 2) + "\n```";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.verdict).toBe("verified");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON in bare fences (no language tag)", () => {
    const raw = "```\n" + JSON.stringify(VALID_RESPONSE) + "\n```";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON with surrounding prose", () => {
    const raw =
      "Here is my review of the changes:\n\n" +
      JSON.stringify(VALID_RESPONSE) +
      "\n\nLet me know if you need anything else.";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("handles verified_weak verdict", () => {
    const weakResponse = { ...VALID_RESPONSE, verdict: "verified_weak" as const };
    const raw = JSON.stringify(weakResponse);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified_weak");
    expect(result.response?.verdict).toBe("verified_weak");
    expect(result.parseError).toBeNull();
  });

  it("handles verification_failed verdict", () => {
    const failedResponse = {
      ...VALID_RESPONSE,
      verdict: "verification_failed" as const,
      reason: "Tests do not pass",
    };
    const raw = JSON.stringify(failedResponse);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.response?.reason).toBe("Tests do not pass");
    expect(result.parseError).toBeNull();
  });

  it("returns verification_failed for completely malformed input", () => {
    const raw = "This is not JSON at all, just plain text rambling.";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
    expect(result.response?.verdict).toBe("verification_failed");
  });

  it("returns verification_failed for empty input", () => {
    const result = parseReviewerResponse("");
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
  });

  it("returns verification_failed for JSON with invalid verdict", () => {
    const raw = JSON.stringify({ ...VALID_RESPONSE, verdict: "approved" });
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
  });
});
