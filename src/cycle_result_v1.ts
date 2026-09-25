// Cycle-result contract v1 — read-only projection of one cycle for desktop gate binding.
// See docs/contracts/cycle-result-v1.md. Does not change cycle execution behaviour.

import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, relative } from "path";
import { collectProgressLogPaths } from "./views/dispatch_detail";
import { loadProjects } from "./projects";
import { getRootDir } from "./state";

export const CYCLE_RESULT_SCHEMA_VERSION = "cycle-result/v1" as const;

export type CycleResultGateState =
  | "passed"
  | "failed"
  | "running"
  | "not_submitted"
  | "unavailable"
  | "stale_uncertain";

export type CycleResultGap = "G1" | "G2" | "G3" | "G4" | "G5";

export interface CycleResultReceipt {
  id: string;
  present: boolean;
  summary: string | null;
}

export interface CycleResultV1 {
  schemaVersion: typeof CYCLE_RESULT_SCHEMA_VERSION;
  cycleId: string;
  state: CycleResultGateState;
  identity: {
    projectId: string;
    checkoutPath: string | null;
    branch: string | null;
    baseRevision: string | null;
    endRevision: string | null;
    patchDigest: string | null;
  };
  outcome: {
    finalOutcome:
      | "verified"
      | "verified_weak"
      | "verification_failed"
      | "cycle_skipped"
      | null;
    verificationOutcome: "passed" | "failed" | "weak" | null;
    reviewerVerdict:
      | "verified"
      | "verified_weak"
      | "verification_failed"
      | null;
    reason: string | null;
  };
  receipts: {
    verification: CycleResultReceipt;
    reviewer: CycleResultReceipt;
  };
  evidence: {
    progressPath: string | null;
    cycleDir: string | null;
    diffPatchPath: string | null;
    reviewerResponsePath: string | null;
  };
  timestamps: {
    startedAt: string | null;
    endedAt: string | null;
  };
  gaps: CycleResultGap[];
  unavailableReason?: string;
}

export class CycleResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleResultError";
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

