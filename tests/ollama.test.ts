import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { checkOllamaReachable } from "../src/ollama";

describe("checkOllamaReachable", () => {
  const originalFetch = globalThis.fetch;
  const originalHost = process.env.OLLAMA_HOST;

  beforeEach(() => {
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
  });

  it("reports reachable when /api/tags returns 200", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkOllamaReachable();

    expect(result.reachable).toBe(true);
    expect(result.host).toBe("http://localhost:11434");
    expect(capturedUrl).toBe("http://localhost:11434/api/tags");
    expect(result.error).toBeUndefined();
  });

  it("honors OLLAMA_HOST override and strips trailing slash", async () => {
    process.env.OLLAMA_HOST = "http://192.168.1.50:11434/";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkOllamaReachable();

    expect(result.reachable).toBe(true);
    expect(result.host).toBe("http://192.168.1.50:11434");
    expect(capturedUrl).toBe("http://192.168.1.50:11434/api/tags");
  });

  it("reports unreachable when fetch throws (server down)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await checkOllamaReachable();

    expect(result.reachable).toBe(false);
    expect(result.error).toContain("fetch failed");
  });

  it("reports unreachable with HTTP status when server returns non-2xx", async () => {
    globalThis.fetch = (async () => {
      return new Response("nope", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }) as unknown as typeof fetch;

    const result = await checkOllamaReachable();

    expect(result.reachable).toBe(false);
    expect(result.error).toContain("503");
    expect(result.error).toContain("Service Unavailable");
  });

  it("reports timeout when fetch exceeds the timeout budget", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;

    const result = await checkOllamaReachable(50);

    expect(result.reachable).toBe(false);
    expect(result.error).toContain("timeout");
    expect(result.error).toContain("50ms");
  });
});
