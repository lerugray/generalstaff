// GeneralStaff — Phase 6 route handlers: GET /tail/:sessionId (gs-285).
//
// Pairs an HTML shell page (`renderTailPage`) with a Server-Sent
// Events stream (`openTailStream`). The shell page is a static site
// chrome wrapping a `<section>` the embedded `/static/tail.js` then
// populates as events arrive. The stream endpoint replays any
// existing fleet-log events matching the session id, then polls the
// file for appends and pushes each new matching line as an SSE
// `message` event. A comment heartbeat keeps intermediaries (proxies,
// the browser's own timeout) from closing an idle stream.
//
// Polling (not fs.watch) is deliberate: Bun's watch on Windows is
// flaky for append-only JSONL, and a 500ms stat-and-read poll is
// within the latency budget for a human-watched tail view.

import { stat, open } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getRootDir } from "../../state";
import { layout } from "../templates/layout";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderTailPage(sessionId: string): string {
  const safeId = escapeHtml(sessionId);
  const body = `<section class="panel" id="tail-root" data-session-id="${safeId}" aria-labelledby="tail-heading">
<h2 id="tail-heading">Session tail <code>${safeId}</code></h2>
<p class="tail-status" id="tail-status" aria-live="polite">Connecting…</p>
<ol class="tail-events" id="tail-events" aria-live="polite"></ol>
</section>
<script src="/static/tail.js" defer></script>`;
  return layout({
    title: `GeneralStaff — tail ${sessionId}`,
    body,
  });
}

interface RawLineEvent {
  timestamp?: unknown;
  event?: unknown;
  cycle_id?: unknown;
  project_id?: unknown;
  data?: unknown;
}

function lineMatchesSession(line: string, sessionId: string): boolean {
  // Quick substring test to skip the JSON.parse cost when the line
  // clearly can't match. Every progress entry that belongs to a
  // session carries `"session_id":"<id>"` inside its `data` object.
  if (!line.includes(sessionId)) return false;
  let parsed: RawLineEvent;
  try {
    parsed = JSON.parse(line) as RawLineEvent;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const data = parsed.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const sid = (data as Record<string, unknown>).session_id;
  return sid === sessionId;
}

// Splits a buffered text blob into complete lines plus any
// trailing partial line the caller should carry into the next
// read. The final element is the leftover (possibly empty).
function splitBufferedLines(buf: string): { lines: string[]; leftover: string } {
  const parts = buf.split("\n");
  const leftover = parts.pop() ?? "";
  return { lines: parts, leftover };
}

export interface OpenTailStreamOptions {
  fleetLogPath?: string;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  // If set, the stream auto-closes after this many milliseconds.
  // Intended for tests; production callers leave it undefined and
  // rely on the client's EventSource lifecycle.
  maxDurationMs?: number;
}

export function openTailStream(
  sessionId: string,
  opts: OpenTailStreamOptions = {},
): Response {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxDurationMs = opts.maxDurationMs;
  const path =
    opts.fleetLogPath ??
    join(getRootDir(), "state", "_fleet", "PROGRESS.jsonl");

  const encoder = new TextEncoder();
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let offset = 0;
  let leftover = "";
  let polling = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function safeEnqueue(chunk: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed by the runtime (client hung up);
          // flip our own flag so the poll loop tears down cleanly.
          closed = true;
        }
      }

      function cleanup(): void {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (maxDurationTimer) clearTimeout(maxDurationTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      async function pollOnce(): Promise<void> {
        if (closed || polling) return;
        polling = true;
        try {
          if (!existsSync(path)) return;
          let st;
          try {
            st = await stat(path);
          } catch {
            return;
          }
          if (st.size < offset) {
            // File was truncated/rotated; restart from the beginning.
            offset = 0;
            leftover = "";
          }
          if (st.size === offset) return;
          const handle = await open(path, "r");
          try {
            const length = st.size - offset;
            const buf = Buffer.alloc(length);
            await handle.read(buf, 0, length, offset);
            offset = st.size;
            const text = leftover + buf.toString("utf8");
            const { lines, leftover: next } = splitBufferedLines(text);
            leftover = next;
            for (const raw of lines) {
              const line = raw.trim();
              if (!line) continue;
              if (!lineMatchesSession(line, sessionId)) continue;
              // SSE message frame: `data: <payload>\n\n`. One line per
              // frame is sufficient because the JSONL line itself is
              // a single JSON object — the browser's EventSource joins
              // nothing, it hands each `data:` field straight through.
              safeEnqueue(`data: ${line}\n\n`);
            }
          } finally {
            await handle.close();
          }
        } finally {
          polling = false;
        }
      }

      // Initial hello so the client can flip out of "Connecting…"
      // state immediately, even before any events exist.
      safeEnqueue(`: tail opened for ${sessionId}\n\n`);

      // Replay the backlog once synchronously (from offset 0).
      await pollOnce();

      pollTimer = setInterval(() => {
        pollOnce().catch(() => {
          // Swallow — a transient read error shouldn't kill the stream.
        });
      }, pollIntervalMs);

      heartbeatTimer = setInterval(() => {
        safeEnqueue(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, heartbeatMs);

      if (maxDurationMs !== undefined) {
        maxDurationTimer = setTimeout(() => {
          cleanup();
        }, maxDurationMs);
      }
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
