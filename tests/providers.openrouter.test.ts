import { afterEach, describe, expect, it } from "bun:test";
import { createOpenRouterProvider } from "../src/providers/openrouter";
import type { ProviderDescriptor } from "../src/providers/types";

const baseDescriptor: ProviderDescriptor = {
  id: "openrouter_ox",
  kind: "openrouter",
  model: "stealth/ox-alpha",
  api_key_env: "TEST_OPENROUTER_KEY",
};

describe("createOpenRouterProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_OPENROUTER_KEY;
  });

  it("rejects descriptors of the wrong kind", () => {
    expect(() =>
      createOpenRouterProvider({
        id: "oops",
        kind: "ollama",
        model: "x",
      } as ProviderDescriptor),
    ).toThrow(/kind='openrouter'/);
  });

  it("invoke() returns content on 200 and sends the key as a bearer header", async () => {
    process.env.TEST_OPENROUTER_KEY = "sk-test";
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody: unknown = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String((init?.headers as Record<string, string>)?.Authorization);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "hello world" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = createOpenRouterProvider(baseDescriptor);
    const result = await provider.invoke("hi", { maxTokens: 123, temperature: 0.2 });

    expect(result.content).toBe("hello world");
    expect(result.error).toBeUndefined();
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedAuth).toBe("Bearer sk-test");
    const body = capturedBody as {
      model: string;
      messages: { role: string; content: string }[];
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe("stealth/ox-alpha");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(123);
  });

  it("reports a 200 that carries an upstream error member as an error", async () => {
    // OpenRouter surfaces provider-side failures inside a 200 body. Treating
    // that as success would hand callers an empty digest and no explanation.
    process.env.TEST_OPENROUTER_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "upstream is down" } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await createOpenRouterProvider(baseDescriptor).invoke("hi");
    expect(result.content).toBe("");
    expect(result.error).toMatch(/upstream is down/);
  });

  it("reports HTTP failures without throwing", async () => {
    process.env.TEST_OPENROUTER_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })) as
      unknown as typeof fetch;

    const result = await createOpenRouterProvider(baseDescriptor).invoke("hi");
    expect(result.content).toBe("");
    expect(result.error).toMatch(/429/);
  });

  it("flags a truncated response rather than returning empty content silently", async () => {
    process.env.TEST_OPENROUTER_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await createOpenRouterProvider(baseDescriptor).invoke("hi");
    expect(result.error).toMatch(/truncated/);
  });
});
