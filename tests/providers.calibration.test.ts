// gs-156: Dual-run reviewer-calibration harness. For each fixture under
// tests/fixtures/reviewer_calibration/, invoke invokeReviewerProvider
// once with provider="claude" and once with provider="ollama", parse
// both responses, and assert the two verdicts AGREE. This is a GATE
// test for the Phase 2 tier taxonomy (FUTURE-DIRECTIONS-2026-04-15.md
// §2) — it catches Ollama drifting from Claude on straightforward
// reviewer scenarios.
//
// The test is skip-when-unavailable: Claude is skipped when CLAUDE_BINARY
// is not set, Ollama is skipped when checkOllamaReachable reports
// unreachable. On a CI machine with neither available, the test prints
// the skip reason and passes. On a developer machine with both, the
// test runs the real calls end-to-end — which is slow (minutes) but
// exactly the contract we want to gate on before shipping Phase 2.
//
// Fixture JSON files live under tests/fixtures/reviewer_calibration/.
// They are loaded at test-run time (not at module load) because some
// unrelated tests in this repo currently rm -rf the entire
// tests/fixtures directory between cases; deferring the read means
// the worst-case failure is a clean skip with a readable error rather
// than a module-load ENOENT that aborts the whole file.
//
// Do NOT add mocks here. The point of the calibration test is that it
// hits the real providers. If you want to test the plumbing without
// calling real providers, write that as a separate test against
// invokeReviewerProvider's branch behaviour.

import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  invokeReviewerProvider,
  parseReviewerResponse,
} from "../src/reviewer";
import {
  buildReviewerPrompt,
  type ReviewerPromptParams,
} from "../src/prompts/reviewer";
import { checkOllamaReachable } from "../src/ollama";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "reviewer_calibration");

const FIXTURE_NAMES = [
  "verified_simple",
  "hands_off_violation",
  "verification_failed_scope_drift",
] as const;

interface CalibrationFixture {
  expectedVerdict: "verified" | "verified_weak" | "verification_failed";
  params: ReviewerPromptParams;
}

function loadFixture(name: string): CalibrationFixture | null {
  const path = join(FIXTURES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as CalibrationFixture;
}

// 15-minute per-test timeout: the Claude reviewer path spawns
// `claude -p` which itself has a 10-minute timeout, and Ollama on a
// cold model can take a few minutes to warm up and emit tokens.
const CALIBRATION_TIMEOUT_MS = 15 * 60 * 1000;

describe("reviewer provider calibration", () => {
  for (const name of FIXTURE_NAMES) {
    it(
      `${name}: claude and ollama verdicts agree`,
      async () => {
        const fixture = loadFixture(name);
        if (!fixture) {
          console.log(
            `[calibration:${name}] skip: fixture file missing at ${FIXTURES_DIR}/${name}.json`,
          );
          return;
        }

        const claudeAvailable = Boolean(process.env.CLAUDE_BINARY);
        if (!claudeAvailable) {
          console.log(
            `[calibration:${name}] skip: no claude binary (CLAUDE_BINARY env not set)`,
          );
          return;
        }

        const ollamaReach = await checkOllamaReachable();
        if (!ollamaReach.reachable) {
          console.log(
            `[calibration:${name}] skip: ollama unreachable at ${ollamaReach.host} (${ollamaReach.error ?? "unknown error"})`,
          );
          return;
        }

        const prompt = buildReviewerPrompt(fixture.params);
        const cwd = process.cwd();
        const claudeRaw = await invokeReviewerProvider("claude", prompt, cwd);
        const ollamaRaw = await invokeReviewerProvider("ollama", prompt, cwd);

        const claudeParsed = parseReviewerResponse(claudeRaw);
        const ollamaParsed = parseReviewerResponse(ollamaRaw);

        if (claudeParsed.verdict !== ollamaParsed.verdict) {
          const diff = [
            `Reviewer calibration disagreement on fixture "${name}":`,
            `  expected verdict:   ${fixture.expectedVerdict}`,
            `  claude verdict:     ${claudeParsed.verdict}`,
            `  claude reason:      ${claudeParsed.response?.reason ?? "(none)"}`,
            `  ollama verdict:     ${ollamaParsed.verdict}`,
            `  ollama reason:      ${ollamaParsed.response?.reason ?? "(none)"}`,
            ``,
            `--- claude raw (first 1000 chars) ---`,
            claudeRaw.slice(0, 1000),
            ``,
            `--- ollama raw (first 1000 chars) ---`,
            ollamaRaw.slice(0, 1000),
          ].join("\n");
          throw new Error(diff);
        }

        expect(claudeParsed.verdict).toBe(ollamaParsed.verdict);
      },
      CALIBRATION_TIMEOUT_MS,
    );
  }
});
