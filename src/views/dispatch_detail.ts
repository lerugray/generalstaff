// GeneralStaff — Phase 6 data-contract: per-cycle dispatch detail view module (gs-224).
//
// Walks state/_fleet/PROGRESS.jsonl events for a single cycle_id and
// assembles the per-phase record used by the Phase 5 Dispatch Detail HTML
// reference. Pure data — no rendering. CLI wiring lives in a later task.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadProjects } from "../projects";
import { getRootDir } from "../state";
import type { ProjectConfig } from "../types";

export interface DispatchPhase {
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  detail: string | null;
}

export interface DispatchCheck {
  name: "scope" | "hands_off" | "silent_failures";
  passed: boolean;
  detail: string | null;
}

export interface DispatchFile {
  path: string;
  added: number;
  removed: number;
}

export interface DispatchDetailData {
  cycle_id: string;
  task_id: string | null;
  task_title: string | null;
  project_id: string;
  session_id: string | null;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  verdict: "verified" | "failed";
  verdict_prose: string | null;
  engineer: DispatchPhase;
  verification: DispatchPhase;
  review: DispatchPhase;
  sha_before: string | null;
  sha_after: string | null;
  files_touched: DispatchFile[];
  diff_added: number;
  diff_removed: number;
  checks: DispatchCheck[];
}

export class DispatchDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchDetailError";
  }
}

interface RawEvent {
  timestamp: string;
  event: string;
  cycle_id?: string;
  project_id?: string;
  data: Record<string, unknown>;
}

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

function classifyVerdict(outcome: unknown): "verified" | "failed" {
  if (outcome === "verified" || outcome === "verified_weak") return "verified";
  return "failed";
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

function readFilesTouched(data: Record<string, unknown>): DispatchFile[] {
  const raw = data.files_touched;
  if (!Array.isArray(raw)) return [];
  const out: DispatchFile[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ path: entry, added: 0, removed: 0 });
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const path = asString(o.path);
      if (!path) continue;
      out.push({
        path,
        added: asNumber(o.added) ?? 0,
        removed: asNumber(o.removed) ?? 0,
      });
    }
  }
  return out;
}

function emptyPhase(): DispatchPhase {
  return {
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    detail: null,
  };
}

function finalizePhase(phase: DispatchPhase): DispatchPhase {
  if (
    phase.duration_seconds === null &&
    phase.started_at !== null &&
    phase.ended_at !== null
  ) {
    const s = new Date(phase.started_at).getTime();
    const e = new Date(phase.ended_at).getTime();
    if (Number.isFinite(s) && Number.isFinite(e)) {
      phase.duration_seconds = Math.max(0, Math.round((e - s) / 1000));
    }
  }
  return phase;
}

function buildChecks(data: Record<string, unknown>): DispatchCheck[] {
  const hasScope = "scope_drift_files" in data;
  const hasHandsOff = "hands_off_violations" in data;
  const hasSilent = "silent_failures" in data;
  if (!hasScope && !hasHandsOff && !hasSilent) return [];

  const checks: DispatchCheck[] = [];
  if (hasScope) {
    const drifts = asStringArray(data.scope_drift_files);
    checks.push({
      name: "scope",
      passed: drifts.length === 0,
      detail: drifts.length === 0 ? null : drifts.join(", "),
    });
  }
  if (hasHandsOff) {
    const violations = asStringArray(data.hands_off_violations);
    checks.push({
      name: "hands_off",
      passed: violations.length === 0,
      detail: violations.length === 0 ? null : violations.join(", "),
    });
  }
  if (hasSilent) {
    const fails = asStringArray(data.silent_failures);
    checks.push({
      name: "silent_failures",
      passed: fails.length === 0,
      detail: fails.length === 0 ? null : fails.join(", "),
    });
  }
  return checks;
}

interface CycleAccumulator {
  cycle_id: string;
  task_id: string | null;
  project_id: string | null;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  verdict: "verified" | "failed" | null;
  verdict_prose: string | null;
  engineer: DispatchPhase;
  verification: DispatchPhase;
  review: DispatchPhase;
  sha_before: string | null;
  sha_after: string | null;
  files_touched: DispatchFile[];
  diff_added: number | null;
  diff_removed: number | null;
  checks: DispatchCheck[];
}

function newAccumulator(cycleId: string): CycleAccumulator {
  return {
    cycle_id: cycleId,
    task_id: null,
    project_id: null,
    session_id: null,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    verdict: null,
    verdict_prose: null,
    engineer: emptyPhase(),
    verification: emptyPhase(),
    review: emptyPhase(),
    sha_before: null,
    sha_after: null,
    files_touched: [],
    diff_added: null,
    diff_removed: null,
    checks: [],
  };
}

