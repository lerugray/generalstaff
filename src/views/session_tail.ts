// GeneralStaff — Phase 6 data-contract: session tail view module (gs-223).
//
// Parses state/_fleet/PROGRESS.jsonl into per-session records suitable for
// the Phase 5 Session Tail HTML reference. Pure data — no rendering. CLI
// wiring lives in a later task.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { getRootDir } from "../state";

export interface CycleRecord {
  cycle_id: string;
  task_id: string | null;
  project_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  verdict: "verified" | "failed" | "other";
  verdict_prose: string | null;
  files_touched: string[];
  sha_before: string | null;
  sha_after: string | null;
  diff_added: number | null;
  diff_removed: number | null;
}

export interface SessionRecord {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number;
  budget_minutes: number | null;
  reviewer: string | null;
  max_parallel_slots: number | null;
  stop_reason: string | null;
  cycles: CycleRecord[];
}

export interface EarlierSessionRow {
  session_id: string;
  started_at: string;
  duration_minutes: number;
  cycles_total: number;
  cycles_verified: number;
  cycles_failed: number;
  mixed: boolean;
}

export interface SessionTailData {
  sessions: SessionRecord[];
  earlier_rail: EarlierSessionRow[];
  rendered_at: string;
}

interface RawEvent {
  timestamp: string;
  event: string;
  cycle_id?: string;
  project_id?: string;
  data: Record<string, unknown>;
}

const DEFAULT_LIMIT = 3;
const EARLIER_RAIL_CAP = 10;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function classifyVerdict(
  outcome: unknown,
): "verified" | "failed" | "other" {
  if (outcome === "verified" || outcome === "verified_weak") return "verified";
  if (outcome === "verification_failed") return "failed";
  return "other";
}

function parseRawEvent(line: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.timestamp !== "string") return null;
  if (typeof o.event !== "string") return null;
  if (o.data === null || typeof o.data !== "object" || Array.isArray(o.data)) {
    return null;
  }
  return {
    timestamp: o.timestamp,
    event: o.event,
    cycle_id: typeof o.cycle_id === "string" ? o.cycle_id : undefined,
    project_id: typeof o.project_id === "string" ? o.project_id : undefined,
    data: o.data as Record<string, unknown>,
  };
}

interface SessionBuilder {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  budget_minutes: number | null;
  reviewer: string | null;
  max_parallel_slots: number | null;
  stop_reason: string | null;
  // cycle_id → partial cycle data (merged from cycle_start + cycle_end)
  cycles: Map<string, CycleBuilder>;
  // cycles without a cycle_id (shouldn't happen, defensive)
  orphanCycles: CycleBuilder[];
}

interface CycleBuilder {
  cycle_id: string;
  task_id: string | null;
  project_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  verdict: "verified" | "failed" | "other" | null;
  verdict_prose: string | null;
  files_touched: string[];
  sha_before: string | null;
  sha_after: string | null;
  diff_added: number | null;
  diff_removed: number | null;
}

function newSessionBuilder(id: string): SessionBuilder {
  return {
    session_id: id,
    started_at: null,
    ended_at: null,
    duration_minutes: null,
    budget_minutes: null,
    reviewer: null,
    max_parallel_slots: null,
    stop_reason: null,
    cycles: new Map(),
    orphanCycles: [],
  };
}

function getOrCreateCycle(
  sb: SessionBuilder,
  cycleId: string | undefined,
  fallbackProjectId: string,
): CycleBuilder {
  if (!cycleId) {
    const b: CycleBuilder = emptyCycleBuilder("", fallbackProjectId);
    sb.orphanCycles.push(b);
    return b;
  }
  let existing = sb.cycles.get(cycleId);
  if (!existing) {
    existing = emptyCycleBuilder(cycleId, fallbackProjectId);
    sb.cycles.set(cycleId, existing);
  }
  return existing;
}

function emptyCycleBuilder(
  cycleId: string,
  projectId: string,
): CycleBuilder {
  return {
    cycle_id: cycleId,
    task_id: null,
    project_id: projectId,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    verdict: null,
    verdict_prose: null,
    files_touched: [],
    sha_before: null,
    sha_after: null,
    diff_added: null,
    diff_removed: null,
  };
}

function readDiffAdded(data: Record<string, unknown>): number | null {
  const direct = asNumber(data.diff_added);
  if (direct !== null) return direct;
  const stats = data.diff_stats;
  if (stats !== null && typeof stats === "object" && !Array.isArray(stats)) {
    const s = stats as Record<string, unknown>;
    const add = asNumber(s.additions) ?? asNumber(s.insertions);
    if (add !== null) return add;
  }
  return null;
}

