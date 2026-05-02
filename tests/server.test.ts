import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startServer } from "../src/server";
import { setRootDir, getRootDir } from "../src/state";

describe("startServer", () => {
  it("binds to an ephemeral port when port=0", async () => {
    const server = await startServer({ port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const port = Number(server.url.split(":").pop());
      expect(port).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });

  it("returns 200 'ok' for GET /health", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("ok");
    } finally {
      server.stop();
    }
  });

  it("returns 404 for unknown routes", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/unknown`);
      expect(res.status).toBe(404);
      // consume body to release the connection
      await res.text();
    } finally {
      server.stop();
    }
  });

  it("stop() actually stops the server (subsequent fetch fails)", async () => {
    const server = await startServer({ port: 0 });
    const url = server.url;
    // confirm it works first
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    await res.text();

    server.stop();
    // Give the OS a moment to release the listening socket.
    await new Promise((r) => setTimeout(r, 50));

    let failed = false;
    try {
      const r = await fetch(`${url}/health`);
      // consume body even on success so the connection is released
      await r.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("startServer — gs-283 GET /project/:id", () => {
  const FIXTURE_DIR = join(tmpdir(), `gs-server-project-${process.pid}`);
  let originalRoot: string;

  function writeProjectsYaml(projectIds: string[]) {
    const lines = ["projects:"];
    for (const id of projectIds) {
      const projectPath = join(FIXTURE_DIR, `proj-${id}`).replace(/\\/g, "/");
      mkdirSync(join(FIXTURE_DIR, `proj-${id}`, "state", id), {
        recursive: true,
      });
      lines.push(
        `  - id: ${id}`,
        `    path: ${projectPath}`,
        `    priority: 1`,
        `    engineer_command: "echo"`,
        `    verification_command: "echo"`,
        `    cycle_budget_minutes: 30`,
        `    branch: bot/work`,
        `    auto_merge: false`,
        `    hands_off:`,
        `      - secret/`,
      );
    }
    lines.push("dispatcher:", "  max_parallel_slots: 1");
    writeFileSync(join(FIXTURE_DIR, "projects.yaml"), lines.join("\n"), "utf8");
  }

  function writeTasks(
    projectId: string,
    tasks: Array<{ id: string; title: string; status: string; priority: number }>,
  ) {
    const path = join(FIXTURE_DIR, `proj-${projectId}`, "state", projectId, "tasks.json");
    writeFileSync(path, JSON.stringify(tasks, null, 2), "utf8");
  }

  function writeProgress(projectId: string, events: Array<Record<string, unknown>>) {
    const path = join(FIXTURE_DIR, `proj-${projectId}`, "state", projectId, "PROGRESS.jsonl");
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  beforeEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    originalRoot = getRootDir();
    setRootDir(FIXTURE_DIR);
  });

  afterEach(() => {
    setRootDir(originalRoot);
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("returns 200 HTML with project id, task queue, and dispatches panel", async () => {
    writeProjectsYaml(["alpha"]);
    writeTasks("alpha", [
      { id: "a-1", title: "ready task", status: "pending", priority: 1 },
      { id: "a-2", title: "in flight task", status: "in_progress", priority: 1 },
    ]);
    writeProgress("alpha", [
      {
        timestamp: "2026-04-20T10:00:00Z",
        event: "cycle_end",
        cycle_id: "c-1",
        project_id: "alpha",
        data: { outcome: "verified", task_id: "a-0", duration_seconds: 120 },
      },
      {
        timestamp: "2026-04-20T11:00:00Z",
        event: "cycle_end",
        cycle_id: "c-2",
        project_id: "alpha",
        data: { outcome: "verification_failed", task_id: "a-1", duration_seconds: 90 },
      },
    ]);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/project/alpha`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("alpha");
      expect(body).toContain("ready task");
      expect(body).toContain("in flight task");
      expect(body).toContain("Task queue");
      expect(body).toContain("Recent dispatches");
      // pass rate section: 1 verified / 1 failed = 50.0%
      expect(body).toContain("50.0%");
      // recent dispatches link to /cycle/:id
      expect(body).toContain('href="/cycle/c-1"');
      expect(body).toContain('href="/cycle/c-2"');
    } finally {
      server.stop();
    }
  });

  it("returns 404 when project id is not in projects.yaml", async () => {
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/project/ghost`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Project not found");
      expect(body).toContain("ghost");
    } finally {
      server.stop();
    }
  });

  it("renders 'Work on this' section with sync+cd+claude commands, quoting paths that contain spaces", async () => {
    // T3-minimal: each project page surfaces a copy-pasteable launch
    // block so interactive work on a registered project is one command
    // away. Paths with spaces must quote the cd target.
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/project/alpha`);
      const body = await res.text();
      expect(body).toContain("Work on this");
      expect(body).toContain("generalstaff sync --project=alpha");
      expect(body).toContain("claude");
      expect(body).toContain("CLAUDE-GS.md");
      // Tests use `proj-alpha/` (no space), so no quoting:
      expect(body).toMatch(/cd [^"][^\n<]*proj-alpha/);
    } finally {
      server.stop();
    }
  });

  it("returns 200 with empty-state panels when project has no tasks.json or PROGRESS.jsonl", async () => {
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/project/alpha`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("alpha");
      expect(body).toContain("No cycles recorded yet");
    } finally {
      server.stop();
    }
  });
});

describe("startServer — gs-284 GET /cycle/:cycleId", () => {
  const FIXTURE_DIR = join(tmpdir(), `gs-server-cycle-${process.pid}`);
  let originalRoot: string;

  function writeFleetLog(events: Array<Record<string, unknown>>) {
    const dir = join(FIXTURE_DIR, "state", "_fleet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROGRESS.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  function writeProjectsYaml(projectIds: string[]) {
    const lines = ["projects:"];
    for (const id of projectIds) {
      const projectPath = join(FIXTURE_DIR, `proj-${id}`).replace(/\\/g, "/");
      mkdirSync(join(FIXTURE_DIR, `proj-${id}`, "state", id), {
        recursive: true,
      });
      lines.push(
        `  - id: ${id}`,
        `    path: ${projectPath}`,
        `    priority: 1`,
        `    engineer_command: "echo"`,
        `    verification_command: "echo"`,
        `    cycle_budget_minutes: 30`,
        `    branch: bot/work`,
        `    auto_merge: false`,
        `    hands_off:`,
        `      - secret/`,
      );
    }
    lines.push("dispatcher:", "  max_parallel_slots: 1");
    writeFileSync(join(FIXTURE_DIR, "projects.yaml"), lines.join("\n"), "utf8");
  }

  beforeEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    originalRoot = getRootDir();
    setRootDir(FIXTURE_DIR);
  });

  afterEach(() => {
    setRootDir(originalRoot);
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("returns 200 HTML with cycle id, outcome, duration, and phase sections", async () => {
    writeProjectsYaml(["alpha"]);
    writeFleetLog([
      {
        timestamp: "2026-04-20T10:00:00Z",
        event: "cycle_start",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { task_id: "a-7", sha_before: "abc123" },
      },
      {
        timestamp: "2026-04-20T10:00:05Z",
        event: "engineer_start",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { command: "claude -p" },
      },
      {
        timestamp: "2026-04-20T10:05:00Z",
        event: "engineer_end",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { duration_seconds: 295 },
      },
      {
        timestamp: "2026-04-20T10:05:05Z",
        event: "verification_start",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { command: "bun test" },
      },
      {
        timestamp: "2026-04-20T10:06:00Z",
        event: "verification_end",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { duration_seconds: 55, outcome: "passed" },
      },
      {
        timestamp: "2026-04-20T10:06:10Z",
        event: "reviewer_start",
        cycle_id: "c-42",
        project_id: "alpha",
        data: {},
      },
      {
        timestamp: "2026-04-20T10:06:40Z",
        event: "reviewer_end",
        cycle_id: "c-42",
        project_id: "alpha",
        data: {
          duration_seconds: 30,
          verdict: "verified",
          scope_drift_files: [],
          hands_off_violations: [],
          silent_failures: [],
        },
      },
      {
        timestamp: "2026-04-20T10:07:00Z",
        event: "cycle_end",
        cycle_id: "c-42",
        project_id: "alpha",
        data: {
          outcome: "verified",
          task_id: "a-7",
          duration_seconds: 420,
          verdict_prose: "All checks passed cleanly.",
          sha_after: "def456",
          diff_added: 42,
          diff_removed: 7,
          files_touched: [
            { path: "src/foo.ts", added: 30, removed: 5 },
            { path: "tests/foo.test.ts", added: 12, removed: 2 },
          ],
        },
      },
    ]);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/cycle/c-42`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("c-42");
      expect(body).toContain("verified");
      expect(body).toContain("420s");
      expect(body).toContain("Engineer");
      expect(body).toContain("Verification");
      expect(body).toContain("Review");
      expect(body).toContain("Diff stats");
      expect(body).toContain("All checks passed cleanly.");
      expect(body).toContain("src/foo.ts");
      expect(body).toContain("+42");
      expect(body).toContain("-7");
      expect(body).toContain('href="/project/alpha"');
    } finally {
      server.stop();
    }
  });

  it("returns 404 when cycle id has no events in the fleet log", async () => {
    writeProjectsYaml(["alpha"]);
    writeFleetLog([
      {
        timestamp: "2026-04-20T10:00:00Z",
        event: "cycle_end",
        cycle_id: "c-1",
        project_id: "alpha",
        data: { outcome: "verified" },
      },
    ]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/cycle/ghost-cycle`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Cycle not found");
      expect(body).toContain("ghost-cycle");
    } finally {
      server.stop();
    }
  });

  it("returns 404 when fleet log does not exist", async () => {
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/cycle/c-1`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Cycle not found");
    } finally {
      server.stop();
    }
  });
});

