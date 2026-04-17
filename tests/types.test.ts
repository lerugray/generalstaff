import { describe, expect, it } from "bun:test";
import { isReviewerResponse, isProgressEntry } from "../src/types";

describe("isReviewerResponse", () => {
  const valid = {
    verdict: "verified",
    reason: "All checks pass",
    scope_drift_files: [],
    hands_off_violations: [],
    task_evidence: [],
    silent_failures: [],
    notes: "",
  };

  it("accepts a valid ReviewerResponse", () => {
    expect(isReviewerResponse(valid)).toBe(true);
  });

  it("accepts all three verdict values", () => {
    for (const v of ["verified", "verified_weak", "verification_failed"]) {
      expect(isReviewerResponse({ ...valid, verdict: v })).toBe(true);
    }
  });

  it("rejects null, undefined, and non-objects", () => {
    expect(isReviewerResponse(null)).toBe(false);
    expect(isReviewerResponse(undefined)).toBe(false);
    expect(isReviewerResponse("string")).toBe(false);
    expect(isReviewerResponse(42)).toBe(false);
  });

  it("rejects invalid verdict", () => {
    expect(isReviewerResponse({ ...valid, verdict: "approved" })).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { reason: _, ...noReason } = valid;
    expect(isReviewerResponse(noReason)).toBe(false);

    const { notes: __, ...noNotes } = valid;
    expect(isReviewerResponse(noNotes)).toBe(false);
  });

  it("rejects non-array for array fields", () => {
    expect(isReviewerResponse({ ...valid, scope_drift_files: "not-array" })).toBe(false);
    expect(isReviewerResponse({ ...valid, task_evidence: {} })).toBe(false);
  });
});

describe("isProgressEntry", () => {
  const valid = {
    timestamp: "2026-04-16T12:00:00.000Z",
    event: "cycle_start",
    data: { start_sha: "abc123" },
  };

  it("accepts a valid ProgressEntry", () => {
    expect(isProgressEntry(valid)).toBe(true);
  });

  it("accepts entries with optional cycle_id and project_id", () => {
    expect(isProgressEntry({ ...valid, cycle_id: "c-1", project_id: "proj" })).toBe(true);
  });

  it("accepts all valid event types", () => {
    const events = [
      "cycle_start", "cycle_skipped", "engineer_invoked", "engineer_completed",
      "verification_run", "verification_outcome", "diff_summary",
      "reviewer_invoked", "reviewer_response", "reviewer_verdict",
      "reviewer_fallback", "worktree_preflight", "cycle_rollback",
      "cycle_end", "session_start", "session_end", "session_complete",
    ];
    for (const e of events) {
      expect(isProgressEntry({ ...valid, event: e })).toBe(true);
    }
  });

  it("accepts worktree_preflight event (regression for gs-134)", () => {
    expect(isProgressEntry({ ...valid, event: "worktree_preflight" })).toBe(true);
  });

  it("rejects null, undefined, and non-objects", () => {
    expect(isProgressEntry(null)).toBe(false);
    expect(isProgressEntry(undefined)).toBe(false);
    expect(isProgressEntry("string")).toBe(false);
  });

  it("rejects invalid event type", () => {
    expect(isProgressEntry({ ...valid, event: "bogus_event" })).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const { timestamp: _, ...noTs } = valid;
    expect(isProgressEntry(noTs)).toBe(false);
  });

  it("rejects non-object data", () => {
    expect(isProgressEntry({ ...valid, data: "string" })).toBe(false);
    expect(isProgressEntry({ ...valid, data: null })).toBe(false);
    expect(isProgressEntry({ ...valid, data: [1, 2] })).toBe(false);
  });
});
