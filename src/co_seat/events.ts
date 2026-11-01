// GeneralStaff — co-seats: wake events (DESIGN.md §v11 driver step 3).
//
// Collected each tick without side effects. The watermark returned is the state
// at COLLECTION time; the driver persists it only when it starts a turn, so
// anything that lands during the turn is seen next time and anything collected
// but not yet delivered (a turn is not due yet) is collected again.
//
// Sources: new `cycle_end` records in the seat's projects' PROGRESS.jsonl,
// new Aide inbox rows that are not tagged `outbound`, done_globs matches that
// are new or whose mtime/size changed, and notes (first turn, heartbeat,
// previous turn killed, previous turn's state restored). The first collection
// of a seat records a baseline and reports nothing as new.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync } from "fs";
import { join, relative } from "path";
import { aidePath, loadAides, readInbox } from "../aides";
import { getStateDir } from "../state";
import { isProgressEntry } from "../types";
import { resolveSeatPath, type SeatContext } from "./config";
import { writeFileAtomic } from "./control";

export interface Watermark {
  version: 1;
  /** project id -> byte offset just past the last complete PROGRESS.jsonl line seen */
  progress: Record<string, number>;
  /** Aide name -> number of inbox rows seen */
  inbox: Record<string, number>;
  /** done_globs match (path relative to the GS root) -> signature when last seen */
  globs: Record<string, { mtimeMs: number; size: number }>;
}

export interface PreviousTurn {
  n: number;
  end_reason: string;
  state_restored: boolean;
  exit_code?: number | null;
  duration_ms?: number;
}

/** A turn that fails this quickly did no real work. */
export const FAST_FAILURE_MS = 60_000;

/** A turn that could not start, or exited non-zero within a minute. */
export function isFastFailure(t: Pick<PreviousTurn, "end_reason" | "exit_code" | "duration_ms">): boolean {
  if (t.end_reason === "spawn_error") return true;
  return (
    t.end_reason === "exit" &&
    t.exit_code !== 0 &&
    typeof t.duration_ms === "number" &&
    t.duration_ms < FAST_FAILURE_MS
  );
}

/** Event lines a failed turn never acted on, kept for the next turn. */
export interface CarryEntry {
  from_turn: number;
  reason: string;
  line: string;
}

export const carryPath = (dir: string) => join(dir, "carry.json");

export function readCarry(dir: string): CarryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(carryPath(dir), "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return (raw.entries as unknown[]).filter(
      (e): e is CarryEntry =>
        !!e &&
        typeof (e as CarryEntry).line === "string" &&
        typeof (e as CarryEntry).from_turn === "number" &&
        typeof (e as CarryEntry).reason === "string",
    );
  } catch {
    return [];
  }
}

export function writeCarry(dir: string, entries: CarryEntry[]): void {
  if (entries.length === 0) {
    rmSync(carryPath(dir), { force: true });
    return;
  }
  writeFileAtomic(carryPath(dir), JSON.stringify({ entries }, null, 1) + "\n");
}

/** Why a turn failed, in a few words, for the carried lines and the note. */
export function failureReason(t: Pick<PreviousTurn, "end_reason" | "exit_code" | "duration_ms">): string {
  if (t.end_reason === "spawn_error") return "it could not start";
  const secs = typeof t.duration_ms === "number" ? ` after ${Math.round(t.duration_ms / 1000)} s` : "";
  return `exit code ${t.exit_code ?? "none"}${secs}`;
}

export interface CollectOptions {
  /** No turn has ever run for this seat. */
  firstTurn?: boolean;
  /** The heartbeat interval, not an event, is waking this turn. */
  heartbeat?: boolean;
  previous?: PreviousTurn | null;
  /** Events a failed turn never acted on; delivered first, labelled as carried. */
  carried?: CarryEntry[];
  /** Cap per kind of event line; the rest are summarised. Default 50. */
  maxLinesPerKind?: number;
}

export interface CollectedEvents {
  /** One plain line per event or note. */
  lines: string[];
  newWatermark: Watermark;
  counts: { cycles: number; inbox: number; sentinels: number; carried: number };
  /** The new event lines alone (cycles, inbox, sentinels), uncapped; what a failed turn carries on. */
  eventLines: string[];
  /** Real events exist, new or carried (notes do not count). */
  hasEvents: boolean;
}

export const watermarkPath = (dir: string) => join(dir, "watermark.json");

export function emptyWatermark(): Watermark {
  return { version: 1, progress: {}, inbox: {}, globs: {} };
}

export function readWatermark(dir: string): Watermark | null {
  try {
    const raw = JSON.parse(readFileSync(watermarkPath(dir), "utf8")) as Partial<Watermark>;
    if (raw && typeof raw === "object" && raw.progress && raw.inbox && raw.globs) {
      return {
        version: 1,
        progress: { ...raw.progress },
        inbox: { ...raw.inbox },
        globs: { ...raw.globs },
      };
    }
  } catch {
    /* none */
  }
  return null;
}

