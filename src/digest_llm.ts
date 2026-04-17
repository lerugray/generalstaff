// GeneralStaff — LLM-backed digest narrative (gs-154, Phase 2)
//
// generateDigestNarrative produces a short plain-English paragraph
// summarizing what happened in a session. Wiring into writeDigest lives
// in gs-158; this module stays standalone and side-effect-free so it
// can be unit-tested with stub providers.

import type { CycleResult } from "./types";
import type { LLMProvider } from "./providers/types";
import { categorizeResults } from "./results";
import { fetchCommitSubject } from "./git";

export interface DigestNarrativeResult {
  narrative: string;
  fellBack: boolean;
  error?: string;
}

export async function generateDigestNarrative(
  results: CycleResult[],
  durationMinutes: number,
  provider: LLMProvider,
): Promise<DigestNarrativeResult> {
  const prompt = buildDigestNarrativePrompt(results, durationMinutes);
  try {
    const { content, error } = await provider.invoke(prompt, {
      maxTokens: 200,
      temperature: 0,
    });
    if (error) {
      return { narrative: "", fellBack: true, error };
    }
    const trimmed = (content ?? "").trim();
    if (trimmed.length === 0) {
      return { narrative: "", fellBack: true, error: "empty provider content" };
    }
    return { narrative: trimmed, fellBack: false };
  } catch (err) {
    return {
      narrative: "",
      fellBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildDigestNarrativePrompt(
  results: CycleResult[],
  durationMinutes: number,
): string {
  const { verified, failed } = categorizeResults(results);
  const lines: string[] = [];
  lines.push(
    `A GeneralStaff bot session ran for ${durationMinutes} minute(s) and produced ` +
      `${verified.length} verified cycle(s) and ${failed.length} failed cycle(s).`,
  );
  if (verified.length > 0) {
    lines.push("");
    lines.push("Verified cycles:");
    for (const r of verified) {
      const subject = fetchCommitSubject(r.cycle_start_sha, r.cycle_end_sha) || r.cycle_id;
      lines.push(`- ${r.project_id}: ${subject}`);
    }
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("Failed cycles:");
    for (const r of failed) {
      lines.push(`- ${r.project_id} (${r.final_outcome}): ${r.reason}`);
    }
  }
  lines.push("");
  lines.push(
    "Write a 2-4 sentence plain-English narrative of what happened this session. " +
      "No bullets, no headings, no markdown — just prose. Summarize what was " +
      "accomplished and what (if anything) went wrong.",
  );
  return lines.join("\n");
}
