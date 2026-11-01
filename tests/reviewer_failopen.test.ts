// A review that did not really happen must never count as a pass: a cut-off
// diff, a nonzero or killed reviewer process, and a reply stopped at the
// output limit are all typed failures ("[REVIEWER ERROR] <kind>: ...").

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  _resetReviewerSemaphoresForTests,
  _setClaudeCommandForTests,
  invokeOllamaReviewer,
  invokeOpenRouterReviewer,
  invokeReviewerWithFallback,
  parseReviewerResponse,
  reviewerMaxDiffChars,
  reviewerFailureKind,
  runQuorumReview,
  runReviewer,
  terminateReviewerChildren,
  voiceErrored,
  type ReviewerAttempt,
} from "../src/reviewer";
import { buildReviewerPromptChecked, type ReviewerPromptParams } from "../src/prompts/reviewer";
import { setRootDir } from "../src/state";
import type { ProjectConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, "fixtures", "reviewer_failopen_test");
const FAKE = join(import.meta.dir, "fake-claude-reviewer.ts");

const VERIFIED = {
  verdict: "verified",
  reason: "diff matches gs-1",
  scope_drift_files: [],
  hands_off_violations: [],
  task_evidence: [{ task: "gs-1", evidence: "adds feature", confidence: "high" }],
  silent_failures: [],
  notes: "looks fine",
};
const VERIFIED_JSON = JSON.stringify(VERIFIED);
const CUT_AFTER_VERDICT =
  "```json\n" + JSON.stringify(VERIFIED, null, 2) + "\n```\n\nAdditional observations: the change in src/auth.ts appears to remove the token check, which would be a serious";

function params(fullDiff: string): ReviewerPromptParams {
  return {
    projectId: "demo",
    markedDoneTasks: "- gs-1 add feature",
    sessionNoteOrNone: "",
    fullDiff,
    diffStat: "1 file",
    verificationCommand: "bun test",
    verificationExitCode: 0,
    verificationOutputTruncated: "ok",
    handsOffList: [],
  };
}

const project = { id: "demo", path: TEST_DIR } as unknown as ProjectConfig;
const quorumProject = (reviewers: Array<Record<string, unknown>>): ProjectConfig =>
  ({
    id: "demo",
    path: TEST_DIR,
    review: { reviewers, quorum_policy: "conservative", min_real_reviews: 1 },
  }) as unknown as ProjectConfig;

