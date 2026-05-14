// GeneralStaff — pre-cycle advisor (gs-327, 2026-05-14)
//
// Optional advisor layer. When `project.advisor.enabled === true`, GS
// calls an external advisor (default: Hammerstein CLI) between picker
// and engineer with the proposed task plan + bounded cycle history.
// The verdict is logged to PROGRESS.jsonl as an `advisor_verdict`
// event. With `gate: true`, a `block` verdict skips the cycle
// (`cycle_skipped`, reason `advisor_gated`).
//
// Hammerstein-audit-reviewed (2026-05-14 home-PC) with adjustments
// landed: history capped at 3 cycles, multi-provider abstraction
// deferred to v2, gate is a strict project-level Boolean, fixed
// verdict schema, latency-bounded.
//
// Design constraints:
//   - Zero overhead when advisor.enabled === false (cheap early return).
//   - No fallback inference: if h CLI is missing, error out with a
//     clear message rather than silently no-op'ing.
//   - Verdict parsing is best-effort regex on the "Recommendation:"
//     line; malformed output → `verdict: "error"`, proceed.
//   - Latency-bounded by `timeout_seconds` (default 90s).

import { $ } from "bun";
import type {
  AdvisorConfig,
  AdvisorVerdict,
  AdvisorVerdictKind,
  ProjectConfig,
} from "./types";

const DEFAULT_TIMEOUT_SEC = 90;
const DEFAULT_HISTORY_CYCLES = 3;

interface AdvisorContext {
  taskTitle: string;
  taskBody: string;
  handsOff: string[];
  recentCycles: Array<{
    cycle_id: string;
    outcome: string;
    cycle_ts: string;
    summary?: string;
  }>;
}

/** Build the plain-text plan to send to the advisor.
 *
 * Bounded: caps recent cycle entries at `history_cycles` (default 3).
 * Avoids dumping full prompts/diffs — only metadata + summaries.
 */
export function buildAdvisorPlan(
  project: ProjectConfig,
  context: AdvisorContext,
): string {
  const lines: string[] = [
    `Pre-cycle audit for GeneralStaff project: ${project.id}`,
    "",
    `## Proposed task`,
    `Title: ${context.taskTitle}`,
    "",
    "Body:",
    context.taskBody.trim() || "(no body)",
    "",
    `## Project hands_off (paths the bot cannot touch)`,
    project.hands_off.length > 0
      ? project.hands_off.map((p) => `- ${p}`).join("\n")
      : "(none)",
    "",
    `## Recent cycle history (last ${context.recentCycles.length})`,
  ];

  if (context.recentCycles.length === 0) {
    lines.push("(no prior cycles)");
  } else {
    for (const c of context.recentCycles) {
      lines.push(
        `- ${c.cycle_ts} ${c.cycle_id} → ${c.outcome}` +
          (c.summary ? `: ${c.summary}` : ""),
      );
    }
  }

  lines.push(
    "",
    `## Audit ask`,
    `Is this task scope likely to land cleanly without scope drift, hands_off violations, or stupid-industrious work?`,
    `If not, what should be revised or blocked?`,
  );

  return lines.join("\n");
}

/** Parse advisor free-text output into a structured verdict.
 *
 * Heuristic: look for a "Recommendation:" line in the output. Hammerstein
 * CLI's audit-this-plan template emits this consistently. Map common
 * recommendation phrasings to the AdvisorVerdictKind enum.
 *
 * Returns `verdict: "error"` if no recommendation line found OR the
 * phrasing doesn't map cleanly. Caller's policy: error proceeds with
 * the cycle (advisory) or skips (gated).
 */
