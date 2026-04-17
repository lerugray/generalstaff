import type { CycleResult } from "./types";

export interface CategorizedResults {
  verified: CycleResult[];
  failed: CycleResult[];
  skipped: CycleResult[];
}

// verified_weak counts as verified, matching the convention used across
// session.ts, summary.ts, and the digest.
export function categorizeResults(results: CycleResult[]): CategorizedResults {
  const verified: CycleResult[] = [];
  const failed: CycleResult[] = [];
  const skipped: CycleResult[] = [];
  for (const r of results) {
    switch (r.final_outcome) {
      case "verified":
      case "verified_weak":
        verified.push(r);
        break;
      case "verification_failed":
        failed.push(r);
        break;
      case "cycle_skipped":
        skipped.push(r);
        break;
    }
  }
  return { verified, failed, skipped };
}
