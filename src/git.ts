// GeneralStaff — git helpers
// Shared git utilities used across the dispatcher, session, and cycle modules.

import { spawnSync } from "child_process";
import { getRootDir } from "./state";

/** Resolves a commit SHA's subject line via `git log -1 --format=%s <sha>`.
 *  Returns "" for equal-SHA / empty-input / unresolvable-SHA. Swallows all
 *  errors — caller uses the return value to decide fallback display.
 *
 *  Retries once on empty result. Background: during the 2026-04-17 morning
 *  Ollama practice runs, the first cycle's subject resolution intermittently
 *  returned empty even though the commit was reachable and a later manual
 *  invocation with the same SHAs resolved correctly. Cause not nailed down;
 *  suspected Windows/Bun spawnSync timing race around a just-written merge.
 *  Retry hides the symptom and stderr capture gives future sessions a trail
 *  if the underlying cause resurfaces.
 */
export function fetchCommitSubject(startSha: string, endSha: string): string {
  if (!endSha || endSha === startSha) return "";

  let lastStderr = "";
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = spawnSync("git", ["log", "-1", "--format=%s", endSha], {
        cwd: getRootDir(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
      lastStatus = result.status;
      lastStderr = (result.stderr ?? "").toString().trim();
      if (result.status === 0) {
        const subject = (result.stdout ?? "").toString().trim();
        if (subject.length > 0) return subject;
      }
    } catch (err) {
      lastStderr = err instanceof Error ? err.message : String(err);
    }
  }

  // Both attempts failed. Leave a trail in stderr so future sessions that
  // hit this bug leave diagnostic evidence; writeDigest falls back to the
  // cycle_id display, so this is informational, not fatal.
  if (process.env.GENERALSTAFF_QUIET !== "1") {
    console.error(
      `[fetchCommitSubject] warning: could not resolve ${endSha.slice(0, 8)} ` +
        `after 2 attempts (status=${lastStatus}, stderr=${lastStderr.slice(0, 200)})`,
    );
  }
  return "";
}