describe("startServer — gs-285 GET /tail/:sessionId", () => {
  const FIXTURE_DIR = join(tmpdir(), `gs-server-tail-${process.pid}`);
  let originalRoot: string;

  function fleetLogPath(): string {
    return join(FIXTURE_DIR, "state", "_fleet", "PROGRESS.jsonl");
  }

  function writeFleetLog(events: Array<Record<string, unknown>>) {
    const dir = join(FIXTURE_DIR, "state", "_fleet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      fleetLogPath(),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  function appendFleetEvent(event: Record<string, unknown>) {
    appendFileSync(fleetLogPath(), JSON.stringify(event) + "\n", "utf8");
  }

  beforeEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    originalRoot = getRootDir();
    setRootDir(FIXTURE_DIR);
  });

  afterEach(() => {
    setRootDir(originalRoot);
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("serves /static/tail.js with application/javascript content-type", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/static/tail.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
      const body = await res.text();
      // Sanity: the load-bearing EventSource subscription is present.
      expect(body).toContain("new EventSource");
      expect(body).toContain("tail-events");
    } finally {
      server.stop();
    }
  });

  it("returns 200 HTML shell for /tail/:sessionId with the session id and tail.js reference", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/tail/sess-42`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      // Security headers land on every HTML response.
      expect(res.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("sess-42");
      expect(body).toContain("tail-events");
      expect(body).toContain("/static/tail.js");
      // Session ID is carried on a data attribute now, not an inline
      // script — keeps CSP strict (`script-src 'self'`).
      expect(body).toContain('data-session-id="sess-42"');
      expect(body).not.toContain("window.__GS_SESSION_ID");
    } finally {
      server.stop();
    }
  });

  it("rejects session ids with HTML/JS metacharacters as 404 rather than rendering", async () => {
    const server = await startServer({ port: 0 });
    try {
      // `<>"` in a session id should never reach the template. The
      // isSafeId allow-list (alphanumerics + `_-`) blocks the request
      // at the edge, so this is a 404 rather than an escape-hatched
      // 200. Stronger than the previous "escape at render time"
      // posture because the malicious input doesn't touch the renderer
      // at all.
      const sid = `s"<x>`;
      const res = await fetch(
        `${server.url}/tail/${encodeURIComponent(sid)}`,
      );
      expect(res.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("streams backlog events from /tail/:sessionId/stream as SSE", async () => {
    writeFleetLog([
      // session A event (should stream)
      {
        timestamp: "2026-04-20T10:00:00Z",
        event: "cycle_start",
        cycle_id: "c-1",
        project_id: "alpha",
        data: { session_id: "sess-A", task_id: "t-1" },
      },
      // session B event (should NOT stream — different session)
      {
        timestamp: "2026-04-20T10:00:01Z",
        event: "cycle_start",
        cycle_id: "c-9",
        project_id: "beta",
        data: { session_id: "sess-B", task_id: "t-9" },
      },
      // another session A event
      {
        timestamp: "2026-04-20T10:05:00Z",
        event: "cycle_end",
        cycle_id: "c-1",
        project_id: "alpha",
        data: { session_id: "sess-A", outcome: "verified" },
      },
    ]);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/tail/sess-A/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 3000;
      // Read until we've seen both sess-A events or we hit the deadline.
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("c-1") && buf.includes("cycle_end")) break;
      }
      await reader.cancel();

      expect(buf).toContain("data: ");
      expect(buf).toContain('"cycle_id":"c-1"');
      expect(buf).toContain('"event":"cycle_end"');
      // sess-B events must not leak into the sess-A stream.
      expect(buf).not.toContain('"session_id":"sess-B"');
      expect(buf).not.toContain("c-9");
    } finally {
      server.stop();
    }
  });

  it("pushes newly-appended events to an already-open stream", async () => {
    writeFleetLog([]);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/tail/sess-live/stream`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Drain the initial hello comment.
      const first = await reader.read();
      expect(first.done).toBe(false);
      const firstChunk = decoder.decode(first.value!, { stream: true });
      expect(firstChunk).toContain("tail opened for sess-live");

      // Now append an event AFTER the stream is open.
      appendFleetEvent({
        timestamp: "2026-04-20T11:00:00Z",
        event: "engineer_start",
        cycle_id: "c-42",
        project_id: "alpha",
        data: { session_id: "sess-live", command: "claude -p" },
      });

      let buf = "";
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("c-42")) break;
      }
      await reader.cancel();

      expect(buf).toContain('"event":"engineer_start"');
      expect(buf).toContain('"cycle_id":"c-42"');
    } finally {
      server.stop();
    }
  });

  it("returns 404 when /tail/ has no session id", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/tail/`);
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      server.stop();
    }
  });
});

