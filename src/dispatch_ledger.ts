// GeneralStaff — autonomous-mode dispatch ledger (gs-332, 2026-06-22, v0.8.0)
//
// A durable, deduped, cross-run JSON ledger of auto-dispatched cycles awaiting
// Ray's review+merge. The autonomous loop dispatches BOT-SAFE work through the
// normal cycle (engineer → verify → reviewer → bot branch) but NEVER pushes or
// merges — the work is automated, the MERGE stays gated on Ray. Without this
// ledger those cycles strand on the host's local clone; it surfaces them at the
// next session's catch-up (gs-bot-diff-review): for each, read the diff, relay
// it in plain English, then merge or delete.
//
// Faithful TS port of wintermute/fleet_loop.py's update_dispatch_ledger,
// adapted: GS dispatches reuse cycle.ts (shared bot branch), so the dedup key
// is the cycle_id (unique per dispatch) rather than the branch, and `sha` pins
// the exact reviewable commit. Resolved entries are KEPT (review_status=
// "resolved") so they never re-surface. The DATA file is gitignored, per-host.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { DispatchLedger, DispatchEntry, LedgerStatus } from "./types";

/** One dispatched cycle to record (the result of an autonomous executeCycle). */
export interface DispatchedCycle {
  project: string;
  title: string;
  branch: string;
  cycle_id: string;
  sha?: string;
  live: boolean;
  status: string; // cycle outcome
}

/** Read + parse the dispatch ledger. Missing file, unparseable JSON, or a
 *  wrong-shaped file (no `dispatches` array, or non-object entries) all yield
 *  an empty ledger — never throws (so downstream `.review_status` / `.id`
 *  access is always safe). */
export function readDispatchLedger(path: string): DispatchLedger {
  if (!existsSync(path)) return { dispatches: [] };
  try {
    const led = JSON.parse(readFileSync(path, "utf-8")) as Partial<DispatchLedger>;
    const dispatches = Array.isArray(led?.dispatches)
      ? (led.dispatches as unknown[]).filter(
          (d): d is DispatchEntry =>
            d != null &&
            typeof d === "object" &&
            typeof (d as DispatchEntry).id === "string",
        )
      : [];
    return {
      dispatches,
      updated: typeof led?.updated === "string" ? led.updated : undefined,
    };
  } catch {
    return { dispatches: [] };
  }
}

/** The dispatched cycles still awaiting review (resolved entries are kept but
 *  filtered out here so they don't re-surface). */
export function pendingDispatches(ledger: DispatchLedger): DispatchEntry[] {
  return ledger.dispatches.filter((d) => d.review_status === "pending");
}

/** Record this run's dispatched cycles in the durable, deduped ledger and write
 *  it back. Each dispatch is keyed by `${project}::${cycle_id}`; an already-
 *  recorded id only refreshes `last_seen` (review_status/resolution preserved).
 *  Returns the count of NEW branches recorded this call. Faithful port of
 *  wintermute's update_dispatch_ledger. */
export function updateDispatchLedger(
  path: string,
  dispatched: DispatchedCycle[],
  ts: string,
): number {
  const led = readDispatchLedger(path);
  const byId = new Map<string, DispatchEntry>(
    led.dispatches.map((d) => [d.id, d]),
  );

  let newCount = 0;
  for (const d of dispatched) {
    if (!d.cycle_id) continue; // nothing reviewable without a cycle to point at
    const id = `${d.project}::${d.cycle_id}`;
    const existing = byId.get(id);
    if (existing) {
      existing.last_seen = ts;
      continue;
    }
    byId.set(id, {
      id,
      project: d.project,
      title: d.title,
      branch: d.branch,
      cycle_id: d.cycle_id,
      sha: d.sha,
      live: d.live,
      status: d.status,
      review_status: "pending" as LedgerStatus,
      first_seen: ts,
      last_seen: ts,
      resolution: null,
    });
    newCount++;
  }

  led.dispatches = Array.from(byId.values());
  led.updated = ts;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(led, null, 1));
  return newCount;
}
