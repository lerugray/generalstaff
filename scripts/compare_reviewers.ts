#!/usr/bin/env bun
// Compare Claude vs OpenRouter Qwen verdicts on already-reviewed cycles.
//
// For each cycle ID passed as an arg, reads the archived
// reviewer-prompt.txt and reviewer-response.txt from
// state/generalstaff/cycles/<id>/, re-invokes the OpenRouter Qwen
// reviewer on the same prompt, and prints a verdict agreement report.
//
// Usage:
//   OPENROUTER_API_KEY=<key> bun scripts/compare_reviewers.ts <cycleId>...
//
// Or via the wrapper that loads the key from ~/.../MiroShark/.env:
//   bash scripts/compare_reviewers.sh <cycleId>...

import { readFileSync } from "fs";
import { join } from "path";
import {
  invokeOpenRouterReviewer,
  parseReviewerResponse,
} from "../src/reviewer";

const cycleIds = process.argv.slice(2);
if (cycleIds.length === 0) {
  console.error(
    "Usage: bun scripts/compare_reviewers.ts <cycleId1> [cycleId2...]",
  );
  process.exit(1);
}

const CYCLES_DIR = "state/generalstaff/cycles";

let matches = 0;
let mismatches = 0;

for (const cycleId of cycleIds) {
  console.log(`\n=== ${cycleId} ===`);
  const dir = join(CYCLES_DIR, cycleId);

  let prompt: string;
  let claudeResponseRaw: string;
  try {
    prompt = readFileSync(join(dir, "reviewer-prompt.txt"), "utf8");
    claudeResponseRaw = readFileSync(
      join(dir, "reviewer-response.txt"),
      "utf8",
    );
  } catch (err) {
    console.log(`  SKIP — could not read cycle artifacts: ${err}`);
    continue;
  }

  const claudeParsed = parseReviewerResponse(claudeResponseRaw);
  console.log(`  Claude verdict: ${claudeParsed.verdict}`);
  console.log(
    `  Claude reason:  ${(claudeParsed.response?.reason ?? "(none)").slice(0, 220)}`,
  );

  const qwenRaw = await invokeOpenRouterReviewer(prompt);
  const qwenParsed = parseReviewerResponse(qwenRaw);
  console.log(`  Qwen verdict:   ${qwenParsed.verdict}`);
  console.log(
    `  Qwen reason:    ${(qwenParsed.response?.reason ?? "(none)").slice(0, 220)}`,
  );

  const match = claudeParsed.verdict === qwenParsed.verdict;
  if (match) {
    matches++;
    console.log(`  AGREEMENT: MATCH`);
  } else {
    mismatches++;
    console.log(`  AGREEMENT: MISMATCH`);
    if (qwenParsed.parseError) {
      console.log(`  Qwen parse error: ${qwenParsed.parseError.slice(0, 300)}`);
      console.log(`  Qwen raw (first 600 chars): ${qwenRaw.slice(0, 600)}`);
    }
  }
}

console.log(
  `\n=== Summary ===\n  Cycles compared: ${cycleIds.length}\n  Matches:         ${matches}\n  Mismatches:      ${mismatches}`,
);
process.exit(mismatches > 0 ? 1 : 0);