const ENV_KEYS = [
  "GENERALSTAFF_REVIEWER_PROVIDER",
  "GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER",
  "GENERALSTAFF_REVIEWER_FIXED_VERDICT",
  "GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS",
  "GENERALSTAFF_REVIEWER_TIMEOUT_MS",
  "FAKE_CLAUDE_MODE",
  "OPENROUTER_API_KEY",
  "OLLAMA_HOST",
];
const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
  _resetReviewerSemaphoresForTests();
  _setClaudeCommandForTests([process.execPath, FAKE]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = originalFetch;
  _setClaudeCommandForTests(null);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function cycleFile(cycleId: string, name: string): string {
  return readFileSync(join(TEST_DIR, "state", "demo", "cycles", cycleId, name), "utf8");
}

function progressEvents(event: string): Array<{ data: Record<string, any> }> {
  return readFileSync(join(TEST_DIR, "state", "demo", "PROGRESS.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === event);
}

describe("input delivery: a cut-off diff is never reviewed", () => {
  it("reports truncation one char over the cap and none at the cap", () => {
    const over = buildReviewerPromptChecked(params("a".repeat(50_001)));
    expect(over.truncated).toBe(true);
    expect(over.diffCharsFull).toBe(50_001);
    expect(over.diffCharsSent).toBe(50_000);
    const at = buildReviewerPromptChecked(params("a".repeat(50_000)));
    expect(at.truncated).toBe(false);
  });

  it("truncation marker no longer points at a directory the reviewer cannot reach", () => {
    const over = buildReviewerPromptChecked(params("a".repeat(60_000)));
    expect(over.prompt).not.toContain("full diff in cycle directory");
  });

  it("fails closed without reaching the reviewer when the diff is over the cap", async () => {
    process.env.GENERALSTAFF_REVIEWER_PROVIDER = "fixed";
    process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verified";
    const r = await runReviewer(project, "c1", params("a".repeat(50_001)));
    expect(r.verdict).toBe("verification_failed");
    expect(r.rawResponse.startsWith("[REVIEWER ERROR] input_delivery_failed")).toBe(true);
  });

  for (const over of [50_500, 75_000, 99_500]) {
    it(`fails closed on a diff ${over - 50_000} chars over the cap`, async () => {
      process.env.GENERALSTAFF_REVIEWER_PROVIDER = "fixed";
      process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verified";
      const r = await runReviewer(project, `c${over}`, params("a".repeat(over)));
      expect(r.verdict).toBe("verification_failed");
    });
  }

  it("sends the whole diff when the configured cap fits it", async () => {
    process.env.GENERALSTAFF_REVIEWER_PROVIDER = "fixed";
    process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verified";
    process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS = "200000";
    const diff = "a".repeat(119_000) + "\nLAST-HUNK-MARKER";
    const r = await runReviewer(project, "c2", params(diff));
    expect(r.verdict).toBe("verified");
    const prompt = cycleFile("c2", "reviewer-prompt.txt");
    expect(prompt).toContain("LAST-HUNK-MARKER");
    expect(prompt).not.toContain("truncated at");
  });

  it("routes an oversize diff to the fallback when only the fallback cap fits", async () => {
    process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS_OPENROUTER = "200000";
    try {
      process.env.OPENROUTER_API_KEY = "k";
      mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "stop" }] });
      const r = await runReviewer(project, "c3", params("a".repeat(120_000)), undefined, false, undefined, {
        provider: "claude",
        fallback: "openrouter",
      });
      expect(r.provider).toBe("openrouter");
      expect(r.verdict).toBe("verified");
    } finally {
      delete process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS_OPENROUTER;
    }
  });

  it("drops a quorum voice whose cap is too small and counts the one that fits", async () => {
    process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verified";
    const p = quorumProject([
      { provider: "fixed", label: "small" },
      { provider: "fixed", label: "big", max_diff_chars: 200_000 },
    ]);
    const r = await runQuorumReview(p, "c4", params("a".repeat(120_000)));
    expect(r.verdict).toBe("verified");
    const q = JSON.parse(cycleFile("c4", "reviewer-quorum.json"));
    const small = q.per_voice.find((v: any) => v.label === "small");
    const big = q.per_voice.find((v: any) => v.label === "big");
    expect(small.errored).toBe(true);
    expect(small.failure_kind).toBe("input_delivery_failed");
    expect(big.errored).toBe(false);
  });
});

