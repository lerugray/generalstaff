// `generalstaff cycle verify` — the verify-only check.
//
// Verifies a frozen snapshot of someone's uncommitted change in an isolated
// worktree and writes a `cycle-result/v1` receipt bound to the snapshot's
// gs-patch-digest/v1 digest. It runs the project's verification command and
// the reviewer, in that sequence, and nothing else: no engineer, no advisor, no
// judgment gate, no mission-swarm preview, no branch reset/merge/rollback, no
// state auto-commit. A runtime guard (guard.ts) enforces that for the whole
// run, and this module imports none of those modules.
//
// Preflight failures throw VerifyRefusal before anything is recorded: no
// cycle_start, no receipt. From cycle_start on, every path — success, failure,
// timeout, interruption, internal error — writes exactly one terminal
// `cycle_end` before returning.

import { randomInt } from "crypto";
import { readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { appendProgress } from "../audit";
import { matchesHandsOffSymlinkAware } from "../safety";
import { redactSecrets, formatSecretRedactionWarning } from "../secrets";
import { cycleDir as cycleDirPath, ensureCycleDir, projectStateDir } from "../state";
import type {
  DispatcherConfig,
  ProjectConfig,
  ReviewerVerdict,
  VerificationOutcome,
} from "../types";
import {
  runQuorumReview,
  runReviewer,
  terminateReviewerChildren,
  type ReviewerResult,
} from "../reviewer";
import type { ReviewerPromptParams } from "../prompts/reviewer";
import {
  DIGEST_INPUT_FILENAME,
  PATCH_DIGEST_ALGORITHM,
  VERIFY_MODE,
} from "./constants";
import { normalizeExclude, type DigestLimits } from "./digest";
import { scrubLine } from "./git";
import { enterVerifyOnlyMode, verifyOnlyProjectView } from "./guard";
import { acquireVerifyLock } from "./lock";
import {
  baseIsCommit,
  isGitTopLevel,
  materializeSnapshot,
  removeVerifyTree,
  renderReviewDiff,
  type Materialized,
} from "./materialize";
import { VerifyRefusal, toRefusal } from "./refusal";
import { killAllOwnedGroups } from "./runner";
import { runVerifyOnlyVerification } from "./verification";

// --- Budgets ---------------------------------------------------------------

export interface VerifyBudgets {
  verificationSec: number;
  reviewerSec: number;
  overallSec: number;
  graceSec: number;
}

/** Defaults. A caller's own budget for the whole call must exceed overall + grace. */
export const DEFAULT_VERIFY_BUDGETS: VerifyBudgets = {
  verificationSec: 10 * 60,
  reviewerSec: 5 * 60,
  overallSec: 15 * 60,
  graceSec: 10,
};

export type FailureCategory =
  | "verification_nonzero"
  | "verification_timeout"
  | "verification_error"
  | "reviewer_rejected"
  | "reviewer_error"
  | "reviewer_timeout"
  | "interrupted"
  | "overall_timeout"
  | "internal_error";

export interface VerifyRunRequest {
  /** The registered project (as loaded from projects.yaml). */
  project: ProjectConfig;
  dispatcher: DispatcherConfig;
  /** Canonical checkout directory: the git top level, read-only for the check. */
  checkout: string;
  /** Full-length base commit id, lowercase hex. */
  base: string;
  /** Recorded identity only; no branch is created, moved or checked out. */
  branch: string;
  bundleDir: string;
  /** `sha256:<64 hex>` the bundle must reproduce. */
  digest: string;
  digestAlgorithm: string;
  exclude?: readonly string[];
  budgets?: Partial<VerifyBudgets>;
  limits?: Partial<DigestLimits>;
  gitTimeoutMs?: number;
  cliVersion: string;
  /** External abort (process signals). Aborting ends the check as interrupted. */
  signal?: AbortSignal;
  /** Called once, right after cycle_start is recorded. */
  onStarted?: (info: { cycleId: string; projectId: string }) => void;
}

export interface VerifyRunResult {
  cycleId: string;
  projectId: string;
  finalOutcome: "verified" | "verified_weak" | "verification_failed";
  passed: boolean;
  reason: string;
  category: FailureCategory | null;
  verificationOutcome: VerificationOutcome;
  reviewerVerdict: ReviewerVerdict;
  reviewerProvider: string | null;
  /** The isolated worktree directory is gone. */
  cleanedUp: boolean;
  /** Every verification process group was proven reaped. */
  reaped: boolean;
  interruptedBy: string | null;
}

// --- Helpers ---------------------------------------------------------------

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const FULL_BASE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function generateCycleId(now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "");
  return `${ts}_${randomInt(0, 36 ** 4).toString(36).padStart(4, "0")}`;
}

