// GeneralStaff — Phase 6 route handler: GET /phase + POST /phase/advance.
//
// Phase B+ deferred items: a fleet-wide page showing every project with a
// PHASE_READY.json sentinel + an "Advance" form-button per row. The
// underlying advance pipeline is the same one src/cli.ts §`phase advance`
// uses (loadRoadmap → loadPhaseState → findPhase → evaluateCriteria →
// executePhaseAdvance → clearPhaseReadySentinel) — this route is a thin
// HTTP wrapper that calls the same library code so the UI and CLI stay
// behaviorally identical.
//
// CSRF: bound to 127.0.0.1 by default (src/server.ts), so cross-machine
// access is not in scope. The POST handler additionally checks the Origin
// header against the request host so a malicious page on the loopback
// address can't trigger advances behind the user's back. Same-origin
// (`Origin` matches the server's `Host`) or absent (older clients, curl
// without -H) is accepted; any other origin is rejected with 403.
//
// All POST responses redirect (303) back to /phase so the success path
// is bookmarkable and a refresh can't double-submit.
//
// Note on auto_advance: this route handles the manual approval path
// (commander gate). The opt-in auto-advance flag in ROADMAP.yaml is
// orthogonal — it runs in phase_detector.ts at session-start. The
// advance button is for projects that haven't opted into auto-advance,
// or for projects that have but the operator wants to advance early.

import { loadProjects, findProject } from "../../projects";
import * as phaseLib from "../../phase";
import * as phaseStateLib from "../../phase_state";
import { clearPhaseReadySentinel } from "../../phase_detector";
import { getPhaseReady, type PhaseReadyProjectRow } from "../../views/phase_ready";
import { layout } from "../templates/layout";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderReadyRow(row: PhaseReadyProjectRow, flash?: FlashState | null): string {
  const id = escapeHtml(row.project_id);
  const from = escapeHtml(row.from_phase);
  const to = escapeHtml(row.to_phase);
  const age = escapeHtml(ageLabel(row.detected_age_seconds));
  const passedLabel = `${row.passed_criteria}/${row.total_criteria}`;
  const flashHtml =
    flash && flash.project_id === row.project_id
      ? `<p class="phase-flash phase-flash-${escapeHtml(flash.status)}">${escapeHtml(flash.message)}</p>`
      : "";
  return `<tr>
<td><a href="/project/${id}"><code>${id}</code></a></td>
<td><code>${from}</code> → <code>${to}</code></td>
<td>${escapeHtml(passedLabel)}</td>
<td>${age}</td>
<td>
<form method="post" action="/phase/advance" class="phase-advance-form">
<input type="hidden" name="project_id" value="${id}">
<button type="submit">Advance</button>
</form>
${flashHtml}
</td>
</tr>`;
}

interface FlashState {
  project_id: string;
  status: "ok" | "error";
  message: string;
}

interface RenderPhasePageOptions {
  flash?: FlashState | null;
}

export async function renderPhasePage(
  options: RenderPhasePageOptions = {},
): Promise<{ status: 200; html: string }> {
  let data;
  try {
    data = await getPhaseReady();
  } catch (err) {
    // Same defensive pattern as renderIndex in src/server.ts. The most
    // common failure mode is "no projects.yaml" (fresh-machine bootstrap
    // hasn't happened yet); render a clear pointer to `gs doctor`
    // instead of letting Bun's default error page leak the stack trace.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 200,
      html: layout({
        title: "GeneralStaff — Phase",
        activeNav: "phase",
        body: `<section class="panel" aria-labelledby="phase-error-heading">
<h2 id="phase-error-heading">Phase-ready dashboard</h2>
<p class="empty">Could not enumerate projects: <code>${escapeHtml(msg)}</code></p>
<p>Run <code>generalstaff doctor</code> to diagnose, or check <code>projects.yaml.example</code> for the schema.</p>
</section>`,
      }),
    };
  }
  const flash = options.flash ?? null;

  // Top-of-page flash for non-row-targeted messages (e.g. an advance
  // succeeded and removed the row, so the project_id no longer matches).
  const topFlashHtml =
    flash && !data.ready.some((r) => r.project_id === flash.project_id)
      ? `<p class="phase-flash phase-flash-${escapeHtml(flash.status)}">${escapeHtml(flash.message)}</p>`
      : "";

  const tableHtml =
    data.ready.length === 0
      ? `<p class="empty">No projects ready to advance. Scanned ${data.total_projects_scanned} project${data.total_projects_scanned === 1 ? "" : "s"}; ${data.total_with_roadmap} have a ROADMAP.yaml.</p>`
      : `<table class="dispatch-table">
<thead><tr>
<th>Project</th><th>Phase</th><th>Criteria</th><th>Detected</th><th>Action</th>
</tr></thead>
<tbody>${data.ready.map((r) => renderReadyRow(r, flash)).join("")}</tbody>
</table>`;

  const body = `<section class="panel" aria-labelledby="phase-heading">
<h2 id="phase-heading">Phase-ready projects</h2>
<p>
Projects whose current phase has all completion criteria passing and
a non-terminal next phase. Click <strong>Advance</strong> to seed the
next phase's tasks and update <code>PHASE_STATE.json</code>. Equivalent
to <code>generalstaff phase advance --project=&lt;id&gt;</code>.
</p>
${topFlashHtml}
${tableHtml}
<p>
Scanned <strong>${data.total_projects_scanned}</strong> registered project${data.total_projects_scanned === 1 ? "" : "s"}
 · <strong>${data.total_with_roadmap}</strong> with <code>ROADMAP.yaml</code>
 · <strong>${data.ready.length}</strong> ready to advance
</p>
</section>`;

  return {
    status: 200,
    html: layout({
      title: "GeneralStaff — Phase",
      activeNav: "phase",
      body,
    }),
  };
}

