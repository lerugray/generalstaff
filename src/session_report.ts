// Session-report analyzer: reads _fleet/PROGRESS.jsonl session_complete
// events and surfaces stop-reason distribution, avg duration and cycles
// per reason, and the empty-cycles ratio. The empty-cycles share is the
// load-bearing number for dispatcher health — it's the only stop reason
// where reseed-style behavior could plausibly extend useful work, so it
// deserves to be visible at a glance.
//
// gs-299: usage-budget sessions ("usage-budget" stop_reason) are surfaced
// distinctly from the wall-clock "budget" reason, and the optional
// consumption_summary payload (gs-298) is aggregated into per-bucket
// totals + a fleet-wide consumption summary so users can see what their
// budget config actually bought them.

import type { ProgressEntry } from "./types";
import { loadProgressEvents } from "./audit";

export interface StopReasonStats {
  reason: string;
  count: number;
  avg_duration_minutes: number;
  avg_cycles: number;
  avg_verified: number;
  avg_failed: number;
  // gs-299: consumption aggregates. Only counted from sessions whose
  // session_complete event carried a consumption_summary — older events
  // (pre-gs-298) don't contribute, and sessions with no reader
  // configured don't either. consumption_sessions records the
  // denominator so the UI can distinguish "zero spend" from "no data."
  consumption_sessions: number;
  sum_usd: number;
  sum_tokens: number;
}

export interface SessionReport {
  total_sessions: number;
  window_last_n: number | null;   // null when the report covers everything
  by_stop_reason: StopReasonStats[];
  // Extracted separately because they're the two most-actionable numbers.
  empty_cycles_share: number;     // fraction 0..1
  healthy_stop_share: number;     // budget + insufficient-budget + max-cycles + usage-budget
  // gs-299: fleet-wide consumption totals across every session in the
  // window that carried a consumption_summary. Zero-populated when no
  // session carried one (regression-safe for pre-gs-298 data).
  total_consumption_usd: number;
  total_consumption_tokens: number;
  consumption_sessions: number;
}

// gs-299: usage-budget joins the healthy-stop set. Hitting a usage
// cap is a clean, user-configured shutdown — same category as
// wall-clock budget or max-cycles, not a symptom of bot confusion.
const HEALTHY_REASONS = new Set([
  "budget",
  "insufficient-budget",
  "max-cycles",
  "usage-budget",
]);

interface ConsumptionSummaryLike {
  total_usd?: number;
  total_tokens?: number;
  cycles_used?: number;
  source?: string;
}

function parseSessionCompleteData(data: Record<string, unknown>): {
  stop_reason: string;
  duration: number;
  cycles: number;
  verified: number;
  failed: number;
  consumption: ConsumptionSummaryLike | null;
} {
  const raw = data.consumption_summary;
  let consumption: ConsumptionSummaryLike | null = null;
  if (raw && typeof raw === "object") {
    const c = raw as Record<string, unknown>;
    consumption = {
      total_usd: typeof c.total_usd === "number" ? c.total_usd : 0,
      total_tokens: typeof c.total_tokens === "number" ? c.total_tokens : 0,
      cycles_used: typeof c.cycles_used === "number" ? c.cycles_used : 0,
      source: typeof c.source === "string" ? c.source : undefined,
    };
  }
  return {
    stop_reason: (data.stop_reason as string | undefined) ?? "(missing)",
    duration: typeof data.duration_minutes === "number" ? data.duration_minutes : 0,
    cycles: typeof data.total_cycles === "number" ? data.total_cycles : 0,
    verified: typeof data.total_verified === "number" ? data.total_verified : 0,
    failed: typeof data.total_failed === "number" ? data.total_failed : 0,
    consumption,
  };
}