export interface NameStatusEntry {
  status: string;
  oldPath?: string;
  newPath: string;
}

/** Parse `git diff --name-status -z`. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (!status) continue;
    if (/^[RC]\d*$/.test(status)) {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error(`malformed name-status record for ${status}`);
      }
      entries.push({ status, oldPath, newPath });
      continue;
    }
    const newPath = fields[i++];
    if (newPath === undefined) {
      throw new Error(`malformed name-status record for ${status}`);
    }
    entries.push({ status, newPath });
  }
  return entries;
}

export function changedFilesFromNameStatus(output: string): string[] {
  const files: string[] = [];
  for (const e of parseNameStatusZ(output)) {
    if (e.oldPath !== undefined) files.push(e.oldPath);
    files.push(e.newPath);
  }
  return [...new Set(files)];
}

export function summarizeDiff(diff: string): {
  files_changed: number;
  insertions: number;
  deletions: number;
} {
  if (!diff) return { files_changed: 0, insertions: 0, deletions: 0 };
  let insertions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) {
      files.add(m[1]!);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { files_changed: files.size, insertions, deletions };
}

const REVIEWER_LOG_MAX = 9500;

/** Keep the head and the tail of a long log: failures show up at the end. */
export function truncateLogForReviewer(log: string): string {
  if (log.length <= REVIEWER_LOG_MAX) return log;
  return (
    log.slice(0, 1500) +
    "\n[... middle of the log omitted ...]\n" +
    log.slice(log.length - (REVIEWER_LOG_MAX - 1500 - 40))
  );
}