export interface PhaseAdvanceOutcome {
  status: number;
  flash: FlashState;
}

// Pure handler — does the work, returns the redirect intent. The HTTP
// shell in src/server.ts builds the actual Response with cookie/flash
// plumbing or query-string fallback for stateless redirect. Returning
// flash data instead of an HTML page keeps the success path a clean
// 303-and-refetch.
export async function handlePhaseAdvance(
  projectId: string | null,
): Promise<PhaseAdvanceOutcome> {
  if (!projectId) {
    return {
      status: 400,
      flash: {
        project_id: "",
        status: "error",
        message: "project_id is required",
      },
    };
  }

  const projects = await loadProjects();
  const projectConfig = findProject(projects, projectId);
  if (!projectConfig) {
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `Project "${projectId}" not registered.`,
      },
    };
  }

  let roadmap;
  try {
    roadmap = await phaseLib.loadRoadmap(projectId);
  } catch (err) {
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `Could not load ROADMAP.yaml: ${(err as Error).message}`,
      },
    };
  }

  const state = await phaseStateLib.loadPhaseState(
    projectId,
    roadmap.current_phase,
  );
  const currentPhase = phaseLib.findPhase(roadmap, state.current_phase);
  if (!currentPhase) {
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `PHASE_STATE.json current_phase="${state.current_phase}" no longer matches any phase in ROADMAP.yaml.`,
      },
    };
  }
  if (!currentPhase.next_phase) {
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `Phase "${currentPhase.id}" is terminal (no next_phase). Nothing to advance to.`,
      },
    };
  }
  const nextPhase = phaseLib.findPhase(roadmap, currentPhase.next_phase);
  if (!nextPhase) {
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `next_phase="${currentPhase.next_phase}" not found in ROADMAP.yaml.`,
      },
    };
  }

  const criteriaResults = await phaseLib.evaluateCriteria(
    currentPhase,
    projectConfig,
  );
  if (!phaseLib.allPassed(criteriaResults)) {
    const failing = criteriaResults
      .filter((r) => !r.passed)
      .map((r) => `${r.kind}: ${r.detail}`)
      .join("; ");
    return {
      status: 400,
      flash: {
        project_id: projectId,
        status: "error",
        message: `Cannot advance: criteria not met. ${failing}`,
      },
    };
  }

  const advance = await phaseLib.executePhaseAdvance(
    projectConfig,
    currentPhase,
    nextPhase,
    criteriaResults,
    { forced: false, triggerEvent: "phase_advanced" },
  );
  await clearPhaseReadySentinel(projectId);

  const seededLabel =
    advance.seeded_task_ids.length > 0
      ? `Seeded ${advance.seeded_task_ids.length} task${advance.seeded_task_ids.length === 1 ? "" : "s"}.`
      : `No tasks declared for "${nextPhase.id}".`;

  return {
    status: 303,
    flash: {
      project_id: projectId,
      status: "ok",
      message: `Advanced ${advance.from_phase} → ${advance.to_phase}. ${seededLabel}`,
    },
  };
}

// Origin-check: same-origin or absent only. Rejects other origins so a
// page on a different localhost port can't trigger advances. Bound to
// 127.0.0.1 in startServer() defaults limits exposure further.
export function isAcceptableOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // older clients / curl without -H
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

// Decode application/x-www-form-urlencoded body for project_id. Bun's
// Request.formData() works but pulls in multipart parsing too; this is
// a 6-line URL-encoded decoder for the single-field form, which is all
// /phase/advance ever submits. Returns null if project_id is missing
// or not a single string value.
export function parseAdvanceFormBody(body: string): string | null {
  const params = new URLSearchParams(body);
  const id = params.get("project_id");
  if (id === null) return null;
  if (id.length === 0) return null;
  return id;
}