describe("claude -p exit: only a clean exit 0 is a verdict", () => {
  for (const code of [1, 2, 137]) {
    it(`exit ${code} after printing a verdict is a nonzero_exit failure`, async () => {
      process.env.FAKE_CLAUDE_MODE = `verdict_exit:${code}`;
      const r = await invokeReviewerWithFallback("p", TEST_DIR, { provider: "claude" });
      expect(reviewerFailureKind(r.rawResponse)).toBe("nonzero_exit");
      const parsed = parseReviewerResponse(r.rawResponse);
      expect(parsed.verdict).toBe("verification_failed");
      expect(voiceErrored(r.rawResponse, parsed.parseError)).toBe(true);
    });
  }

  it("runs the fallback reviewer after a nonzero exit", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_exit:1";
    process.env.OPENROUTER_API_KEY = "k";
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "stop" }] });
    const r = await invokeReviewerWithFallback("p", TEST_DIR, {
      provider: "claude",
      fallback: "openrouter",
    });
    expect(r.usedFallback).toBe(true);
  });

  it("a reviewer killed after printing a verdict is an error, never a verdict", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_hang";
    const pending = invokeReviewerWithFallback("p", TEST_DIR, { provider: "claude" });
    await new Promise((res) => setTimeout(res, 1500));
    terminateReviewerChildren("SIGKILL");
    const r = await pending;
    expect(reviewerFailureKind(r.rawResponse)).toBe("nonzero_exit");
  });

  it("the time limit is a reviewer_timeout and partial output is discarded", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_hang";
    process.env.GENERALSTAFF_REVIEWER_TIMEOUT_MS = "1500";
    const attempts: ReviewerAttempt[] = [];
    const r = await invokeReviewerWithFallback("p", TEST_DIR, { provider: "claude", attempts });
    expect(reviewerFailureKind(r.rawResponse)).toBe("reviewer_timeout");
    expect(attempts[0].timed_out).toBe(true);
  });

  it("exit 0 with no output is an empty_response failure", async () => {
    process.env.FAKE_CLAUDE_MODE = "empty";
    const r = await invokeReviewerWithFallback("p", TEST_DIR, { provider: "claude" });
    expect(reviewerFailureKind(r.rawResponse)).toBe("empty_response");
  });

  it("a quorum voice whose cap is too small runs on its fallback when that cap fits", async () => {
    process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS_OPENROUTER = "200000";
    process.env.OPENROUTER_API_KEY = "k";
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "stop" }] });
    try {
      const p = quorumProject([{ provider: "claude", label: "tiny", fallback: "openrouter", max_diff_chars: 1000 }]);
      const r = await runQuorumReview(p, "c6", params("a".repeat(120_000)));
      expect(r.verdict).toBe("verified");
      const q = JSON.parse(cycleFile("c6", "reviewer-quorum.json"));
      expect(q.per_voice[0].errored).toBe(false);
    } finally {
      delete process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS_OPENROUTER;
    }
  });

  it("an error report never parses as a verdict even if it holds verdict JSON", () => {
    const r = parseReviewerResponse(`[REVIEWER ERROR] nonzero_exit: x\nstderr: ${VERIFIED_JSON}`);
    expect(r.verdict).toBe("verification_failed");
    expect(r.parseError).not.toBeNull();
  });

  it("a bad cap value is ignored with one warning", () => {
    process.env.GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS = "12abc";
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      expect(reviewerMaxDiffChars("claude")).toBe(50_000);
      reviewerMaxDiffChars("claude");
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes("GENERALSTAFF_REVIEWER_MAX_DIFF_CHARS")).length).toBe(1);
  });

  it("a quorum voice that exits nonzero with a verdict is dropped, not counted", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_exit:1";
    process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verification_failed";
    const p = quorumProject([{ provider: "claude", label: "crashy" }, { provider: "fixed", label: "steady" }]);
    const r = await runQuorumReview(p, "c5", params("small diff"));
    expect(r.verdict).toBe("verification_failed");
    const q = JSON.parse(cycleFile("c5", "reviewer-quorum.json"));
    expect(q.per_voice.find((v: any) => v.label === "crashy").errored).toBe(true);
    expect(q.real).toBe(1);
  });

  it("exit 0 with a valid verdict still passes", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_exit:0";
    const r = await invokeReviewerWithFallback("p", TEST_DIR, { provider: "claude" });
    expect(parseReviewerResponse(r.rawResponse).verdict).toBe("verified");
  });
});

