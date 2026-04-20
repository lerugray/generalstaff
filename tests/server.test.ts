import { describe, it, expect } from "bun:test";
import { startServer } from "../src/server";

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
