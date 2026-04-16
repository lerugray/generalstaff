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

  // Spawn claude -p
  const rawResponse = await spawnClaude(prompt, cwdOverride ?? project.path);

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
