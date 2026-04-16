// GeneralStaff — clean command
// Remove stale worktrees and prune old cycle artifacts

import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import { getRootDir } from "./state";
import { loadProjects } from "./projects";

export async function runClean(
  keepCycles: number = 20,
  logDays: number = 30,
) {
  const projects = await loadProjects();
  const root = getRootDir();
  let cleaned = 0;

  // 1. Clean stale worktrees for each project
  for (const p of projects) {
    const wt = join(p.path, ".bot-worktree");
    if (existsSync(wt)) {
      try {
        await $`git -C ${p.path} worktree remove ${wt} --force`.quiet().nothrow();
      } catch { /* ignore */ }
      if (existsSync(wt)) {
        rmSync(wt, { recursive: true, force: true });
      }
      console.log(`  Removed stale worktree: ${wt}`);
      cleaned++;
    }
  }

  // 2. Rotate old log files in <root>/logs (older than logDays)
  const logsDir = join(root, "logs");
  if (existsSync(logsDir)) {
    const cutoffMs = Date.now() - logDays * 86_400_000;
    let deletedLogs = 0;
    for (const f of readdirSync(logsDir)) {
      const full = join(logsDir, f);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoffMs) {
        try {
          rmSync(full, { force: true });
          deletedLogs++;
        } catch { /* ignore */ }
      }
    }
    if (deletedLogs > 0) {
      console.log(
        `  Deleted ${deletedLogs} log file(s) older than ${logDays} day(s)`,
      );
      cleaned += deletedLogs;
    }
  }

  // 3. Prune old cycle directories (keep last N per project)
  const stateDir = join(root, "state");
  if (!existsSync(stateDir)) {
    if (cleaned === 0) console.log("Nothing to clean.");
    return;
  }

  for (const dir of readdirSync(stateDir)) {
    const cyclesDir = join(stateDir, dir, "cycles");
    if (!existsSync(cyclesDir)) continue;

    const cycles = readdirSync(cyclesDir)
      .filter((f) => {
        const full = join(cyclesDir, f);
        return statSync(full).isDirectory();
      })
      .sort(); // cycle IDs are timestamp-based, so sort = chronological

    if (cycles.length <= keepCycles) continue;

    const toRemove = cycles.slice(0, cycles.length - keepCycles);
    for (const c of toRemove) {
      rmSync(join(cyclesDir, c), { recursive: true, force: true });
      cleaned++;
    }
    console.log(
      `  Pruned ${toRemove.length} old cycle(s) from ${dir} (kept last ${keepCycles})`,
    );
  }

  if (cleaned === 0) {
    console.log("Nothing to clean.");
  } else {
    console.log(`\nCleaned ${cleaned} item(s).`);
  }
}
