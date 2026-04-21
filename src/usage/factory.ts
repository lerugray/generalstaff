// GeneralStaff — ConsumptionReader factory (gs-298).
//
// Given a BudgetProviderSource, returns the concrete ConsumptionReader
// instance the session loop should use. Isolated in its own module so
// tests can stub the whole factory (via DI on startSession) without
// touching the individual reader modules.

import { ClaudeCodeReader } from "./claude_code";
import type { ConsumptionReader } from "./types";
import type { BudgetProviderSource } from "../types";

// Returns null for providers whose readers aren't implemented yet.
// The session loop handles null readers the same as "source
// unavailable" — one fail-open WARN per session, continue without
// gating. Downstream gs-296 follow-ups (openrouter, anthropic_api,
// ollama) will replace these null returns with real implementations.
export function createConsumptionReader(
  source: BudgetProviderSource,
): ConsumptionReader | null {
  switch (source) {
    case "claude_code":
      return new ClaudeCodeReader();
    case "openrouter":
    case "anthropic_api":
    case "ollama":
      return null;
  }
}
