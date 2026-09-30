// End-to-end tests for `generalstaff cycle verify` and `changeset bundle`.
//
// Every test drives the real CLI as a subprocess against a throwaway
// GeneralStaff root and a real git repository. The reviewer is a fake
// `claude` script on PATH; no engineer, model CLI or network is ever started.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from "fs";
import * as fsp from "fs/promises";
import { delimiter, join } from "path";
import { cliFixturePath, installTestCli, scriptCommand, sleepingCommand } from "./helpers/test_cli";
import { createHash } from "crypto";
import * as childProcess from "child_process";
import * as gitRunner from "../src/verify_only/git";
import {
  getCycleResultV1,
  meetsPassCondition,
  type CycleResultV1,
} from "../src/cycle_result_v1";
import { loadProjectsYaml } from "../src/projects";
import { isWorkingTreeClean } from "../src/safety";
import { setRootDir } from "../src/state";
import { writeBundle } from "../src/verify_only/bundle";
import { runCycleVerifyCli } from "../src/verify_only/cli";
import { CLEANUP_CAP_SEC, removeVerifyTree } from "../src/verify_only/materialize";
import { VerifyRefusal } from "../src/verify_only/refusal";
import type { RunnerResult } from "../src/verify_only/runner";
import {
  decide,
  DEFAULT_VERIFY_BUDGETS,
  PREFLIGHT_CAP_SEC,
  runVerifyOnlyCycle,
  worstCaseWallClockSec,
} from "../src/verify_only/run";
import type { ReviewerResult } from "../src/reviewer";
import { validateAgainstSchema, type JsonSchema } from "./helpers/json_schema";
import { git, makeVerifyFixture, type VerifyFixture } from "./helpers/verify_only_fixture";

const ORIGINAL_ROOT = process.cwd();
// Windows kill(SIGTERM/SIGINT) force-terminates: these tests specifically assert
// catchable POSIX signals and Unix exit conventions. Timeout/tree tests run everywhere.
const posixIt = process.platform === "win32" ? it.skip : it;
const SCHEMA = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "docs", "contracts", "cycle-result-v1.schema.json"),
    "utf8",
  ),
) as JsonSchema;

let fx: VerifyFixture | undefined;
afterEach(() => {
  setRootDir(ORIGINAL_ROOT);
  fx?.cleanup();
  fx = undefined;
});

// --- helpers ---------------------------------------------------------------

function editCheckout(f: VerifyFixture, files: Record<string, string> = {}): void {
  const changes = Object.keys(files).length
    ? files
    : { "a.txt": "one\nchanged\n", "new.txt": "brand new\n" };
  for (const [rel, content] of Object.entries(changes)) {
    const full = join(f.checkout, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

async function cliBundle(
  f: VerifyFixture,
  extra: string[] = [],
  env: Record<string, string> = {},
) {
  const out = join(f.scratch, `bundle-${Math.random().toString(36).slice(2, 8)}`);
  const r = await f.runCli(
    [
      "changeset",
      "bundle",
      `--checkout=${f.checkout}`,
      `--base=${f.base}`,
      `--out=${out}`,
      "--json",
      ...extra,
    ],
    { env },
  );
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as { bundlePath: string; digest: string; digestAlgorithm: string };
}

function verifyArgs(
  f: VerifyFixture,
  bundle: { bundlePath: string; digest: string },
  extra: string[] = [],
  over: Partial<Record<string, string>> = {},
): string[] {
  const flags: Record<string, string> = {
    project: f.projectId,
    checkout: f.checkout,
    base: f.base,
    branch: "main",
    bundle: bundle.bundlePath,
    digest: bundle.digest,
    "digest-algorithm": "gs-patch-digest/v1",
    ...(over as Record<string, string>),
  };
  return [
    "cycle",
    "verify",
    ...Object.entries(flags).map(([k, v]) => `--${k}=${v}`),
    ...extra,
  ];
}

function progressEvents(f: VerifyFixture): Array<{ event: string; cycle_id?: string; data: Record<string, unknown> }> {
  const p = join(f.root, "state", f.projectId, "PROGRESS.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function receiptOf(f: VerifyFixture, cycleId: string): Promise<CycleResultV1> {
  setRootDir(f.root);
  return getCycleResultV1(cycleId);
}

function startedCycleId(stdout: string): string {
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const obj = JSON.parse(lines[0]!);
  expect(obj.schemaVersion).toBe("cycle-verify/v1");
  expect(obj.state).toBe("running");
  expect(obj.mode).toBe("verify_only");
  expect(typeof obj.cycleId).toBe("string");
  return obj.cycleId as string;
}

function noLeftovers(f: VerifyFixture): void {
  const verifyDir = join(f.root, "state", f.projectId, "verify");
  const left = existsSync(verifyDir) ? readdirSync(verifyDir) : [];
  expect(left).toEqual([]);
  expect(git(f.checkout, ["worktree", "list"]).split("\n")).toHaveLength(1);
  expect(existsSync(join(f.checkout, ".git", "worktrees"))).toBe(false);
}

function noReceipt(f: VerifyFixture): void {
  expect(existsSync(join(f.root, "state", f.projectId, "cycles"))).toBe(false);
  expect(existsSync(join(f.root, "state", f.projectId, "PROGRESS.jsonl"))).toBe(false);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function checkoutFacts(f: VerifyFixture) {
  return {
    head: git(f.checkout, ["rev-parse", "HEAD"]),
    branches: git(f.checkout, ["branch", "--list", "--all"]),
    refs: git(f.checkout, ["for-each-ref"]),
    stash: git(f.checkout, ["stash", "list"]),
    status: git(f.checkout, ["status", "--porcelain"]),
  };
}

// --- a passing check --------------------------------------------------------

describe("cycle verify: a passing check", () => {
  it("verifies a bundled change and writes a passing verify_only receipt", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const yamlBefore = readFileSync(join(fx.root, "projects.yaml"), "utf8");
    const before = checkoutFacts(fx);
    const indexPath = join(fx.checkout, ".git", "index");
    const indexBytes = readFileSync(indexPath);

    const bundle = await cliBundle(fx);
    expect(bundle.digestAlgorithm).toBe("gs-patch-digest/v1");
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const cycleId = startedCycleId(r.stdout);

    // The receipt, read the way a caller reads it: through the CLI.
    const read = await fx.runCli(["cycle", "result", cycleId, "--json"]);
    expect(read.exitCode).toBe(0);
    const doc = JSON.parse(read.stdout) as CycleResultV1;
    expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
    expect(doc.schemaVersion).toBe("cycle-result/v1");
    expect(doc.state).toBe("passed");
    expect(meetsPassCondition(doc)).toBe(true);
    expect(doc.identity.projectId).toBe(fx.projectId);
    expect(doc.identity.checkoutPath).toBe(fx.checkout);
    expect(doc.identity.branch).toBe("main");
    expect(doc.identity.baseRevision).toBe(fx.base);
    expect(doc.identity.endRevision).toBe(fx.base);
    expect(doc.identity.patchDigest).toBe(bundle.digest);
    expect(doc.identity.patchDigestAlgorithm).toBe("gs-patch-digest/v1");
    expect(doc.outcome.finalOutcome).toBe("verified");
    expect(doc.outcome.verificationOutcome).toBe("passed");
    expect(doc.receipts.verification).toEqual({
      id: `${cycleId}:verification`,
      present: true,
      summary: "passed",
    });
    expect(doc.receipts.reviewer.id).toBe(`${cycleId}:reviewer`);
    expect(doc.receipts.reviewer.present).toBe(true);
    expect(doc.verify).toMatchObject({
      mode: "verify_only",
      changesetDigest: bundle.digest,
      digestAlgorithm: "gs-patch-digest/v1",
      baseRevision: fx.base,
      checkoutPath: fx.checkout,
      excludedPaths: [],
      handsOffHits: [],
      reviewerProvider: "claude",
      failureCategory: null,
      // REAL #2: the passing check proved every process group reaped.
      reaped: true,
      // REAL #1: the hermetic test user has no global excludes file.
      globalExcludesFile: null,
      globalExcludesSha256: null,
    });
    expect(doc.verify!.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.verify!.worktreePath).toContain(join("state", fx.projectId, "verify", cycleId));

    // Every evidence path resolves to a real file.
    for (const rel of [
      doc.evidence.progressPath,
      doc.evidence.diffPatchPath,
      doc.evidence.reviewerResponsePath,
      doc.evidence.bundlePath,
    ]) {
      expect(rel).toBeTruthy();
      expect(existsSync(join(fx.root, rel!))).toBe(true);
    }
    expect(existsSync(join(fx.root, doc.evidence.cycleDir!, "verification.log"))).toBe(true);
    // The frozen digest input hashes to the bound digest; diff.patch stays readable.
    const digestInput = readFileSync(join(fx.root, doc.evidence.bundlePath!));
    expect(`sha256:${createHash("sha256").update(digestInput).digest("hex")}`).toBe(bundle.digest);
    const humanPatch = readFileSync(join(fx.root, doc.evidence.diffPatchPath!), "utf8");
    expect(humanPatch).toContain("+changed");
    expect(humanPatch).toContain("new.txt");
    expect(humanPatch).toContain("+brand new");

    // Nothing but the verification command and the reviewer ran.
    expect(existsSync(fx.engineerSentinel)).toBe(false);
    expect(fx.vendorCalls()).toEqual([]);
    const calls = fx.claudeInvocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["-p", "--allowedTools", "Read,Grep,Glob", "--output-format", "text"]);
    const prompt = fx.lastReviewerPrompt();
    expect(prompt).toContain("VERIFY-ONLY MODE");
    expect(prompt).toContain("+brand new");
    const events = progressEvents(fx).map((e) => e.event);
    expect(events.filter((e) => e === "cycle_end")).toHaveLength(1);
    expect(events[0]).toBe("cycle_start");
    expect(events.at(-1)).toBe("cycle_end");
    for (const banned of [
      "engineer_invoked",
      "engineer_completed",
      "advisor_verdict",
      "judgment_verdict",
      "cycle_rollback",
      "cycle_skipped",
      "provider_invoked",
    ]) {
      expect(events).not.toContain(banned);
    }
    expect(existsSync(join(fx.root, "fleet_state.json"))).toBe(false);

    // The caller's repository and registry are exactly as they were.
    expect(readFileSync(indexPath).equals(indexBytes)).toBe(true);
    expect(checkoutFacts(fx)).toEqual(before);
    expect(readFileSync(join(fx.root, "projects.yaml"), "utf8")).toBe(yamlBefore);
    expect(readFileSync(join(fx.checkout, "a.txt"), "utf8")).toBe("one\nchanged\n");
    expect(git(fx.checkout, ["branch", "--list", "bot/work"])).toBe("");
    noLeftovers(fx);
  });

  it("records hands-off matches instead of failing the change, and tells the reviewer", async () => {
    fx = makeVerifyFixture({ handsOff: ["secrets/**", "a.txt"] });
    editCheckout(fx, { "a.txt": "one\nchanged\n", "secrets/key.txt": "not a real secret\n", "ok.txt": "fine\n" });
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.verify!.handsOffHits).toEqual([
      { file: "a.txt", pattern: "a.txt" },
      { file: "secrets/key.txt", pattern: "secrets/**" },
    ]);
    const prompt = fx.lastReviewerPrompt();
    expect(prompt).toContain("`secrets/key.txt` (matched `secrets/**`)");
    expect(prompt).toContain("not a veto");
  });

  it("runs the verification command in the isolated tree with a pinned environment", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => scriptCommand(scratch, `
import { writeFileSync, existsSync } from "fs";
writeFileSync(${JSON.stringify(join(scratch, "pwd.txt"))}, process.cwd());
writeFileSync(${JSON.stringify(join(scratch, "env.txt"))}, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n"));
process.exit(existsSync("new.txt") ? 0 : 1);
`),
    });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]), {
      env: {
        GENERALSTAFF_TEST_SECRET: "top-secret-value",
        OPENROUTER_API_KEY: "sk-or-test-not-real",
        GENERALSTAFF_VERIFY_ENV_PASSTHROUGH: "KEEP_ME",
        KEEP_ME: "kept",
      },
    });
    expect(r.exitCode).toBe(0);
    const cycleId = startedCycleId(r.stdout);
    const cwd = readFileSync(join(fx.scratch, "pwd.txt"), "utf8").trim();
    expect(cwd.endsWith(join("state", fx.projectId, "verify", cycleId, "tree"))).toBe(true);
    const env = readFileSync(join(fx.scratch, "env.txt"), "utf8");
    expect(env).toContain("GENERALSTAFF_VERIFY_ONLY=1");
    expect(env).toContain(`GENERALSTAFF_CYCLE_ID=${cycleId}`);
    expect(env).toContain("KEEP_ME=kept");
    expect(env).not.toContain("top-secret-value");
    expect(env).not.toContain("sk-or-test-not-real");
  });

  it("prints human output without --json and reads back the same receipt", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Verify-only cycle");
    expect(r.stdout).toContain("generalstaff cycle result");
    expect(r.stdout).toContain("verified");
  });

  it("verifies a dirty checkout that the autonomous path refuses, with scaffold left out (F25, F23, F11)", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    mkdirSync(join(fx.checkout, ".generalstaff-proposal"), { recursive: true });
    writeFileSync(join(fx.checkout, ".generalstaff-proposal", "notes.md"), "scaffold\n");
    writeFileSync(join(fx.checkout, "engineer_command.sh"), "#!/bin/sh\ntouch scaffold-ran\n");

    // The autonomous path's own guard, untouched, refuses this tree.
    const guard = await isWorkingTreeClean(fx.checkout);
    expect(guard.clean).toBe(false);

    const exclude = [
      "--exclude=.generalstaff-proposal/notes.md",
      "--exclude=engineer_command.sh",
    ];
    const bundle = await cliBundle(fx, exclude);
    const withNew = bundle.digest;
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json", ...exclude]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.verify!.excludedPaths).toEqual([".generalstaff-proposal/notes.md", "engineer_command.sh"]);
    const patch = readFileSync(join(fx.root, doc.evidence.diffPatchPath!), "utf8");
    expect(patch).not.toContain("generalstaff-proposal");
    expect(patch).not.toContain("engineer_command");
    expect(existsSync(join(fx.checkout, "scaffold-ran"))).toBe(false);

    // A genuinely new untracked file does move the digest.
    writeFileSync(join(fx.checkout, "another-new.txt"), "more\n");
    const moved = await cliBundle(fx, exclude);
    expect(moved.digest).not.toBe(withNew);
  });
});

