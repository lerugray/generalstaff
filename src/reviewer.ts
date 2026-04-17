// GeneralStaff — reviewer module (build step 11)
// Spawn claude -p reviewer, parse JSON verdict

import { spawn } from "child_process";
import { writeCycleFile } from "./state";
import { appendProgress } from "./audit";
import { buildReviewerPrompt, type ReviewerPromptParams } from "./prompts/reviewer";
import {
  isReviewerResponse,
  type ProjectConfig,
  type DispatcherConfig,
  type ReviewerVerdict,
  type ReviewerResponse,
} from "./types";

export interface ReviewerResult {
  verdict: ReviewerVerdict;
  response: ReviewerResponse | null;
  rawResponse: string;
  parseError: string | null;
}

const DEFAULT_FAILED_RESPONSE: ReviewerResponse = {
  verdict: "verification_failed",
  reason: "reviewer response was not valid JSON",
  scope_drift_files: [],
  hands_off_violations: [],
  task_evidence: [],
  silent_failures: [],
  notes: "Malformed reviewer response — defaulting to verification_failed (fail-safe)",
};

export async function runReviewer(
  project: ProjectConfig,
  cycleId: string,
  promptParams: ReviewerPromptParams,
  config?: DispatcherConfig,
  dryRun: boolean = false,
  cwdOverride?: string,
): Promise<ReviewerResult> {
  const prompt = buildReviewerPrompt(promptParams);

  // Write prompt to cycle directory for audit
  await writeCycleFile(
    project.id,
    cycleId,
    "reviewer-prompt.txt",
    prompt,
    config,
  );

  await appendProgress(project.id, "reviewer_invoked", {
    prompt_length: prompt.length,
    dry_run: dryRun,
  }, cycleId);

  if (dryRun) {
    const dryResponse: ReviewerResponse = {
      verdict: "verified",
      reason: "[DRY RUN] Simulated verification pass",
      scope_drift_files: [],
      hands_off_violations: [],
      task_evidence: [],
      silent_failures: [],
      notes: "Dry run — no actual review performed",
    };
    const raw = JSON.stringify(dryResponse, null, 2);
    await writeCycleFile(
      project.id,
      cycleId,
      "reviewer-response.txt",
      raw,
      config,
    );
    await appendProgress(project.id, "reviewer_response", {
      response_length: raw.length,
      dry_run: true,
    }, cycleId);
    await appendProgress(project.id, "reviewer_verdict", {
      verdict: "verified",
      reason: dryResponse.reason,
      dry_run: true,
    }, cycleId);
    return { verdict: "verified", response: dryResponse, rawResponse: raw, parseError: null };
  }

  // Provider routing. Default: claude -p (behavior since Phase 1). Opt-in:
  // GENERALSTAFF_REVIEWER_PROVIDER=openrouter uses the OpenRouter Chat
  // Completions API with Qwen3 Coder (see FUTURE-DIRECTIONS-2026-04-15.md
  // §2 tier taxonomy). GENERALSTAFF_REVIEWER_PROVIDER=ollama uses a
  // locally running Ollama server — zero-cost, offline, and the best
  // story for users who don't want to pay for an LLM API. The reviewer
  // is structured JSON-in/JSON-out so a tools-capable agent is not
  // required on any of these paths.
  const provider = (process.env.GENERALSTAFF_REVIEWER_PROVIDER ?? "claude").toLowerCase();
  const fallback = (process.env.GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER ?? "").toLowerCase();
  const cwd = cwdOverride ?? project.path;
  const { rawResponse } = await invokeReviewerWithFallback(prompt, cwd, {
    provider,
    fallback,
    onFallback: async (primaryError) => {
      await appendProgress(project.id, "reviewer_fallback", {
        primary_provider: provider,
        fallback_provider: fallback,
        primary_error: primaryError.slice(0, 500),
      }, cycleId);
    },
  });

  await writeCycleFile(
    project.id,
    cycleId,
    "reviewer-response.txt",
    rawResponse,
    config,
  );

  await appendProgress(project.id, "reviewer_response", {
    response_length: rawResponse.length,
  }, cycleId);

  // Parse JSON verdict
  const { verdict, response, parseError } = parseReviewerResponse(rawResponse);

  await appendProgress(project.id, "reviewer_verdict", {
    verdict,
    reason: response?.reason ?? parseError ?? "unknown",
    scope_drift_files: response?.scope_drift_files ?? [],
    hands_off_violations: response?.hands_off_violations ?? [],
    silent_failures: response?.silent_failures ?? [],
  }, cycleId);

  return { verdict, response, rawResponse, parseError };
}

