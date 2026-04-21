// GeneralStaff — Claude Code consumption reader (gs-296).
//
// Wraps ccusage as a library dependency. ccusage owns the hard parts:
// locating the Claude Code data dir (env-var + XDG + legacy probes),
// parsing JSONL across project subdirs, deduping by (message.id,
// requestId), computing 5-hour block boundaries, and resolving
// mixed-model per-entry pricing via LiteLLM. This module does
// nothing but pick the active block from ccusage's output and map it
// to our ConsumptionSnapshot shape.
//
// See docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md §"Resolved
// questions (ccusage research, 2026-04-21)" for why the dep-add
// beat a from-scratch JSONL reader.

import { loadSessionBlockData } from "ccusage/data-loader";
import type { ConsumptionReader, ConsumptionSnapshot } from "./types";

// Narrow structural type matching the subset of ccusage's SessionBlock
// our mapping actually reads. Declared locally (rather than re-exported
// from ccusage) so the DI seam below can accept plain objects in tests
// without dragging ccusage's full type graph into the test fixtures.
export interface SessionBlockLike {
  startTime: Date;
  endTime: Date;
  actualEndTime?: Date;
  isGap?: boolean;
  costUSD: number;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  entries: unknown[];
}

// The loader signature we actually depend on. Matches ccusage's
// `loadSessionBlockData` shape but is expressed in terms of the
// local SessionBlockLike so tests can supply their own loader
// without needing ccusage's private types.
export type SessionBlockLoader = () => Promise<SessionBlockLike[]>;

export class ClaudeCodeReader implements ConsumptionReader {
  readonly name = "claude_code";

  // Constructor-injected loader. Defaults to the real ccusage call
  // in production; tests pass in a fake that returns canned blocks
  // (or throws) to exercise the mapping layer in isolation. Per
  // gs-296 spec — DO NOT re-test ccusage's own logic; test only
  // what this file does with ccusage's output.
  constructor(
    private readonly loadBlocks: SessionBlockLoader = loadSessionBlockData as unknown as SessionBlockLoader,
  ) {}

  async readCurrentWindow(): Promise<ConsumptionSnapshot | null> {
    let blocks: SessionBlockLike[];
    try {
      blocks = await this.loadBlocks();
    } catch {
      // ccusage throws when the Claude Code data dir is absent or
      // unreadable. That's not an error from our perspective — it
      // just means "no consumption data to compare against." The
      // session loop converts this to a fail-open WARN. Swallowing
      // the error here (rather than rethrowing) is deliberate.
      return null;
    }
    if (!blocks || blocks.length === 0) return null;

    // ccusage returns blocks in chronological order and interleaves
    // synthetic `isGap: true` entries to mark quiet periods. The
    // active window is the latest non-gap block. If every block is
    // a gap (pathological — Claude Code has never actually run on
    // this machine), treat it the same as "no data."
    let active: SessionBlockLike | undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!blocks[i].isGap) {
        active = blocks[i];
        break;
      }
    }
    if (!active) return null;

    const tokens =
      active.tokenCounts.inputTokens +
      active.tokenCounts.outputTokens +
      active.tokenCounts.cacheCreationInputTokens +
      active.tokenCounts.cacheReadInputTokens;

    return {
      total_usd: active.costUSD,
      total_tokens: tokens,
      cycles_used: active.entries.length,
      source: this.name,
      last_updated: active.actualEndTime ?? active.endTime,
      window_start: active.startTime,
    };
  }
}