describe("HTTP reviewers: only a normal stop is a finished review", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "k";
  });

  it("OpenRouter finish_reason=length with a complete verdict is token_limit", async () => {
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "length" }] });
    expect(reviewerFailureKind(await invokeOpenRouterReviewer("p"))).toBe("token_limit");
  });

  it("OpenRouter length with a fenced verdict and cut-off prose is token_limit", async () => {
    mockFetch({ choices: [{ message: { content: CUT_AFTER_VERDICT }, finish_reason: "length" }] });
    expect(reviewerFailureKind(await invokeOpenRouterReviewer("p"))).toBe("token_limit");
  });

  for (const reason of ["content_filter", "error"]) {
    it(`OpenRouter finish_reason=${reason} is provider_error`, async () => {
      mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: reason }] });
      expect(reviewerFailureKind(await invokeOpenRouterReviewer("p"))).toBe("provider_error");
    });
  }

  it("OpenRouter 200 carrying an error payload is provider_error", async () => {
    mockFetch({ error: { message: "upstream blew up", code: 502 } });
    expect(reviewerFailureKind(await invokeOpenRouterReviewer("p"))).toBe("provider_error");
  });

  it("OpenRouter with no finish_reason and a normal verdict still passes", async () => {
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON } }] });
    expect(await invokeOpenRouterReviewer("p")).toBe(VERIFIED_JSON);
  });

  it("OpenRouter empty reply is empty_response and triggers the fallback", async () => {
    mockFetch({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
    expect(reviewerFailureKind(await invokeOpenRouterReviewer("p"))).toBe("empty_response");
  });

  it("Ollama with no done_reason and a normal verdict still passes", async () => {
    mockFetch({ message: { content: VERIFIED_JSON } });
    expect(await invokeOllamaReviewer("p")).toBe(VERIFIED_JSON);
  });

  it("OpenRouter finish_reason=stop returns the content", async () => {
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "stop" }] });
    expect(await invokeOpenRouterReviewer("p")).toBe(VERIFIED_JSON);
  });

  it("Ollama done_reason=length with non-empty verdict content is token_limit", async () => {
    mockFetch({ message: { content: VERIFIED_JSON }, done_reason: "length" });
    expect(reviewerFailureKind(await invokeOllamaReviewer("p"))).toBe("token_limit");
  });

  it("Ollama done_reason=stop returns the content", async () => {
    mockFetch({ message: { content: VERIFIED_JSON }, done_reason: "stop" });
    expect(await invokeOllamaReviewer("p")).toBe(VERIFIED_JSON);
  });

  it("a hung OpenRouter fetch times out and releases its semaphore slot", async () => {
    process.env.GENERALSTAFF_REVIEWER_TIMEOUT_MS = "300";
    globalThis.fetch = (() => new Promise(() => { /* never resolves */ })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) {
      // The OpenRouter limit is 2; a leaked slot would hang the third call.
      const raw = await invokeReviewerWithFallback("p", TEST_DIR, { provider: "openrouter" });
      expect(reviewerFailureKind(raw.rawResponse)).toBe("reviewer_timeout");
    }
  });
});

describe("per-attempt evidence", () => {
  it("logs failure kind, exit code and diff sizes for a failed attempt", async () => {
    process.env.FAKE_CLAUDE_MODE = "verdict_exit:3";
    process.env.GENERALSTAFF_REVIEWER_PROVIDER = "claude";
    await runReviewer(project, "e1", params("small diff"));
    const d = progressEvents("reviewer_response")[0].data;
    expect(d.failure_kind).toBe("nonzero_exit");
    expect(d.attempts[0].exit_code).toBe(3);
    expect(d.diff_chars_full).toBe(10);
    expect(d.diff_chars_sent).toBe(10);
  });

  it("logs no failure kind and the stop reason for a clean attempt", async () => {
    process.env.GENERALSTAFF_REVIEWER_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "k";
    mockFetch({ choices: [{ message: { content: VERIFIED_JSON }, finish_reason: "stop" }] });
    await runReviewer(project, "e2", params("small diff"));
    const d = progressEvents("reviewer_response")[0].data;
    expect(d.failure_kind).toBeNull();
    expect(d.attempts[0].stop_reason).toBe("stop");
  });

  it("logs the oversize refusal with zero chars sent", async () => {
    process.env.GENERALSTAFF_REVIEWER_PROVIDER = "fixed";
    process.env.GENERALSTAFF_REVIEWER_FIXED_VERDICT = "verified";
    await runReviewer(project, "e3", params("a".repeat(60_000)));
    const d = progressEvents("reviewer_response")[0].data;
    expect(d.failure_kind).toBe("input_delivery_failed");
    expect(d.diff_chars_full).toBe(60_000);
    expect(d.diff_chars_sent).toBe(0);
  });
});