async function spawnClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p", prompt,
        "--allowedTools", "Read,Bash,Grep,Glob",
        "--output-format", "text",
      ],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 10-minute timeout for reviewer
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, 10 * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stdout.length === 0) {
        resolve(
          `[REVIEWER ERROR] claude -p exited ${code}.\nstderr: ${stderr.slice(0, 2000)}`,
        );
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`[REVIEWER ERROR] Failed to spawn claude: ${err.message}`);
    });
  });
}

// Dispatches a single reviewer call to the configured provider.
// "claude" (default) uses spawnClaude; "openrouter" and "ollama" use
// the HTTP-based invokers below. Unknown provider names fall back to
// claude rather than erroring — the env var is user-facing.
export async function invokeReviewerProvider(
  provider: string,
  prompt: string,
  cwd: string,
): Promise<string> {
  const p = provider.toLowerCase();
  if (p === "openrouter") return invokeOpenRouterReviewer(prompt);
  if (p === "ollama") return invokeOllamaReviewer(prompt);
  return spawnClaude(prompt, cwd);
}

// Runs the primary reviewer provider and, if the response begins with
// `[REVIEWER ERROR]` (the sentinel used by every provider invoker for
// recoverable failures), retries once against the fallback provider.
// Fallback is skipped when unset, equal to the primary, or when the
// primary response is not an error. The onFallback callback fires
// before the retry so callers can log the attempt.
export async function invokeReviewerWithFallback(
  prompt: string,
  cwd: string,
  opts: {
    provider?: string;
    fallback?: string;
    onFallback?: (primaryError: string) => void | Promise<void>;
  } = {},
): Promise<{ rawResponse: string; usedFallback: boolean }> {
  const provider = (opts.provider ?? "claude").toLowerCase();
  const fallback = (opts.fallback ?? "").toLowerCase();
  const primary = await invokeReviewerProvider(provider, prompt, cwd);

  const shouldFallback =
    primary.startsWith("[REVIEWER ERROR]") &&
    fallback.length > 0 &&
    fallback !== provider;

  if (!shouldFallback) {
    return { rawResponse: primary, usedFallback: false };
  }

  if (opts.onFallback) await opts.onFallback(primary);
  const retry = await invokeReviewerProvider(fallback, prompt, cwd);
  return { rawResponse: retry, usedFallback: true };
}

