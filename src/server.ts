// GeneralStaff — Phase 6 web dashboard server.
//
// Minimal Bun.serve() entrypoint. gs-269 adds the shared layout,
// base stylesheet served at /static/style.css, and the root `/`
// route rendering a placeholder fleet overview. Later tasks will
// add /project/:id, /cycle/:id, /tail, /inbox, etc.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { layout } from "./server/templates/layout";
import { renderProjectPage } from "./server/routes/project";
import { renderCyclePage } from "./server/routes/cycle";
import { renderTailPage, openTailStream } from "./server/routes/tail";
import { renderInboxPage } from "./server/routes/inbox";
import {
  renderPhasePage,
  handlePhaseAdvance,
  isAcceptableOrigin,
  parseAdvanceFormBody,
} from "./server/routes/phase";
import { getFleetOverview } from "./views/fleet_overview";
import type { FleetOverviewProjectRow } from "./views/fleet_overview";

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  stop: () => void;
}

// Read style.css once at server-boot time rather than per-request.
// The stylesheet is a shipped build constant — any editor change
// requires a server restart anyway (no HMR in this Bun.serve()
// setup), so caching is correct and saves disk I/O on every hit.
//
// If the file is missing we fall back to a visible comment so a
// misconfigured deploy renders a loud empty dashboard rather than
// a silent 500.
let cachedStyleCss: string | null = null;
function loadStyleCss(): string {
  if (cachedStyleCss !== null) return cachedStyleCss;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const cssPath = join(moduleDir, "server", "static", "style.css");
    cachedStyleCss = readFileSync(cssPath, "utf8");
  } catch {
    cachedStyleCss = "/* style.css failed to load at server boot */";
  }
  return cachedStyleCss;
}

let cachedTailJs: string | null = null;
function loadTailJs(): string {
  if (cachedTailJs !== null) return cachedTailJs;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const jsPath = join(moduleDir, "server", "static", "tail.js");
    cachedTailJs = readFileSync(jsPath, "utf8");
  } catch {
    cachedTailJs = "/* tail.js failed to load at server boot */";
  }
  return cachedTailJs;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Route-param allow-list. Project IDs, cycle IDs, and session IDs all
// conform to alphanumerics + `_` + `-` in practice. Enforcing the
// allow-list here blocks path-traversal tricks (both `/` and `\` on
// Windows), Unicode line-terminator embedding in downstream contexts,
// and any other separator-style attack on the file paths these IDs
// interpolate into. Tightening this at the edge is cheap — widen it
// only if a legitimate ID shape requires it.
function isSafeId(id: string): boolean {
  return id.length > 0 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// Shared response headers for every HTML + SSE response. CSP is strict:
// `default-src 'self'` + `script-src 'self'` (no inline scripts — the
// one we had in tail.ts was refactored to a data attribute so this can
// stay strict). `frame-ancestors 'none'` belt-and-suspenders with
// `X-Frame-Options: DENY`.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function htmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  };
}

function renderProjectRow(p: FleetOverviewProjectRow): string {
  const id = escHtml(p.id);
  const outcome = p.last_cycle_outcome
    ? `<span class="outcome-${escHtml(p.last_cycle_outcome)}">${escHtml(p.last_cycle_outcome)}</span>`
    : "—";
  const passRate =
    p.verified + p.failed > 0
      ? `${Math.round((100 * p.verified) / (p.verified + p.failed))}%`
      : "—";
  const autoMerge = p.auto_merge ? "on" : "off";
  return `<tr>
<td><a href="/project/${id}"><code>${id}</code></a></td>
<td>P${p.priority}</td>
<td>${p.cycles_total}</td>
<td>${passRate}</td>
<td>${p.bot_pickable}</td>
<td>${outcome}</td>
<td>${autoMerge}</td>
</tr>`;
}