/** Resolve with `promise`'s value, or with `null` after `ms`. Leaves no timer behind. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- The check -------------------------------------------------------------

interface Decision {
  finalOutcome: "verified" | "verified_weak" | "verification_failed";
  reason: string;
  category: FailureCategory | null;
  verificationOutcome: VerificationOutcome;
  reviewerVerdict: ReviewerVerdict;
  reviewerProvider: string | null;
  reaped: boolean;
}

export async function runVerifyOnlyCycle(
  req: VerifyRunRequest,
): Promise<VerifyRunResult> {
  const leaveGuard = enterVerifyOnlyMode();
  try {
    return await runInner(req);
  } finally {
    leaveGuard();
  }
}

async function runInner(req: VerifyRunRequest): Promise<VerifyRunResult> {
  const project = verifyOnlyProjectView(req.project);
  const budgets: VerifyBudgets = { ...DEFAULT_VERIFY_BUDGETS };
  for (const [key, value] of Object.entries(req.budgets ?? {}) as Array<
    [keyof VerifyBudgets, number | undefined]
  >) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      budgets[key] = value;
    }
  }

  // Preflight that needs no filesystem. Each failure is a refusal.
  if (!project.verification_command || project.verification_command.trim() === "") {
    throw new VerifyRefusal(
      "no_verification_command",
      `project "${project.id}" has no verification command configured`,
    );
  }
  if (req.digestAlgorithm !== PATCH_DIGEST_ALGORITHM) {
    throw new VerifyRefusal(
      "unsupported_digest_algorithm",
      `unsupported digest algorithm "${scrubLine(req.digestAlgorithm, 60)}"; this build supports ${PATCH_DIGEST_ALGORITHM}`,
    );
  }
  if (!DIGEST_RE.test(req.digest)) {
    throw new VerifyRefusal("invalid_argument", "digest is not sha256:<64 lowercase hex>");
  }
  if (!FULL_BASE_RE.test(req.base)) {
    throw new VerifyRefusal("invalid_argument", "base is not a full lowercase hex commit id");
  }
  let exclude: string[];
  try {
    exclude = normalizeExclude(req.exclude);
  } catch (err) {
    throw toRefusal(err);
  }

  if (!(await isGitTopLevel(req.checkout, (p) => realpathSync.native(p), req.gitTimeoutMs))) {
    throw new VerifyRefusal(
      "checkout_invalid",
      "the checkout is not the top level of a git work tree",
    );
  }
  if (!(await baseIsCommit(req.checkout, req.base, req.gitTimeoutMs))) {
    throw new VerifyRefusal(
      "base_unresolvable",
      "the base revision is not a commit in the checkout",
    );
  }

  const cycleId = generateCycleId();
  const verifyRoot = join(projectStateDir(project.id, req.dispatcher), "verify");
  const verifyDir = join(verifyRoot, cycleId);
  const lock = acquireVerifyLock(
    verifyRoot,
    cycleId,
    (budgets.overallSec + budgets.graceSec + 120) * 1000,
  );
  try {
    // Leftovers of a check that died without cleaning up. Safe to remove:
    // this process holds the project's verify lock.
    for (const name of safeReaddir(verifyRoot)) {
      if (name === ".lock" || name === cycleId) continue;
      rmSync(join(verifyRoot, name), { recursive: true, force: true });
    }

    const materialized = await materializeSnapshot({
      checkout: req.checkout,
      verifyDir,
      base: req.base,
      bundleDir: req.bundleDir,
      expectedDigest: req.digest,
      exclude,
      limits: req.limits,
      gitTimeoutMs: req.gitTimeoutMs,
    });

    let review;
    try {
      review = await renderReviewDiff(materialized.treePath, req.base, req.gitTimeoutMs);
    } catch (err) {
      await removeVerifyTree(req.checkout, verifyDir);
      throw err;
    }

    let result: VerifyRunResult | undefined;
    try {
      result = await runRecordedCheck({
        req,
        project,
        budgets,
        cycleId,
        exclude,
        materialized,
        review,
      });
    } finally {
      const cleanedUp = await removeVerifyTree(req.checkout, verifyDir);
      if (result) result.cleanedUp = cleanedUp;
    }
    return result;
  } finally {
    lock.release();
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

interface RecordedCheckArgs {
  req: VerifyRunRequest;
  project: ProjectConfig;
  budgets: VerifyBudgets;
  cycleId: string;
  exclude: string[];
  materialized: Materialized;
  review: { diff: string; stat: string; nameStatusZ: string };
}

/** From cycle_start to cycle_end: everything here is on the record. */
async function runRecordedCheck(a: RecordedCheckArgs): Promise<VerifyRunResult> {
  const { req, project, budgets, cycleId, exclude, materialized, review } = a;
  const started = performance.now();
  const graceMs = budgets.graceSec * 1000;
  const tree = materialized.treePath;
  const dispatcher = req.dispatcher;

  const cycleDirAbs = ensureCycleDir(project.id, cycleId, dispatcher);
  writeFileSync(
    join(cycleDirAbs, DIGEST_INPUT_FILENAME),
    materialized.snapshot.digestInput,
  );

  const redacted = redactSecrets(review.diff || "(empty diff)\n");
  if (redacted.hits.length > 0) {
    console.warn(formatSecretRedactionWarning("diff.patch", redacted.hits));
  }
  writeFileSync(join(cycleDirAbs, "diff.patch"), redacted.redacted);

  const changedFiles = changedFilesFromNameStatus(review.nameStatusZ);
  const handsOffHits: Array<{ file: string; pattern: string }> = [];
  for (const file of changedFiles) {
    const pattern = matchesHandsOffSymlinkAware(file, project.hands_off, tree);
    if (pattern) handsOffHits.push({ file, pattern });
  }
  const diffStats = summarizeDiff(review.diff);

  // The one terminal record. Written exactly once, on every path.
  let terminalWritten = false;
  const writeTerminal = async (decision: Decision): Promise<void> => {
    if (terminalWritten) return;
    terminalWritten = true;
    await appendProgress(
      project.id,
      "cycle_end",
      {
        outcome: decision.finalOutcome,
        reason: decision.reason,
        start_sha: req.base,
        end_sha: req.base,
        engineer_exit_code: null,
        verification_outcome: decision.verificationOutcome,
        reviewer_verdict: decision.reviewerVerdict,
        checkout_path: req.checkout,
        branch: req.branch,
        base_revision: req.base,
        patch_digest: req.digest,
        patch_digest_algorithm: PATCH_DIGEST_ALGORITHM,
        verify: {
          mode: VERIFY_MODE,
          changesetDigest: req.digest,
          digestAlgorithm: PATCH_DIGEST_ALGORITHM,
          baseRevision: req.base,
          checkoutPath: req.checkout,
          worktreePath: tree,
          excludedPaths: exclude,
          handsOffHits,
          cliVersion: req.cliVersion,
          reviewerProvider: decision.reviewerProvider,
          failureCategory: decision.category,
        },
        diff_stats: diffStats,
        duration_seconds: Math.round((performance.now() - started) / 1000),
      },
      cycleId,
    );
  };

  const controller = new AbortController();
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(`interrupted:${String(req.signal?.reason ?? "signal")}`);
    }
  };
  let startRecorded = false;

  try {
    await appendProgress(
      project.id,
      "cycle_start",
      {
        start_sha: req.base,
        branch: req.branch,
        checkout_path: req.checkout,
        patch_digest_algorithm: PATCH_DIGEST_ALGORITHM,
        mode: VERIFY_MODE,
      },
      cycleId,
    );
    startRecorded = true;
    await appendProgress(
      project.id,
      "worktree_preflight",
      { status: "verified", branch: req.branch, expected_sha: req.base, verify_only: true },
      cycleId,
    );
    if (redacted.hits.length > 0) {
      await appendProgress(
        project.id,
        "secret_redaction",
        { artifact: "diff.patch", hits: redacted.hits },
        cycleId,
      );
    }
    await appendProgress(
      project.id,
      "diff_summary",
      {
        start_sha: req.base,
        end_sha: req.base,
        branch: req.branch,
        files_changed: review.stat || "(no changes)",
        diff_length: review.diff.length,
      },
      cycleId,
    );
    req.onStarted?.({ cycleId, projectId: project.id });

    // From here on the check can be aborted (time budget or a signal).
    overallTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("overall_timeout");
    }, budgets.overallSec * 1000);
    if (req.signal) {
      if (req.signal.aborted) onExternalAbort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const flow = async (): Promise<Decision> => {
      const ver = await runVerifyOnlyVerification({
        project,
        cycleId,
        cwd: tree,
        cycleDirPath: cycleDirAbs,
        budgetMs: budgets.verificationSec * 1000,
        graceMs,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new AbortedFlow();

      const reviewer = await runReviewerStep({
        project,
        cycleId,
        dispatcher,
        tree,
        review,
        redactedDiff: redacted.redacted,
        handsOffHits,
        ver,
        reviewerMs: budgets.reviewerSec * 1000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new AbortedFlow();
      return decide(ver, reviewer, budgets);
    };

    let decision: Decision;
    let interruptedBy: string | null = null;
    const flowPromise = flow().then(
      (d) => ({ kind: "done" as const, decision: d }),
      (err: unknown) => ({ kind: "error" as const, err }),
    );
    const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
        once: true,
      });
    });
    const first = await Promise.race([flowPromise, abortPromise]);
    if (first.kind === "aborted" || controller.signal.aborted) {
      // Stop the reviewer, let the verification runner finish its own group
      // kill, then record the interruption.
      terminateReviewerChildren();
      await withTimeout(flowPromise, graceMs + 5000);
      terminateReviewerChildren();
      killAllOwnedGroups();
      const why = String(controller.signal.reason ?? "interrupted");
      if (why === "overall_timeout") {
        decision = failedDecision(
          `Check exceeded its overall time budget (${budgets.overallSec}s)`,
          "overall_timeout",
        );
      } else {
        interruptedBy = why.replace(/^interrupted:/, "");
        decision = failedDecision(`Check interrupted (${interruptedBy})`, "interrupted");
      }
    } else if (first.kind === "error") {
      const msg = first.err instanceof Error ? first.err.message : String(first.err);
      decision = failedDecision(
        `Check failed with an internal error: ${scrubLine(msg, 200)}`,
        "internal_error",
      );
    } else {
      decision = first.decision;
    }

    await writeTerminal(decision);
    return {
      cycleId,
      projectId: project.id,
      finalOutcome: decision.finalOutcome,
      passed:
        decision.finalOutcome === "verified" || decision.finalOutcome === "verified_weak",
      reason: decision.reason,
      category: decision.category,
      verificationOutcome: decision.verificationOutcome,
      reviewerVerdict: decision.reviewerVerdict,
      reviewerProvider: decision.reviewerProvider,
      cleanedUp: false,
      reaped: decision.reaped,
      interruptedBy,
    };
  } catch (err) {
    // An unexpected failure after cycle_start must still end on the record,
    // or the receipt would read "running" for ever.
    if (startRecorded && !terminalWritten) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await writeTerminal(
          failedDecision(
            `Check failed with an internal error: ${scrubLine(msg, 200)}`,
            "internal_error",
          ),
        );
      } catch {
        /* the log itself is unwritable; nothing more can be recorded */
      }
    }
    throw err;
  } finally {
    if (overallTimer !== undefined) clearTimeout(overallTimer);
    req.signal?.removeEventListener("abort", onExternalAbort);
  }
}