// --- failing checks ----------------------------------------------------------

describe("cycle verify: checks that do not pass still leave a receipt", () => {
  it("a verification command that exits nonzero fails with the exit code", async () => {
    fx = makeVerifyFixture({ verificationCommand: "exit 3" });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.finalOutcome).toBe("verification_failed");
    expect(doc.outcome.verificationOutcome).toBe("failed");
    expect(doc.outcome.reason).toBe("Verification gate failed (exit 3)");
    expect(doc.verify!.failureCategory).toBe("verification_nonzero");
    expect(meetsPassCondition(doc)).toBe(false);
    noLeftovers(fx);
  });

  it("a reviewer that rejects the change fails it with the reviewer's reason", async () => {
    fx = makeVerifyFixture({
      reviewerVerdict: { verdict: "verification_failed", reason: "leftover debug code in new.txt" },
    });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toBe("leftover debug code in new.txt");
    expect(doc.outcome.reviewerVerdict).toBe("verification_failed");
    expect(doc.verify!.failureCategory).toBe("reviewer_rejected");
    expect(doc.outcome.verificationOutcome).toBe("passed");
  });

  it("a reviewer that errors out fails the change", async () => {
    fx = makeVerifyFixture({ claudeExit: 3 });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toContain("Reviewer error");
    expect(doc.verify!.failureCategory).toBe("reviewer_error");
  });

  it("a weak reviewer verdict passes the gate as verified_weak, like an autonomous cycle", async () => {
    fx = makeVerifyFixture({ reviewerVerdict: { verdict: "verified_weak", reason: "low confidence" } });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.outcome.finalOutcome).toBe("verified_weak");
  });

  it("a verification command past its time budget fails and its whole process tree is reaped", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => sleepingCommand(scratch, 60_000),
    });
    const pidFile = join(fx.scratch, "pid.txt");
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const started = Date.now();
    const r = await fx.runCli(
      verifyArgs(fx, bundle, ["--json", "--verification-timeout=2", "--grace=1"]),
    );
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toMatch(/^Verification timed out/);
    expect(doc.verify!.failureCategory).toBe("verification_timeout");
    expect(doc.timestamps.endedAt).not.toBeNull();
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(grandchild)).toBe(false);
    noLeftovers(fx);
  }, 30_000);

  posixIt("the overall budget ends a stuck check with a terminal record", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => sleepingCommand(scratch, 60_000, true),
    });
    const pidFile = join(fx.scratch, "pid.txt");
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    // POSIX-only grace escalation: Windows taskkill cannot deliver a catchable TERM.
    // A valid budget set: overall (2) covers verification (1) + reviewer (1).
    // The command ignores the polite stop, so the overall timer fires while
    // the stage is still being killed.
    const r = await fx.runCli(
      verifyArgs(fx, bundle, [
        "--json",
        "--verification-timeout=1",
        "--reviewer-timeout=1",
        "--overall-timeout=2",
        "--grace=2",
      ]),
    );
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toContain("overall time budget");
    expect(doc.verify!.failureCategory).toBe("overall_timeout");
    // cycle_start -> cycle_end is the timed part of the published budget: the
    // overall budget (2 s) plus at most the grace (2 s) plus scheduling slack.
    const ev = progressEvents(fx);
    const startedMs = Date.parse((ev.find((e) => e.event === "cycle_start") as any).timestamp);
    const endedMs = Date.parse((ev.find((e) => e.event === "cycle_end") as any).timestamp);
    expect(endedMs - startedMs).toBeGreaterThanOrEqual(1900);
    expect(endedMs - startedMs).toBeLessThan((2 + 2) * 1000 + 2500);
    expect(pidAlive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    noLeftovers(fx);
  }, 30_000);

  it("a reviewer past its time budget fails the change and is ended", async () => {
    fx = makeVerifyFixture({ claudeDelay: 30_000, claudePid: true });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const started = Date.now();
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json", "--reviewer-timeout=2"]));
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.verify!.failureCategory).toBe("reviewer_timeout");
    expect(doc.outcome.reason).toContain("Reviewer timed out");
    const reviewerPid = Number(readFileSync(join(fx.scratch, "claude.pid"), "utf8"));
    expect(pidAlive(reviewerPid)).toBe(false);
    noLeftovers(fx);
  }, 30_000);

  posixIt("SIGTERM writes a terminal record, reaps the process tree and exits 143", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => sleepingCommand(scratch, 60_000),
    });
    const pidFile = join(fx.scratch, "pid.txt");
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const { proc, result } = fx.spawnCli(verifyArgs(fx, bundle, ["--json", "--grace=1"]));
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 20_000, "the command to start");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(grandchild)).toBe(true);
    proc.kill("SIGTERM");
    const r = await result;
    expect(r.exitCode).toBe(143);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toBe("Check interrupted (SIGTERM)");
    expect(doc.verify!.failureCategory).toBe("interrupted");
    expect(doc.timestamps.endedAt).not.toBeNull();
    expect(pidAlive(grandchild)).toBe(false);
    noLeftovers(fx);
  }, 30_000);

  posixIt("SIGTERM while the reviewer runs ends the reviewer, records the interruption and exits 143", async () => {
    fx = makeVerifyFixture({
      claudeDelay: 60_000, claudePid: true,
    });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const pidFile = join(fx.scratch, "claude.pid");
    const { proc, result } = fx.spawnCli(verifyArgs(fx, bundle, ["--json", "--grace=1"]));
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 20_000, "the reviewer to start");
    const reviewerPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(reviewerPid)).toBe(true);
    proc.kill("SIGTERM");
    const r = await result;
    expect(r.exitCode).toBe(143);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.verify!.failureCategory).toBe("interrupted");
    expect(pidAlive(reviewerPid)).toBe(false);
    noLeftovers(fx);
  }, 30_000);

  it("a verification command longer than the 30 second child budget completes", async () => {
    fx = makeVerifyFixture({ verificationCommand: "sleep 31" });
    editCheckout(fx);
    expect(DEFAULT_VERIFY_BUDGETS.verificationSec).toBeGreaterThan(30);
    // The check's worst case stays well inside a caller's 20 minute budget,
    // so the caller never has to kill it before it writes its own record.
    const worstCase =
      DEFAULT_VERIFY_BUDGETS.overallSec + DEFAULT_VERIFY_BUDGETS.graceSec;
    expect(worstCase + 60).toBeLessThan(20 * 60);
    expect(DEFAULT_VERIFY_BUDGETS.verificationSec).toBeLessThan(DEFAULT_VERIFY_BUDGETS.overallSec);
    expect(DEFAULT_VERIFY_BUDGETS.reviewerSec).toBeLessThan(DEFAULT_VERIFY_BUDGETS.overallSec);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
  }, 90_000);
});

