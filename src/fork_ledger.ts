// GeneralStaff — autonomous-mode fork ledger (gs-332, 2026-06-22, v0.8.0)
//
// A durable, deduped, cross-run JSON ledger of autonomous-mode decisions that
// need a human (Ray): design-forks, plus bot-safe items held back because the
// project is a live/revenue product. Resolved entries are KEPT
// (status="resolved") so they never re-surface; gate-REJECTs (slop) and
// over-cap mechanical holds are NOT ledgered. Surfaced as multiple-choice at
// the start of the next interactive session (see the catch-up rule).
//
// Faithful TS port of wintermute/fleet_loop.py's `_fork_id` + `update_fork_ledger`.
// The ledger DATA file is gitignored, per-host (Ray's private decision data);
// this machinery is public.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { withDirLock } from "./co_seat/dirlock";
import type {
  ForkLedger,
  ForkEntry,
  ForkKind,
  ResolutionKind,
  JudgmentVerdictKind,
  JudgmentClass,
} from "./types";

/** A scoped item the autonomous loop held back for Ray (the TS analogue of
 *  wintermute's `queued` dicts). Only KEEP items that are DESIGN-FORK, or
 *  bot-safe items on a live project, become ledger decisions. */
export interface HeldItem {
  project: string;
  title: string;
  verdict: JudgmentVerdictKind; // "keep" | "reject" | "error"
  cls?: JudgmentClass; // "bot-safe" | "design-fork" | undefined
}

/** The dedup key for a fork: `${project}::${slug(title)}`. Faithful port of
 *  wintermute's `_fork_id` — substitute every run of non-[a-z0-9] with a single
 *  "-", strip leading/trailing "-", THEN truncate to 56 (a trailing dash can
 *  reappear after the slice; that's the reference behavior, matched verbatim so
 *  ids stay stable across the Python loop and this one during the migration). */
export function forkId(project: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `${project}::${slug}`;
}

/** Read + parse the ledger. Missing file, unparseable JSON, or a valid-but-
 *  wrong-shaped file (no `forks` array) all yield an empty ledger — never
 *  throws (mirrors the Python `led.get("forks", [])` defense so downstream
 *  `.forks` access is always safe). */
export function readForkLedger(path: string): ForkLedger {
  if (!existsSync(path)) return { forks: [] };
  try {
    const led = JSON.parse(readFileSync(path, "utf-8")) as Partial<ForkLedger>;
    // Validate ENTRIES too, not just that `forks` is an array — a corrupted
    // file with a null/number/string inside the array would otherwise crash
    // pendingForks()/updateForkLedger() on `.status` / `.id` access.
    const forks = Array.isArray(led?.forks)
      ? (led.forks as unknown[]).filter(
          (f): f is ForkEntry =>
            f != null &&
            typeof f === "object" &&
            typeof (f as ForkEntry).id === "string",
        )
      : [];
    return {
      forks,
      updated: typeof led?.updated === "string" ? led.updated : undefined,
    };
  } catch {
    return { forks: [] };
  }
}

/** The pending decisions awaiting Ray (resolved entries are kept but filtered
 *  out here so they never re-surface). */
export function pendingForks(ledger: ForkLedger): ForkEntry[] {
  return ledger.forks.filter((f) => f.status === "pending");
}

/** Update the durable, deduped ledger with this run's held items and write it
 *  back. Only genuine Ray-decisions are recorded: a KEEP item that is a
 *  DESIGN-FORK, or a bot-safe KEEP item held because its project is live. An
 *  already-tracked id only refreshes `last_seen` (status/resolution/first_seen
 *  preserved). Returns the count of NEW pending decisions added this call.
 *  Faithful port of wintermute's `update_fork_ledger`. */
export function updateForkLedger(
  path: string,
  held: HeldItem[],
  liveProjects: Set<string>,
  ts: string,
): number {
  const led = readForkLedger(path);
  // Seed a Map from the existing forks in order, so iteration/insertion order
  // is preserved across runs (matches the Python `by_id` dict).
  const byId = new Map<string, ForkEntry>(led.forks.map((f) => [f.id, f]));

  let newCount = 0;
  for (const h of held) {
    const isDecision =
      h.verdict === "keep" &&
      (h.cls === "design-fork" || liveProjects.has(h.project));
    if (!isDecision) continue;

    const fid = forkId(h.project, h.title);
    const existing = byId.get(fid);
    if (existing) {
      existing.last_seen = ts; // already tracked; preserve status/resolution
      continue;
    }

    const kind: ForkKind = h.cls === "design-fork" ? "design-fork" : "live-held";
    byId.set(fid, {
      id: fid,
      project: h.project,
      title: h.title,
      kind,
      status: "pending",
      first_seen: ts,
      last_seen: ts,
      resolution: null,
    });
    newCount++;
  }

  led.forks = Array.from(byId.values());
  led.updated = ts;
  // Ensure the state dir exists — the ledger may be the first thing written
  // to a fresh state/ (e.g. autonomous dry-run before any cycle has run).
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(led, null, 1));
  return newCount;
}