export function writeWatermark(dir: string, watermark: Watermark): void {
  writeFileAtomic(watermarkPath(dir), JSON.stringify(watermark, null, 1) + "\n");
}

// --- cycle_end records ---

function progressFile(ctx: SeatContext, projectId: string): string | null {
  // The audit writer appends to <root>/state/<id>/PROGRESS.jsonl; a custom
  // dispatcher.state_dir is read by the views. Take whichever exists.
  const candidates = [
    join(ctx.root, "state", projectId, "PROGRESS.jsonl"),
    join(getStateDir(ctx.dispatcher), projectId, "PROGRESS.jsonl"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Read the complete lines of `path` past `offset`. A shrunk file starts over. */
function readNewLines(path: string, offset: number): { lines: string[]; end: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const length = size - start;
    if (length <= 0) return { lines: [], end: start };
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const got = buf.subarray(0, read);
    const lastNewline = got.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], end: start };
    const text = got.subarray(0, lastNewline + 1).toString("utf8");
    return { lines: text.split("\n").filter((l) => l.trim() !== ""), end: start + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

function collectCycles(
  ctx: SeatContext,
  wm: Watermark | null,
  next: Watermark,
  baseline: boolean,
): string[] {
  const out: string[] = [];
  for (const project of ctx.projects) {
    const file = progressFile(ctx, project.id);
    if (!file) {
      next.progress[project.id] = wm?.progress[project.id] ?? 0;
      continue;
    }
    if (baseline) {
      // Start after the last complete line that exists now; history is not news.
      next.progress[project.id] = readNewLines(file, 0).end;
      continue;
    }
    const { lines, end } = readNewLines(file, wm?.progress[project.id] ?? 0);
    next.progress[project.id] = end;
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isProgressEntry(value) || value.event !== "cycle_end") continue;
      const d = value.data;
      const outcome = typeof d.outcome === "string" ? d.outcome : "?";
      const reason = typeof d.reason === "string" && d.reason !== "" ? ` reason=${d.reason}` : "";
      out.push(`cycle ended: ${project.id} ${value.cycle_id ?? "?"} outcome=${outcome}${reason}`);
    }
  }
  return out;
}

// --- Aide inbox rows ---

async function collectInboxes(
  ctx: SeatContext,
  wm: Watermark | null,
  next: Watermark,
  baseline: boolean,
  notes: string[],
): Promise<string[]> {
  const out: string[] = [];
  let aides: ReturnType<typeof loadAides>;
  try {
    aides = loadAides(ctx.root);
  } catch (error) {
    notes.push(`Aide registry unreadable (${(error as Error).message}); no inbox rows were checked.`);
    next.inbox = { ...(wm?.inbox ?? {}) };
    return out;
  }
  for (const aide of aides) {
    const previous = wm?.inbox[aide.name];
    try {
      const rows = await readInbox(aidePath(ctx.root, aide.inbox));
      if (baseline || previous === undefined) {
        next.inbox[aide.name] = rows.length;
        continue;
      }
      if (rows.length < previous) {
        next.inbox[aide.name] = rows.length;
        notes.push(`Aide ${aide.name}: inbox has fewer rows than before; re-baselined.`);
        continue;
      }
      next.inbox[aide.name] = rows.length;
      for (const row of rows.slice(previous)) {
        if (row.tags.includes("outbound")) continue;
        const tags = row.tags.map((t) => ` [${t}]`).join("");
        out.push(`Aide inbox: ${aide.name}: ${row.timestamp} ${row.from}: ${row.title}${tags}`);
      }
    } catch (error) {
      // Keep the old count so rows are not lost while the inbox is unreadable.
      if (previous !== undefined) next.inbox[aide.name] = previous;
      notes.push(`Aide ${aide.name}: inbox unreadable (${(error as Error).message}).`);
    }
  }
  return out;
}

// --- done_globs sentinels ---

const GLOB_MAGIC = /[*?[\]{}!]/;
const MAX_GLOB_FILES = 2000;

/** Absolute paths of the files a glob matches; the static prefix may climb out of the root (`../lanes/*`). */
export function expandGlob(pattern: string, root: string): string[] {
  const segments = pattern.replace(/\\/g, "/").split("/");
  let k = 0;
  while (k < segments.length && !GLOB_MAGIC.test(segments[k]!)) k++;
  if (k === segments.length) {
    // No magic at all: a literal path.
    const abs = resolveSeatPath(root, pattern);
    try {
      return statSync(abs).isFile() ? [abs] : [];
    } catch {
      return [];
    }
  }
  const prefix = segments.slice(0, k).join("/");
  const base = resolveSeatPath(root, prefix === "" ? (segments[0] === "" ? "/" : ".") : prefix);
  const rest = segments.slice(k).join("/");
  try {
    const out: string[] = [];
    for (const match of new Bun.Glob(rest).scanSync({ cwd: base, onlyFiles: true, dot: true })) {
      out.push(join(base, match));
      if (out.length >= MAX_GLOB_FILES) break;
    }
    return out;
  } catch {
    return [];
  }
}

function collectSentinels(
  ctx: SeatContext,
  wm: Watermark | null,
  next: Watermark,
  baseline: boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of ctx.seat.wake.done_globs) {
    for (const abs of expandGlob(pattern, ctx.root)) {
      const shown = relative(ctx.root, abs).replace(/\\/g, "/");
      if (seen.has(shown)) continue;
      seen.add(shown);
      let sig: { mtimeMs: number; size: number };
      try {
        const st = statSync(abs);
        sig = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        continue;
      }
      next.globs[shown] = sig;
      if (baseline) continue;
      const before = wm?.globs[shown];
      if (!before) out.push(`done sentinel appeared: ${shown}`);
      else if (before.mtimeMs !== sig.mtimeMs || before.size !== sig.size) {
        out.push(`done sentinel changed: ${shown}`);
      }
    }
  }
  return out;
}