function readDiffRemoved(data: Record<string, unknown>): number | null {
  const direct = asNumber(data.diff_removed);
  if (direct !== null) return direct;
  const stats = data.diff_stats;
  if (stats !== null && typeof stats === "object" && !Array.isArray(stats)) {
    const s = stats as Record<string, unknown>;
    const del = asNumber(s.deletions);
    if (del !== null) return del;
  }
  return null;
}

function applyEvent(
  sessions: Map<string, SessionBuilder>,
  evt: RawEvent,
): void {
  const sessionId = asString(evt.data.session_id);
  if (!sessionId) return;
  let sb = sessions.get(sessionId);
  if (!sb) {
    sb = newSessionBuilder(sessionId);
    sessions.set(sessionId, sb);
  }

  switch (evt.event) {
    case "session_start": {
      sb.started_at = sb.started_at ?? evt.timestamp;
      sb.budget_minutes = sb.budget_minutes ?? asNumber(evt.data.budget_minutes);
      sb.max_parallel_slots =
        sb.max_parallel_slots ?? asNumber(evt.data.max_parallel_slots);
      sb.reviewer = sb.reviewer ?? asString(evt.data.reviewer);
      return;
    }
    case "session_end":
    case "session_complete": {
      sb.ended_at = evt.timestamp;
      const dur = asNumber(evt.data.duration_minutes);
      if (dur !== null) sb.duration_minutes = dur;
      const reviewer = asString(evt.data.reviewer);
      if (reviewer !== null) sb.reviewer = reviewer;
      const stopReason = asString(evt.data.stop_reason);
      if (stopReason !== null) sb.stop_reason = stopReason;
      const slots = asNumber(evt.data.max_parallel_slots);
      if (slots !== null && sb.max_parallel_slots === null) {
        sb.max_parallel_slots = slots;
      }
      // If no explicit session_start was seen, back-date started_at using
      // duration_minutes so we still have a plausible timeline.
      if (sb.started_at === null && dur !== null) {
        const endMs = new Date(evt.timestamp).getTime();
        if (Number.isFinite(endMs)) {
          sb.started_at = new Date(endMs - dur * 60_000).toISOString();
        }
      }
      return;
    }
    case "cycle_start": {
      const cid = evt.cycle_id ?? asString(evt.data.cycle_id) ?? undefined;
      const projectId =
        evt.project_id ?? asString(evt.data.project_id) ?? "unknown";
      const cb = getOrCreateCycle(sb, cid, projectId);
      if (!cb.started_at) cb.started_at = evt.timestamp;
      if (cb.project_id === "unknown" || cb.project_id === "") {
        cb.project_id = projectId;
      }
      if (cb.task_id === null) {
        cb.task_id = asString(evt.data.task_id);
      }
      if (cb.sha_before === null) {
        cb.sha_before =
          asString(evt.data.sha_before) ?? asString(evt.data.start_sha);
      }
      return;
    }
    case "cycle_end": {
      const cid = evt.cycle_id ?? asString(evt.data.cycle_id) ?? undefined;
      const projectId =
        evt.project_id ?? asString(evt.data.project_id) ?? "unknown";
      const cb = getOrCreateCycle(sb, cid, projectId);
      cb.ended_at = evt.timestamp;
      if (cb.project_id === "unknown" || cb.project_id === "") {
        cb.project_id = projectId;
      }
      if (cb.task_id === null) {
        cb.task_id = asString(evt.data.task_id);
      }
      cb.verdict = classifyVerdict(evt.data.outcome);
      cb.verdict_prose =
        asString(evt.data.verdict_prose) ?? asString(evt.data.reason);
      cb.duration_seconds = asNumber(evt.data.duration_seconds);
      cb.files_touched = asStringArray(evt.data.files_touched);
      if (cb.sha_before === null) {
        cb.sha_before =
          asString(evt.data.sha_before) ?? asString(evt.data.start_sha);
      }
      cb.sha_after =
        asString(evt.data.sha_after) ?? asString(evt.data.end_sha);
      cb.diff_added = readDiffAdded(evt.data);
      cb.diff_removed = readDiffRemoved(evt.data);
      return;
    }
    default:
      return;
  }
}

