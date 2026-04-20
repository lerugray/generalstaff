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