// OpenRouter-backed reviewer invocation. Uses the OpenAI-compatible
// Chat Completions API. Defaults to qwen/qwen3-coder-30b-a3b-instruct
// ($0.07/$0.27 per M — very cheap); overridable via
// GENERALSTAFF_REVIEWER_MODEL. Returns the raw text content of the
// first choice's message, or a `[REVIEWER ERROR] ...` string that
// parseReviewerResponse will fail-safe to verification_failed on.
export async function invokeOpenRouterReviewer(prompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return (
      "[REVIEWER ERROR] OPENROUTER_API_KEY not set in environment. " +
      "Set it via `export OPENROUTER_API_KEY=...` or source it from " +
      "your provider .env file before running with " +
      "GENERALSTAFF_REVIEWER_PROVIDER=openrouter."
    );
  }
  const model =
    process.env.GENERALSTAFF_REVIEWER_MODEL ?? "qwen/qwen3-coder-30b-a3b-instruct";

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 4000,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return `[REVIEWER ERROR] OpenRouter ${response.status} ${response.statusText}: ${body.slice(0, 1500)}`;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return `[REVIEWER ERROR] OpenRouter response missing content: ${JSON.stringify(data).slice(0, 1500)}`;
    }
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[REVIEWER ERROR] OpenRouter fetch failed: ${msg}`;
  }
}

// Ollama-backed reviewer invocation. Calls a locally running Ollama
// server via its native chat API. Defaults to qwen3:8b (8B Qwen3 with
// strong code/JSON output, ~5 GB model); overridable via
// GENERALSTAFF_REVIEWER_MODEL. The host defaults to http://localhost:11434
// and can be overridden via OLLAMA_HOST (e.g. for a remote Ollama server
// on another machine in the LAN).
//
// Zero network cost, works offline, no API key needed — the best default
// for self-hosted users of GeneralStaff. Qwen3 enables a thinking/reasoning
// mode by default; num_predict is set high enough to cover both the
// reasoning pass and the final JSON verdict output.
export async function invokeOllamaReviewer(prompt: string): Promise<string> {
  const host = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.GENERALSTAFF_REVIEWER_MODEL ?? "qwen3:8b";

  try {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: {
          temperature: 0,
          num_predict: 8000,
        },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return `[REVIEWER ERROR] Ollama ${response.status} ${response.statusText}: ${body.slice(0, 1500)}`;
    }
    const data = (await response.json()) as {
      message?: { content?: string };
      done_reason?: string;
    };
    const content = data?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      const hint =
        data?.done_reason === "length"
          ? " (response truncated — consider raising num_predict)"
          : "";
      return `[REVIEWER ERROR] Ollama response missing content${hint}: ${JSON.stringify(data).slice(0, 1500)}`;
    }
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[REVIEWER ERROR] Ollama fetch failed (is the Ollama server running at ${host}?): ${msg}`;
  }
}

// Strips balanced <think>...</think> blocks from a reviewer response.
// Qwen3 and other reasoning models emit their internal chain-of-thought
// inside <think> tags before the final answer; those tags may themselves
// contain JSON-looking text that would poison the brace-matching parse
// below. Stack-based so nested tags are handled correctly. Unbalanced
// closing tags (more </think> than <think>) are silently dropped.
export function stripThinkTags(s: string): string {
  let result = "";
  let i = 0;
  let depth = 0;
  while (i < s.length) {
    if (s.startsWith("<think>", i)) {
      depth++;
      i += 7;
      continue;
    }
    if (s.startsWith("</think>", i)) {
      if (depth > 0) depth--;
      i += 8;
      continue;
    }
    if (depth === 0) result += s[i];
    i++;
  }
  return result;
}

export function parseReviewerResponse(raw: string): {
  verdict: ReviewerVerdict;
  response: ReviewerResponse | null;
  parseError: string | null;
} {
  // Try to extract JSON from the response
  // The reviewer is instructed to return JSON only, but might include
  // markdown fences or prose despite instructions
  const trimmed = stripThinkTags(raw).trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (isReviewerResponse(parsed)) {
      return { verdict: parsed.verdict, response: parsed, parseError: null };
    }
  } catch {
    // Try extracting JSON from markdown fences
  }

  // Try extracting from ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (isReviewerResponse(parsed)) {
        return { verdict: parsed.verdict, response: parsed, parseError: null };
      }
    } catch {
      // Fall through
    }
  }

  // Try finding first { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (isReviewerResponse(parsed)) {
        return { verdict: parsed.verdict, response: parsed, parseError: null };
      }
    } catch {
      // Fall through
    }
  }

  // Fail-safe: can't parse → verification_failed
  return {
    verdict: "verification_failed",
    response: DEFAULT_FAILED_RESPONSE,
    parseError: `Could not parse reviewer response as JSON. Raw response starts with: ${trimmed.slice(0, 200)}`,
  };
}

