import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createOllamaProvider } from "../src/providers/ollama";
import type { ProviderDescriptor } from "../src/providers/types";

const baseDescriptor: ProviderDescriptor = {
  id: "ollama_llama3",
  kind: "ollama",
  model: "llama3:8b",
};

describe("createOllamaProvider (gs-151)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // ensure each test installs its own stub
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects descriptors of the wrong kind", () => {
    expect(() =>
      createOllamaProvider({
        id: "oops",
        kind: "openrouter",
        model: "x",
      } as ProviderDescriptor),
    ).toThrow(/kind='ollama'/);
  });

  it("invoke() returns content on 200 and posts the expected body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ message: { content: "hello world" }, done_reason: "stop" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const result = await provider.invoke("hi", { maxTokens: 123, temperature: 0.2 });

    expect(result.content).toBe("hello world");
    expect(result.error).toBeUndefined();
    expect(capturedUrl).toBe("http://localhost:11434/api/chat");
    const body = capturedBody as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
      options: { temperature: number; num_predict: number };
    };
    expect(body.model).toBe("llama3:8b");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.2);
    expect(body.options.num_predict).toBe(123);
  });

  it("invoke() applies defaults (maxTokens=800, temperature=0) when opts omitted", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ message: { content: "ok" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const result = await provider.invoke("x");

    expect(result.content).toBe("ok");
    const body = capturedBody as {
      options: { temperature: number; num_predict: number };
    };
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(800);
  });

  it("invoke() returns { content:'', error } on non-2xx response", async () => {
    globalThis.fetch = (async () => {
      return new Response("boom", { status: 500, statusText: "Internal Error" });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const result = await provider.invoke("hi");

    expect(result.content).toBe("");
    expect(result.error).toContain("500");
    expect(result.error).toContain("Internal Error");
    expect(result.error).toContain("boom");
    expect(result.error).not.toContain("[REVIEWER ERROR]");
  });

  it("invoke() returns { content:'', error } when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const result = await provider.invoke("hi");

    expect(result.content).toBe("");
    expect(result.error).toContain("fetch failed");
    expect(result.error).toContain("http://localhost:11434");
    expect(result.error).not.toContain("[REVIEWER ERROR]");
  });

  it("invoke() returns an error when response has empty content", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ message: { content: "" }, done_reason: "length" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const result = await provider.invoke("hi");

    expect(result.content).toBe("");
    expect(result.error).toContain("missing content");
    expect(result.error).toContain("truncated");
  });

  it("invoke() normalizes host with trailing slash", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ message: { content: "ok" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({
      ...baseDescriptor,
      host: "http://192.168.1.50:11434/",
    });
    await provider.invoke("hi");

    expect(capturedUrl).toBe("http://192.168.1.50:11434/api/chat");
  });

  it("health() returns reachable=true when /api/tags returns 200", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const h = await provider.health!();

    expect(h.reachable).toBe(true);
    expect(h.host).toBe("http://localhost:11434");
    expect(capturedUrl).toBe("http://localhost:11434/api/tags");
    expect(typeof h.latencyMs).toBe("number");
    expect(h.error).toBeUndefined();
  });

  it("health() returns reachable=false with HTTP status on non-2xx", async () => {
    globalThis.fetch = (async () => {
      return new Response("nope", { status: 503, statusText: "Service Unavailable" });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const h = await provider.health!();

    expect(h.reachable).toBe(false);
    expect(h.error).toContain("503");
    expect(h.error).toContain("Service Unavailable");
  });

  it("health() returns reachable=false when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider(baseDescriptor);
    const h = await provider.health!();

    expect(h.reachable).toBe(false);
    expect(h.host).toBe("http://localhost:11434");
    expect(h.error).toContain("fetch failed");
  });

  it("provider name reflects the descriptor id", () => {
    const provider = createOllamaProvider({
      ...baseDescriptor,
      id: "custom_ollama",
    });
    expect(provider.name).toBe("custom_ollama");
  });
});