// --- refusals: no receipt ----------------------------------------------------

describe("cycle verify: preflight refusals leave no receipt", () => {
  async function refuse(
    f: VerifyFixture,
    args: string[],
    exit: number,
    code: string,
  ): Promise<void> {
    const r = await f.runCli(args);
    expect(r.exitCode).toBe(exit);
    const obj = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    expect(obj.refused).toBe(true);
    expect(obj.state).toBe("refused");
    expect(obj.cycleId).toBeNull();
    expect(obj.reason).toBe(code);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    // One scrubbed reason line on stderr.
    const lines = r.stderr.trim().split("\n").filter((l) => l.startsWith("generalstaff: verify refused"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`(${code})`);
    expect(lines[0]!.length).toBeLessThan(400);
    noReceipt(f);
    noLeftovers(f);
  }

  it("refuses an unregistered project or a checkout that is not its registered path", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { project: "nope" }), 3, "project_not_registered");
    const other = join(fx.scratch, "other-checkout");
    mkdirSync(other);
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { checkout: other }), 3, "project_not_registered");
    expect(existsSync(fx.engineerSentinel)).toBe(false);
  });

  it("refuses an unresolvable base", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { base: "0".repeat(40) }), 3, "base_unresolvable");
  });

  it("refuses a missing, empty or unreadable bundle", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, { ...bundle, bundlePath: join(fx.scratch, "absent") }, ["--json"]), 3, "bundle_missing");
    const empty = join(fx.scratch, "empty-dir");
    mkdirSync(empty);
    await refuse(fx, verifyArgs(fx, { ...bundle, bundlePath: empty }, ["--json"]), 3, "bundle_empty");
    const file = join(fx.scratch, "just-a-file");
    writeFileSync(file, "x");
    await refuse(fx, verifyArgs(fx, { ...bundle, bundlePath: file }, ["--json"]), 3, "bundle_unreadable");
  });

  it("refuses a digest the bundle does not reproduce", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, { ...bundle, digest: `sha256:${"a".repeat(64)}` }, ["--json"]), 3, "digest_mismatch");
    // The bundle is bound to its own exclusions: a different set is a different digest.
    await refuse(fx, verifyArgs(fx, bundle, ["--json", "--exclude=new.txt"]), 3, "digest_mismatch");
  });

  it("refuses an empty change", async () => {
    fx = makeVerifyFixture();
    const bundle = join(fx.scratch, "hand-made");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "diff.patch"), "");
    const emptyDigest = `sha256:${createHash("sha256").update("").digest("hex")}`;
    await refuse(fx, verifyArgs(fx, { bundlePath: bundle, digest: emptyDigest }, ["--json"]), 3, "empty_patch");
    // The writer refuses to make one in the first place.
    const r = await fx.runCli(["changeset", "bundle", `--checkout=${fx.checkout}`, `--base=${fx.base}`, `--out=${join(fx.scratch, "nothing")}`]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("empty");
    expect(existsSync(join(fx.scratch, "nothing"))).toBe(false);
  });

  it("refuses a digest algorithm it does not know", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { "digest-algorithm": "gs-patch-digest/v2" }), 3, "unsupported_digest_algorithm");
  });

  it("refuses a project with no verification command", async () => {
    fx = makeVerifyFixture({ verificationCommand: "   " });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    await refuse(fx, verifyArgs(fx, bundle, ["--json"]), 3, "no_verification_command");
  });

  it("treats bad flags as usage errors (exit 2), not checks", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const ok = verifyArgs(fx, bundle, ["--json"]);
    const without = (flag: string) => ok.filter((a) => !a.startsWith(`--${flag}=`));
    for (const flag of ["project", "checkout", "base", "branch", "bundle", "digest", "digest-algorithm"]) {
      await refuse(fx, without(flag), 2, "invalid_argument");
    }
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { checkout: "relative/path" }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { checkout: `${fx.checkout}/../project` }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { bundle: "-rf" }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { base: "HEAD" }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { base: "ABCDEF".repeat(7).slice(0, 40) }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { digest: "sha256:zz" }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json"], { branch: "-x" }), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json", "--model=opus"]), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json", "--provider=claude"]), 2, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json", "--exclude=../up"]), 3, "invalid_argument");
    await refuse(fx, verifyArgs(fx, bundle, ["--json", "--overall-timeout=0"]), 2, "invalid_argument");
  }, 30_000);
});

