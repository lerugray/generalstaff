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
  type QuorumPolicy,
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

export interface ReviewerProviderOverride {
  provider?: string;
  fallback?: string;
}

export async function runReviewer(
  project: ProjectConfig,
  cycleId: string,
  promptParams: ReviewerPromptParams,
  config?: DispatcherConfig,
  dryRun: boolean = false,
  cwdOverride?: string,
  providerOverride?: ReviewerProviderOverride,
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
  // gs-249 precedence: CLI override > env var > default "claude".
  // Override is scoped to this single call — process.env is not mutated.
  const provider = (
    providerOverride?.provider ??
    process.env.GENERALSTAFF_REVIEWER_PROVIDER ??
    "claude"
  ).toLowerCase();
  const fallback = (
    providerOverride?.fallback ??
    process.env.GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER ??
    ""
  ).toLowerCase();
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

async function spawnClaude(prompt: string, cwd: string, model?: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const args = [
      "-p", prompt,
      "--allowedTools", "Read,Bash,Grep,Glob",
      "--output-format", "text",
    ];
    // gs quorum-review: per-call model override (e.g. a specific Claude tier
    // as one quorum voice). Threaded as an arg — process.env is never touched
    // — so parallel voices don't race on a shared GENERALSTAFF_REVIEWER_MODEL.
    if (model) args.push("--model", model);
    const child = spawn(
      "claude",
      args,
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

// gs-187: per-provider concurrency semaphore for reviewer calls. When
// the dispatcher runs cycles in parallel (gs-186 / max_parallel_slots
// > 1), multiple cycles can hit the reviewer step simultaneously.
// Without throttling, parallel OpenRouter free-tier calls immediately
// 429-cascade; parallel Ollama calls saturate the local GPU. Each
// provider gets its own semaphore, keyed by lowercased provider name.
//
// Defaults (chosen per DESIGN.md §v6 Q2):
//   - claude      : unbounded (subscription auth; rate limits are
//                   handled upstream by claude -p itself)
//   - openrouter  : 2          (free-tier friendly; Ray's typical
//                   config. Paid-tier users can raise via env.)
//   - ollama      : 1          (local model, typically one-at-a-time)
//
// Override per provider via
//   GENERALSTAFF_REVIEWER_CONCURRENCY_<PROVIDER>=N
// e.g. GENERALSTAFF_REVIEWER_CONCURRENCY_OPENROUTER=8 for a paid tier.

class PromiseSemaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  isUnbounded(): boolean {
    return !Number.isFinite(this.limit);
  }

  inFlight(): number {
    if (this.isUnbounded()) return 0;
    return this.limit - this.available;
  }

  waiters(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.isUnbounded()) {
      return () => { /* no-op release */ };
    }
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        // The slot was pre-decremented in release() right before the
        // dequeue, so we already "own" the token — just return the
        // release closure.
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    if (this.isUnbounded()) return;
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter (keep available
      // decremented). Without this, a burst of waiters could race each
      // other on available.
      next();
    } else {
      this.available++;
    }
  }
}

const DEFAULT_REVIEWER_CONCURRENCY: Record<string, number> = {
  claude: Infinity,
  openrouter: 2,
  ollama: 1,
};

const reviewerSemaphores = new Map<string, PromiseSemaphore>();

export function reviewerConcurrencyLimit(provider: string): number {
  const p = provider.toLowerCase();
  const envKey = `GENERALSTAFF_REVIEWER_CONCURRENCY_${p.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_REVIEWER_CONCURRENCY[p] ?? Infinity;
}

function getReviewerSemaphore(provider: string): PromiseSemaphore {
  const p = provider.toLowerCase();
  const cached = reviewerSemaphores.get(p);
  if (cached) return cached;
  const sem = new PromiseSemaphore(reviewerConcurrencyLimit(p));
  reviewerSemaphores.set(p, sem);
  return sem;
}

// Test-only helper so a fixture can reset the semaphore map between
// runs. Production code should NEVER need this — semaphores live for
// the lifetime of the session process.
export function _resetReviewerSemaphoresForTests(): void {
  reviewerSemaphores.clear();
}

/**
 * Run `fn` while holding a token on the named provider's semaphore.
 *
 * gs-187 per-provider throttle: when the dispatcher runs cycles in
 * parallel (gs-186 / `max_parallel_slots > 1`), multiple cycles can hit
 * the reviewer step simultaneously. Without throttling, parallel
 * OpenRouter free-tier calls 429-cascade and parallel Ollama calls
 * saturate the local GPU. This helper acquires the provider's semaphore
 * before invoking `fn`, runs it, and releases the slot via `finally` so
 * the release happens even if `fn` throws.
 *
 * @typeParam T The return type of the wrapped function.
 * @param provider Lowercased provider name (`claude`, `openrouter`,
 *   `ollama`, or any custom name — unknown names default to unbounded).
 * @param fn The reviewer call to wrap.
 * @returns Whatever `fn` returns; re-throws any error `fn` throws.
 */
export async function withReviewerSemaphore<T>(
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  const sem = getReviewerSemaphore(provider);
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// Dispatches a single reviewer call to the configured provider.
// "claude" (default) uses spawnClaude; "openrouter" and "ollama" use
// the HTTP-based invokers below. Unknown provider names fall back to
// claude rather than erroring — the env var is user-facing.
// gs-187 wraps every dispatch in withReviewerSemaphore so parallel
// cycles (gs-186) serialize per-provider rather than stampeding.
export async function invokeReviewerProvider(
  provider: string,
  prompt: string,
  cwd: string,
  model?: string,
): Promise<string> {
  const p = provider.toLowerCase();
  return withReviewerSemaphore(p, async () => {
    if (p === "openrouter") return invokeOpenRouterReviewer(prompt, model);
    if (p === "ollama") return invokeOllamaReviewer(prompt, model);
    return spawnClaude(prompt, cwd, model);
  });
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
    model?: string;
    onFallback?: (primaryError: string) => void | Promise<void>;
  } = {},
): Promise<{ rawResponse: string; usedFallback: boolean }> {
  const provider = (opts.provider ?? "claude").toLowerCase();
  const fallback = (opts.fallback ?? "").toLowerCase();
  // model applies to the primary voice only; the fallback provider uses its
  // own default (a per-reviewer tuned model rarely transfers across providers).
  const primary = await invokeReviewerProvider(provider, prompt, cwd, opts.model);

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
export async function invokeOpenRouterReviewer(
  prompt: string,
  modelOverride?: string,
): Promise<string> {
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
    modelOverride ?? process.env.GENERALSTAFF_REVIEWER_MODEL ?? "qwen/qwen3-coder-30b-a3b-instruct";

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
// Validate OLLAMA_HOST before interpolating it into a fetch URL. Security
// audit 2026-04-19 (HIGH) flagged this as an SSRF surface: an env var set
// to something like http://169.254.169.254 (AWS IMDS) or an internal
// service URL would cause every reviewer invocation to POST the full
// prompt to that host. Fail loud rather than silently SSRF.
//
// Exported for tests. Throws on invalid input (caller should surface
// [REVIEWER ERROR] rather than propagate).
export function validateOllamaHost(raw: string): string {
  const cleaned = raw.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    throw new Error(
      `OLLAMA_HOST is not a valid URL: ${raw}. Expected http://host:port or https://host:port.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `OLLAMA_HOST must use http:// or https://, got ${url.protocol} (value: ${raw}).`,
    );
  }
  return cleaned;
}

