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

function renderIndex(): string {
  return layout({
    title: "GeneralStaff — Fleet",
    activeNav: "fleet",
    body: `<section class="panel" aria-labelledby="fleet-overview-heading">
  <h2 id="fleet-overview-heading">Fleet overview</h2>
  <p>Dashboard scaffolding. Per-project cards and the live session
  stream will land in gs-270+ (see
  <code>docs/internal/PHASE-6-SKETCH-2026-04-19.md</code>).</p>
</section>`,
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
        return new Response(renderIndex(), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/project/")) {
        const projectId = decodeURIComponent(
          url.pathname.slice("/project/".length),
        );
        if (projectId.length > 0 && !projectId.includes("/")) {
          const { status, html } = await renderProjectPage(projectId);
          return new Response(html, {
            status,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/cycle/")) {
        const cycleId = decodeURIComponent(
          url.pathname.slice("/cycle/".length),
        );
        if (cycleId.length > 0 && !cycleId.includes("/")) {
          const { status, html } = await renderCyclePage(cycleId);
          return new Response(html, {
            status,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
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
          if (sessionId.length > 0 && !sessionId.includes("/")) {
            return openTailStream(sessionId);
          }
        } else {
          const sessionId = decodeURIComponent(rest);
          if (sessionId.length > 0 && !sessionId.includes("/")) {
            return new Response(renderTailPage(sessionId), {
              status: 200,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache",
              },
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
