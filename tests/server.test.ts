import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
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

describe("startServer — gs-269 layout + / route + static stylesheet", () => {
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
