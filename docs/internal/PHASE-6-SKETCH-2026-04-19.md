# Phase 6 sketch (2026-04-19)

**Status:** Design decisions committed 2026-04-19 evening. Authoritative
spec for Phase 6 scaffolding tasks until superseded by
`PHASE-6-COMPLETE-<date>.md` at phase closure.

**Companion docs:**
- `DESIGN.md` — full architecture (Phase 6 UI shell is next major piece)
- `docs/internal/UI-VISION-2026-04-15.md` — Kriegspiel / command-room aesthetic
- `docs/internal/UI-VISION-2026-04-19.md` — dev-mode vs live-mode Fleet card
- `docs/phase-5-references/` — five HTML mockups that establish visual vocabulary
- `web/index.html` — existing landing mockup

---

## Scope

Phase 6 ships a **local web dashboard** that wraps the existing
`src/views/*.ts` data modules in a visual layer. The dispatcher
itself stays headless (CLI-driven); the dashboard is a
viewer/controller overlay.

**In v1 scope:**
- Read-only views of dispatcher state (fleet, project, cycle, tail)
- Live-updating session tail via Server-Sent Events
- `generalstaff serve` CLI subcommand that boots the server
- Localhost-bound HTTP; no auth; anyone on the machine can see

**Out of v1 scope (punted to Phase 6.5+):**
- Dispatching sessions from the UI (read-only in v1; actions later)
- Editing `projects.yaml` or `tasks.json` from the UI
- Authentication / tokens
- Remote access (localhost-bound only)
- Mobile layout (dev users run this on a laptop)
- System tray, notifications, file picker

## Stack decisions (Ray-approved 2026-04-19 evening)

| Decision | Choice | Why |
|---|---|---|
| Runtime | Bun local HTTP via `Bun.serve()` | Zero install friction (Bun already shipped via install.sh); aligns with "one stack to maintain" |
| Rendering | Server-rendered HTML + small vanilla JS | No bundler, no SPA framework; Phase 5 refs are HTML |
| Real-time | Server-Sent Events | One-way push, no WebSocket complexity, works over HTTP |
| Port | 3737 (default, configurable via `--port`) | Arbitrary but memorable |
| Auth | None beyond `127.0.0.1` binding | Anyone on the machine already has repo read access |
| v1 capability | Read-only views | Actions (dispatch, queue edit) deferred to Phase 6.5 |

**Rejected alternatives:**
- **Tauri** — adds Rust toolchain, platform-specific binary build step,
  another install story. Solo-dev maintenance burden is the blocker.
- **Electron** — ~100MB bundles, memory-heavy, reputation drag. Same
  maintenance concerns as Tauri plus the bundle size.
- **SPA (React/Svelte/Vue)** — adds bundler, build step, runtime deps.
  Phase 5 references are static HTML; server-rendered is the natural
  match and cuts a whole toolchain.
- **WebSocket** — two-way is overkill for a read-only dashboard. SSE
  covers the actual need (stream cycle events to the client).
- **Polling** — works but wastes request/response pairs when SSE is
  natively supported and cheaper.

## Route structure

| Route | View module | Purpose |
|---|---|---|
| `/` | `src/views/fleet_overview.ts` | Fleet card — all managed projects, recent cycle outcomes, status |
| `/project/:id` | `src/views/task_queue.ts` + `src/views/dispatch_detail.ts` | Per-project: task queue, recent dispatches, verification rate |
| `/cycle/:id` | `src/views/dispatch_detail.ts` | Single cycle drill-down: engineer prompt, reviewer verdict, diff stats |
| `/tail/:sessionId` | `src/views/session_tail.ts` (SSE) | Live session tail — streams cycle_start / engineer_invoked / cycle_end events |
| `/inbox` | `src/views/inbox.ts` | Cross-project messages/signals needing attention |

All routes render server-side; the browser requests HTML and gets
HTML. No JSON APIs in v1 beyond the SSE stream.

## File layout (target)