// --- lifecycle ---------------------------------------------------------------

describe("cycle verify: one check per project at a time", () => {
  it("a second identical check while one runs is refused and starts nothing", async () => {
    fx = makeVerifyFixture({ verificationCommand: "sleep 4" });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const args = verifyArgs(fx, bundle, ["--json"]);
    const first = fx.spawnCli(args);
    const lock = join(fx.root, "state", fx.projectId, "verify", ".lock");
    await waitFor(() => existsSync(lock), 20_000, "the first check to take the lock");
    const second = await fx.runCli(args);
    expect(second.exitCode).toBe(3);
    expect(JSON.parse(second.stdout).reason).toBe("verify_in_progress");
    const firstResult = await first.result;
    expect(firstResult.exitCode).toBe(0);
    const cycles = readdirSync(join(fx.root, "state", fx.projectId, "cycles"));
    expect(cycles).toHaveLength(1);
    expect(progressEvents(fx).filter((e) => e.event === "cycle_start")).toHaveLength(1);
    noLeftovers(fx);
  }, 30_000); // Includes a 20 s readiness wait and a 4 s command, plus preflight.

  it("replaces a lock whose owner is gone and sweeps a dead check's leftovers", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const verifyRoot = join(fx.root, "state", fx.projectId, "verify");
    mkdirSync(join(verifyRoot, "20200101000000_dead", "tree"), { recursive: true });
    writeFileSync(join(verifyRoot, "20200101000000_dead", "tree", "junk.txt"), "x");
    writeFileSync(
      join(verifyRoot, ".lock"),
      JSON.stringify({ pid: 2_147_000_000, cycleId: "20200101000000_dead", startedAt: "x", expiresAtMs: Date.now() + 3_600_000 }),
    );
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    noLeftovers(fx);
  });

  it("a second check after the first attaches nothing and is a new cycle", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const a = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    const b = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(startedCycleId(a.stdout)).not.toBe(startedCycleId(b.stdout));
  }, 15_000);
});

// --- reviewer providers ----------------------------------------------------------

describe("cycle verify: the reviewer is the project's, not the request's", () => {
  it("records the provider that actually ran when the primary errored and the fallback answered", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]), {
      env: {
        GENERALSTAFF_REVIEWER_PROVIDER: "ollama",
        GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER: "claude",
        OLLAMA_HOST: "http://127.0.0.1:9",
      },
    });
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.verify!.reviewerProvider).toBe("claude");
    expect(progressEvents(fx).map((e) => e.event)).toContain("reviewer_fallback");
  });

  it("runs a configured quorum through the same path and records it", async () => {
    fx = makeVerifyFixture({
      extraProjectYaml: [
        "    review:",
        "      reviewers:",
        "        - provider: claude",
        "          label: first",
        "        - provider: claude",
        "          label: second",
      ].join("\n"),
    });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.verify!.reviewerProvider).toBe("quorum:first,second");
    expect(fx.claudeInvocations()).toHaveLength(2);
    expect(existsSync(fx.engineerSentinel)).toBe(false);
  });
});

// --- every path ends on the record ----------------------------------------------------

describe("cycle verify: an unexpected failure still writes the terminal record", () => {
  it("records an internal error, removes the worktree and rethrows", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const info = await writeBundle({
      checkout: fx.checkout,
      base: fx.base,
      outDir: join(fx.scratch, "in-process-bundle"),
    });
    setRootDir(fx.root);
    const yaml = await loadProjectsYaml();
    let cycleId = "";
    await expect(
      runVerifyOnlyCycle({
        project: yaml.projects[0]!,
        dispatcher: yaml.dispatcher,
        checkout: fx.checkout,
        base: fx.base,
        branch: "main",
        bundleDir: info.bundlePath,
        digest: info.digest,
        digestAlgorithm: "gs-patch-digest/v1",
        cliVersion: "test",
        onStarted: (started) => {
          cycleId = started.cycleId;
          throw new Error("boom in the caller's callback");
        },
      }),
    ).rejects.toThrow("boom");
    const doc = await getCycleResultV1(cycleId);
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toContain("internal error");
    expect(doc.verify!.failureCategory).toBe("internal_error");
    expect(doc.timestamps.endedAt).not.toBeNull();
    expect(progressEvents(fx).filter((e) => e.event === "cycle_end")).toHaveLength(1);
    noLeftovers(fx);
    expect(existsSync(fx.engineerSentinel)).toBe(false);
  });
});

// --- receipts re-read ---------------------------------------------------------

describe("receipt re-read", () => {
  it("every receipt's recorded digest equals the digest recomputed from disk, and its state matches the writer's", async () => {
    const cases: Array<{ opts: Parameters<typeof makeVerifyFixture>[0]; state: string }> = [
      { opts: {}, state: "passed" },
      { opts: { verificationCommand: "exit 1" }, state: "failed" },
      { opts: { reviewerVerdict: { verdict: "verification_failed", reason: "no" } }, state: "failed" },
    ];
    for (const c of cases) {
      const f = makeVerifyFixture(c.opts);
      try {
        editCheckout(f);
        const bundle = await cliBundle(f);
        const r = await f.runCli(verifyArgs(f, bundle, ["--json"]));
        const cycleId = startedCycleId(r.stdout);
        const doc = await receiptOf(f, cycleId);
        const end = progressEvents(f).find((e) => e.event === "cycle_end")!;
        expect(end.data.patch_digest).toBe(bundle.digest);
        expect(end.data.patch_digest_algorithm).toBe("gs-patch-digest/v1");
        const recomputed = `sha256:${createHash("sha256")
          .update(readFileSync(join(f.root, doc.evidence.bundlePath!)))
          .digest("hex")}`;
        expect(doc.identity.patchDigest).toBe(recomputed);
        expect(recomputed).toBe(end.data.patch_digest as string);
        expect(doc.state).toBe(c.state as CycleResultV1["state"]);
        expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
      } finally {
        setRootDir(ORIGINAL_ROOT);
        f.cleanup();
      }
    }
  }, 30_000);
});

// --- reviewer cwd, global excludes, reap and cleanup reporting ----------

