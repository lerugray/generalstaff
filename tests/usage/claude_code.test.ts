import { describe, expect, it } from "bun:test";
import {
  ClaudeCodeReader,
  type SessionBlockLike,
  type SessionBlockLoader,
} from "../../src/usage/claude_code";

// Helper for building canned SessionBlock fixtures with sensible
// defaults. Only the fields our mapping actually reads are
// required; everything else gets a no-op default so the tests
// stay focused on the bits that matter (block selection + token
// summing + field mapping).
function block(overrides: Partial<SessionBlockLike> = {}): SessionBlockLike {
  const now = new Date("2026-04-21T18:00:00Z");
  return {
    startTime: overrides.startTime ?? new Date("2026-04-21T14:00:00Z"),
    endTime: overrides.endTime ?? new Date("2026-04-21T19:00:00Z"),
    actualEndTime: overrides.actualEndTime,
    isGap: overrides.isGap,
    costUSD: overrides.costUSD ?? 0,
    tokenCounts: overrides.tokenCounts ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    entries: overrides.entries ?? [],
  };
}

// Factory for an injected loader that resolves to the given blocks
// synchronously. Keeps the per-test boilerplate low.
function loaderOf(blocks: SessionBlockLike[]): SessionBlockLoader {
  return async () => blocks;
}

describe("ClaudeCodeReader (gs-296)", () => {
  it("maps an active block to a ConsumptionSnapshot", async () => {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: new Date("2026-04-21T14:00:00Z"),
          actualEndTime: new Date("2026-04-21T17:45:00Z"),
          costUSD: 1.23,
          tokenCounts: {
            inputTokens: 1000,
            outputTokens: 2000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 7000,
          },
          entries: [{}, {}, {}],
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    expect(snap).not.toBeNull();
    expect(snap!.total_usd).toBe(1.23);
    expect(snap!.total_tokens).toBe(10500);
    expect(snap!.cycles_used).toBe(3);
    expect(snap!.source).toBe("claude_code");
    expect(snap!.window_start.toISOString()).toBe("2026-04-21T14:00:00.000Z");
    expect(snap!.last_updated.toISOString()).toBe("2026-04-21T17:45:00.000Z");
  });

  it("falls back to endTime when actualEndTime is absent", async () => {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          endTime: new Date("2026-04-21T19:00:00Z"),
          actualEndTime: undefined,
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    expect(snap!.last_updated.toISOString()).toBe("2026-04-21T19:00:00.000Z");
  });

  it("returns null when the loader throws (source unavailable)", async () => {
    const reader = new ClaudeCodeReader(async () => {
      throw new Error("ENOENT: Claude Code data dir not found");
    });
    const snap = await reader.readCurrentWindow();
    expect(snap).toBeNull();
  });

  it("returns null when the loader resolves to an empty array", async () => {
    const reader = new ClaudeCodeReader(loaderOf([]));
    const snap = await reader.readCurrentWindow();
    expect(snap).toBeNull();
  });

  it("returns null when every block is a gap", async () => {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({ isGap: true }),
        block({ isGap: true }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    expect(snap).toBeNull();
  });

  it("picks the most recent non-gap block when blocks are mixed", async () => {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: new Date("2026-04-21T09:00:00Z"),
          endTime: new Date("2026-04-21T14:00:00Z"),
          costUSD: 5.0,
          entries: [{}],
        }),
        block({
          startTime: new Date("2026-04-21T14:00:00Z"),
          endTime: new Date("2026-04-21T19:00:00Z"),
          isGap: true,
        }),
        block({
          startTime: new Date("2026-04-21T19:00:00Z"),
          endTime: new Date("2026-04-22T00:00:00Z"),
          costUSD: 2.5,
          entries: [{}, {}],
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    expect(snap!.total_usd).toBe(2.5);
    expect(snap!.cycles_used).toBe(2);
    expect(snap!.window_start.toISOString()).toBe("2026-04-21T19:00:00.000Z");
  });

  it("falls back to the prior non-gap block if the latest block is a gap", async () => {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: new Date("2026-04-21T09:00:00Z"),
          costUSD: 3.0,
          entries: [{}],
        }),
        block({
          startTime: new Date("2026-04-21T14:00:00Z"),
          isGap: true,
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    expect(snap!.total_usd).toBe(3.0);
    expect(snap!.window_start.toISOString()).toBe("2026-04-21T09:00:00.000Z");
  });

  it("reports zero totals when the active block has no usage", async () => {
    // A freshly-rolled block can have zero entries + zero cost. The
    // reader must still return a non-null snapshot so the session
    // loop's budget comparison sees "consumption = 0" rather than
    // "consumption unavailable, fail open."
    const reader = new ClaudeCodeReader(loaderOf([block()]));
    const snap = await reader.readCurrentWindow();
    expect(snap).not.toBeNull();
    expect(snap!.total_usd).toBe(0);
    expect(snap!.total_tokens).toBe(0);
    expect(snap!.cycles_used).toBe(0);
  });

  it("exposes its source name as 'claude_code'", async () => {
    const reader = new ClaudeCodeReader(loaderOf([block()]));
    expect(reader.name).toBe("claude_code");
    const snap = await reader.readCurrentWindow();
    expect(snap!.source).toBe("claude_code");
  });
});
