// gs-306 smoke test: invoke runMissionSwarmPreview end-to-end against
// the live mission-swarm repo + OpenRouter, verify cache writes, then
// run a second call to verify the cache hit short-circuits the spawn.
//
// Prerequisites:
//   - MISSIONSWARM_ROOT points at a working mission-swarm clone
//   - OPENROUTER_API_KEY is set in env
//   - MISSIONSWARM_LLM_MODEL set OR pass a default below
//
// Run from the GS repo root:
//   MISSIONSWARM_ROOT=../mission-swarm \
//   MISSIONSWARM_LLM_MODEL=anthropic/claude-sonnet-4-6 \
//   OPENROUTER_API_KEY=sk-or-... \
//   bun scripts/smoke-missionswarm-hook.ts
//
// This script is diagnostic only — not wired into the CLI.

import { rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMissionSwarmPreview } from "../src/integrations/mission_swarm/hook";
import type {
  GreenfieldTask,
  ProjectConfig,
} from "../src/types";

async function main(): Promise<number> {
  const root = process.env.MISSIONSWARM_ROOT;
  if (!root) {
    console.error("MISSIONSWARM_ROOT is required");
    return 1;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is required (BYOK)");
    return 1;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cacheDir = join(tmpdir(), `gs-ms-smoke-${stamp}`);

  const task: GreenfieldTask = {
    id: "wdb-smoke-001",
    title: "Launch WDB hardcopy at $20 with a draft README framing: 'by a game designer, not venture capital' — a book about designing wargames for a community that's already reading Perla, Cole, and Dunnigan.",
    status: "pending",
    priority: 1,
  };

  const project: ProjectConfig = {
    id: "wargame-design-book-smoke",
    path: "/tmp/wdb-smoke",
    priority: 1,
    engineer_command: "claude",
    verification_command: "true",
    cycle_budget_minutes: 10,
    work_detection: "tasks_json",
    concurrency_detection: "worktree",
    branch: "master",
    auto_merge: false,
    hands_off: [],
    missionswarm: {
      default_audience: "gaming-community",
      n_agents: 2,
      n_rounds: 1,
    },
  };

  console.log(`[smoke] MISSIONSWARM_ROOT=${root}`);
  console.log(`[smoke] cache dir: ${cacheDir}`);
  console.log(`[smoke] task: ${task.id}`);
  console.log(`[smoke] audience: ${project.missionswarm!.default_audience}`);
  console.log(`[smoke] agents x rounds: ${project.missionswarm!.n_agents} x ${project.missionswarm!.n_rounds}`);
  console.log("");
  console.log("[smoke] first run (expect spawn + cache write)...");
  const t0 = Date.now();
  const r1 = await runMissionSwarmPreview(task, project, {
    cacheDir,
    missionswarmRoot: root,
  });
  const dt1 = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`[smoke] first run: ${dt1}s, cacheHit=${r1.cacheHit}, skipped=${r1.skipped}, skipReason=${r1.skipReason ?? "-"}`);
  if (r1.summary) {
    console.log("");
    console.log("--- summary (truncated to 800 chars) ---");
    console.log(r1.summary.slice(0, 800));
    if (r1.summary.length > 800) console.log(`[... truncated from ${r1.summary.length} chars]`);
    console.log("--- end summary ---");
  }

  if (!r1.summary) {
    console.error(`[smoke] first run did not produce a summary (skipReason=${r1.skipReason})`);
    return 2;
  }

  console.log("");
  console.log("[smoke] second run (expect cache hit, no spawn)...");
  const t1 = Date.now();
  const r2 = await runMissionSwarmPreview(task, project, {
    cacheDir,
    missionswarmRoot: root,
  });
  const dt2 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`[smoke] second run: ${dt2}s, cacheHit=${r2.cacheHit}, skipped=${r2.skipped}`);
  if (!r2.cacheHit) {
    console.error("[smoke] second run was NOT a cache hit — integration is broken");
    return 3;
  }

  console.log("");
  console.log("[smoke] PASS: subprocess fired, summary rendered, cache round-tripped.");
  console.log(`[smoke] cache left at ${cacheDir} — delete manually or re-run; tmpdir cleanup is OS-managed.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[smoke] uncaught:", err);
    process.exit(99);
  },
);