export async function buildSessionReport(
  options: { lastN?: number } = {},
): Promise<SessionReport> {
  const events = await loadProgressEvents(
    "_fleet",
    (e: ProgressEntry) => e.event === "session_complete",
  );

  // Most-recent N, ordered newest-last in the file (events are append-only).
  const selected =
    options.lastN !== undefined && options.lastN > 0
      ? events.slice(-options.lastN)
      : events;

  const buckets = new Map<
    string,
    {
      count: number;
      duration: number;
      cycles: number;
      verified: number;
      failed: number;
      consumption_sessions: number;
      sum_usd: number;
      sum_tokens: number;
    }
  >();

  let fleetUsd = 0;
  let fleetTokens = 0;
  let fleetConsumptionSessions = 0;

  for (const ev of selected) {
    const parsed = parseSessionCompleteData(ev.data);
    const b = buckets.get(parsed.stop_reason) ?? {
      count: 0,
      duration: 0,
      cycles: 0,
      verified: 0,
      failed: 0,
      consumption_sessions: 0,
      sum_usd: 0,
      sum_tokens: 0,
    };
    b.count += 1;
    b.duration += parsed.duration;
    b.cycles += parsed.cycles;
    b.verified += parsed.verified;
    b.failed += parsed.failed;
    if (parsed.consumption) {
      b.consumption_sessions += 1;
      b.sum_usd += parsed.consumption.total_usd ?? 0;
      b.sum_tokens += parsed.consumption.total_tokens ?? 0;
      fleetUsd += parsed.consumption.total_usd ?? 0;
      fleetTokens += parsed.consumption.total_tokens ?? 0;
      fleetConsumptionSessions += 1;
    }
    buckets.set(parsed.stop_reason, b);
  }

  const by_stop_reason: StopReasonStats[] = [];
  for (const [reason, b] of buckets) {
    by_stop_reason.push({
      reason,
      count: b.count,
      avg_duration_minutes: b.count > 0 ? b.duration / b.count : 0,
      avg_cycles: b.count > 0 ? b.cycles / b.count : 0,
      avg_verified: b.count > 0 ? b.verified / b.count : 0,
      avg_failed: b.count > 0 ? b.failed / b.count : 0,
      consumption_sessions: b.consumption_sessions,
      sum_usd: b.sum_usd,
      sum_tokens: b.sum_tokens,
    });
  }
  // Descending by count so the most-common stop reason leads.
  by_stop_reason.sort((a, b) => b.count - a.count);

  const total = selected.length;
  const emptyCount = buckets.get("empty-cycles")?.count ?? 0;
  const healthyCount = [...HEALTHY_REASONS].reduce(
    (sum, r) => sum + (buckets.get(r)?.count ?? 0),
    0,
  );

  return {
    total_sessions: total,
    window_last_n: options.lastN ?? null,
    by_stop_reason,
    empty_cycles_share: total > 0 ? emptyCount / total : 0,
    healthy_stop_share: total > 0 ? healthyCount / total : 0,
    total_consumption_usd: fleetUsd,
    total_consumption_tokens: fleetTokens,
    consumption_sessions: fleetConsumptionSessions,
  };
}

export function formatSessionReport(report: SessionReport): string {
  const lines: string[] = [];
  const windowLabel =
    report.window_last_n !== null ? ` (last ${report.window_last_n})` : "";
  lines.push(`Session report: ${report.total_sessions} sessions${windowLabel}`);
  lines.push("");

  if (report.total_sessions === 0) {
    lines.push("  (no session_complete events recorded yet)");
    return lines.join("\n") + "\n";
  }

  lines.push(
    "  reason                   count   avg_min   avg_cyc   avg_verif   avg_fail",
  );
  lines.push(
    "  ---------------------   -----   -------   -------   ---------   --------",
  );
  for (const row of report.by_stop_reason) {
    // gs-299: usage-budget rows get a "$" marker so the user can scan
    // the table and immediately see which stops were driven by the
    // consumption cap (vs. wall-clock "budget" which is visually
    // similar but semantically unrelated).
    const marker = row.reason === "usage-budget" ? "$" : " ";
    const label = `${marker}${row.reason}`;
    lines.push(
      `  ${label.padEnd(21)}   ${String(row.count).padStart(5)}   ` +
        `${row.avg_duration_minutes.toFixed(1).padStart(7)}   ` +
        `${row.avg_cycles.toFixed(1).padStart(7)}   ` +
        `${row.avg_verified.toFixed(1).padStart(9)}   ` +
        `${row.avg_failed.toFixed(1).padStart(8)}`,
    );
  }

  lines.push("");
  lines.push(
    `  Empty-cycles share: ${(report.empty_cycles_share * 100).toFixed(1)}%` +
      "   (sessions that hit the 3-consecutive-empty guard)",
  );
  lines.push(
    `  Healthy-stop share: ${(report.healthy_stop_share * 100).toFixed(1)}%` +
      "   (budget / insufficient-budget / max-cycles / usage-budget)",
  );

  // gs-299: consumption block. Only rendered when at least one session
  // in the window carried a consumption_summary. Pre-gs-298 data is
  // silently absent here — no misleading "$0.00 spent" when the real
  // answer is "we don't know."
  if (report.consumption_sessions > 0) {
    lines.push("");
    lines.push(
      `  Consumption: $${report.total_consumption_usd.toFixed(2)} / ` +
        `${report.total_consumption_tokens.toLocaleString()} tokens ` +
        `across ${report.consumption_sessions} session(s) with data`,
    );
    // Per-bucket consumption breakdown for buckets that carry any data.
    // Keeps the table above lean (adding two more columns makes the
    // numeric column alignment painful to read) while still giving the
    // user a per-reason view of where spend landed.
    const bucketsWithData = report.by_stop_reason.filter(
      (r) => r.consumption_sessions > 0,
    );
    for (const row of bucketsWithData) {
      const marker = row.reason === "usage-budget" ? "$" : " ";
      lines.push(
        `    ${marker}${row.reason.padEnd(20)} ` +
          `$${row.sum_usd.toFixed(2).padStart(7)}   ` +
          `${row.sum_tokens.toLocaleString().padStart(12)} tokens   ` +
          `(${row.consumption_sessions}/${row.count} with data)`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