export async function invokeOllamaReviewer(
  prompt: string,
  modelOverride?: string,
): Promise<string> {
  let host: string;
  try {
    host = validateOllamaHost(process.env.OLLAMA_HOST ?? "http://localhost:11434");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[REVIEWER ERROR] ${msg}`;
  }
  const model = modelOverride ?? process.env.GENERALSTAFF_REVIEWER_MODEL ?? "qwen3:8b";

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
  const direct = tryStrictParse(trimmed);
  if (direct) return { verdict: direct.verdict, response: direct, parseError: null };

  // Try extracting from ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const fenced = tryStrictParse(fenceMatch[1]);
    if (fenced) return { verdict: fenced.verdict, response: fenced, parseError: null };
  }

  // Try finding first { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const braced = tryStrictParse(braceMatch[0]);
    if (braced) return { verdict: braced.verdict, response: braced, parseError: null };

    // Permissive fallback (gs-171): across 2026-04-17→18 Qwen emitted
    // responses where an inner task_evidence item looked like
    // `"task": "status": "done"` (unescaped colon in a string value).
    // That single malformed inner field failed the strict parse for
    // the whole response — silently rolling back cycles that were
    // actually verified. The decision-critical fields (verdict,
    // reason, scope_drift_files, hands_off_violations, silent_failures)
    // are strict; task_evidence and notes are observational and may be
    // dropped or permissively recovered so the whole response isn't
    // lost.
    const permissive = tryPermissiveParse(braceMatch[0]);
    if (permissive) {
      return { verdict: permissive.verdict, response: permissive, parseError: null };
    }
  }

  // Fail-safe: can't parse → verification_failed
  return {
    verdict: "verification_failed",
    response: DEFAULT_FAILED_RESPONSE,
    parseError: `Could not parse reviewer response as JSON. Raw response starts with: ${trimmed.slice(0, 200)}`,
  };
}

function tryStrictParse(s: string): ReviewerResponse | null {
  try {
    const parsed = JSON.parse(s);
    if (isReviewerResponse(parsed)) return parsed;
  } catch {
    // Ignore — caller handles fallback
  }
  return null;
}

// Permissive fallback for the reviewer response. Replaces the observational
// task_evidence (array) and notes (string) field values with safe defaults
// and re-attempts a strict parse. If the decision-critical fields are
// well-formed, the response is recovered; after recovery we also try to
// salvage individual task_evidence items (drop malformed ones). Returns
// null if verdict still can't be extracted.
function tryPermissiveParse(src: string): ReviewerResponse | null {
  // Try progressive relaxation: task_evidence first, then notes.
  let working = replaceTopLevelValue(src, "task_evidence", "[]");
  let parsed = working ? tryStrictParse(working) : null;
  if (!parsed) {
    const both = replaceTopLevelValue(working ?? src, "notes", '""');
    parsed = both ? tryStrictParse(both) : null;
  }
  if (!parsed) return null;

  // Best-effort recovery of individual task_evidence items.
  const teSpan = findTopLevelValueSpan(src, "task_evidence");
  if (teSpan) {
    const arraySrc = src.slice(teSpan.start, teSpan.end);
    const items = recoverTaskEvidenceItems(arraySrc);
    if (items.length > 0) parsed.task_evidence = items;
  }

  return parsed;
}

// Walks a string value and returns the index of the character immediately
// after its closing quote. Caller must pass startIdx pointing at the
// opening '"'. Handles escape sequences.
function scanStringEnd(src: string, startIdx: number): number {
  let i = startIdx + 1;
  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return -1;
}

// Scans from a '[' '{' or '"' at startIdx and returns the index immediately
// after the matching close. String literals are skipped so bracket chars
// inside strings don't confuse the depth counter. Returns -1 on failure.
function scanValueEnd(src: string, startIdx: number): number {
  const open = src[startIdx];
  if (open === '"') return scanStringEnd(src, startIdx);
  if (open !== "[" && open !== "{") return -1;
  const close = open === "[" ? "]" : "}";
  let depth = 1;
  let i = startIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"') {
      const end = scanStringEnd(src, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

// Finds the span of a top-level object key's value. The key is matched at
// depth 1 of the root object only — preceded by '{' or ',' with optional
// whitespace — so keys appearing inside string values are not mistaken
// for top-level keys. Returns null if not found or value can't be bounded.
export function findTopLevelValueSpan(
  src: string,
  keyName: string,
): { start: number; end: number } | null {
  const escaped = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`[{,]\\s*"${escaped}"\\s*:\\s*`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= src.length) return null;
    const firstCh = src[valueStart];
    let valueEnd: number;
    if (firstCh === '"' || firstCh === "[" || firstCh === "{") {
      valueEnd = scanValueEnd(src, valueStart);
      if (valueEnd < 0) continue;
    } else {
      // Scalar (number/bool/null) — scan until , or }
      let j = valueStart;
      while (j < src.length && src[j] !== "," && src[j] !== "}") j++;
      valueEnd = j;
    }
    return { start: valueStart, end: valueEnd };
  }
  return null;
}

// Replaces the value of the named top-level key with `replacement`.
// Returns null if the key isn't found (caller can fall back to the
// original source).
function replaceTopLevelValue(
  src: string,
  keyName: string,
  replacement: string,
): string | null {
  const span = findTopLevelValueSpan(src, keyName);
  if (!span) return null;
  return src.slice(0, span.start) + replacement + src.slice(span.end);
}

// Given the raw source of a task_evidence array (including outer []),
// recover as many individual items as possible. Well-formed items are
// kept; malformed ones are dropped. Returns [] if nothing can be
// recovered.
function recoverTaskEvidenceItems(
  arraySrc: string,
): ReviewerResponse["task_evidence"] {
  const result: ReviewerResponse["task_evidence"] = [];
  // Locate each top-level '{' inside the array and attempt to parse it.
  let i = 0;
  while (i < arraySrc.length) {
    const ch = arraySrc[i];
    if (ch === "{") {
      const end = scanValueEnd(arraySrc, i);
      if (end < 0) break;
      const itemSrc = arraySrc.slice(i, end);
      const item = parseTaskEvidenceItem(itemSrc);
      if (item) result.push(item);
      i = end;
      continue;
    }
    if (ch === '"') {
      // Skip stray strings if any
      const end = scanStringEnd(arraySrc, i);
      if (end < 0) break;
      i = end;
      continue;
    }
    i++;
  }
  return result;
}

function parseTaskEvidenceItem(
  itemSrc: string,
): ReviewerResponse["task_evidence"][number] | null {
  try {
    const parsed = JSON.parse(itemSrc);
    if (isTaskEvidenceItem(parsed)) return parsed;
  } catch {
    // Fall through to sanitization
  }
  // Sanitize the known bad pattern: `"k": "a": "b"` → `"k": "a: b"`.
  // This matches the 2026-04-17/18 Qwen failure mode where `"task":
  // "status": "done"` appeared instead of a bare identifier.
  const sanitized = itemSrc.replace(
    /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"/,
    (_m, k: string, a: string, b: string) =>
      `"${k}": "${a}: ${b}"`,
  );
  if (sanitized !== itemSrc) {
    try {
      const parsed = JSON.parse(sanitized);
      if (isTaskEvidenceItem(parsed)) return parsed;
    } catch {
      // Give up
    }
  }
  return null;
}

function isTaskEvidenceItem(
  v: unknown,
): v is ReviewerResponse["task_evidence"][number] {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.task === "string" &&
    typeof o.evidence === "string" &&
    typeof o.confidence === "string" &&
    (o.confidence === "high" ||
      o.confidence === "medium" ||
      o.confidence === "low")
  );
}

// =====================================================================
// Quorum review (gs quorum-review, 2026-06-02)
// Multi-reviewer consensus with three load-bearing properties:
//   1. Parallel independence — each voice judges the same diff alone.
//   2. Synthesis, not pick-best — findings are UNIONED and tagged by
//      agreement count; reviewer B's real catch is never discarded
//      because reviewer A "scored better."
//   3. Honest-error + quorum contract — an errored voice is DROPPED,
//      never fabricated, never counted toward the quorum; below
//      min_real_reviews real voices it falls back to single-reviewer
//      and SAYS SO rather than presenting one survivor as quorum-vetted.
// See docs/quorum-review-design-2026-06-02.md.
// =====================================================================

const VERDICT_RANK: Record<ReviewerVerdict, number> = {
  verification_failed: 0,
  verified_weak: 1,
  verified: 2,
};

// One reviewer's contribution to a quorum, after it has run + parsed.
export interface QuorumVoice {
  label: string;
  provider: string;
  model?: string;
  verdict: ReviewerVerdict;
  response: ReviewerResponse | null;
  rawResponse: string;
  parseError: string | null;
  // True when this voice did NOT produce a real review (transport error,
  // timeout, or unparseable output). Honest-error contract hinges on this.
  errored: boolean;
  errorDetail?: string;
}

type FindingKind = "scope_drift" | "hands_off" | "silent_failure";

export interface TaggedFinding {
  finding: string;
  kind: FindingKind;
  agree: number; // how many REAL reviewers raised it (the confidence signal)
}

export interface QuorumSynthesis {
  verdict: ReviewerVerdict;
  response: ReviewerResponse; // merged, downstream-compatible
  realCount: number;
  droppedCount: number;
  quorumReached: boolean;
  perVoice: Array<{ label: string; verdict: ReviewerVerdict | "errored"; errorDetail?: string }>;
  taggedFindings: TaggedFinding[];
}

// A voice errored (no real review happened) when the invoker returned the
// [REVIEWER ERROR] sentinel OR the response could not be parsed to a real
// verdict (parseReviewerResponse sets parseError and falls back to the
// fail-safe). A genuine `verification_failed` has parseError === null and is
// NOT treated as an error — it's a real, counted vote.
export function voiceErrored(rawResponse: string, parseError: string | null): boolean {
  return rawResponse.trimStart().startsWith("[REVIEWER ERROR]") || parseError !== null;
}

function mostConservative(verdicts: ReviewerVerdict[]): ReviewerVerdict {
  return verdicts.reduce<ReviewerVerdict>(
    (acc, v) => (VERDICT_RANK[v] < VERDICT_RANK[acc] ? v : acc),
    "verified",
  );
}

// Aggregate verdict across the REAL voices, by policy.
//   conservative: any blocker from any reviewer holds the merge → the most
//     conservative verdict present wins. Safest when auto_merge is on.
//   majority: the verdict held by a STRICT majority wins; on a split (no
//     strict majority) it falls to the most conservative present so the
//     disagreement surfaces for the human relay (auto_merge: false case).
export function aggregateVerdict(
  verdicts: ReviewerVerdict[],
  policy: QuorumPolicy,
): ReviewerVerdict {
  if (verdicts.length === 0) return "verification_failed";
  if (policy === "conservative") return mostConservative(verdicts);
  const counts = new Map<ReviewerVerdict, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
  const half = verdicts.length / 2;
  let majority: ReviewerVerdict | null = null;
  for (const [v, c] of counts) if (c > half) majority = v;
  return majority ?? mostConservative(verdicts);
}

// Union the findings across real voices, tagged by how many raised each.
// Dedup is case-insensitive on the trimmed string, scoped per kind; a single
// voice listing the same finding twice counts once toward agreement.
export function unionFindings(real: QuorumVoice[]): TaggedFinding[] {
  const fields: Record<FindingKind, keyof ReviewerResponse> = {
    scope_drift: "scope_drift_files",
    hands_off: "hands_off_violations",
    silent_failure: "silent_failures",
  };
  const counts = new Map<string, TaggedFinding>();
  for (const v of real) {
    const r = v.response;
    if (!r) continue;
    for (const kind of Object.keys(fields) as FindingKind[]) {
      const arr = (r[fields[kind]] as string[]) ?? [];
      const seenThisVoice = new Set<string>();
      for (const raw of arr) {
        const norm = raw.trim();
        if (norm === "") continue;
        const key = `${kind}::${norm.toLowerCase()}`;
        if (seenThisVoice.has(key)) continue;
        seenThisVoice.add(key);
        const existing = counts.get(key);
        if (existing) existing.agree++;
        else counts.set(key, { finding: norm, kind, agree: 1 });
      }
    }
  }
  // Highest agreement first (then stable by text) — the operator reads the
  // 3/3 catches before the 1/3 uncertain ones.
  return [...counts.values()].sort(
    (a, b) => b.agree - a.agree || a.finding.localeCompare(b.finding),
  );
}

function dedupTaskEvidence(
  items: ReviewerResponse["task_evidence"],
): ReviewerResponse["task_evidence"] {
  const seen = new Set<string>();
  const out: ReviewerResponse["task_evidence"] = [];
  for (const it of items) {
    const k = `${it.task}::${it.evidence}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// The reason from the voice driving the verdict (most conservative real one)
// — so the headline cites the actual blocking rationale, not an arbitrary one.
function drivingReason(real: QuorumVoice[]): string {
  const sorted = [...real].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
  return sorted[0]?.response?.reason ?? "";
}

function quorumNotes(
  perVoice: QuorumSynthesis["perVoice"],
  realCount: number,
  droppedCount: number,
  quorumReached: boolean,
  policy: QuorumPolicy,
  minRealReviews: number,
  tagged: TaggedFinding[],
): string {
  const lines: string[] = [];
  lines.push(
    `Quorum review — ${realCount} real / ${droppedCount} dropped ` +
      `(policy=${policy}, min_real_reviews=${minRealReviews}).`,
  );
  if (!quorumReached) {
    lines.push(
      "Quorum NOT reached: fell back to single-reviewer over the surviving " +
        "voice(s). This verdict is NOT vetted by a full quorum.",
    );
  }
  lines.push("Per reviewer:");
  for (const pv of perVoice) {
    lines.push(
      `  - ${pv.label}: ${pv.verdict}` +
        (pv.errorDetail ? ` (dropped — ${pv.errorDetail.slice(0, 160)})` : ""),
    );
  }
  if (tagged.length) {
    lines.push("Findings (agreement = # reviewers raising it):");
    for (const t of tagged) lines.push(`  - [${t.agree}x] ${t.kind}: ${t.finding}`);
  } else {
    lines.push("No findings raised by any real reviewer.");
  }
  return lines.join("\n");
}

// PURE synthesis of already-run voices into one ReviewerResult-shaped verdict.
// Separated from orchestration so the honest-error + union contract is
// unit-testable without spawning real reviewers.
export function synthesizeQuorum(
  voices: QuorumVoice[],
  policy: QuorumPolicy,
  minRealReviews: number,
): QuorumSynthesis {
  const real = voices.filter((v) => !v.errored && v.response);
  const droppedCount = voices.length - real.length;
  const realCount = real.length;
  const quorumReached = realCount >= minRealReviews;

  const perVoice: QuorumSynthesis["perVoice"] = voices.map((v) => ({
    label: v.label,
    verdict: v.errored || !v.response ? "errored" : v.verdict,
    errorDetail: v.errored ? v.errorDetail ?? v.parseError ?? undefined : undefined,
  }));

  // Zero real reviews → fail safe (mirrors the single path's malformed
  // default). NEVER fabricate a passing verdict from errored voices.
  if (realCount === 0) {
    return {
      verdict: "verification_failed",
      response: {
        verdict: "verification_failed",
        reason:
          `Quorum review: 0/${voices.length} reviewers produced a real review ` +
          `(all errored or unparseable). Failing safe.`,
        scope_drift_files: [],
        hands_off_violations: [],
        task_evidence: [],
        silent_failures: [],
        notes: quorumNotes(perVoice, 0, droppedCount, false, policy, minRealReviews, []),
      },
      realCount: 0,
      droppedCount,
      quorumReached: false,
      perVoice,
      taggedFindings: [],
    };
  }

  const tagged = unionFindings(real);
  const realVerdicts = real.map((v) => v.verdict);
  // Sub-quorum: single-reviewer fallback = the conservative pick over the
  // survivors (don't elevate a lone survivor's optimism to a quorum pass).
  const verdict = quorumReached
    ? aggregateVerdict(realVerdicts, policy)
    : mostConservative(realVerdicts);

  const scope_drift_files = tagged.filter((t) => t.kind === "scope_drift").map((t) => t.finding);
  const hands_off_violations = tagged.filter((t) => t.kind === "hands_off").map((t) => t.finding);
  const silent_failures = tagged.filter((t) => t.kind === "silent_failure").map((t) => t.finding);
  const task_evidence = dedupTaskEvidence(real.flatMap((v) => v.response!.task_evidence));

  const headline = quorumReached
    ? `Quorum ${realCount}/${voices.length} reviewers (policy=${policy}) → ${verdict}.`
    : `Quorum NOT reached (${realCount}/${minRealReviews} real reviews, ` +
      `${droppedCount} dropped) — single-reviewer fallback → ${verdict}.`;
  const reason = drivingReason(real) ? `${headline} ${drivingReason(real)}` : headline;

  return {
    verdict,
    response: {
      verdict,
      reason,
      scope_drift_files,
      hands_off_violations,
      task_evidence,
      silent_failures,
      notes: quorumNotes(perVoice, realCount, droppedCount, quorumReached, policy, minRealReviews, tagged),
    },
    realCount,
    droppedCount,
    quorumReached,
    perVoice,
    taggedFindings: tagged,
  };
}

// Orchestrator: run every configured reviewer voice in parallel + independent,
// then synthesize. Returns the SAME ReviewerResult shape as runReviewer, so
// the cycle.ts call-site, the hands_off sanity check, and all logging consume
// it unchanged. Caller gates on project.review.reviewers.length > 1.
export async function runQuorumReview(
  project: ProjectConfig,
  cycleId: string,
  promptParams: ReviewerPromptParams,
  config?: DispatcherConfig,
  dryRun: boolean = false,
  cwdOverride?: string,
): Promise<ReviewerResult> {
  const reviewCfg = project.review!;
  const reviewers = reviewCfg.reviewers;
  const policy: QuorumPolicy = reviewCfg.quorum_policy ?? "conservative";
  const minReal = reviewCfg.min_real_reviews ?? 2;
  const prompt = buildReviewerPrompt(promptParams);
  const cwd = cwdOverride ?? project.path;

  await writeCycleFile(project.id, cycleId, "reviewer-prompt.txt", prompt, config);
  await appendProgress(
    project.id,
    "reviewer_invoked",
    {
      prompt_length: prompt.length,
      dry_run: dryRun,
      quorum: true,
      reviewer_count: reviewers.length,
      quorum_policy: policy,
      min_real_reviews: minReal,
    },
    cycleId,
  );

  if (dryRun) {
    const dryResponse: ReviewerResponse = {
      verdict: "verified",
      reason: "[DRY RUN] Simulated quorum pass",
      scope_drift_files: [],
      hands_off_violations: [],
      task_evidence: [],
      silent_failures: [],
      notes: `Dry run — ${reviewers.length} quorum reviewers not invoked`,
    };
    const raw = JSON.stringify(dryResponse, null, 2);
    await writeCycleFile(project.id, cycleId, "reviewer-response.txt", raw, config);
    await appendProgress(
      project.id,
      "reviewer_verdict",
      { verdict: "verified", reason: dryResponse.reason, dry_run: true, quorum: true },
      cycleId,
    );
    return { verdict: "verified", response: dryResponse, rawResponse: raw, parseError: null };
  }

  // Each invoker is already wrapped in the per-provider semaphore (gs-187),
  // so parallel OpenRouter/Ollama voices serialize per-provider rather than
  // stampeding the free tier / local GPU.
  const voices: QuorumVoice[] = await Promise.all(
    reviewers.map(async (entry): Promise<QuorumVoice> => {
      const label = entry.label ?? (entry.model ? `${entry.provider}:${entry.model}` : entry.provider);
      let rawResponse: string;
      try {
        const r = await invokeReviewerWithFallback(prompt, cwd, {
          provider: entry.provider,
          fallback: entry.fallback ?? "",
          model: entry.model,
          onFallback: async (primaryError) => {
            await appendProgress(
              project.id,
              "reviewer_fallback",
              {
                reviewer: label,
                primary_provider: entry.provider,
                fallback_provider: entry.fallback,
                primary_error: primaryError.slice(0, 500),
              },
              cycleId,
            );
          },
        });
        rawResponse = r.rawResponse;
      } catch (err) {
        rawResponse = `[REVIEWER ERROR] quorum voice ${label} threw: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      const { verdict, response, parseError } = parseReviewerResponse(rawResponse);
      const errored = voiceErrored(rawResponse, parseError);
      return {
        label,
        provider: entry.provider,
        model: entry.model,
        verdict,
        response,
        rawResponse,
        parseError,
        errored,
        errorDetail: errored ? parseError ?? rawResponse.slice(0, 200) : undefined,
      };
    }),
  );

  const synth = synthesizeQuorum(voices, policy, minReal);

  // Audit trail: full per-voice raw + the synthesis (the merged response is
  // also written to reviewer-response.txt below so existing tooling finds it).
  await writeCycleFile(
    project.id,
    cycleId,
    "reviewer-quorum.json",
    JSON.stringify(
      {
        policy,
        min_real_reviews: minReal,
        real: synth.realCount,
        dropped: synth.droppedCount,
        quorum_reached: synth.quorumReached,
        aggregate_verdict: synth.verdict,
        tagged_findings: synth.taggedFindings,
        per_voice: voices.map((v) => ({
          label: v.label,
          provider: v.provider,
          model: v.model,
          verdict: v.errored ? "errored" : v.verdict,
          errored: v.errored,
          error_detail: v.errorDetail,
          raw: v.rawResponse.slice(0, 4000),
        })),
      },
      null,
      2,
    ),
    config,
  );

  const mergedRaw = JSON.stringify(synth.response, null, 2);
  await writeCycleFile(project.id, cycleId, "reviewer-response.txt", mergedRaw, config);
  await appendProgress(
    project.id,
    "reviewer_response",
    { response_length: mergedRaw.length, quorum: true },
    cycleId,
  );
  await appendProgress(
    project.id,
    "reviewer_verdict",
    {
      verdict: synth.verdict,
      reason: synth.response.reason,
      scope_drift_files: synth.response.scope_drift_files,
      hands_off_violations: synth.response.hands_off_violations,
      silent_failures: synth.response.silent_failures,
      quorum: true,
      real_reviews: synth.realCount,
      dropped_reviews: synth.droppedCount,
      quorum_reached: synth.quorumReached,
    },
    cycleId,
  );

  return { verdict: synth.verdict, response: synth.response, rawResponse: mergedRaw, parseError: null };
}

