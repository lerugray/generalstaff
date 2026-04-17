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
  // §2 tier taxonomy). The reviewer is structured JSON-in/JSON-out so a
  // tools-capable agent is not required on this path.
  const provider = (process.env.GENERALSTAFF_REVIEWER_PROVIDER ?? "claude").toLowerCase();
  const rawResponse =
    provider === "openrouter"
      ? await invokeOpenRouterReviewer(prompt)
      : await spawnClaude(prompt, cwdOverride ?? project.path);

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

export function parseReviewerResponse(raw: string): {
  verdict: ReviewerVerdict;
  response: ReviewerResponse | null;
  parseError: string | null;
} {
  // Try to extract JSON from the response
  // The reviewer is instructed to return JSON only, but might include
  // markdown fences or prose despite instructions
  const trimmed = raw.trim();

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

