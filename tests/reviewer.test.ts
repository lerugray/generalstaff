import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  invokeOllamaReviewer,
  invokeOpenRouterReviewer,
  invokeReviewerWithFallback,
  parseReviewerResponse,
} from "../src/reviewer";

const VALID_RESPONSE = {
  verdict: "verified" as const,
  reason: "All tasks completed correctly",
  scope_drift_files: [],
  hands_off_violations: [],
  task_evidence: [{ task: "Fix login", evidence: "Updated auth.ts", result: "pass" }],
  silent_failures: [],
  notes: "Clean cycle",
};

describe("parseReviewerResponse", () => {
  it("parses raw JSON", () => {
    const raw = JSON.stringify(VALID_RESPONSE);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON in markdown fences", () => {
    const raw = "```json\n" + JSON.stringify(VALID_RESPONSE, null, 2) + "\n```";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.verdict).toBe("verified");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON in bare fences (no language tag)", () => {
    const raw = "```\n" + JSON.stringify(VALID_RESPONSE) + "\n```";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON with surrounding prose", () => {
    const raw =
      "Here is my review of the changes:\n\n" +
      JSON.stringify(VALID_RESPONSE) +
      "\n\nLet me know if you need anything else.";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("handles verified_weak verdict", () => {
    const weakResponse = { ...VALID_RESPONSE, verdict: "verified_weak" as const };
    const raw = JSON.stringify(weakResponse);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified_weak");
    expect(result.response?.verdict).toBe("verified_weak");
    expect(result.parseError).toBeNull();
  });

  it("handles verification_failed verdict", () => {
    const failedResponse = {
      ...VALID_RESPONSE,
      verdict: "verification_failed" as const,
      reason: "Tests do not pass",
    };
    const raw = JSON.stringify(failedResponse);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.response?.reason).toBe("Tests do not pass");
    expect(result.parseError).toBeNull();
  });

  it("returns verification_failed for completely malformed input", () => {
    const raw = "This is not JSON at all, just plain text rambling.";
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
    expect(result.response?.verdict).toBe("verification_failed");
  });

  it("returns verification_failed for empty input", () => {
    const result = parseReviewerResponse("");
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
  });

  it("returns verification_failed for JSON with invalid verdict", () => {
    const raw = JSON.stringify({ ...VALID_RESPONSE, verdict: "approved" });
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verification_failed");
    expect(result.parseError).not.toBeNull();
  });

  it("parses JSON that follows a <think>...</think> reasoning block", () => {
    const raw =
      "<think>Let me review the diff carefully and check each task.</think>\n" +
      JSON.stringify(VALID_RESPONSE);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("parses JSON correctly when <think> tags are nested", () => {
    const raw =
      "<think>outer reasoning <think>inner subthought</think> more outer</think>" +
      JSON.stringify(VALID_RESPONSE);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });

  it("ignores JSON-looking text inside <think> tags and parses the trailing real JSON", () => {
    const decoyVerdict = {
      verdict: "verification_failed",
      reason: "this is the decoy inside think",
    };
    const raw =
      "<think>Maybe the answer is " +
      JSON.stringify(decoyVerdict) +
      " but let me reconsider.</think>\n" +
      JSON.stringify(VALID_RESPONSE);
    const result = parseReviewerResponse(raw);
    expect(result.verdict).toBe("verified");
    expect(result.response?.reason).toBe("All tasks completed correctly");
    expect(result.parseError).toBeNull();
  });
});

describe("invokeOpenRouterReviewer", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.GENERALSTAFF_REVIEWER_MODEL;

  beforeEach(() => {
    delete process.env.GENERALSTAFF_REVIEWER_MODEL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.GENERALSTAFF_REVIEWER_MODEL;
    else process.env.GENERALSTAFF_REVIEWER_MODEL = originalModel;
  });

  it("returns error string when OPENROUTER_API_KEY is not set", async () => {
    delete process.env.OPENROUTER_API_KEY;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("test prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("OPENROUTER_API_KEY");
    expect(fetchCalled).toBe(false);
  });

  it("builds correct request body and parses content from well-formed response", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key-123";
    let capturedUrl: string = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "the reviewer verdict text" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("review this diff");

    expect(result).toBe("the reviewer verdict text");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe("qwen/qwen3-coder-30b-a3b-instruct");
    expect(body.messages).toEqual([{ role: "user", content: "review this diff" }]);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4000);
  });

  it("honors GENERALSTAFF_REVIEWER_MODEL override", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.GENERALSTAFF_REVIEWER_MODEL = "anthropic/claude-sonnet-4.6";
    let capturedBody: string | null = null;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await invokeOpenRouterReviewer("prompt");

    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody as unknown as string);
    expect(body.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("returns error string on non-2xx HTTP response", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      return new Response("upstream rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      });
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("429");
    expect(result).toContain("Too Many Requests");
    expect(result).toContain("upstream rate limited");
  });

  it("returns error string when response JSON is missing content", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("missing content");
  });

  it("returns error string when fetch throws", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      throw new Error("ENETUNREACH: network is down");
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("fetch failed");
    expect(result).toContain("ENETUNREACH");
  });

  it("returns error string when response body is not valid JSON", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      return new Response("not-json-at-all", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await invokeOpenRouterReviewer("prompt");

    // The fetch try/catch will catch the JSON parse error
    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("fetch failed");
  });
});

