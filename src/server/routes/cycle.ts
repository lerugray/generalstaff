// GeneralStaff — Phase 6 route handler: GET /cycle/:cycleId (gs-284).
//
// Server-renders a single-cycle drill-down page. Reads the per-cycle
// record assembled by src/views/dispatch_detail.ts and emits a
// summary header + sections for engineer, verification, review, and
// diff stats. Returns 404 when the cycle id is unknown. Follows
// gs-269's layout() pattern; mounted from src/server.ts.

import {
  getDispatchDetail,
  DispatchDetailError,
  type DispatchDetailData,
  type DispatchPhase,
  type DispatchFile,
  type DispatchCheck,
} from "../../views/dispatch_detail";
import { layout } from "../templates/layout";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPhase(label: string, phase: DispatchPhase): string {
  const rows: string[] = [];
  if (phase.started_at) {
    rows.push(`<dt>Started</dt><dd>${escapeHtml(phase.started_at)}</dd>`);
  }
  if (phase.ended_at) {
    rows.push(`<dt>Ended</dt><dd>${escapeHtml(phase.ended_at)}</dd>`);
  }
  if (phase.duration_seconds !== null) {
    rows.push(`<dt>Duration</dt><dd>${phase.duration_seconds}s</dd>`);
  }
  if (phase.detail) {
    rows.push(`<dt>Detail</dt><dd><code>${escapeHtml(phase.detail)}</code></dd>`);
  }
  const headingId = `phase-${label.toLowerCase().replace(/\s+/g, "-")}-heading`;
  if (rows.length === 0) {
    return `<section class="panel" aria-labelledby="${headingId}">
<h3 id="${headingId}">${escapeHtml(label)}</h3>
<p class="empty">No ${escapeHtml(label.toLowerCase())} events recorded.</p>
</section>`;
  }
  return `<section class="panel" aria-labelledby="${headingId}">
<h3 id="${headingId}">${escapeHtml(label)}</h3>
<dl class="phase-meta">${rows.join("")}</dl>
</section>`;
}

function renderFiles(files: DispatchFile[]): string {
  if (files.length === 0) {
    return `<p class="empty">No files recorded.</p>`;
  }
  const rows = files
    .map(
      (f) =>
        `<tr><td><code>${escapeHtml(f.path)}</code></td><td>+${f.added}</td><td>-${f.removed}</td></tr>`,
    )
    .join("");
  return `<table class="diff-table">
<thead><tr><th>Path</th><th>Added</th><th>Removed</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderChecks(checks: DispatchCheck[]): string {
  if (checks.length === 0) return "";
  const rows = checks
    .map((c) => {
      const status = c.passed ? "pass" : "fail";
      const statusClass = c.passed ? "check-pass" : "check-fail";
      const detail = c.detail ? ` <span class="check-detail">${escapeHtml(c.detail)}</span>` : "";
      return `<li class="${statusClass}"><strong>${escapeHtml(c.name)}</strong>: ${status}${detail}</li>`;
    })
    .join("");
  return `<ul class="check-list">${rows}</ul>`;
}

function renderSummary(data: DispatchDetailData): string {
  const outcomeClass =
    data.verdict === "verified" ? "outcome-verified" : "outcome-failed";
  const taskCell = data.task_id
    ? `<code>${escapeHtml(data.task_id)}</code>${
        data.task_title ? ` — ${escapeHtml(data.task_title)}` : ""
      }`
    : "—";
  return `<section class="panel" aria-labelledby="cycle-heading">
<h2 id="cycle-heading">Cycle <code>${escapeHtml(data.cycle_id)}</code></h2>
<dl class="cycle-meta">
<dt>Project</dt><dd><a href="/project/${escapeHtml(data.project_id)}"><code>${escapeHtml(data.project_id)}</code></a></dd>
<dt>Outcome</dt><dd class="${outcomeClass}">${escapeHtml(data.verdict)}</dd>
<dt>Duration</dt><dd>${data.duration_seconds}s</dd>
<dt>Started</dt><dd>${escapeHtml(data.started_at)}</dd>
<dt>Ended</dt><dd>${escapeHtml(data.ended_at)}</dd>
<dt>Task</dt><dd>${taskCell}</dd>
</dl>
</section>`;
}

function renderReview(data: DispatchDetailData): string {
  const phaseHtml = renderPhase("Review", data.review);
  if (!data.verdict_prose && data.checks.length === 0) {
    return phaseHtml;
  }
  const prose = data.verdict_prose
    ? `<p class="verdict-prose">${escapeHtml(data.verdict_prose)}</p>`
    : "";
  const checks = renderChecks(data.checks);
  return `${phaseHtml}
<section class="panel" aria-labelledby="reviewer-response-heading">
<h3 id="reviewer-response-heading">Reviewer response</h3>
${prose}
${checks}
</section>`;
}

function renderDiff(data: DispatchDetailData): string {
  return `<section class="panel" aria-labelledby="diff-heading">
<h3 id="diff-heading">Diff stats</h3>
<dl class="diff-meta">
<dt>Added</dt><dd>+${data.diff_added}</dd>
<dt>Removed</dt><dd>-${data.diff_removed}</dd>
${data.sha_before ? `<dt>SHA before</dt><dd><code>${escapeHtml(data.sha_before)}</code></dd>` : ""}
${data.sha_after ? `<dt>SHA after</dt><dd><code>${escapeHtml(data.sha_after)}</code></dd>` : ""}
</dl>
${renderFiles(data.files_touched)}
</section>`;
}

export async function renderCyclePage(
  cycleId: string,
): Promise<{ status: 200 | 404; html: string }> {
  let data: DispatchDetailData;
  try {
    data = await getDispatchDetail(cycleId);
  } catch (err) {
    if (err instanceof DispatchDetailError) {
      const body = `<section class="panel" aria-labelledby="not-found-heading">
<h2 id="not-found-heading">Cycle not found</h2>
<p>No events recorded for cycle id <code>${escapeHtml(cycleId)}</code> in the fleet progress log.</p>
<p><a href="/">← Back to fleet</a></p>
</section>`;
      return {
        status: 404,
        html: layout({
          title: `GeneralStaff — cycle ${cycleId} (not found)`,
          body,
        }),
      };
    }
    throw err;
  }

  const body = `${renderSummary(data)}
${renderPhase("Engineer", data.engineer)}
${renderPhase("Verification", data.verification)}
${renderReview(data)}
${renderDiff(data)}`;

  return {
    status: 200,
    html: layout({
      title: `GeneralStaff — cycle ${data.cycle_id}`,
      body,
    }),
  };
}