export function parseAdvisorOutput(raw: string): {
  verdict: AdvisorVerdictKind;
  reason: string;
} {
  // Strip markdown emphasis around the recommendation header / value.
  const recLine = raw
    .split(/\r?\n/)
    .find((line) => /\*?\*?Recommendation:?\*?\*?/i.test(line));

  if (!recLine) {
    return {
      verdict: "error",
      reason: "advisor output missing Recommendation: line",
    };
  }

  // Extract the verdict phrasing after the label
  const m = recLine.match(/Recommendation:?\s*\*?\*?\s*(.+?)\s*\*?\*?$/i);
  const phrasing = (m?.[1] ?? recLine).toLowerCase();

  let verdict: AdvisorVerdictKind = "error";
  if (/\bblock\b|\bdon'?t ship\b|\bdo not ship\b|\bdo not proceed\b/i.test(phrasing)) {
    verdict = "block";
  } else if (/\brevise\b|\brewrite\b|\breconsider\b|\bre-?scope\b/i.test(phrasing)) {
    verdict = "revise";
  } else if (
    /\bship\b|\bproceed\b|\bgo\b|\bclear\b|\bgreen[- ]light\b/i.test(phrasing)
  ) {
    verdict = "proceed";
  }

  // Pull a Plain English summary if present, else use the recommendation line.
  const summary = raw
    .split(/\r?\n/)
    .find((line) => /Plain English summary:/i.test(line));
  const reason = summary
    ? summary.replace(/^\*+Plain English summary:?\*+\s*/i, "").trim()
    : recLine.trim();

  return { verdict, reason };
}

/** Resolve the `h` CLI path. Returns null if not found.
 *
 * Windows installs `h.cmd` (a batch wrapper) into ~/.local/bin or similar.
 * Unix installs `h` directly. We don't enforce a specific install path;
 * `which`/`where` in PATH is the contract.
 */
async function resolveHCli(): Promise<string | null> {
  const isWin = process.platform === "win32";
  const probe = isWin ? "where" : "which";
  const candidates = isWin ? ["h.cmd", "h"] : ["h"];
  for (const name of candidates) {
    const proc = await $`${probe} ${name}`.nothrow().quiet();
    if (proc.exitCode === 0) {
      const path = proc.stdout.toString().trim().split(/\r?\n/)[0];
      if (path) return path;
    }
  }
  return null;
}

/** Run the advisor against a constructed plan. */
export async function runAdvisor(
  plan: string,
  config: AdvisorConfig,
): Promise<AdvisorVerdict> {
  const ts = new Date().toISOString();
  const provider = config.provider ?? "hammerstein";
  const timeoutSec = config.timeout_seconds ?? DEFAULT_TIMEOUT_SEC;
  const startedAt = Date.now();

  if (provider !== "hammerstein") {
    return {
      verdict: "error",
      reason: `advisor provider '${provider}' not supported in v1 (only 'hammerstein')`,
      duration_sec: 0,
      provider,
      ts,
    };
  }

  const hPath = await resolveHCli();
  if (!hPath) {
    return {
      verdict: "error",
      reason:
        "Hammerstein CLI (`h`) not found on PATH. Install from github.com/lerugray/hammerstein or set advisor.enabled to false.",
      duration_sec: 0,
      provider,
      ts,
    };
  }

  // Spawn h CLI with timeout. Bun.$ doesn't directly support timeout —
  // race against a timeout Promise.
  const audit = $`${hPath} audit ${plan}`.nothrow().quiet();
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutSec * 1000),
  );

  const result = await Promise.race([audit, timeout]);
  const duration_sec = (Date.now() - startedAt) / 1000;

  if (result === "timeout") {
    return {
      verdict: "timeout",
      reason: `advisor exceeded ${timeoutSec}s timeout`,
      duration_sec,
      provider,
      ts,
    };
  }

  const raw =
    result.stdout.toString() + (result.stderr ? result.stderr.toString() : "");

  if (result.exitCode !== 0) {
    return {
      verdict: "error",
      reason: `advisor exited ${result.exitCode}: ${raw.slice(-300)}`,
      raw_output: raw,
      duration_sec,
      provider,
      ts,
    };
  }

  const parsed = parseAdvisorOutput(raw);
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    raw_output: raw,
    duration_sec,
    provider,
    ts,
  };
}

/** Apply advisor defaults to a project config. */
export function normalizeAdvisorConfig(
  cfg: AdvisorConfig | undefined,
): AdvisorConfig | null {
  if (!cfg || !cfg.enabled) return null;
  return {
    enabled: true,
    gate: cfg.gate ?? false,
    provider: cfg.provider ?? "hammerstein",
    timeout_seconds: cfg.timeout_seconds ?? DEFAULT_TIMEOUT_SEC,
    history_cycles: cfg.history_cycles ?? DEFAULT_HISTORY_CYCLES,
  };
}
