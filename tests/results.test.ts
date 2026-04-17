import { describe, expect, it } from "bun:test";
import { categorizeResults } from "../src/results";
import type { CycleResult, CycleOutcome } from "../src/types";

function mkResult(id: string, outcome: CycleOutcome): CycleResult {
  return {
    cycle_id: id,
    project_id: "p",
    started_at: "2026-04-17T00:00:00Z",
    ended_at: "2026-04-17T00:01:00Z",
    cycle_start_sha: "a".repeat(40),
    cycle_end_sha: "b".repeat(40),
    engineer_exit_code: 0,
    verification_outcome: "passed",
    reviewer_verdict: outcome === "cycle_skipped" ? "verified" : (outcome as any),
    final_outcome: outcome,
    reason: "ok",
  };
}

describe("categorizeResults", () => {
  it("returns empty buckets for empty input", () => {
    const out = categorizeResults([]);
    expect(out.verified).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it("places verified and verified_weak in the verified bucket", () => {
    const r1 = mkResult("c1", "verified");
    const r2 = mkResult("c2", "verified_weak");
    const out = categorizeResults([r1, r2]);
    expect(out.verified).toEqual([r1, r2]);
    expect(out.failed).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it("places verification_failed in the failed bucket", () => {
    const r = mkResult("c1", "verification_failed");
    const out = categorizeResults([r]);
    expect(out.failed).toEqual([r]);
    expect(out.verified).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it("places cycle_skipped in the skipped bucket", () => {
    const r = mkResult("c1", "cycle_skipped");
    const out = categorizeResults([r]);
    expect(out.skipped).toEqual([r]);
    expect(out.verified).toEqual([]);
    expect(out.failed).toEqual([]);
  });

  it("partitions a mixed list and preserves order within each bucket", () => {
    const r1 = mkResult("c1", "verified");
    const r2 = mkResult("c2", "cycle_skipped");
    const r3 = mkResult("c3", "verification_failed");
    const r4 = mkResult("c4", "verified_weak");
    const r5 = mkResult("c5", "cycle_skipped");
    const r6 = mkResult("c6", "verification_failed");
    const out = categorizeResults([r1, r2, r3, r4, r5, r6]);
    expect(out.verified).toEqual([r1, r4]);
    expect(out.failed).toEqual([r3, r6]);
    expect(out.skipped).toEqual([r2, r5]);
  });

  it("handles a list of all the same outcome", () => {
    const all = [
      mkResult("c1", "verified"),
      mkResult("c2", "verified"),
      mkResult("c3", "verified"),
    ];
    const out = categorizeResults(all);
    expect(out.verified).toEqual(all);
    expect(out.failed).toEqual([]);
    expect(out.skipped).toEqual([]);
  });
});
