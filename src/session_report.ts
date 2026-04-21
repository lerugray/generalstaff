// Session-report analyzer: reads _fleet/PROGRESS.jsonl session_complete
// events and surfaces stop-reason distribution, avg duration and cycles
// per reason, and the empty-cycles ratio. The empty-cycles share is the
// load-bearing number for dispatcher health — it's the only stop reason
// where reseed-style behavior could plausibly extend useful work, so it
// deserves to be visible at a glance.

import type { ProgressEntry } from "./types";
import { loadProgressEvents } from "./audit";

export interface StopReasonStats {
  reason: string;
  count: number;
  avg_duration_minutes: number;
  avg_cycles: number;
  avg_verified: number;
  avg_failed: number;
}

export interface SessionReport {
  total_sessions: number;
  window_last_n: number | null;   // null when the report covers everything
  by_stop_reason: StopReasonStats[];
  // Extracted separately because they're the two most-actionable numbers.
  empty_cycles_share: number;     // fraction 0..1
  healthy_stop_share: number;     // budget + insufficient-budget + max-cycles
}

const HEALTHY_REASONS = new Set([
  "budget",
  "insufficient-budget",
  "max-cycles",
]);

function parseSessionCompleteData(data: Record<string, unknown>): {
  stop_reason: string;
  duration: number;
  cycles: number;
  verified: number;
  failed: number;
} {
  return {
    stop_reason: (data.stop_reason as string | undefined) ?? "(missing)",
    duration: typeof data.duration_minutes === "number" ? data.duration_minutes : 0,
    cycles: typeof data.total_cycles === "number" ? data.total_cycles : 0,
    verified: typeof data.total_verified === "number" ? data.total_verified : 0,
    failed: typeof data.total_failed === "number" ? data.total_failed : 0,
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
    }
  >();

  for (const ev of selected) {
    const parsed = parseSessionCompleteData(ev.data);
    const b = buckets.get(parsed.stop_reason) ?? {
      count: 0,
      duration: 0,
      cycles: 0,
      verified: 0,
      failed: 0,
    };
    b.count += 1;
    b.duration += parsed.duration;
    b.cycles += parsed.cycles;
    b.verified += parsed.verified;
    b.failed += parsed.failed;
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
    lines.push(
      `  ${row.reason.padEnd(21)}   ${String(row.count).padStart(5)}   ` +
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
      "   (budget / insufficient-budget / max-cycles)",
  );

  return lines.join("\n") + "\n";
}
