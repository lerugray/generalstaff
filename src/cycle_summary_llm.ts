// GeneralStaff — LLM-backed cycle description (gs-155, Phase 2)
//
// generateCycleDescription produces a single-line (<=120 char) human-
// readable description of what a cycle did, suitable for digest
// "What got done" sections. Standalone and side-effect-free so it
// can be unit-tested with stub providers. Wiring into writeDigest is
// a follow-up (gs-158 covers the narrative path; cycle description
// replacement is deferred).

import type { CycleResult } from "./types";
import type { LLMProvider } from "./providers/types";

export interface CycleDescriptionResult {
  description: string;
  fellBack: boolean;
  error?: string;
}

const MAX_DESCRIPTION_CHARS = 120;

export async function generateCycleDescription(
  result: CycleResult,
  diffStat: string,
  provider: LLMProvider,
): Promise<CycleDescriptionResult> {
  const prompt = buildCycleDescriptionPrompt(result, diffStat);
  try {
    const { content, error } = await provider.invoke(prompt, {
      maxTokens: 80,
      temperature: 0,
    });
    if (error) {
      return { description: "", fellBack: true, error };
    }
    const cleaned = normalizeDescription(content ?? "");
    if (cleaned.length === 0) {
      return {
        description: "",
        fellBack: true,
        error: "empty provider content",
      };
    }
    return { description: cleaned, fellBack: false };
  } catch (err) {
    return {
      description: "",
      fellBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildCycleDescriptionPrompt(
  result: CycleResult,
  diffStat: string,
): string {
  const lines: string[] = [];
  lines.push(`Cycle ${result.cycle_id} in project ${result.project_id}.`);
  lines.push(`Outcome: ${result.final_outcome}.`);
  if (result.diff_stats) {
    const { files_changed, insertions, deletions } = result.diff_stats;
    lines.push(
      `Diff: ${files_changed} file(s), +${insertions}/-${deletions}.`,
    );
  }
  const trimmedStat = diffStat.trim();
  if (trimmedStat.length > 0) {
    lines.push("Diff stat summary:");
    lines.push(trimmedStat);
  }
  lines.push("");
  lines.push(
    "Write a single-line human-readable description (max ~80 characters) " +
      "of what this cycle did. No bullets, no markdown, no newlines — just " +
      "one short sentence.",
  );
  return lines.join("\n");
}

function normalizeDescription(raw: string): string {
  const singleLine = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_DESCRIPTION_CHARS) {
    return singleLine;
  }
  return singleLine.slice(0, MAX_DESCRIPTION_CHARS - 1) + "…";
}