async function renderIndex(): Promise<string> {
  let data;
  try {
    data = await getFleetOverview();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return layout({
      title: "GeneralStaff — Fleet",
      activeNav: "fleet",
      body: `<section class="panel" aria-labelledby="fleet-heading">
<h2 id="fleet-heading">Fleet overview</h2>
<p class="empty">Could not load projects.yaml: <code>${escHtml(msg)}</code></p>
<p>Run <code>generalstaff doctor</code> to diagnose, or check <code>projects.yaml.example</code> for the schema.</p>
</section>`,
    });
  }

  const agg = data.aggregates;
  const passRatePct =
    agg.total_verified + agg.total_failed > 0
      ? `${Math.round(100 * agg.pass_rate)}%`
      : "—";
  const slotLine =
    agg.slot_efficiency_recent !== null
      ? ` · Parallel efficiency ${Math.round(agg.slot_efficiency_recent * 100)}%`
      : "";

  const projectsBody =
    data.projects.length === 0
      ? `<p class="empty">No projects registered. See <code>projects.yaml.example</code> or run <code>generalstaff bootstrap</code>.</p>`
      : `<table class="dispatch-table">
<thead><tr>
<th>Project</th><th>Pri</th><th>Cycles</th><th>Pass rate</th>
<th>Bot-pickable</th><th>Last outcome</th><th>Auto-merge</th>
</tr></thead>
<tbody>${data.projects.map(renderProjectRow).join("")}</tbody>
</table>`;

  const body = `<section class="panel" aria-labelledby="fleet-heading">
<h2 id="fleet-heading">Fleet overview</h2>
<p>
<strong>${agg.project_count}</strong> projects
 · <strong>${agg.total_cycles}</strong> cycles
 · <strong>${passRatePct}</strong> pass rate
 (${agg.total_verified} verified / ${agg.total_failed} failed)${slotLine}
</p>
</section>
<section class="panel" aria-labelledby="projects-heading">
<h2 id="projects-heading">Projects</h2>
${projectsBody}
</section>
<section class="panel" aria-labelledby="orders-heading">
<h2 id="orders-heading">Dispatch orders</h2>
<p>Actions are CLI-first. Copy the command, paste in your terminal:</p>
<dl class="project-meta">
<dt>Queue a task</dt><dd><code>generalstaff task add --project=&lt;id&gt; --priority=&lt;1-5&gt; "&lt;title&gt;"</code></dd>
<dt>Launch a session</dt><dd><code>generalstaff session --budget=60</code></dd>
<dt>Run one cycle</dt><dd><code>generalstaff cycle --project=&lt;id&gt;</code></dd>
<dt>Stop the dispatcher</dt><dd><code>generalstaff stop</code></dd>
<dt>Tail live events</dt><dd><a href="/inbox">/inbox</a> (attention items) or <code>generalstaff status --watch</code></dd>
</dl>
</section>`;

  return layout({
    title: "GeneralStaff — Fleet",
    activeNav: "fleet",
    body,
  });
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const hostname = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3737;

  // Warm the static-asset caches at boot so the first request
  // doesn't pay the disk-read cost.
  loadStyleCss();
  loadTailJs();

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      if (req.method === "GET" && url.pathname === "/static/style.css") {
        return new Response(loadStyleCss(), {
          status: 200,
          headers: {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/static/tail.js") {
        return new Response(loadTailJs(), {
          status: 200,
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(await renderIndex(), {
          status: 200,
          headers: htmlHeaders(),
        });
      }
      if (req.method === "GET" && url.pathname === "/inbox") {
        const { status, html } = await renderInboxPage();
        return new Response(html, {
          status,
          headers: htmlHeaders(),
        });
      }
      if (req.method === "GET" && url.pathname === "/phase") {
        // Phase B+ deferred item: phase-ready dashboard. Carries optional
        // ?flash params from the POST /phase/advance redirect so the
        // success/error message survives the round-trip without a server-
        // side session store.
        const flashProjectId = url.searchParams.get("flash_project");
        const flashStatusRaw = url.searchParams.get("flash_status");
        const flashMessage = url.searchParams.get("flash_message");
        const flashStatus: "ok" | "error" | null =
          flashStatusRaw === "ok" || flashStatusRaw === "error"
            ? flashStatusRaw
            : null;
        const flash =
          flashProjectId !== null && flashStatus !== null && flashMessage !== null
            ? {
                project_id: flashProjectId,
                status: flashStatus,
                message: flashMessage,
              }
            : null;
        const { status, html } = await renderPhasePage({ flash });
        return new Response(html, {
          status,
          headers: htmlHeaders(),
        });
      }
      if (req.method === "POST" && url.pathname === "/phase/advance") {
        // Origin-check guards same-origin only. Loopback binding plus
        // this header check is the CSRF defense.
        if (!isAcceptableOrigin(req)) {
          return new Response("Forbidden", {
            status: 403,
            headers: SECURITY_HEADERS,
          });
        }
        let body: string;
        try {
          body = await req.text();
        } catch {
          return new Response("Bad Request", {
            status: 400,
            headers: SECURITY_HEADERS,
          });
        }
        const projectId = parseAdvanceFormBody(body);
        const { flash } = await handlePhaseAdvance(projectId);
        // Always 303-redirect back to /phase carrying the flash so the
        // success path is bookmarkable + a refresh can't double-submit.
        // Even the advance-attempted-but-failed case redirects: the
        // user lands on /phase and sees the error inline next to the row
        // (or top-of-page if the row is gone after a successful advance).
        const params = new URLSearchParams({
          flash_project: flash.project_id,
          flash_status: flash.status,
          flash_message: flash.message,
        });
        return new Response(null, {
          status: 303,
          headers: {
            ...SECURITY_HEADERS,
            Location: `/phase?${params.toString()}`,
          },
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/project/")) {
        const projectId = decodeURIComponent(
          url.pathname.slice("/project/".length),
        );
        if (isSafeId(projectId)) {
          const { status, html } = await renderProjectPage(projectId);
          return new Response(html, {
            status,
            headers: htmlHeaders(),
          });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/cycle/")) {
        const cycleId = decodeURIComponent(
          url.pathname.slice("/cycle/".length),
        );
        if (isSafeId(cycleId)) {
          const { status, html } = await renderCyclePage(cycleId);
          return new Response(html, {
            status,
            headers: htmlHeaders(),
          });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/tail/")) {
        const rest = url.pathname.slice("/tail/".length);
        // Two shapes land here: `/tail/:sessionId` (HTML shell) and
        // `/tail/:sessionId/stream` (SSE). Anything else is 404.
        if (rest.endsWith("/stream")) {
          const sessionId = decodeURIComponent(
            rest.slice(0, -"/stream".length),
          );
          if (isSafeId(sessionId)) {
            return openTailStream(sessionId);
          }
        } else {
          const sessionId = decodeURIComponent(rest);
          if (isSafeId(sessionId)) {
            return new Response(renderTailPage(sessionId), {
              status: 200,
              headers: htmlHeaders(),
            });
          }
        }
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
}