export function patchDigestFromBytes(bytes: string | Uint8Array): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hash}`;
}

export function meetsPassCondition(doc: CycleResultV1): boolean {
  if (doc.schemaVersion !== CYCLE_RESULT_SCHEMA_VERSION) return false;
  const fo = doc.outcome.finalOutcome;
  const vo = doc.outcome.verificationOutcome;
  const rv = doc.outcome.reviewerVerdict;
  if (fo !== "verified" && fo !== "verified_weak") return false;
  if (vo !== "passed" && vo !== "weak") return false;
  if (rv !== "verified" && rv !== "verified_weak") return false;
  if (!doc.receipts.verification.present || !doc.receipts.reviewer.present) {
    return false;
  }
  if (
    doc.identity.patchDigest === null ||
    !doc.identity.patchDigest.startsWith("sha256:") ||
    doc.identity.patchDigest.length <= "sha256:".length
  ) {
    return false;
  }
  return true;
}

function relFromRoot(root: string, abs: string): string {
  const r = relative(root, abs);
  return r.length === 0 ? "." : r.split("\\").join("/");
}

export interface GetCycleResultV1Options {
  fleetLogPath?: string;
  /** When set, skip projects.yaml and use this checkout path. */
  checkoutPathOverride?: string | null;
}

/**
 * Build a cycle-result/v1 document from on-disk CLI records for `cycleId`.
 */
export async function getCycleResultV1(
  cycleId: string,
  opts: GetCycleResultV1Options = {},
): Promise<CycleResultV1> {
  const root = getRootDir();
  const paths = await collectProgressLogPaths({
    fleetLogPath: opts.fleetLogPath,
  });
  if (paths.length === 0) {
    throw new CycleResultError(`cycle not found: ${cycleId}`);
  }

  const events: RawEvent[] = [];
  let progressPathUsed: string | null = null;

  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = parseRawEvent(trimmed);
      if (!evt) continue;
      const evtCycleId = evt.cycle_id ?? asString(evt.data.cycle_id);
      if (evtCycleId !== cycleId) continue;
      events.push(evt);
      if (progressPathUsed === null) progressPathUsed = path;
    }
  }

  if (events.length === 0) {
    throw new CycleResultError(`cycle not found: ${cycleId}`);
  }

  let projectId: string | null = null;
  let branch: string | null = null;
  let baseRevision: string | null = null;
  let endRevision: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let finalOutcome: CycleResultV1["outcome"]["finalOutcome"] = null;
  let verificationOutcome: CycleResultV1["outcome"]["verificationOutcome"] =
    null;
  let reviewerVerdict: CycleResultV1["outcome"]["reviewerVerdict"] = null;
  let reason: string | null = null;
  let verificationPresent = false;
  let reviewerPresent = false;
  let verificationSummary: string | null = null;
  let reviewerSummary: string | null = null;
  let cycleEndCount = 0;
  let cycleSkippedCount = 0;

  for (const evt of events) {
    if (projectId === null) {
      projectId = evt.project_id ?? asString(evt.data.project_id);
    }
    switch (evt.event) {
      case "cycle_start": {
        startedAt = startedAt ?? evt.timestamp;
        branch = branch ?? asString(evt.data.branch);
        baseRevision =
          baseRevision ??
          asString(evt.data.start_sha) ??
          asString(evt.data.sha_before);
        break;
      }
      case "diff_summary": {
        branch = branch ?? asString(evt.data.branch);
        baseRevision = baseRevision ?? asString(evt.data.start_sha);
        endRevision = endRevision ?? asString(evt.data.end_sha);
        break;
      }
      case "verification_outcome":
      case "verification_end": {
        verificationPresent = true;
        const o = asString(evt.data.outcome);
        if (o === "passed" || o === "failed" || o === "weak" || o === "pass") {
          verificationOutcome =
            o === "pass" ? "passed" : (o as "passed" | "failed" | "weak");
        }
        verificationSummary = o;
        break;
      }
      case "reviewer_verdict":
      case "reviewer_end": {
        reviewerPresent = true;
        const v = asString(evt.data.verdict);
        if (
          v === "verified" ||
          v === "verified_weak" ||
          v === "verification_failed"
        ) {
          reviewerVerdict = v;
        }
        reviewerSummary = v ?? asString(evt.data.reason);
        break;
      }
      case "cycle_end": {
        cycleEndCount += 1;
        endedAt = evt.timestamp;
        const outcome = asString(evt.data.outcome);
        if (
          outcome === "verified" ||
          outcome === "verified_weak" ||
          outcome === "verification_failed" ||
          outcome === "cycle_skipped"
        ) {
          finalOutcome = outcome;
        }
        reason = asString(evt.data.reason) ?? reason;
        baseRevision =
          baseRevision ??
          asString(evt.data.start_sha) ??
          asString(evt.data.sha_before);
        endRevision =
          asString(evt.data.end_sha) ??
          asString(evt.data.sha_after) ??
          endRevision;
        const vo = asString(evt.data.verification_outcome);
        if (vo === "passed" || vo === "failed" || vo === "weak") {
          verificationOutcome = vo;
          verificationPresent = true;
          verificationSummary = verificationSummary ?? vo;
        }
        const rv = asString(evt.data.reviewer_verdict);
        if (
          rv === "verified" ||
          rv === "verified_weak" ||
          rv === "verification_failed"
        ) {
          reviewerVerdict = rv;
          reviewerPresent = true;
          reviewerSummary = reviewerSummary ?? rv;
        }
        break;
      }
      case "cycle_skipped": {
        cycleSkippedCount += 1;
        endedAt = evt.timestamp;
        finalOutcome = "cycle_skipped";
        reason = asString(evt.data.reason) ?? reason;
        break;
      }
      default:
        break;
    }
  }

  if (projectId === null) {
    throw new CycleResultError(
      `cycle ${cycleId}: missing project_id in progress events`,
    );
  }

  const gaps: CycleResultGap[] = ["G1", "G2", "G3", "G5"];

  let checkoutPath: string | null =
    opts.checkoutPathOverride === undefined
      ? null
      : opts.checkoutPathOverride;
  if (opts.checkoutPathOverride === undefined) {
    try {
      const projects = await loadProjects();
      const match = projects.find((p) => p.id === projectId);
      checkoutPath = match?.path ?? null;
    } catch {
      checkoutPath = null;
    }
  }

  const cycleDirAbs = join(root, "state", projectId, "cycles", cycleId);
  const diffAbs = join(cycleDirAbs, "diff.patch");
  const reviewerAbs = join(cycleDirAbs, "reviewer-response.txt");

  let patchDigest: string | null = null;
  if (existsSync(diffAbs)) {
    const bytes = await readFile(diffAbs);
    patchDigest = patchDigestFromBytes(bytes);
  }

  const progressRel =
    progressPathUsed !== null ? relFromRoot(root, progressPathUsed) : null;
  const cycleDirRel = existsSync(cycleDirAbs)
    ? relFromRoot(root, cycleDirAbs)
    : `state/${projectId}/cycles/${cycleId}`;
  const diffRel = existsSync(diffAbs) ? relFromRoot(root, diffAbs) : null;
  const reviewerRel = existsSync(reviewerAbs)
    ? relFromRoot(root, reviewerAbs)
    : null;

  const doc: CycleResultV1 = {
    schemaVersion: CYCLE_RESULT_SCHEMA_VERSION,
    cycleId,
    state: "failed",
    identity: {
      projectId,
      checkoutPath,
      branch,
      baseRevision,
      endRevision,
      patchDigest,
    },
    outcome: {
      finalOutcome,
      verificationOutcome,
      reviewerVerdict,
      reason,
    },
    receipts: {
      verification: {
        id: `${cycleId}:verification`,
        present: verificationPresent,
        summary: verificationSummary,
      },
      reviewer: {
        id: `${cycleId}:reviewer`,
        present: reviewerPresent,
        summary: reviewerSummary,
      },
    },
    evidence: {
      progressPath: progressRel,
      cycleDir: cycleDirRel,
      diffPatchPath: diffRel,
      reviewerResponsePath: reviewerRel,
    },
    timestamps: { startedAt, endedAt },
    gaps,
  };

  const terminals = cycleEndCount + cycleSkippedCount;
  if (cycleEndCount > 1 || (cycleEndCount >= 1 && cycleSkippedCount >= 1)) {
    doc.state = "unavailable";
    doc.unavailableReason = "duplicate_terminal_records";
    return doc;
  }

  if (terminals === 0) {
    doc.state = "running";
    return doc;
  }

  if (meetsPassCondition(doc)) {
    doc.state = "passed";
    return doc;
  }

  doc.state = "failed";
  return doc;
}