describe("hardening fix round 1", () => {
  it("runs the reviewer from outside the materialized tree, never inside it", async () => {
    // The reviewer subprocess is an agent CLI: it loads project instruction
    // files and settings hooks from its working directory. Everything inside
    // the materialized tree comes from the untrusted bundle, so the reviewer
    // must not run there. Its cwd is the cycle's verify directory.
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const cycleId = startedCycleId(r.stdout);
    const calls = fx.claudeInvocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toContain(join("state", fx.projectId, "verify", cycleId));
    expect(calls[0]!.cwd.endsWith("tree")).toBe(false);
    noLeftovers(fx);
  });

  it("refuses an overall budget below the verification + reviewer budgets", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(
      verifyArgs(fx, bundle, ["--json", "--overall-timeout=2", "--verification-timeout=40"]),
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const obj = JSON.parse(r.stdout.trim());
    expect(obj.refused).toBe(true);
    expect(obj.state).toBe("refused");
    expect(obj.reason).toBe("invalid_argument");
    noReceipt(fx);
  });

  it("pins a global excludes file from the user's git config: the ignored .env stays out of bundle, digest and diff.patch", async () => {
    fx = makeVerifyFixture();
    const ignoreFile = join(fx.scratch, "global-ignore");
    writeFileSync(ignoreFile, ".env\n");
    git(fx.home, ["config", "--file", join(fx.home, ".gitconfig"), "core.excludesFile", ignoreFile]);
    editCheckout(fx, { "a.txt": "one\nchanged\n", ".env": "SECRET=live-token\n" });
    const bundle = await cliBundle(fx);
    // The bundle never carried the globally-ignored secret.
    expect(existsSync(join(bundle.bundlePath, "files", ".env"))).toBe(false);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    // The receipt records WHICH global excludes file was in force — the pin,
    // not the user's ambient config, decided what "ignored" meant.
    expect(doc.verify!.globalExcludesFile).toBe(ignoreFile);
    expect(doc.verify!.globalExcludesSha256).toBe(
      createHash("sha256").update(".env\n").digest("hex"),
    );
    const patch = readFileSync(join(fx.root, doc.evidence.diffPatchPath!), "utf8");
    expect(patch).not.toContain(".env");
    noLeftovers(fx);
  });

  it("falls back to ~/.config/git/ignore when no core.excludesFile is configured", async () => {
    fx = makeVerifyFixture();
    mkdirSync(join(fx.home, ".config", "git"), { recursive: true });
    writeFileSync(join(fx.home, ".config", "git", "ignore"), ".env\n");
    editCheckout(fx, { "a.txt": "one\nchanged\n", ".env": "SECRET=live-token\n" });
    const bundle = await cliBundle(fx);
    expect(existsSync(join(bundle.bundlePath, "files", ".env"))).toBe(false);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    expect(doc.verify!.globalExcludesFile).toBe(join(fx.home, ".config", "git", "ignore"));
    noLeftovers(fx);
  });

  it("an unproven reap fails the check even when the exit code was 0", () => {
    const ver = {
      outcome: "failed",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      reaped: false,
      durationSeconds: 1,
      failedStage: null,
      logPath: "verification.log",
      logText: "",
    } as Parameters<typeof decide>[0];
    const reviewer = {
      result: {
        verdict: "verified",
        response: { verdict: "verified", reason: "ok" },
        rawResponse: "{}",
        parseError: null,
        provider: "claude",
      },
      timedOut: false,
    } as Parameters<typeof decide>[1];
    const d = decide(ver, reviewer, DEFAULT_VERIFY_BUDGETS);
    expect(d.finalOutcome).toBe("verification_failed");
    expect(d.category).toBe("verification_error");
    expect(d.reason).toContain("not proven reaped");
    expect(d.reaped).toBe(false);
  });

  it("a worktree cleanup failure is reported on the record, not silent", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    const cycleId = startedCycleId(r.stdout);
    // The cleanup-failure event is appended after the terminal record; the
    // receipt reader surfaces it on the verify block.
    appendFileSync(
      join(fx.root, "state", fx.projectId, "PROGRESS.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "verify_cleanup_failed",
        cycle_id: cycleId,
        project_id: fx.projectId,
        data: { path: join(fx.root, "state", fx.projectId, "verify", cycleId) },
      })}\n`,
      "utf8",
    );
    const doc = await receiptOf(fx, cycleId);
    expect(doc.verify!.cleanupFailed).toBe(true);
  }, 15_000);
});

// --- hardening fix round 2 ------------------------------------------------------------

type InProcessOverrides = Partial<Parameters<typeof runVerifyOnlyCycle>[0]>;

/**
 * Run the real verify-only check in this process under the fixture's hermetic
 * HOME, with the fixture's fake `claude` first on PATH. Restores the process
 * environment and the root directory afterwards.
 */
async function inProcessVerify(
  f: VerifyFixture,
  over: InProcessOverrides = {},
  env: { path?: string } = {},
) {
  editCheckout(f);
  const info = await writeBundle({
    checkout: f.checkout,
    base: f.base,
    outDir: join(f.scratch, `in-process-${Math.random().toString(36).slice(2, 8)}`),
  });
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  };
  setRootDir(f.root);
  const yaml = await loadProjectsYaml();
  process.env.PATH = env.path ?? `${f.binDir}${delimiter}${saved.PATH ?? ""}`;
  process.env.HOME = f.home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.GIT_CONFIG_GLOBAL;
  let cycleId = "";
  try {
    const result = await runVerifyOnlyCycle({
      project: yaml.projects[0]!,
      dispatcher: yaml.dispatcher,
      checkout: f.checkout,
      base: f.base,
      branch: "main",
      bundleDir: info.bundlePath,
      digest: info.digest,
      digestAlgorithm: "gs-patch-digest/v1",
      cliVersion: "test",
      onStarted: (started) => {
        cycleId = started.cycleId;
      },
      ...over,
    });
    return { result, cycleId: result.cycleId };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    void cycleId;
  }
}

/** A `git` on PATH that stalls (with a background child) for chosen subcommands, else runs real git. */
function installSlowGit(
  f: VerifyFixture,
  stallWhen: string,
  pidFile: string,
  ignoreSignals = false,
): void {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git not found");
  const sleeper = join(f.scratch, "git-sleeper.mjs");
  writeFileSync(sleeper, "setTimeout(() => {}, 120_000);\n");
  installTestCli(f.binDir, "git", `
import { spawn } from "child_process";
import { writeFileSync } from "fs";
${ignoreSignals ? 'for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});' : ''}
const args = process.argv.slice(2);
if ((" " + args.join(" ") + " ").includes(${JSON.stringify(" " + stallWhen + " ")})) {
  const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(sleeper)}], { stdio: "inherit" });
  child.on("spawn", () => writeFileSync(${JSON.stringify(pidFile)}, child.pid + "\\n" + process.pid + "\\n"));
  child.on("exit", () => process.exit(1));
} else {
  const child = spawn(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  child.on("error", err => { console.error(err); process.exit(1); });
  child.on("exit", code => process.exit(code ?? 1));
}
`);
}

const stalledRunner = (): Promise<RunnerResult> => new Promise<RunnerResult>(() => undefined);

describe("cleanup Git ownership", () => {
  for (const command of ["remove", "prune"]) {
    it(`unproven worktree ${command} fails the result and receipt before any terminal pass`, async () => {
      fx = makeVerifyFixture();
      const fixture = fx;
      const original = gitRunner.runGit;
      let cleanup = false;
      let injected = 0;
      const spy = spyOn(gitRunner, "runGit").mockImplementation(async (args, opts) => {
        if (cleanup && args[0] === "worktree") {
          // Even while either cleanup command is in flight, no terminal pass
          // may exist for a reader to consume.
          expect(progressEvents(fixture).filter(e => e.event === "cycle_end")).toHaveLength(0);
          const result = await original(args, opts);
          if (args[1] === command) {
            injected++;
            return { ...result, code: 0, reaped: false,
              reapError: "QueryInformationJobObject failed (Win32 error 5)" };
          }
          return result;
        }
        return original(args, opts);
      });
      try {
        const { result, cycleId } = await inProcessVerify(fixture, {
          onStarted: () => { cleanup = true; },
          runShell: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false,
            durationSeconds: 0, output: "ok", omittedBytes: 0, reaped: true, pid: null }),
        });
        expect(injected).toBe(1);
        expect(result.cleanedUp).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.reaped).toBe(false);
        expect(result.category).toBe("verification_error");
        expect(result.reason).toContain("Win32 error 5");
        const terminal = progressEvents(fixture).filter(e => e.event === "cycle_end");
        expect(terminal).toHaveLength(1);
        expect(terminal[0]!.data.outcome).toBe("verification_failed");
        const doc = await receiptOf(fixture, cycleId);
        expect(doc.state).toBe("failed");
        expect(meetsPassCondition(doc)).toBe(false);
        expect(doc.verify!.reaped).toBe(false);
        expect(doc.verify!.cleanupFailed).toBe(true);
        expect(doc.outcome.reason).toContain(`worktree ${command}`);
        expect(doc.outcome.reason).toContain("Win32 error 5");
        expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
      } finally { spy.mockRestore(); }
    });
  }
});

describe("hardening fix round 2", () => {
  posixIt("item 1: cleanupFailed round-trips writer -> schema -> reader when a real worktree removal fails", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    // POSIX mode bits: chmod 500 does not remove Windows delete permission.
    // The verification command leaves a directory nobody can delete from, so
    // the real cleanup (git worktree remove, then directory removal) fails.
    fx = makeVerifyFixture({
      verificationCommand: "mkdir locked && touch locked/f && chmod 500 locked",
    });
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    let cycleId = "";
    try {
      expect(r.exitCode).toBe(0);
      cycleId = startedCycleId(r.stdout);
      expect(r.stderr).toContain("verify cleanup failed");
      const events = progressEvents(fx).filter((e) => e.event === "verify_cleanup_failed");
      expect(events).toHaveLength(1);
      expect(events[0]!.cycle_id).toBe(cycleId);
      const doc = await receiptOf(fx, cycleId);
      expect(doc.verify!.cleanupFailed).toBe(true);
      // The schema accepts the field the reader adds.
      expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
    } finally {
      chmodSync(join(fx.root, "state", fx.projectId, "verify", cycleId, "tree", "locked"), 0o700);
    }
  }, 60_000);

  it("item 1: the schema declares verify.cleanupFailed as a boolean, and the contract docs list it", () => {
    const verifyProps = (SCHEMA as any).properties.verify.properties;
    expect(verifyProps.cleanupFailed.type).toBe("boolean");
    for (const doc of ["cycle-result-v1.md", "verify-only-cycle.md"]) {
      const text = readFileSync(join(import.meta.dir, "..", "docs", "contracts", doc), "utf8");
      expect(text).toContain("cleanupFailed");
    }
  });

  it("item 2: an unproven reap in the real verification stage fails the check and is recorded", async () => {
    fx = makeVerifyFixture();
    const fake = async (): Promise<RunnerResult> => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      durationSeconds: 0,
      output: "ok\n",
      omittedBytes: 0,
      reaped: false,
      pid: null,
    });
    const { result, cycleId } = await inProcessVerify(fx, { runShell: fake });
    expect(result.passed).toBe(false);
    expect(result.reaped).toBe(false);
    expect(result.category).toBe("verification_error");
    const doc = await receiptOf(fx, cycleId);
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toContain("not proven reaped");
    expect(doc.verify!.reaped).toBe(false);
    expect(doc.verify!.failureCategory).toBe("verification_error");
    const log = readFileSync(join(fx.root, doc.evidence.cycleDir!, "verification.log"), "utf8");
    expect(log).toContain("PROCESS TREE NOT PROVEN REAPED");
    expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
    noLeftovers(fx);
  });

  it("items 3 and 6: a stalled child ends inside the published budget; the abort waits grace, not grace + 5 s", async () => {
    fx = makeVerifyFixture();
    const budgets = { verificationSec: 1, reviewerSec: 1, overallSec: 2, graceSec: 1, preflightSec: 30 };
    const wallStart = Date.now();
    const { result, cycleId } = await inProcessVerify(fx, { runShell: stalledRunner, budgets });
    const wall = Date.now() - wallStart;
    expect(result.category).toBe("overall_timeout");
    const ev = progressEvents(fx);
    const startedMs = Date.parse((ev.find((e) => e.event === "cycle_start") as any).timestamp);
    const endedMs = Date.parse((ev.find((e) => e.event === "cycle_end") as any).timestamp);
    const timed = endedMs - startedMs;
    // The timed part is overall + grace (3 s) plus slack; with the old
    // grace + 5 s wait it would be about 8 s.
    expect(timed).toBeGreaterThanOrEqual(2900);
    expect(timed).toBeLessThan((budgets.overallSec + budgets.graceSec) * 1000 + 1800);
    // The whole call, cleanup included, is inside the published worst case
    // computed from the same numbers.
    expect(wall).toBeLessThan(worstCaseWallClockSec({ ...DEFAULT_VERIFY_BUDGETS, ...budgets }) * 1000);
    const doc = await receiptOf(fx, cycleId);
    expect(doc.verify!.failureCategory).toBe("overall_timeout");
    noLeftovers(fx);
  }, 30_000);

  it("items 5 and 6: the preflight cap fires, stops and reaps the in-flight git, then refuses cleanly", async () => {
    fx = makeVerifyFixture();
    const pidFile = join(fx.scratch, "slow-git.pids");
    installSlowGit(fx, "worktree add", pidFile);
    // Preflight includes several real Git launches before the deliberately
    // parked command. Leave setup room on Windows while still testing its cap.
    const preflightSec = 5;
    const started = Date.now();
    let caught: unknown;
    try {
      await inProcessVerify(fx, { budgets: { preflightSec } });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(VerifyRefusal);
    expect((caught as VerifyRefusal).code).toBe("materialize_failed");
    expect((caught as VerifyRefusal).message).toContain(`hard cap (${preflightSec}s)`);
    // cap + reap wait + cleanup, all small: nowhere near the fake git's 120 s.
    expect(elapsed).toBeLessThan(preflightSec * 1000 + 5000 + 4000 + 5000);
    // The slow git and its background child are both gone, not orphaned.
    const pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
    noLeftovers(fx);
    noReceipt(fx);
  }, 60_000);

  it("item 5: cleanup itself is bounded when git stalls", async () => {
    fx = makeVerifyFixture();
    const pidFile = join(fx.scratch, "slow-cleanup-git.pids");
    installSlowGit(fx, "prune", pidFile);
    const verifyDir = join(fx.scratch, "verify-dir");
    mkdirSync(join(verifyDir, "tree"), { recursive: true });
    const savedPath = process.env.PATH;
    const spawn = childProcess.spawn;
    // Inject startup timing at the spawn boundary: the real shim must have
    // entered its stall before git's 100 ms kill timer starts. Under load it
    // could previously be killed before writing either PID (ENOENT).
    const stalledGit = spawn(cliFixturePath(fx.binDir, "git"), ["worktree", "prune"], {
      cwd: fx.checkout,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnSpy: ReturnType<typeof spyOn> | undefined;
    let handedOff = false;
    try {
      // Readiness is setup, bounded by 5 s within the 30 s test timeout.
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length === 2,
        5000,
        "stalled prune shim readiness",
      );
      const pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(pidAlive(pid)).toBe(true);
      spawnSpy = spyOn(childProcess, "spawn").mockImplementation(((command, args, options) => {
        if (command === "git" && args?.at(-1) === "prune") {
          expect(handedOff).toBe(false);
          handedOff = true;
          return stalledGit;
        }
        return spawn(command, args ?? [], options ?? {});
      }) as typeof childProcess.spawn);
      process.env.PATH = `${fx.binDir}${delimiter}${savedPath ?? ""}`;
      const stepMs = 400;
      const started = Date.now();
      const gone = await removeVerifyTree(fx.checkout, verifyDir, stepMs);
      // Three step caps plus git.ts's documented 3 s reap grace; unchanged
      // from the original bound. Readiness and death observation are outside it.
      expect(Date.now() - started).toBeLessThan(3 * stepMs + 3000);
      expect(handedOff).toBe(true);
      // The directory removal is its own step and still succeeded.
      expect(gone.removed).toBe(true);
      expect(existsSync(verifyDir)).toBe(false);
      // SIGKILL can precede OS reaping: allow at most 1 s to observe death,
      // well inside the 30 s timeout. A surviving process still fails the test.
      await waitFor(() => pids.every((pid) => !pidAlive(pid)), 1000, "stalled git PIDs to disappear");
      for (const pid of pids) expect(pidAlive(pid)).toBe(false);
    } finally {
      spawnSpy?.mockRestore();
      process.env.PATH = savedPath;
      // Also clean up the real group when readiness or an assertion fails.
      try {
        if (process.platform === "win32" && stalledGit.pid !== undefined) {
          childProcess.spawnSync("taskkill.exe", ["/PID", String(stalledGit.pid), "/T", "/F"], {
            stdio: "ignore", timeout: 3000, windowsHide: true,
          });
        }
        else if (stalledGit.pid !== undefined) process.kill(-stalledGit.pid, "SIGKILL");
      } catch { /* already gone */ }
      await waitFor(
        () => stalledGit.exitCode !== null || stalledGit.signalCode !== null,
        1000,
        "stalled git leader reaping",
      );
    }
  }, 30_000);

  it("item 4: the published formula matches what the code bounds", () => {
    const doc = readFileSync(
      join(import.meta.dir, "..", "docs", "contracts", "verify-only-cycle.md"),
      "utf8",
    );
    expect(doc).toContain(
      `${PREFLIGHT_CAP_SEC} (preflight cap) + overall + grace + ${CLEANUP_CAP_SEC} (cleanup)`,
    );
    expect(worstCaseWallClockSec(DEFAULT_VERIFY_BUDGETS)).toBe(
      PREFLIGHT_CAP_SEC +
        DEFAULT_VERIFY_BUDGETS.overallSec +
        DEFAULT_VERIFY_BUDGETS.graceSec +
        CLEANUP_CAP_SEC,
    );
    // The preflight cap covers the redaction and artifact writes too.
    expect(doc.replaceAll("\r\n", "\n")).toContain("secret\n  redaction and the `digest-input` / `diff.patch` writes");
  });

  it("item 4: a hostile diff full of unterminated private-key headers is redacted in bounded time", async () => {
    fx = makeVerifyFixture();
    const spam = "-----BEGIN PRIVATE KEY-----\n".repeat(Math.floor((1024 * 1024) / 28));
    editCheckout(fx, { "spam.txt": spam });
    const bundle = await cliBundle(fx);
    const started = Date.now();
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
    expect(r.exitCode).toBe(0);
    // The quadratic form took over ten seconds on 1 MiB of this.
    expect(Date.now() - started).toBeLessThan(20_000);
    noLeftovers(fx);
  }, 60_000);

  it("item 7: --help and the refusal name the overall-timeout minimum and how to fix the call", async () => {
    fx = makeVerifyFixture();
    const help = await fx.runCli(["cycle", "verify", "--help"]);
    expect(help.stdout).toMatch(/--overall-timeout must be at least --verification-timeout \+ --reviewer-timeout/);
    expect(help.stdout).toContain("raised to their sum");
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(
      verifyArgs(fx, bundle, ["--json", "--overall-timeout=2", "--verification-timeout=40"]),
    );
    expect(r.exitCode).toBe(3);
    const obj = JSON.parse(r.stdout.trim());
    expect(obj.message).toContain("minimum of 340s");
    expect(obj.message).toContain("raise --overall-timeout to at least 340");
    noReceipt(fx);
  });

  it("item 7: giving only --verification-timeout raises the default overall budget instead of refusing", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    // 1000 + 300 > the default overall 900: without the auto-raise this is refused.
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json", "--verification-timeout=1000"]));
    expect(r.exitCode).toBe(0);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("passed");
    // An explicit --overall-timeout is never changed.
    const bundle2 = await cliBundle(fx);
    const bad = await fx.runCli(
      verifyArgs(fx, bundle2, ["--json", "--verification-timeout=1000", "--overall-timeout=900"]),
    );
    expect(bad.exitCode).toBe(3);
  }, 15_000);
});

// --- hardening fix round 3 ------------------------------------------------------------

describe("hardening fix round 3", () => {
  function cycleDirGone(f: VerifyFixture): void {
    expect(existsSync(join(f.root, "state", f.projectId, "cycles"))).toBe(false);
  }

  it("item 1: a forced write failure in preflight leaves no worktree, no git worktree list entry and no cycle directory", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const info = await writeBundle({
      checkout: fx.checkout,
      base: fx.base,
      outDir: join(fx.scratch, "bundle-write-fail"),
    });
    const orig = fsp.writeFile;
    const digestPath = join(fx.root, "state", fx.projectId, "cycles");
    const spy = spyOn(fsp, "writeFile").mockImplementation(((path: unknown, data: unknown, opts: unknown) => {
      if (String(path).startsWith(digestPath) && String(path).endsWith("digest-input.bin")) {
        return Promise.reject(
          Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
        );
      }
      return orig(path as never, data as never, opts as never);
    }) as typeof fsp.writeFile);
    const saved = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = console.error;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    };
    setRootDir(fx.root);
    process.env.PATH = `${fx.binDir}${delimiter}${saved.PATH ?? ""}`;
    process.env.HOME = fx.home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.GIT_CONFIG_GLOBAL;
    try {
      const code = await runCycleVerifyCli(
        [
          `--project=${fx.projectId}`,
          `--checkout=${fx.checkout}`,
          `--base=${fx.base}`,
          "--branch=main",
          `--bundle=${info.bundlePath}`,
          `--digest=${info.digest}`,
          "--digest-algorithm=gs-patch-digest/v1",
          "--json",
        ],
        "test",
      );
      // Carry the captured output so an unexpected exit code says why (a refusal names its code).
      expect({ code, stdout: stdout.join(""), stderr: stderr.join("\n") }).toMatchObject({ code: 4 });
      const record = JSON.parse(stdout.join("").trim()) as {
        refused: boolean;
        reason: string;
        cycleId: null;
        state: string;
      };
      expect(record.refused).toBe(true);
      expect(record.state).toBe("refused");
      expect(record.cycleId).toBeNull();
      expect(record.reason).toBe("internal_error");
      expect(stderr.join("\n")).toContain("verify refused (internal_error)");
      noLeftovers(fx);
      cycleDirGone(fx);
      noReceipt(fx);
    } finally {
      process.stdout.write = origWrite;
      console.error = origErr;
      spy.mockRestore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 60_000);

  it("item 1: the preflight cap firing after the cycle directory exists leaves no worktree and no cycle directory", async () => {
    fx = makeVerifyFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orig = fsp.writeFile;
    const digestPath = join(fx.root, "state", fx.projectId, "cycles");
    const spy = spyOn(fsp, "writeFile").mockImplementation(((path: unknown, data: unknown, opts: unknown) => {
      if (String(path).startsWith(digestPath) && String(path).endsWith("digest-input.bin")) {
        return gate.then(() =>
          Promise.reject(new Error("preflight write released after the cap")),
        );
      }
      return orig(path as never, data as never, opts as never);
    }) as typeof fsp.writeFile);
    let caught: unknown;
    try {
      await inProcessVerify(fx, { budgets: { preflightSec: 2 } });
    } catch (err) {
      caught = err;
    } finally {
      release();
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(VerifyRefusal);
    expect((caught as VerifyRefusal).code).toBe("materialize_failed");
    expect((caught as VerifyRefusal).message).toContain("hard cap (2s)");
    noLeftovers(fx);
    cycleDirGone(fx);
    noReceipt(fx);
  }, 30_000);

  async function signalSlowGit(
    signal: "SIGINT" | "SIGTERM",
    twice: boolean,
  ): Promise<{ exitCode: number; pids: number[] }> {
    const pidFile = join(fx!.scratch, "slow-git.pids");
    installSlowGit(fx!, "worktree add", pidFile, twice);
    editCheckout(fx!);
    const bundle = await cliBundle(fx!);
    const { proc, result } = fx!.spawnCli(verifyArgs(fx!, bundle, ["--json"]));
    const pids: number[] = [];
    try {
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").split("\n").filter(Boolean).length >= 2,
        20_000,
        "slow git to start",
      );
      pids.push(...readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number));
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(pidAlive(pid)).toBe(true);
      proc.kill(signal);
      if (twice) {
        await new Promise((r) => setTimeout(r, 200));
        proc.kill(signal);
      }
      const r = await Promise.race([
        result,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("verify did not exit after the signal")), 15_000),
        ),
      ]);
      for (const pid of pids) expect(pidAlive(pid)).toBe(false);
      return { exitCode: r.exitCode, pids };
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* group already gone */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  posixIt("item 2: SIGTERM aborts preflight and no live git process survives", async () => {
    fx = makeVerifyFixture();
    const { pids } = await signalSlowGit("SIGTERM", false);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
  }, 40_000);

  posixIt("item 2: preflight SIGINT exits 130 with no surviving git, even when git traps SIGINT and another is sent", async () => {
    fx = makeVerifyFixture();
    const { exitCode, pids } = await signalSlowGit("SIGINT", true);
    expect(exitCode).toBe(130);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
  }, 40_000);
});

// --- CLI surface ----------------------------------------------------------------

describe("CLI help", () => {
  it("documents the verify flags, exit codes and the absence of a model flag", async () => {
    fx = makeVerifyFixture();
    const r = await fx.runCli(["cycle", "verify", "--help"]);
    expect(r.exitCode).toBe(0);
    for (const flag of ["--project", "--checkout", "--base", "--branch", "--bundle", "--digest", "--digest-algorithm", "--exclude", "--json"]) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).toContain("Exit codes");
    expect(r.stdout).not.toContain("--model");
    const c = await fx.runCli(["cycle", "--help"]);
    expect(c.stdout).toContain("cycle verify");
    const b = await fx.runCli(["changeset", "--help"]);
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain("changeset bundle");
    const g = await fx.runCli(["--help"]);
    expect(g.stdout).toContain("changeset bundle");
  });
});


// --- hardening fix round 5 -------------------------------------------------------

describe("hardening fix round 5", () => {
  posixIt("finding 1: SIGTERM during preflight reports interrupted, exit 143, no receipt or debris", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const pidFile = join(fx.scratch, "preflight-signal.pids");
    installSlowGit(fx, "worktree add", pidFile);
    const { proc, result } = fx.spawnCli(verifyArgs(fx, bundle, ["--json"]));
    const pids: number[] = [];
    try {
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length === 2,
        20_000,
        "preflight worktree add",
      );
      pids.push(...readFileSync(pidFile, "utf8").trim().split("\n").map(Number));
      proc.kill("SIGTERM");
      const r = await result;
      // Check the outcome as well as exit status: a signal must not blame the bundle.
      const record = JSON.parse(r.stdout.trim());
      expect(record.reason).toBe("interrupted");
      expect(r.exitCode).toBe(143);
      expect(record.refused).toBe(true);
      expect(record.state).toBe("refused");
      expect(record.cycleId).toBeNull();
      expect(r.stderr).toContain("verify refused (interrupted)");
      for (const pid of pids) expect(pidAlive(pid)).toBe(false);
      noLeftovers(fx);
      noReceipt(fx);
    } finally {
      proc.kill("SIGKILL");
      for (const pid of pids) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      await result;
    }
  }, 40_000);

  it("finding 2: a refusal before tree creation spawns no git worktree prune", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const realGit = Bun.which("git")!;
    const log = join(fx.scratch, "git-calls.log");
    installTestCli(fx.binDir, "git", `
import { appendFileSync } from "fs";
import { spawnSync } from "child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"], { base: "f".repeat(40) }));
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout).reason).toBe("base_unresolvable");
    expect(readFileSync(log, "utf8")).not.toContain("worktree prune");
    noLeftovers(fx);
    noReceipt(fx);
  });

  it("finding 5: preflight cleanup preserves a cycle created concurrently in its parent", async () => {
    fx = makeVerifyFixture();
    const parent = join(fx.root, "state", fx.projectId, "cycles");
    const neighbor = join(parent, "concurrent-autonomous-cycle");
    const origWrite = fsp.writeFile;
    const origRm = fsp.rm;
    const origRmdir = fsp.rmdir;
    const writeSpy = spyOn(fsp, "writeFile").mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (String(path).startsWith(parent) && String(path).endsWith("digest-input.bin")) {
        return Promise.reject(new Error("forced preflight write failure"));
      }
      return origWrite(path as never, ...args as [never, never]);
    }) as typeof fsp.writeFile);
    let raced = false;
    const race = (path: unknown) => {
      if (String(path) === parent) {
        raced = true;
        mkdirSync(neighbor);
        writeFileSync(join(neighbor, "evidence"), "keep me");
      }
    };
    const rmSpy = spyOn(fsp, "rm").mockImplementation(((path: unknown, opts: unknown) => {
      race(path);
      return origRm(path as never, opts as never);
    }) as typeof fsp.rm);
    const rmdirSpy = spyOn(fsp, "rmdir").mockImplementation(((path: unknown) => {
      race(path);
      return origRmdir(path as never);
    }) as typeof fsp.rmdir);
    try {
      await expect(inProcessVerify(fx)).rejects.toThrow("forced preflight write failure");
      expect(raced).toBe(true);
      expect(existsSync(join(neighbor, "evidence"))).toBe(true);
      expect(readdirSync(parent)).toEqual(["concurrent-autonomous-cycle"]);
      expect(progressEvents(fx)).toEqual([]);
      noLeftovers(fx);
    } finally {
      writeSpy.mockRestore();
      rmSpy.mockRestore();
      rmdirSpy.mockRestore();
    }
  });

  // Windows kill(SIGKILL) returns exit 1, indistinguishable from git config's
  // "key unset" result. Use a fatal exit there; retain real signal death on POSIX.
  const die = process.platform === "win32"
    ? "process.exit(137);"
    : 'process.kill(process.pid, "SIGKILL");';
  for (const mode of ["dies", "hangs"] as const) {
    it(`finding 6: cycle verify refuses when global-excludes git ${mode}`, async () => {
      fx = makeVerifyFixture();
      // Build with an explicitly configured global ignore, then make resolution
      // indeterminate. Falling back to no excludes would misclassify this bundle.
      writeFileSync(join(fx.home, ".gitignore"), ".env\n");
      git(fx.home, ["config", "--file", join(fx.home, ".gitconfig"), "core.excludesFile", join(fx.home, ".gitignore")]);
      editCheckout(fx);
      writeFileSync(join(fx.checkout, ".env"), "local secret\n");
      const bundle = await cliBundle(fx);
      const realGit = Bun.which("git")!;
      const reached = join(fx.scratch, "excludes-shim-reached");
      installTestCli(fx.binDir, "git", `
import { writeFileSync } from "fs";
import { spawnSync } from "child_process";
const args = process.argv.slice(2);
if (args.join(" ") === "config --global --path --get core.excludesFile") {
  writeFileSync(${JSON.stringify(reached)}, args.join(" "));
  ${mode === "dies" ? die : 'await new Promise(resolve => setTimeout(resolve, 120_000));'}
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`);
      if (mode === "dies") {
        const r = await fx.runCli(verifyArgs(fx, bundle, ["--json"]));
        expect(r.exitCode).toBe(3);
        const record = JSON.parse(r.stdout);
        expect(record.reason).toBe("materialize_failed");
        expect(record.message).toContain("could not resolve");
      } else {
        // The CLI has no git-timeout flag; exercise its real run call with a
        // short git budget, without waiting for the production 60-second cap.
        await expect(inProcessVerify(fx, {
          bundleDir: bundle.bundlePath,
          digest: bundle.digest,
          gitTimeoutMs: 500,
        })).rejects.toThrow("could not resolve");
      }
      expect(readFileSync(reached, "utf8")).toBe("config --global --path --get core.excludesFile");
      noLeftovers(fx);
      noReceipt(fx);
    }, 15_000);

    it(`finding 6: changeset bundle refuses when global-excludes git ${mode}`, async () => {
      fx = makeVerifyFixture();
      editCheckout(fx);
      writeFileSync(join(fx.home, ".gitignore"), ".env\n");
      git(fx.home, ["config", "--file", join(fx.home, ".gitconfig"), "core.excludesFile", join(fx.home, ".gitignore")]);
      writeFileSync(join(fx.checkout, ".env"), "local secret\n");
      const realGit = Bun.which("git")!;
      const reached = join(fx.scratch, "excludes-shim-reached");
      installTestCli(fx.binDir, "git", `
import { writeFileSync } from "fs";
import { spawnSync } from "child_process";
const args = process.argv.slice(2);
if (args.join(" ") === "config --global --path --get core.excludesFile") {
  writeFileSync(${JSON.stringify(reached)}, args.join(" "));
  ${mode === "dies" ? die : 'await new Promise(resolve => setTimeout(resolve, 120_000));'}
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`);
      const out = join(fx.scratch, "indeterminate-bundle");
      const saved = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
      process.env.PATH = `${fx.binDir}${delimiter}${saved.PATH ?? ""}`;
      process.env.HOME = fx.home;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GIT_CONFIG_GLOBAL;
      try {
        await expect(writeBundle({ checkout: fx.checkout, base: fx.base, outDir: out, gitTimeoutMs: 500 })).rejects.toThrow("could not resolve");
        expect(readFileSync(reached, "utf8")).toBe("config --global --path --get core.excludesFile");
        expect(existsSync(out)).toBe(false);
        expect(readFileSync(join(fx.checkout, ".env"), "utf8")).toBe("local secret\n");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }, 15_000);
  }
});