describe("startServer — gs-286 GET /inbox", () => {
  const FIXTURE_DIR = join(tmpdir(), `gs-server-inbox-${process.pid}`);
  let originalRoot: string;

  function writeFleetMessages(entries: Array<Record<string, unknown>>) {
    const dir = join(FIXTURE_DIR, "state", "_fleet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "messages.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  beforeEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    originalRoot = getRootDir();
    setRootDir(FIXTURE_DIR);
  });

  afterEach(() => {
    setRootDir(originalRoot);
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("returns 200 HTML with recent messages grouped by date and links to cycles", async () => {
    const now = new Date();
    const today = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const yesterday = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
    writeFleetMessages([
      {
        timestamp: today,
        from: "generalstaff-bot",
        body: "verification failed on gs-99",
        kind: "blocker",
        refs: [{ cycle_id: "c-77", task_id: "gs-99" }],
      },
      {
        timestamp: yesterday,
        from: "dispatcher",
        body: "picked gamr for next slot",
        kind: "fyi",
        refs: [],
      },
    ]);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/inbox`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("Inbox");
      expect(body).toContain("verification failed on gs-99");
      expect(body).toContain("picked gamr for next slot");
      expect(body).toContain('href="/cycle/c-77"');
      expect(body).toContain("generalstaff-bot");
      expect(body).toContain("dispatcher");
      expect(body).toContain("blocker");
      // Inbox nav link should be marked active.
      expect(body).toMatch(/<a href="\/inbox"\s+aria-current="page">Inbox<\/a>/);
    } finally {
      server.stop();
    }
  });

  it("shows empty-state copy when there are no fleet messages", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/inbox`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Inbox empty");
      expect(body).toContain("all projects running clean");
    } finally {
      server.stop();
    }
  });

  it("escapes HTML in message bodies to prevent injection", async () => {
    const now = new Date();
    writeFleetMessages([
      {
        timestamp: new Date(now.getTime() - 60 * 1000).toISOString(),
        from: "ray",
        body: "<script>alert('xss')</script>",
        refs: [],
      },
    ]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/inbox`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("<script>alert('xss')</script>");
      expect(body).toContain("&lt;script&gt;");
    } finally {
      server.stop();
    }
  });
});

describe("startServer — gs-269 layout + / route + static stylesheet", () => {
  // Reset rootDir each test so earlier describe-blocks that call
  // setRootDir(FIXTURE_DIR) don't leak into / which reads projects.yaml
  // via getFleetOverview (cycle-404 fix side-effect, 2026-04-20).
  let originalRoot: string;
  beforeEach(() => {
    originalRoot = getRootDir();
    setRootDir(process.cwd());
  });
  afterEach(() => {
    setRootDir(originalRoot);
  });

  it("serves /static/style.css with 200 + text/css content-type", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/static/style.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
      const body = await res.text();
      // Sanity-check that it's actually the base stylesheet (not a
      // fallback-empty or the 404 body). The palette custom properties
      // are the load-bearing identity.
      expect(body).toContain("--paper:");
      expect(body).toContain("--ink:");
    } finally {
      server.stop();
    }
  });

  it("GET / returns 200 HTML with title tag, nav element, and link to style.css", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("<title>");
      expect(body).toContain("GeneralStaff");
      expect(body).toContain("<nav");
      expect(body).toContain('href="/static/style.css"');
    } finally {
      server.stop();
    }
  });

  it("GET / marks the Fleet nav link as aria-current='page'", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/`);
      const body = await res.text();
      // Fleet link should be active; Inbox should not.
      expect(body).toMatch(/<a href="\/"\s+aria-current="page">Fleet<\/a>/);
      expect(body).toMatch(/<a href="\/inbox">Inbox<\/a>/);
    } finally {
      server.stop();
    }
  });

  it("GET / renders fleet overview content: aggregate stats, project table headings, and Dispatch Orders CLI hints", async () => {
    // Regression test for the 2026-04-20 pre-HN audit finding that / was
    // just a "Dashboard scaffolding" placeholder. The / route now pulls
    // data via getFleetOverview and renders fleet aggregates + a per-project
    // table + CLI dispatch hints. This test locks in that structure so the
    // placeholder can't regress.
    //
    // Self-contained fixture: the surrounding describe block resets rootDir
    // to process.cwd() in beforeEach for tests that exercise empty/error
    // paths; this test specifically needs a populated projects.yaml so the
    // fleet-overview success path renders the table headings the assertions
    // below check for. Without the fixture, getFleetOverview throws on a
    // clean machine and the renderer falls back to an error message that
    // doesn't contain "cycles" or "<th>Project</th>".
    const FIXTURE_DIR = join(tmpdir(), `gs-server-fleet-${process.pid}`);
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(join(FIXTURE_DIR, "proj-alpha", "state", "alpha"), { recursive: true });
    const projectPath = join(FIXTURE_DIR, "proj-alpha").replace(/\\/g, "/");
    const projectsYaml = [
      "projects:",
      `  - id: alpha`,
      `    path: ${projectPath}`,
      `    priority: 1`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: bot/work`,
      `    auto_merge: false`,
      `    hands_off:`,
      `      - secret/`,
      "dispatcher:",
      "  max_parallel_slots: 1",
    ].join("\n");
    writeFileSync(join(FIXTURE_DIR, "projects.yaml"), projectsYaml, "utf8");
    const savedRoot = getRootDir();
    setRootDir(FIXTURE_DIR);

    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // No more placeholder text.
      expect(body).not.toContain("Dashboard scaffolding");
      // Fleet aggregates section.
      expect(body).toContain("Fleet overview");
      expect(body).toMatch(/projects/i);
      expect(body).toMatch(/cycles/i);
      expect(body).toMatch(/pass rate/i);
      // Per-project table headings.
      expect(body).toContain("Projects");
      expect(body).toMatch(/<th>Project<\/th>/);
      expect(body).toMatch(/<th>Pri<\/th>/);
      expect(body).toMatch(/<th>Bot-pickable<\/th>/);
      // Dispatch Orders section with CLI hints.
      expect(body).toContain("Dispatch orders");
      expect(body).toContain("generalstaff task add");
      expect(body).toContain("generalstaff session");
      expect(body).toContain("generalstaff cycle");
      expect(body).toContain("generalstaff stop");
    } finally {
      server.stop();
      setRootDir(savedRoot);
      rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it("still returns 404 for unknown routes (regression: the layout route shouldn't swallow everything)", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/does-not-exist`);
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      server.stop();
    }
  });

  it("serves /health unchanged after adding the layout route", async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("ok");
    } finally {
      server.stop();
    }
  });
});