describe("invokeOllamaReviewer", () => {
  const originalFetch = globalThis.fetch;
  const originalHost = process.env.OLLAMA_HOST;
  const originalModel = process.env.GENERALSTAFF_REVIEWER_MODEL;

  beforeEach(() => {
    delete process.env.GENERALSTAFF_REVIEWER_MODEL;
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
    if (originalModel === undefined) delete process.env.GENERALSTAFF_REVIEWER_MODEL;
    else process.env.GENERALSTAFF_REVIEWER_MODEL = originalModel;
  });

  it("builds correct request body and parses content from well-formed response", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ message: { content: "the ollama verdict" }, done: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("review the diff");

    expect(result).toBe("the ollama verdict");
    expect(capturedUrl).toBe("http://localhost:11434/api/chat");
    expect(capturedInit?.method).toBe("POST");

    const body = JSON.parse(capturedInit?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      options: { temperature: number; num_predict: number };
    };
    expect(body.model).toBe("qwen3:8b");
    expect(body.messages).toEqual([{ role: "user", content: "review the diff" }]);
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(8000);
  });

  it("honors OLLAMA_HOST override and strips trailing slash", async () => {
    process.env.OLLAMA_HOST = "http://192.168.1.50:11434/";
    let capturedUrl = "";

    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ message: { content: "ok" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await invokeOllamaReviewer("prompt");

    expect(capturedUrl).toBe("http://192.168.1.50:11434/api/chat");
  });

  it("honors GENERALSTAFF_REVIEWER_MODEL override", async () => {
    process.env.GENERALSTAFF_REVIEWER_MODEL = "llama3:latest";
    let capturedBody: string | null = null;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ message: { content: "ok" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await invokeOllamaReviewer("prompt");

    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody as unknown as string);
    expect(body.model).toBe("llama3:latest");
  });

  it("returns error string on non-2xx HTTP response", async () => {
    globalThis.fetch = (async () => {
      return new Response("model not found", {
        status: 404,
        statusText: "Not Found",
      });
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("404");
    expect(result).toContain("Not Found");
    expect(result).toContain("model not found");
  });

  it("returns error string with truncation hint when done_reason is 'length'", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ message: { content: "" }, done_reason: "length" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("truncated");
    expect(result).toContain("num_predict");
  });

  it("returns error string when response is missing content", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("missing content");
  });

  it("returns error string when fetch throws (server not running)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("prompt");

    expect(result).toContain("[REVIEWER ERROR]");
    expect(result).toContain("fetch failed");
    expect(result).toContain("ECONNREFUSED");
    expect(result).toContain("Ollama server running");
  });

  it("returns message.content and ignores 'thinking' field when both present", async () => {
    // Reasoning models like qwen3 populate a separate `thinking` field
    // alongside `content`. The reviewer must return only `content` so
    // parseReviewerResponse sees the JSON verdict, not the chain of thought.
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          message: {
            content: "real answer",
            thinking: "internal reasoning that should be ignored",
          },
          done: true,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await invokeOllamaReviewer("prompt");

    expect(result).toBe("real answer");
    expect(result).not.toContain("internal reasoning");
  });
});

