// GeneralStaff — Phase 6 shared HTML layout template (gs-269).
//
// Returns a complete HTML5 document string for server-rendered pages.
// Every route handler in Phase 6+ wraps its body markup in this
// layout so the site shell (header, nav, footer) stays consistent.
// No SPA, no bundler — plain HTML string rendering over Bun.serve().

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface LayoutOptions {
  title: string;
  body: string;
  // Highlights the active nav link with aria-current. Omit or pass
  // a value not in the set to render the nav without any active state
  // (e.g. a dedicated error page).
  activeNav?: "fleet" | "inbox";
}

// Resolve the dispatcher's package.json relative to this module.
// Read once at module load — the version is a shipped build constant,
// not something that mutates at runtime, so caching is fine and saves
// a disk read per request.
let cachedVersion: string | null = null;
function getVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // templates/ → server/ → src/ → project root
    const pkgPath = join(moduleDir, "..", "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

// Minimal HTML-escape for values we interpolate into text content
// or attribute values. Keeps the layout safe against titles or body
// content that happens to contain angle brackets or quotes. The
// `body` parameter is treated as pre-rendered HTML (not escaped) —
// callers are responsible for escaping their own content where
// necessary.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function layout(opts: LayoutOptions): string {
  const safeTitle = escapeHtml(opts.title);
  const activeFleet = opts.activeNav === "fleet" ? ' aria-current="page"' : "";
  const activeInbox = opts.activeNav === "inbox" ? ' aria-current="page"' : "";
  const now = new Date().toISOString();
  const version = getVersion();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site-header">
  <h1 class="site-title">GeneralStaff</h1>
  <nav class="site-nav" aria-label="Primary">
    <a href="/"${activeFleet}>Fleet</a>
    <a href="/inbox"${activeInbox}>Inbox</a>
  </nav>
</header>
<main class="site-main">
${opts.body}
</main>
<footer class="site-footer">
  <span>GeneralStaff v${escapeHtml(version)}</span>
  <span class="site-footer-time">${escapeHtml(now)}</span>
</footer>
</body>
</html>`;
}