class AbortedFlow extends Error {
  constructor() {
    super("check aborted");
    this.name = "AbortedFlow";
  }
}

function failedDecision(reason: string, category: FailureCategory): Decision {
  return {
    finalOutcome: "verification_failed",
    reason,
    category,
    verificationOutcome: "failed",
    reviewerVerdict: "verification_failed",
    reviewerProvider: null,
    reaped: true,
  };
}

interface ReviewerStepResult {
  result: ReviewerResult;
  timedOut: boolean;
}

async function runReviewerStep(a: {
  project: ProjectConfig;
  cycleId: string;
  dispatcher: DispatcherConfig;
  tree: string;
  review: { diff: string; stat: string };
  redactedDiff: string;
  handsOffHits: Array<{ file: string; pattern: string }>;
  ver: Awaited<ReturnType<typeof runVerifyOnlyVerification>>;
  reviewerMs: number;
  signal: AbortSignal;
}): Promise<ReviewerStepResult> {
  const { project, cycleId } = a;
  const params: ReviewerPromptParams = {
    projectId: project.id,
    markedDoneTasks: "",
    sessionNoteOrNone: "",
    fullDiff: a.redactedDiff,
    diffStat: a.review.stat,
    verificationCommand: project.verification_command,
    verificationExitCode: a.ver.exitCode,
    verificationOutputTruncated: truncateLogForReviewer(a.ver.logText),
    handsOffList: project.hands_off,
    publicFacing: project.public_facing,
    verifyOnly: { handsOffHits: a.handsOffHits },
  };
  const useQuorum = (project.review?.reviewers.length ?? 0) > 1;
  // The reviewer resolves its provider from project configuration and the
  // GENERALSTAFF_REVIEWER_* variables only. This request carries none.
  const reviewerPromise: Promise<ReviewerResult> = useQuorum
    ? runQuorumReview(project, cycleId, params, a.dispatcher, false, a.tree)
    : runReviewer(project, cycleId, params, a.dispatcher, false, a.tree);
  const guarded = reviewerPromise.catch(
    (err: unknown): ReviewerResult => ({
      verdict: "verification_failed",
      response: null,
      rawResponse: `[REVIEWER ERROR] ${err instanceof Error ? err.message : String(err)}`,
      parseError: "reviewer threw",
    }),
  );

  const timeoutSentinel = Symbol("reviewer-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timeoutSentinel>((resolve) => {
    timer = setTimeout(() => resolve(timeoutSentinel), a.reviewerMs);
  });
  const abortSentinel = Symbol("aborted");
  const aborted = new Promise<typeof abortSentinel>((resolve) => {
    if (a.signal.aborted) resolve(abortSentinel);
    else a.signal.addEventListener("abort", () => resolve(abortSentinel), { once: true });
  });
  const first = await Promise.race([guarded, timeout, aborted]);
  clearTimeout(timer);
  if (first === abortSentinel) {
    terminateReviewerChildren();
    throw new AbortedFlow();
  }
  if (first !== timeoutSentinel) return { result: first as ReviewerResult, timedOut: false };

  // Out of time: end the reviewer process, give it a moment to unwind and
  // record its own (failed) verdict, and record one ourselves if it does not.
  terminateReviewerChildren();
  const settled = await withTimeout(guarded, 3000);
  const message = `reviewer did not finish within ${Math.round(a.reviewerMs / 1000)}s`;
  if (settled === null) {
    writeFileSync(
      join(cycleDirPath(project.id, cycleId, a.dispatcher), "reviewer-response.txt"),
      `[REVIEWER ERROR] ${message}`,
    );
    await appendProgress(
      project.id,
      "reviewer_verdict",
      { verdict: "verification_failed", reason: message },
      cycleId,
    );
  }
  return {
    result: {
      verdict: "verification_failed",
      response: null,
      rawResponse: `[REVIEWER ERROR] ${message}`,
      parseError: message,
      provider: settled?.provider,
    },
    timedOut: true,
  };
}

