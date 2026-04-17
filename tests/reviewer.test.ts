import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { invokeOpenRouterReviewer, parseReviewerResponse } from "../src/reviewer";

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
