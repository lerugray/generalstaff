// GeneralStaff — Phase 6 route handler: GET /project/:id (gs-283).
//
// Server-renders a per-project dashboard page: pending task list,
// recent dispatch outcomes, and verification pass-rate. Returns a
// 404 Response when the project id is not registered in projects.yaml.
// Follows gs-269's pattern: wraps child HTML in layout() from
// ../templates/layout and is mounted from src/server.ts.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadProjects, findProject } from "../../projects";
import {
  getProjectTaskQueue,
  type TaskQueueEntry,
} from "../../views/task_queue";
import { isProgressEntry } from "../../types";
import { layout } from "../templates/layout";

const RECENT_CYCLES_CAP = 10;

interface RecentDispatch {
  cycle_id: string | null;
  ended_at: string;
  outcome: string;
  task_id: string | null;
  duration_seconds: number | null;
}

interface ProjectStats {
  recent: RecentDispatch[];
  verified: number;
  failed: number;
  total: number;
  pass_rate: number | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readProjectStats(projectPath: string, projectId: string): Promise<ProjectStats> {
  const path = join(projectPath, "state", projectId, "PROGRESS.jsonl");
  const stats: ProjectStats = {
    recent: [],
    verified: 0,
    failed: 0,
    total: 0,
    pass_rate: null,
  };
  if (!existsSync(path)) return stats;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return stats;
  }
  const cycleEnds: RecentDispatch[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isProgressEntry(parsed) || parsed.event !== "cycle_end") continue;
    const outcome = typeof parsed.data.outcome === "string" ? parsed.data.outcome : "unknown";
    stats.total += 1;
    if (outcome === "verified" || outcome === "verified_weak") {
      stats.verified += 1;
    } else if (outcome === "verification_failed") {
      stats.failed += 1;
    }
    const duration =
      typeof parsed.data.duration_seconds === "number" && Number.isFinite(parsed.data.duration_seconds)
        ? parsed.data.duration_seconds
        : null;
    const taskId = typeof parsed.data.task_id === "string" ? parsed.data.task_id : null;
    cycleEnds.push({
      cycle_id: parsed.cycle_id ?? null,
      ended_at: parsed.timestamp,
      outcome,
      task_id: taskId,
      duration_seconds: duration,
    });
  }
  const denom = stats.verified + stats.failed;
  stats.pass_rate = denom === 0 ? null : stats.verified / denom;
  stats.recent = cycleEnds
    .slice()
    .reverse()
    .slice(0, RECENT_CYCLES_CAP);
  return stats;
}

function renderTaskList(title: string, entries: TaskQueueEntry[]): string {
  if (entries.length === 0) {
    return `<h3>${escapeHtml(title)}</h3><p class="empty">None.</p>`;
  }
  const items = entries
    .map((e) => {
      const priority = `<span class="task-priority">P${e.priority}</span>`;
      const idEscaped = escapeHtml(e.id);
      const titleEscaped = escapeHtml(e.title);
      const blocked = e.block_reason
        ? ` <span class="task-blocked">[${escapeHtml(e.block_reason)}]</span>`
        : "";
      return `<li><code>${idEscaped}</code> ${priority} ${titleEscaped}${blocked}</li>`;
    })
    .join("");
  return `<h3>${escapeHtml(title)} (${entries.length})</h3><ul class="task-list">${items}</ul>`;
}

function renderRecentDispatches(recent: RecentDispatch[]): string {
  if (recent.length === 0) {
    return `<p class="empty">No cycles recorded yet.</p>`;
  }
  const rows = recent
    .map((r) => {
      const cycleCell = r.cycle_id
        ? `<a href="/cycle/${escapeHtml(r.cycle_id)}"><code>${escapeHtml(r.cycle_id)}</code></a>`
        : "<code>unknown</code>";
      const task = r.task_id ? `<code>${escapeHtml(r.task_id)}</code>` : "—";
      const dur = r.duration_seconds !== null ? `${r.duration_seconds}s` : "—";
      const outcomeClass = r.outcome === "verified" || r.outcome === "verified_weak"
        ? "outcome-verified"
        : "outcome-failed";
      return `<tr>
<td>${cycleCell}</td>
<td>${escapeHtml(r.ended_at)}</td>
<td class="${outcomeClass}">${escapeHtml(r.outcome)}</td>
<td>${task}</td>
<td>${dur}</td>
</tr>`;
    })
    .join("");
  return `<table class="dispatch-table">
<thead><tr><th>Cycle</th><th>Ended</th><th>Outcome</th><th>Task</th><th>Duration</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderPassRate(stats: ProjectStats): string {
  if (stats.pass_rate === null) {
    return `<p class="empty">No verified/failed cycles yet (total: ${stats.total}).</p>`;
  }
  const pct = (stats.pass_rate * 100).toFixed(1);
  return `<p>
<strong>${escapeHtml(pct)}%</strong> verification pass rate
(${stats.verified} verified / ${stats.failed} failed / ${stats.total} total cycles)
</p>`;
}

export async function renderProjectPage(projectId: string): Promise<{ status: 200 | 404; html: string }> {
  const projects = await loadProjects();
  const project = findProject(projects, projectId);
  if (!project) {
    const body = `<section class="panel" aria-labelledby="not-found-heading">
<h2 id="not-found-heading">Project not found</h2>
<p>No project registered with id <code>${escapeHtml(projectId)}</code> in <code>projects.yaml</code>.</p>
<p><a href="/">← Back to fleet</a></p>
</section>`;
    return {
      status: 404,
      html: layout({
        title: `GeneralStaff — ${projectId} (not found)`,
        body,
      }),
    };
  }

  const [queue, stats] = await Promise.all([
    getProjectTaskQueue(projectId),
    readProjectStats(project.path, projectId),
  ]);

  const safeId = escapeHtml(project.id);
  const body = `<section class="panel" aria-labelledby="project-heading">
<h2 id="project-heading">Project: ${safeId}</h2>
<dl class="project-meta">
<dt>Priority</dt><dd>${project.priority}</dd>
<dt>Branch</dt><dd><code>${escapeHtml(project.branch)}</code></dd>
<dt>Auto-merge</dt><dd>${project.auto_merge ? "enabled" : "off"}</dd>
</dl>
</section>
<section class="panel" aria-labelledby="verification-heading">
<h2 id="verification-heading">Verification</h2>
${renderPassRate(stats)}
</section>
<section class="panel" aria-labelledby="tasks-heading">
<h2 id="tasks-heading">Task queue</h2>
${renderTaskList("In flight", queue.in_flight)}
${renderTaskList("Ready (bot-pickable)", queue.ready)}
${renderTaskList("Blocked", queue.blocked)}
</section>
<section class="panel" aria-labelledby="dispatches-heading">
<h2 id="dispatches-heading">Recent dispatches</h2>
${renderRecentDispatches(stats.recent)}
</section>`;

  return {
    status: 200,
    html: layout({
      title: `GeneralStaff — ${project.id}`,
      activeNav: "fleet",
      body,
    }),
  };
}