function capLines(lines: string[], max: number, what: string): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `... and ${lines.length - max} more ${what}`];
}

/**
 * What woke the seat. Pure of side effects; the returned watermark is the
 * state at this moment and is not persisted here.
 */
export async function collectEvents(
  ctx: SeatContext,
  watermark: Watermark | null,
  opts: CollectOptions = {},
): Promise<CollectedEvents> {
  const baseline = watermark === null;
  const next: Watermark = emptyWatermark();
  const max = opts.maxLinesPerKind ?? 50;
  const wake = ctx.seat.wake;
  const notes: string[] = [];

  let cycles: string[] = [];
  if (wake.cycles) {
    cycles = collectCycles(ctx, watermark, next, baseline);
  } else if (watermark) {
    next.progress = { ...watermark.progress };
  }

  let inbox: string[] = [];
  if (wake.aide_inboxes) {
    inbox = await collectInboxes(ctx, watermark, next, baseline, notes);
  } else if (watermark) {
    next.inbox = { ...watermark.inbox };
  }

  const sentinels = collectSentinels(ctx, watermark, next, baseline);

  const lines: string[] = [];
  if (opts.firstTurn) {
    lines.push(
      "First turn of this seat: nothing below is reported as new. Survey your projects and the state file before acting.",
    );
  }
  if (opts.previous && ["timeout", "stop"].includes(opts.previous.end_reason)) {
    lines.push(
      `Turn ${opts.previous.n} was killed (${opts.previous.end_reason}). Run \`generalstaff status\` and check the bot worktrees before starting any cycle.`,
    );
  }
  if (opts.previous && isFastFailure(opts.previous)) {
    lines.push(
      `Turn ${opts.previous.n} failed fast (${failureReason(opts.previous)}) and may have done nothing. Its output is in turns/${opts.previous.n}/run.err; check it before relying on that turn.`,
    );
  }
  if (opts.previous?.state_restored) {
    lines.push(
      `Turn ${opts.previous.n} left the state file without a required heading or deleted it, so the driver restored the copy from before that turn. Redo what that turn tried to record.`,
    );
  }
  const carried = (opts.carried ?? []).map(
    (c) => `CARRIED FROM TURN ${c.from_turn} (it failed: ${c.reason}): ${c.line}`,
  );
  lines.push(...capLines(carried, max, "carried events"));
  lines.push(...capLines(cycles, max, "cycle_end records"));
  lines.push(...capLines(inbox, max, "Aide inbox rows"));
  lines.push(...capLines(sentinels, max, "done sentinels"));
  lines.push(...notes);
  if (opts.heartbeat) {
    lines.push("Heartbeat: the heartbeat interval woke this turn. Check on the work you own and on anything waiting.");
  }

  const counts = {
    cycles: cycles.length,
    inbox: inbox.length,
    sentinels: sentinels.length,
    carried: carried.length,
  };
  return {
    lines,
    newWatermark: next,
    counts,
    eventLines: [...cycles, ...inbox, ...sentinels],
    hasEvents: counts.cycles + counts.inbox + counts.sentinels + counts.carried > 0,
  };
}

/** The EVENTS.md body for a turn. */
export function eventsMarkdown(n: number, nowIso: string, lines: string[]): string {
  const body = lines.length ? lines.map((l) => `- ${l}`).join("\n") : "- (no new events)";
  return `# Events for turn ${n}\n\nCollected ${nowIso}.\n\n${body}\n`;
}
