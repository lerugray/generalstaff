// End-to-end tests for `generalstaff cycle verify` and `changeset bundle`.
//
// Every test drives the real CLI as a subprocess against a throwaway
// GeneralStaff root and a real git repository. The reviewer is a fake
// `claude` script on PATH; no engineer, model CLI or network is ever started.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import {
  getCycleResultV1,
  meetsPassCondition,
  type CycleResultV1,
} from "../src/cycle_result_v1";
import { loadProjectsYaml } from "../src/projects";
import { isWorkingTreeClean } from "../src/safety";
import { setRootDir } from "../src/state";
import { writeBundle } from "../src/verify_only/bundle";
import { DEFAULT_VERIFY_BUDGETS, runVerifyOnlyCycle } from "../src/verify_only/run";
import { validateAgainstSchema, type JsonSchema } from "./helpers/json_schema";
import { git, makeVerifyFixture, type VerifyFixture } from "./helpers/verify_only_fixture";

const ORIGINAL_ROOT = process.cwd();
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

async function cliBundle(f: VerifyFixture, extra: string[] = []) {
  const out = join(f.scratch, `bundle-${Math.random().toString(36).slice(2, 8)}`);
  const r = await f.runCli([
    "changeset",
    "bundle",
    `--checkout=${f.checkout}`,
    `--base=${f.base}`,
    `--out=${out}`,
    "--json",
    ...extra,
  ]);
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
      verificationCommand: ({ scratch }) =>
        `pwd > '${scratch}/pwd.txt'; env > '${scratch}/env.txt'; test -f new.txt`,
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
      verificationCommand: ({ scratch }) => `sleep 60 & echo $! > '${scratch}/pid.txt'; wait`,
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
  });

  it("the overall budget ends a stuck check with a terminal record", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => `sleep 60 & echo $! > '${scratch}/pid.txt'; wait`,
    });
    const pidFile = join(fx.scratch, "pid.txt");
    editCheckout(fx);
    const bundle = await cliBundle(fx);
    const r = await fx.runCli(
      verifyArgs(fx, bundle, ["--json", "--overall-timeout=2", "--verification-timeout=40", "--grace=1"]),
    );
    expect(r.exitCode).toBe(1);
    const doc = await receiptOf(fx, startedCycleId(r.stdout));
    expect(doc.state).toBe("failed");
    expect(doc.outcome.reason).toContain("overall time budget");
    expect(doc.verify!.failureCategory).toBe("overall_timeout");
    expect(pidAlive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    noLeftovers(fx);
  });

  it("a reviewer past its time budget fails the change and is ended", async () => {
    fx = makeVerifyFixture({ claudeDelay: "exec sleep 30" });
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
    noLeftovers(fx);
  });

  it("SIGTERM writes a terminal record, reaps the process tree and exits 143", async () => {
    fx = makeVerifyFixture({
      verificationCommand: ({ scratch }) => `sleep 60 & echo $! > '${scratch}/pid.txt'; wait`,
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
  });

  it("SIGTERM while the reviewer runs ends the reviewer, records the interruption and exits 143", async () => {
    fx = makeVerifyFixture({
      claudeDelay: ({ scratch }) => `echo $$ > '${scratch}/claude.pid'; exec sleep 60`,
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
  });

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
  });
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
  });

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
  });
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
  });
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