// --- v11 co-seats: parking an item for a person (DESIGN.md §v11) ---

/** What `generalstaff co-seat park` records. The id is namespaced by the
 *  caller (`co-seat:<seat>::<project>::<slug>`) so it never collides with an
 *  autonomous-mode fork. */
export interface CoSeatForkInput {
  id: string;
  project: string;
  title: string;
  evidence?: string;
}

export function hasFork(path: string, id: string): boolean {
  return readForkLedger(path).forks.some((f) => f.id === id);
}

export function getFork(path: string, id: string): ForkEntry | undefined {
  return readForkLedger(path).forks.find((f) => f.id === id);
}

/** Add a `kind: "co-seat"` entry, or refresh an existing id's `last_seen`
 *  (status, resolution and first_seen are preserved; a given `evidence` is
 *  updated). Returns which one happened. Written atomically; this does not
 *  touch `updateForkLedger`'s behaviour. */
export function upsertCoSeatFork(
  path: string,
  input: CoSeatForkInput,
  ts: string,
): "added" | "refreshed" {
  // Two seats can park at once; the read-modify-write must not lose an entry.
  return withDirLock(`${path}.lock`, () => upsertCoSeatForkLocked(path, input, ts));
}

function upsertCoSeatForkLocked(
  path: string,
  input: CoSeatForkInput,
  ts: string,
): "added" | "refreshed" {
  const led = readForkLedger(path);
  const existing = led.forks.find((f) => f.id === input.id);
  let outcome: "added" | "refreshed";
  if (existing) {
    existing.last_seen = ts;
    if (input.evidence !== undefined) existing.evidence = input.evidence;
    outcome = "refreshed";
  } else {
    const entry: ForkEntry = {
      id: input.id,
      project: input.project,
      title: input.title,
      kind: "co-seat",
      status: "pending",
      first_seen: ts,
      last_seen: ts,
      resolution: null,
    };
    if (input.evidence !== undefined) entry.evidence = input.evidence;
    led.forks.push(entry);
    outcome = "added";
  }
  led.updated = ts;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(led, null, 1));
  renameSync(tmp, path);
  return outcome;
}

// --- v0.18.0: recording a resolution (docs/SPEC-GATE.md, "Picks are not rulings") ---

/** Fewest words a quote needs to count as the owner's words rather than a bare pick. */
export const MIN_RULING_WORDS = 3;

export interface ForkResolutionInput {
  resolution: string;
  /** The owner's own words for the decision, quoted. Needed for a `ruling`. */
  ownerWords?: string;
  /** Asked-for kind. Defaults to `ruling` with owner words, `seat_option` without. */
  kind?: ResolutionKind;
}

export type ForkResolutionResult =
  | { ok: true; entry: ForkEntry }
  | { ok: false; error: string };

/** Resolve a pending entry. A `ruling` needs quoted owner words; a pick without
 *  words is stored as a `seat_option`. Asking for `ruling` without words is refused. */
export function recordForkResolution(
  path: string,
  id: string,
  input: ForkResolutionInput,
  ts: string,
): ForkResolutionResult {
  const resolution = input.resolution.trim();
  if (!resolution) return { ok: false, error: "a resolution needs a non-empty description" };
  const words = (input.ownerWords ?? "").trim().replace(/\s+/g, " ");
  const hasWords = words.split(" ").filter(Boolean).length >= MIN_RULING_WORDS;
  if (input.kind === "ruling" && !hasWords) {
    return {
      ok: false,
      error: `a ruling must carry the owner's quoted words (at least ${MIN_RULING_WORDS} words); a pick without words is a seat option`,
    };
  }
  const kind: ResolutionKind = input.kind === "seat_option" ? "seat_option" : hasWords ? "ruling" : "seat_option";
  return withDirLock(`${path}.lock`, () => {
    const led = readForkLedger(path);
    const entry = led.forks.find((f) => f.id === id);
    if (!entry) return { ok: false as const, error: `no fork-ledger entry with id ${id}` };
    entry.status = "resolved";
    entry.resolution = resolution;
    entry.resolution_kind = kind;
    if (kind === "ruling") entry.owner_words = words;
    else delete entry.owner_words;
    entry.last_seen = ts;
    led.updated = ts;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(led, null, 1));
    renameSync(tmp, path);
    return { ok: true as const, entry };
  });
}