function applyEvent(acc: CycleAccumulator, evt: RawEvent): void {
  if (acc.session_id === null) {
    acc.session_id = asString(evt.data.session_id);
  }
  if (acc.project_id === null) {
    acc.project_id = evt.project_id ?? asString(evt.data.project_id);
  }

  switch (evt.event) {
    case "cycle_start": {
      acc.started_at = acc.started_at ?? evt.timestamp;
      if (acc.task_id === null) acc.task_id = asString(evt.data.task_id);
      if (acc.sha_before === null) {
        acc.sha_before =
          asString(evt.data.sha_before) ?? asString(evt.data.start_sha);
      }
      return;
    }
    case "cycle_end": {
      acc.ended_at = evt.timestamp;
      acc.verdict = classifyVerdict(evt.data.outcome);
      acc.verdict_prose =
        asString(evt.data.verdict_prose) ?? asString(evt.data.reason);
      acc.duration_seconds = asNumber(evt.data.duration_seconds);
      const files = readFilesTouched(evt.data);
      if (files.length > 0) acc.files_touched = files;
      if (acc.sha_before === null) {
        acc.sha_before =
          asString(evt.data.sha_before) ?? asString(evt.data.start_sha);
      }
      acc.sha_after =
        asString(evt.data.sha_after) ?? asString(evt.data.end_sha);
      const add = readDiffAdded(evt.data);
      const rem = readDiffRemoved(evt.data);
      if (add !== null) acc.diff_added = add;
      if (rem !== null) acc.diff_removed = rem;
      if (acc.task_id === null) acc.task_id = asString(evt.data.task_id);
      return;
    }
    case "engineer_start":
    case "engineer_invoked": {
      acc.engineer.started_at = acc.engineer.started_at ?? evt.timestamp;
      acc.engineer.detail = acc.engineer.detail ?? asString(evt.data.command);
      return;
    }
    case "engineer_end":
    case "engineer_completed": {
      acc.engineer.ended_at = evt.timestamp;
      acc.engineer.duration_seconds =
        asNumber(evt.data.duration_seconds) ?? acc.engineer.duration_seconds;
      return;
    }
    case "verification_start":
    case "verification_run": {
      acc.verification.started_at =
        acc.verification.started_at ?? evt.timestamp;
      acc.verification.detail =
        acc.verification.detail ?? asString(evt.data.command);
      return;
    }
    case "verification_end":
    case "verification_outcome": {
      acc.verification.ended_at = evt.timestamp;
      acc.verification.duration_seconds =
        asNumber(evt.data.duration_seconds) ??
        acc.verification.duration_seconds;
      const outcome = asString(evt.data.outcome);
      if (outcome !== null) acc.verification.detail = outcome;
      return;
    }
    case "reviewer_start":
    case "reviewer_invoked": {
      acc.review.started_at = acc.review.started_at ?? evt.timestamp;
      return;
    }
    case "reviewer_end":
    case "reviewer_verdict": {
      acc.review.ended_at = evt.timestamp;
      acc.review.duration_seconds =
        asNumber(evt.data.duration_seconds) ?? acc.review.duration_seconds;
      const verdict = asString(evt.data.verdict);
      if (verdict !== null) acc.review.detail = verdict;
      const checks = buildChecks(evt.data);
      if (checks.length > 0) acc.checks = checks;
      return;
    }
    default:
      return;
  }
}

async function lookupTaskTitle(
  projectId: string | null,
  taskId: string | null,
): Promise<string | null> {
  if (!projectId || !taskId) return null;
  let projects: ProjectConfig[];
  try {
    projects = await loadProjects();
  } catch {
    return null;
  }
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  const tasksPath = join(project.path, "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return null;
  let raw: string;
  try {
    raw = await readFile(tasksPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const t of parsed) {
    if (
      t !== null &&
      typeof t === "object" &&
      (t as Record<string, unknown>).id === taskId
    ) {
      const title = (t as Record<string, unknown>).title;
      return typeof title === "string" ? title : null;
    }
  }
  return null;
}

export interface GetDispatchDetailOptions {
  fleetLogPath?: string;
}

export async function getDispatchDetail(
  cycleId: string,
  opts: GetDispatchDetailOptions = {},
): Promise<DispatchDetailData> {
  const path =
    opts.fleetLogPath ??
    join(getRootDir(), "state", "_fleet", "PROGRESS.jsonl");

  if (!existsSync(path)) {
    throw new DispatchDetailError(`cycle not found: ${cycleId}`);
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new DispatchDetailError(`cycle not found: ${cycleId}`);
  }

  const acc = newAccumulator(cycleId);
  let matched = false;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const evt = parseRawEvent(trimmed);
    if (!evt) continue;
    const evtCycleId = evt.cycle_id ?? asString(evt.data.cycle_id);
    if (evtCycleId !== cycleId) continue;
    matched = true;
    applyEvent(acc, evt);
  }

  if (!matched) {
    throw new DispatchDetailError(`cycle not found: ${cycleId}`);
  }

  finalizePhase(acc.engineer);
  finalizePhase(acc.verification);
  finalizePhase(acc.review);

  const started_at = acc.started_at ?? acc.ended_at ?? "";
  const ended_at = acc.ended_at ?? acc.started_at ?? "";
  let duration_seconds = acc.duration_seconds;
  if (duration_seconds === null && acc.started_at && acc.ended_at) {
    const s = new Date(acc.started_at).getTime();
    const e = new Date(acc.ended_at).getTime();
    if (Number.isFinite(s) && Number.isFinite(e)) {
      duration_seconds = Math.max(0, Math.round((e - s) / 1000));
    }
  }

  const task_title = await lookupTaskTitle(acc.project_id, acc.task_id);

  return {
    cycle_id: acc.cycle_id,
    task_id: acc.task_id,
    task_title,
    project_id: acc.project_id ?? "unknown",
    session_id: acc.session_id,
    started_at,
    ended_at,
    duration_seconds: duration_seconds ?? 0,
    verdict: acc.verdict ?? "failed",
    verdict_prose: acc.verdict_prose,
    engineer: acc.engineer,
    verification: acc.verification,
    review: acc.review,
    sha_before: acc.sha_before,
    sha_after: acc.sha_after,
    files_touched: acc.files_touched,
    diff_added: acc.diff_added ?? 0,
    diff_removed: acc.diff_removed ?? 0,
    checks: acc.checks,
  };
}
