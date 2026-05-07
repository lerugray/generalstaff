// GeneralStaff — inventory audit (gs-324)
// Scans every registered project's tasks.json, counts bot-pickable tasks,
// and produces a per-project breakdown with distribution tags. Used as a
// pre-flight before dispatcher sessions to surface inventory starvation
// before cycles burn budget on verified_weak empty-diff outcomes.

import { loadProjects } from "./projects";
import { loadTasks, botPickableTasks } from "./tasks";
import type { ProjectConfig } from "./types";

export interface InventoryRow {
  project_id: string;
  total: number;
  pending: number;
  bot_pickable: number;
  /** Tasks in partial-done state (status === "done" but marked with cursor/work note) — counted as done. */
  partial_done: number;
  /** Tag: bot-rich (>=3 bot-pickable), bot-light (1-2), interactive-only (pending > 0, bot=0), done (pending = 0). */
  tag: "bot-rich" | "bot-light" | "interactive-only" | "done";
}

export interface InventoryAudit {
  projects: InventoryRow[];
  summary: {
    total_projects: number;
    bot_rich: number;
    bot_light: number;
    interactive_only: number;
    done: number;
    /** Total bot-pickable tasks across the fleet. */
    fleet_bot_pickable: number;
  };
}

/** Assign a tag based on bot-pickable and pending counts. */
function tag(row: Omit<InventoryRow, "tag">): InventoryRow["tag"] {
  if (row.pending === 0) return "done";
  if (row.bot_pickable >= 3) return "bot-rich";
  if (row.bot_pickable >= 1) return "bot-light";
  return "interactive-only";
}

/** Build inventory audit across all registered projects. */
export async function buildInventoryAudit(
  projects?: ProjectConfig[],
): Promise<InventoryAudit> {
  const projectList = projects ?? (await loadProjects());
  const rows: InventoryRow[] = [];

  for (const p of projectList) {
    let total = 0;
    let pending = 0;
    let botPickable = 0;
    let partialDone = 0;

    try {
      const tasks = await loadTasks(p.id);
      total = tasks.length;
      pending = tasks.filter((t) => t.status === "pending").length;
      botPickable = botPickableTasks(tasks, p.hands_off).length;
      // Partial-done: tasks marked done that carry a _partial_done_note marker.
      partialDone = tasks.filter(
        (t) =>
          t.status === "done" &&
          (t as unknown as Record<string, unknown>)._partial_done_note !== undefined,
      ).length;
    } catch {
      // Project may not have a tasks.json yet — treat as zero-task.
    }

    const row: Omit<InventoryRow, "tag"> = {
      project_id: p.id,
      total,
      pending,
      bot_pickable: botPickable,
      partial_done: partialDone,
    };

    rows.push({ ...row, tag: tag(row) });
  }

  // Sort: bot-rich first, then bot-light, then interactive-only, then done.
  // Within each group, sort by bot_pickable descending.
  const tagOrder: Record<InventoryRow["tag"], number> = {
    "bot-rich": 0,
    "bot-light": 1,
    "interactive-only": 2,
    done: 3,
  };
  rows.sort((a, b) => {
    const d = tagOrder[a.tag] - tagOrder[b.tag];
    if (d !== 0) return d;
    return b.bot_pickable - a.bot_pickable;
  });

  const summary = {
    total_projects: rows.length,
    bot_rich: rows.filter((r) => r.tag === "bot-rich").length,
    bot_light: rows.filter((r) => r.tag === "bot-light").length,
    interactive_only: rows.filter((r) => r.tag === "interactive-only").length,
    done: rows.filter((r) => r.tag === "done").length,
    fleet_bot_pickable: rows.reduce((sum, r) => sum + r.bot_pickable, 0),
  };

  return { projects: rows, summary };
}

/** Format the audit as a human-readable table with distribution summary. */
export function formatInventoryAudit(audit: InventoryAudit): string {
  const lines: string[] = [];
  lines.push("=== Inventory Audit ===\n");

  // Per-project table
  const col = { id: 20, total: 6, pending: 8, bot: 13, partial: 8, tag: 18 };
  const pad = (s: string, w: number) => s.padEnd(w);

  lines.push(
    pad("Project", col.id) +
      pad("Total", col.total) +
      pad("Pending", col.pending) +
      pad("Bot-pickable", col.bot) +
      pad("Part.done", col.partial) +
      "Tag",
  );
  lines.push(
    "-".repeat(col.id + col.total + col.pending + col.bot + col.partial + col.tag),
  );

  for (const r of audit.projects) {
    const tagStr =
      r.tag === "bot-rich" ? "bot-rich" :
      r.tag === "bot-light" ? "bot-light" :
      r.tag === "interactive-only" ? "interactive-only" :
      "done (no pending)";
    lines.push(
      pad(r.project_id.slice(0, col.id), col.id) +
        pad(String(r.total), col.total) +
        pad(String(r.pending), col.pending) +
        pad(String(r.bot_pickable), col.bot) +
        pad(String(r.partial_done), col.partial) +
        tagStr,
    );
  }

  // Distribution summary
  lines.push("");
  lines.push("=== Distribution ===");
  lines.push(`Bot-rich (>=3 bot-pickable):   ${audit.summary.bot_rich}`);
  lines.push(`Bot-light (1-2 bot-pickable):  ${audit.summary.bot_light}`);
  lines.push(`Interactive-only:              ${audit.summary.interactive_only}`);
  lines.push(`Done (no pending):             ${audit.summary.done}`);
  lines.push(`Total bot-pickable fleet-wide: ${audit.summary.fleet_bot_pickable}`);

  // Recommendations
  lines.push("");
  if (audit.summary.fleet_bot_pickable === 0) {
    lines.push(
      "⚠  Zero bot-pickable tasks across the fleet. A bot session would produce only verified_weak cycles.",
    );
    lines.push(
      "   File mechanical tasks on active projects, or run interactive sessions only.",
    );
  } else if (audit.summary.fleet_bot_pickable <= 3) {
    lines.push(
      `⚠  Only ${audit.summary.fleet_bot_pickable} bot-pickable task(s) — thin inventory.`,
    );
    lines.push(
      "   Consider a short session (--max-cycles=2) or filing more mechanical work.",
    );
  }

  return lines.join("\n");
}