describe("invokeReviewerWithFallback", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalHost = process.env.OLLAMA_HOST;
  const originalModel = process.env.GENERALSTAFF_REVIEWER_MODEL;

  beforeEach(() => {
    delete process.env.GENERALSTAFF_REVIEWER_MODEL;
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
    if (originalModel === undefined) delete process.env.GENERALSTAFF_REVIEWER_MODEL;
    else process.env.GENERALSTAFF_REVIEWER_MODEL = originalModel;
  });

  it("falls back when primary returns a [REVIEWER ERROR] response", async () => {
    // Primary = openrouter with no API key → returns error synchronously.
    // Fallback = ollama, mocked to succeed.
    delete process.env.OPENROUTER_API_KEY;

    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ message: { content: "fallback ok" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fallbackLog: { value: string | null } = { value: null };
    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "openrouter",
      fallback: "ollama",
      onFallback: (primaryError) => {
        fallbackLog.value = primaryError;
      },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.rawResponse).toBe("fallback ok");
    expect(fallbackLog.value).not.toBeNull();
    expect(fallbackLog.value).toContain("[REVIEWER ERROR]");
    expect(fallbackLog.value).toContain("OPENROUTER_API_KEY");
    expect(urls).toEqual(["http://localhost:11434/api/chat"]);
  });

  it("does not fall back when primary succeeds", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "primary ok" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fallbackLog: { value: string | null } = { value: null };
    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "openrouter",
      fallback: "ollama",
      onFallback: (primaryError) => {
        fallbackLog.value = primaryError;
      },
    });

    expect(result.usedFallback).toBe(false);
    expect(result.rawResponse).toBe("primary ok");
    expect(fallbackLog.value).toBeNull();
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });

  it("returns the fallback error when both primary and fallback fail", async () => {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = (async () => {
      return new Response("ollama down", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;

    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "openrouter",
      fallback: "ollama",
    });

    expect(result.usedFallback).toBe(true);
    expect(result.rawResponse).toContain("[REVIEWER ERROR]");
    expect(result.rawResponse).toContain("Ollama 500");
  });

  it("does not retry when fallback equals primary", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response("nope", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;

    const fallbackLog: { value: string | null } = { value: null };
    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "ollama",
      fallback: "ollama",
      onFallback: (primaryError) => {
        fallbackLog.value = primaryError;
      },
    });

    expect(result.usedFallback).toBe(false);
    expect(result.rawResponse).toContain("[REVIEWER ERROR]");
    expect(callCount).toBe(1);
    expect(fallbackLog.value).toBeNull();
  });

  it("does not retry when fallback is unset", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response("nope", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;

    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "ollama",
      fallback: "",
    });

    expect(result.usedFallback).toBe(false);
    expect(result.rawResponse).toContain("[REVIEWER ERROR]");
    expect(callCount).toBe(1);
  });

  it("falls back from Ollama-unreachable to OpenRouter success", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";

    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/api/chat")) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "openrouter ok" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fallbackLog: { value: string | null } = { value: null };
    const result = await invokeReviewerWithFallback("prompt", "/tmp", {
      provider: "ollama",
      fallback: "openrouter",
      onFallback: (primaryError) => {
        fallbackLog.value = primaryError;
      },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.rawResponse).toBe("openrouter ok");
    expect(fallbackLog.value).not.toBeNull();
    expect(fallbackLog.value).toContain("[REVIEWER ERROR]");
    expect(fallbackLog.value).toContain("Ollama fetch failed");
    expect(urls).toEqual([
      "http://localhost:11434/api/chat",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });
});

