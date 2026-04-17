// GeneralStaff — git helpers
// Shared git utilities used across the dispatcher, session, and cycle modules.

import { spawnSync } from "child_process";
import { getRootDir } from "./state";

export function fetchCommitSubject(startSha: string, endSha: string): string {
  if (!endSha || endSha === startSha) return "";
  try {
    const result = spawnSync("git", ["log", "-1", "--format=%s", endSha], {
      cwd: getRootDir(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0) return "";
    return (result.stdout ?? "").toString().trim();
  } catch {
    return "";
  }
}
