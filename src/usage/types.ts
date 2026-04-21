// GeneralStaff — consumption reader interface (gs-296).
//
// Provider-agnostic shape the session loop's budget gate (gs-298)
// reads once per cycle boundary and compares against the
// session_budget fields on DispatcherConfig / ProjectConfig
// (gs-297). Per-provider implementations live in
// src/usage/<provider>.ts and are selected by
// `dispatcher.session_budget.provider_source`.
//
// See docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md for the full
// design, including the rationale for block-based windows, the
// fail-open semantics (null → log + continue, NOT abort), and the
// v1 Claude-Code-first / multi-provider-post-v1 sequencing.

export interface ConsumptionSnapshot {
  // Accumulated cost inside the current consumption window.
  // Providers that can't compute USD (e.g. anthropic_api without
  // public remaining-quota API, ollama local-only) report 0 and
  // the session loop treats max_usd caps as non-binding for them.
  total_usd: number;
  // Sum of input + output + cache_creation + cache_read tokens
  // over the window. Providers that can't report tokens (e.g.
  // openrouter's credit-balance endpoint) report 0.
  total_tokens: number;
  // Count of distinct entries (Claude Code JSONL lines, API
  // invocations, etc.) within the window. Always meaningful;
  // every provider can at least count cycles.
  cycles_used: number;
  // Reader identifier — matches the BudgetProviderSource enum in
  // src/types.ts so log messages + session_complete events can
  // attribute the consumption figures unambiguously.
  source: string;
  // When the underlying data was last updated by the provider.
  // For Claude Code: the `actualEndTime` (or `endTime`) of the
  // active 5-hour block. Useful for stale-data detection —
  // dispatcher can log a warning if `now - last_updated > 5min`
  // while the bot is actively running.
  last_updated: Date;
  // Start of the consumption window. For claude_code this is the
  // active 5-hour block's `startTime`; for credit-balance-style
  // providers it's the session's own start snapshot.
  window_start: Date;
}

export interface ConsumptionReader {
  // Matches `BudgetProviderSource`. Kept as a bare string here so
  // this module doesn't import from src/types.ts (and invert the
  // dep direction of the types → consumers convention).
  readonly name: string;
  // Reads the current consumption window. Returns null when the
  // source is unavailable — the caller (session loop) converts
  // null into a single WARN log and proceeds without gating
  // (fail-open). NEVER throw for "source unavailable"; genuine
  // bugs in the mapping layer are still fair game to throw.
  readCurrentWindow(): Promise<ConsumptionSnapshot | null>;
}