// --- hardening fix round 6 -------------------------------------------------------

describe("hardening fix round 6", () => {
  it("D2: an unwritable progress log after start keeps stdout to one JSON line", async () => {
    fx = makeVerifyFixture();
    editCheckout(fx);
    const info = await writeBundle({
      checkout: fx.checkout,
      base: fx.base,
      outDir: join(fx.scratch, "bundle-log-fail"),
    });
    const progressPath = join(fx.root, "state", fx.projectId, "PROGRESS.jsonl");
    let started = false;
    let failedAppends = 0;
    const originalAppend = fsp.appendFile;
    const spy = spyOn(fsp, "appendFile").mockImplementation(((path: unknown, data: unknown, opts: unknown) => {
      if (String(path) === progressPath && started) {
        failedAppends++;
        return Promise.reject(Object.assign(new Error("ENOSPC: progress log is unwritable"), { code: "ENOSPC" }));
      }
      return originalAppend(path as never, data as never, opts as never);
    }) as typeof fsp.appendFile);
    const saved = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalWrite = process.stdout.write;
    const originalError = console.error;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      const line = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      stdout.push(line);
      if (JSON.parse(line).state === "running") started = true;
      return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    setRootDir(fx.root);
    process.env.PATH = `${fx.binDir}${delimiter}${saved.PATH ?? ""}`;
    process.env.HOME = fx.home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.GIT_CONFIG_GLOBAL;
    try {
      const code = await runCycleVerifyCli(verifyArgs(fx, info, ["--json"]).slice(2), "test");
      // Carry the captured output so an unexpected exit code says why (a refusal names its code).
      expect({ code, stdout: stdout.join(""), stderr: stderr.join("\n") }).toMatchObject({ code: 4 });
      expect(started).toBe(true);
      expect(failedAppends).toBeGreaterThan(0);
      const events = progressEvents(fx);
      expect(events.some((e) => e.event === "cycle_start")).toBe(true);
      expect(events.some((e) => e.event === "cycle_end")).toBe(false);
      const lines = stdout.join("").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ state: "running", projectId: fx.projectId });
      expect(stderr.join("\n")).toContain("internal_error");
      expect(stderr.join("\n")).toContain("progress log is unwritable");
      noLeftovers(fx);
    } finally {
      process.stdout.write = originalWrite;
      console.error = originalError;
      spy.mockRestore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 60_000);
});