function finalizeCycle(cb: CycleBuilder): CycleRecord {
  const started_at = cb.started_at ?? cb.ended_at ?? "";
  const ended_at = cb.ended_at ?? cb.started_at ?? "";
  let duration_seconds = cb.duration_seconds;
  if (duration_seconds === null && cb.started_at && cb.ended_at) {
    const s = new Date(cb.started_at).getTime();
    const e = new Date(cb.ended_at).getTime();
    if (Number.isFinite(s) && Number.isFinite(e)) {
      duration_seconds = Math.max(0, Math.round((e - s) / 1000));
    }
  }
  return {
    cycle_id: cb.cycle_id,
    task_id: cb.task_id,
    project_id: cb.project_id,
    started_at,
    ended_at,
    duration_seconds: duration_seconds ?? 0,
    verdict: cb.verdict ?? "other",
    verdict_prose: cb.verdict_prose,
    files_touched: cb.files_touched,
    sha_before: cb.sha_before,
    sha_after: cb.sha_after,
    diff_added: cb.diff_added,
    diff_removed: cb.diff_removed,
  };
}

function finalizeSession(
  sb: SessionBuilder,
  now: Date,
): SessionRecord | null {
  if (sb.started_at === null) return null;
  const cycles: CycleRecord[] = [];
  for (const cb of sb.cycles.values()) cycles.push(finalizeCycle(cb));
  for (const cb of sb.orphanCycles) cycles.push(finalizeCycle(cb));
  cycles.sort((a, b) => {
    if (a.started_at < b.started_at) return -1;
    if (a.started_at > b.started_at) return 1;
    return 0;
  });

  let duration_minutes: number;
  if (sb.duration_minutes !== null) {
    duration_minutes = sb.duration_minutes;
  } else if (sb.ended_at !== null) {
    const s = new Date(sb.started_at).getTime();
    const e = new Date(sb.ended_at).getTime();
    duration_minutes = Number.isFinite(s) && Number.isFinite(e)
      ? Math.max(0, Math.round((e - s) / 60_000))
      : 0;
  } else {
    // in-progress: compute from now()
    const s = new Date(sb.started_at).getTime();
    const e = now.getTime();
    duration_minutes = Number.isFinite(s)
      ? Math.max(0, Math.round((e - s) / 60_000))
      : 0;
  }

  return {
    session_id: sb.session_id,
    started_at: sb.started_at,
    ended_at: sb.ended_at,
    duration_minutes,
    budget_minutes: sb.budget_minutes,
    reviewer: sb.reviewer,
    max_parallel_slots: sb.max_parallel_slots,
    stop_reason: sb.stop_reason,
    cycles,
  };
}

function toEarlierRow(record: SessionRecord): EarlierSessionRow {
  let verified = 0;
  let failed = 0;
  for (const c of record.cycles) {
    if (c.verdict === "verified") verified += 1;
    else if (c.verdict === "failed") failed += 1;
  }
  return {
    session_id: record.session_id,
    started_at: record.started_at,
    duration_minutes: record.duration_minutes,
    cycles_total: record.cycles.length,
    cycles_verified: verified,
    cycles_failed: failed,
    mixed: verified > 0 && failed > 0,
  };
}

export interface GetRecentSessionsOptions {
  warn?: (msg: string) => void;
  fleetLogPath?: string;
  now?: Date;
}

export async function getRecentSessions(
  limit: number = DEFAULT_LIMIT,
  opts: GetRecentSessionsOptions = {},
): Promise<SessionTailData> {
  const warn = opts.warn ?? (() => {});
  const now = opts.now ?? new Date();
  const path =
    opts.fleetLogPath ??
    join(getRootDir(), "state", "_fleet", "PROGRESS.jsonl");

  if (!existsSync(path)) {
    return { sessions: [], earlier_rail: [], rendered_at: now.toISOString() };
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { sessions: [], earlier_rail: [], rendered_at: now.toISOString() };
  }

  const sessions = new Map<string, SessionBuilder>();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const evt = parseRawEvent(line);
    if (!evt) {
      warn(`session_tail: malformed JSONL at line ${i + 1}`);
      continue;
    }
    applyEvent(sessions, evt);
  }

  const finalized: SessionRecord[] = [];
  for (const sb of sessions.values()) {
    const s = finalizeSession(sb, now);
    if (s) finalized.push(s);
  }
  finalized.sort((a, b) => {
    if (a.started_at < b.started_at) return 1;
    if (a.started_at > b.started_at) return -1;
    return 0;
  });

  const effectiveLimit = Math.max(0, limit);
  const headSessions = finalized.slice(0, effectiveLimit);
  const tailSessions = finalized.slice(
    effectiveLimit,
    effectiveLimit + EARLIER_RAIL_CAP,
  );
  const earlier_rail = tailSessions.map(toEarlierRow);

  return {
    sessions: headSessions,
    earlier_rail,
    rendered_at: now.toISOString(),
  };
}