```
src/
  server.ts                  # Bun.serve() entrypoint; route dispatch
  server/
    routes/
      fleet.ts               # GET / handler
      project.ts             # GET /project/:id handler
      cycle.ts               # GET /cycle/:id handler
      tail.ts                # GET /tail/:sessionId SSE handler
      inbox.ts               # GET /inbox handler
    templates/
      layout.ts              # Shared HTML shell (head, nav, footer)
      fleet.ts               # Fleet-page template function
      project.ts             # Project-page template
      cycle.ts               # Cycle-detail template
      tail.ts                # Tail-page shell (SSE client JS embedded)
      inbox.ts               # Inbox template
    static/
      style.css              # Shared stylesheet (Kriegspiel-ish)
      tail.js                # Vanilla JS for SSE subscription
  cli.ts                     # Add `serve` subcommand
```

Templates are **template functions** (TypeScript functions returning
HTML strings), not a templating language. Simplest possible pattern.
Keeps type safety.

## CLI surface

```
generalstaff serve [--port 3737] [--host 127.0.0.1] [--open]
```

`--open` launches the default browser at the bound URL (convenience).
`--host 0.0.0.0` is **not** documented in the CLI help — users who
really need LAN exposure can set it, but the README doesn't advertise
it. Default is strictly localhost.

## Real-time strategy

SSE endpoint at `/tail/:sessionId/stream` pushes events as the session
writes them to `state/<project>/PROGRESS.jsonl`. Implementation:

1. Client subscribes via `new EventSource('/tail/:sessionId/stream')`.
2. Server watches the relevant `PROGRESS.jsonl` file via Bun's `fs.watch`.
3. On new line, parse JSON, push as SSE event.
4. Client appends to the page DOM via a small inline script.

No WebSocket, no Socket.io, no library. ~50 lines of TypeScript on the
server, ~30 lines of vanilla JS on the client.

## Build order

Phase 6 scaffolding in a dependency-respecting sequence:

1. **gs-XXX: Bun.serve() skeleton.** Create `src/server.ts` with a
   minimal `Bun.serve({ port, fetch })` handler that returns `200 OK`
   on `/health` and `404` elsewhere. No templates yet.
2. **gs-XXX: `serve` CLI subcommand.** Wire `generalstaff serve` to
   boot `src/server.ts` with port/host flags. Exit cleanly on SIGINT.
3. **gs-XXX: Layout template + static CSS.** Shared HTML shell; muted
   palette pulled from `docs/phase-5-references/`.
4. **gs-XXX: `/` fleet route.** Server-renders fleet_overview.ts data
   into HTML.
5. **gs-XXX: `/project/:id` route.** Renders task_queue + recent cycles.
6. **gs-XXX: `/cycle/:id` route.** Renders dispatch_detail.
7. **gs-XXX: `/tail/:sessionId` route + SSE stream.** Live session tail.
8. **gs-XXX: `/inbox` route.** Cross-project inbox view.
9. **gs-XXX: `doctor --check-server`.** Health check for the server
   layer (port available, static assets present).
10. **PHASE-6-COMPLETE-<date>.md** — closure narrative when shipped.

Tasks 1-3 are foundational and must land in order. Tasks 4-8 can
parallelize across bot cycles once the layout is up.

## Open questions (non-blocking)

- Does `Bun.serve()` support streaming responses for SSE? **Yes**, via
  `Response(new ReadableStream(...))`. Confirmed in Bun docs.
- Does Bun have a built-in file-watch API? **Yes**, `fs.watch` from
  `node:fs` works. For file-level events on `.jsonl` appends, watch
  the file and seek from last known offset.
- How does the server handle restart during a live SSE session? **The
  client's EventSource auto-reconnects.** No server-side
  responsibility.
- What about CSRF? **N/A for read-only.** When actions ship in
  Phase 6.5, revisit.

## Non-decisions deliberately deferred

- **Dashboard theme** — Kriegspiel vs modern-minimal vs hybrid. The
  Phase 5 references lean Kriegspiel; we'll match that for v1 and
  leave theme variants for after Phase 6.5.
- **Animation / transitions** — none in v1. Server-rendered pages
  don't animate between renders. Phase 6.5 can add htmx-style
  progressive enhancement if needed.
- **Accessibility audit** — deferred to pre-launch gate. The layout
  template should follow semantic HTML (nav, main, section, article)
  so a11y is reasonable by default without an audit.