/** Combine the verification and reviewer outcomes the way an autonomous cycle does. */
function decide(
  ver: Awaited<ReturnType<typeof runVerifyOnlyVerification>>,
  reviewer: ReviewerStepResult,
  budgets: VerifyBudgets,
): Decision {
  const r = reviewer.result;
  const base = {
    verificationOutcome: ver.outcome,
    reviewerVerdict: r.verdict,
    reviewerProvider: r.provider ?? null,
    reaped: ver.reaped,
  };
  if (ver.outcome === "failed") {
    if (ver.timedOut) {
      return {
        ...base,
        finalOutcome: "verification_failed",
        reason: `Verification timed out (time budget ${budgets.verificationSec}s)`,
        category: "verification_timeout",
      };
    }
    if (ver.spawnError) {
      return {
        ...base,
        finalOutcome: "verification_failed",
        reason: `Verification command could not be started: ${scrubLine(ver.spawnError, 160)}`,
        category: "verification_error",
      };
    }
    const stage =
      ver.failedStage && ver.failedStage !== "Verification" ? `${ver.failedStage} failed` : "Verification gate failed";
    return {
      ...base,
      finalOutcome: "verification_failed",
      reason: `${stage} (exit ${ver.exitCode})`,
      category: "verification_nonzero",
    };
  }
  if (r.verdict === "verification_failed") {
    if (reviewer.timedOut) {
      return {
        ...base,
        finalOutcome: "verification_failed",
        reason: `Reviewer timed out (time budget ${budgets.reviewerSec}s)`,
        category: "reviewer_timeout",
      };
    }
    if (r.rawResponse.startsWith("[REVIEWER ERROR]")) {
      return {
        ...base,
        finalOutcome: "verification_failed",
        reason: `Reviewer error: ${scrubLine(r.rawResponse.slice("[REVIEWER ERROR]".length), 200)}`,
        category: "reviewer_error",
      };
    }
    if (r.parseError !== null) {
      return {
        ...base,
        finalOutcome: "verification_failed",
        reason: "Reviewer response could not be parsed",
        category: "reviewer_error",
      };
    }
    return {
      ...base,
      finalOutcome: "verification_failed",
      reason: r.response?.reason ?? "Reviewer rejected",
      category: "reviewer_rejected",
    };
  }
  if (ver.outcome === "weak" || r.verdict === "verified_weak") {
    return {
      ...base,
      finalOutcome: "verified_weak",
      reason: r.response?.reason ?? "Weak verification or low confidence",
      category: null,
    };
  }
  return {
    ...base,
    finalOutcome: "verified",
    reason: r.response?.reason ?? "Verification passed",
    category: null,
  };
}
