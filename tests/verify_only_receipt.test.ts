// The cycle-result/v1 reader's additive verify-only rules: the digest is
// recomputed according to identity.patchDigestAlgorithm, the verify object is
// carried through, and cycles without either read exactly as they always did.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getCycleResultV1,
  CycleResultError,
  meetsPassCondition,
  patchDigestFromBytes,
  type CycleResultV1,
} from "../src/cycle_result_v1";
import { setRootDir } from "../src/state";
import { validateAgainstSchema, type JsonSchema } from "./helpers/json_schema";

const ORIGINAL_ROOT = process.cwd();
const DIR = join(import.meta.dir, "fixtures", "verify_only_receipt_live");
const PROJECT = "alpha";
const CYCLE = "20260929120000_vrfy";
const LOG = join(DIR, "state", "_fleet", "PROGRESS.jsonl");
const CYCLE_DIR = join(DIR, "state", PROJECT, "cycles", CYCLE);
const SCHEMA = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "docs", "contracts", "cycle-result-v1.schema.json"),
    "utf8",
  ),
) as JsonSchema;

const DIGEST_INPUT = Buffer.from("diff --git a/x b/x\n...\ngs-untracked-file: n.txt\ngs-content-sha256:00\n");
const DIGEST = patchDigestFromBytes(DIGEST_INPUT);

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(CYCLE_DIR, { recursive: true });
  mkdirSync(join(DIR, "state", "_fleet"), { recursive: true });
  setRootDir(DIR);
});
afterEach(() => {
  setRootDir(ORIGINAL_ROOT);
  rmSync(DIR, { recursive: true, force: true });
});

interface Opts {
  algorithm?: string | null;
  startAlgorithm?: string | null;
  verify?: Record<string, unknown> | null;
  recordedDigest?: string;
  writeDigestInput?: boolean;
  terminal?: boolean;
}

function write(opts: Opts = {}): void {
  const algorithm = opts.algorithm === undefined ? "gs-patch-digest/v1" : opts.algorithm;
  const startAlgorithm = opts.startAlgorithm === undefined ? algorithm : opts.startAlgorithm;
  if (opts.writeDigestInput !== false) writeFileSync(join(CYCLE_DIR, "digest-input.bin"), DIGEST_INPUT);
  writeFileSync(join(CYCLE_DIR, "diff.patch"), "diff --git a/x b/x\n+human readable\n");
  writeFileSync(join(CYCLE_DIR, "reviewer-response.txt"), "{}");
  const verify =
    opts.verify === undefined
      ? {
          mode: "verify_only",
          changesetDigest: DIGEST,
          digestAlgorithm: "gs-patch-digest/v1",
          baseRevision: "b".repeat(40),
          checkoutPath: "/work/alpha",
          worktreePath: "/gs/state/alpha/verify/x/tree",
          excludedPaths: ["scaffold/a"],
          handsOffHits: [{ file: "src/safety.ts", pattern: "src/safety.ts" }],
          cliVersion: "0.15.0",
          reviewerProvider: "claude",
          failureCategory: null,
          futureField: "ignored",
        }
      : opts.verify;
  const line = (event: string, data: Record<string, unknown>, t: string) =>
    JSON.stringify({ timestamp: t, event, cycle_id: CYCLE, project_id: PROJECT, data });
  const lines = [
    line("cycle_start", { start_sha: "b".repeat(40), branch: "main", ...(startAlgorithm ? { patch_digest_algorithm: startAlgorithm } : {}) }, "2026-09-29T12:00:00Z"),
    line("verification_outcome", { outcome: "passed" }, "2026-09-29T12:01:00Z"),
    line("reviewer_verdict", { verdict: "verified", reason: "ok" }, "2026-09-29T12:02:00Z"),
  ];
  if (opts.terminal !== false) {
    lines.push(
      line(
        "cycle_end",
        {
          outcome: "verified",
          reason: "ok",
          start_sha: "b".repeat(40),
          end_sha: "b".repeat(40),
          checkout_path: "/work/alpha",
          branch: "main",
          base_revision: "b".repeat(40),
          patch_digest: opts.recordedDigest ?? DIGEST,
          ...(algorithm ? { patch_digest_algorithm: algorithm } : {}),
          ...(verify ? { verify } : {}),
        },
        "2026-09-29T12:03:00Z",
      ),
    );
  }
  writeFileSync(LOG, `${lines.join("\n")}\n`);
}

const read = (): Promise<CycleResultV1> =>
  getCycleResultV1(CYCLE, { fleetLogPath: LOG, checkoutPathOverride: "/work/alpha" });

describe("unreadable receipt evidence", () => {
  for (const artifact of ["digest-input.bin", "diff.patch", "reviewer-response.txt", "PROGRESS.jsonl"]) {
    for (const legacy of artifact === "diff.patch" ? [false, true] : [false]) {
      it(`refuses a directory at ${artifact}${legacy ? " (legacy digest)" : ""} through the reader and JSON CLI`, async () => {
        write(legacy ? { algorithm: null, verify: null } : {});
        const path = artifact === "PROGRESS.jsonl" ? LOG : join(CYCLE_DIR, artifact);
        rmSync(path);
        mkdirSync(path);
        let error: unknown;
        try { await read(); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(CycleResultError);
        expect((error as Error).message).toBe(`receipt evidence unreadable: ${artifact} (EISDIR)`);
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"),
          "cycle", "result", CYCLE, "--json"], { cwd: DIR, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        expect(exit).toBe(1);
        expect(stderr.trim()).toBe(`Error: receipt evidence unreadable: ${artifact} (EISDIR)`);
        expect(JSON.parse(stdout)).toEqual({ error: {
          code: "receipt_evidence_unreadable", message: `receipt evidence unreadable: ${artifact} (EISDIR)`,
        } });
      });
    }
  }
});

describe("cycle-result/v1 reader: verify-only additions", () => {
  it("binds a verify-only cycle to the digest of its frozen digest input", async () => {
    write();
    const doc = await read();
    expect(doc.state).toBe("passed");
    expect(doc.identity.patchDigest).toBe(DIGEST);
    expect(doc.identity.patchDigestAlgorithm).toBe("gs-patch-digest/v1");
    expect(doc.evidence.bundlePath).toBe(`state/${PROJECT}/cycles/${CYCLE}/digest-input.bin`);
    expect(doc.verify?.mode).toBe("verify_only");
    expect(doc.verify?.excludedPaths).toEqual(["scaffold/a"]);
    expect(doc.verify?.handsOffHits).toEqual([{ file: "src/safety.ts", pattern: "src/safety.ts" }]);
    expect(Object.keys(doc.verify!)).not.toContain("futureField");
    expect(meetsPassCondition(doc)).toBe(true);
    expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
  });

  it("the human-readable diff.patch is not the digest source for this algorithm", async () => {
    write();
    writeFileSync(join(CYCLE_DIR, "diff.patch"), "rewritten, still readable\n");
    expect((await read()).state).toBe("passed");
  });

  it("a changed digest input reads stale_uncertain, never passed", async () => {
    write();
    writeFileSync(join(CYCLE_DIR, "digest-input.bin"), "tampered");
    const doc = await read();
    expect(doc.state).toBe("stale_uncertain");
    expect(doc.identity.patchDigest).not.toBe(DIGEST);
  });

  it("a missing digest input reads unavailable", async () => {
    write({ writeDigestInput: false });
    const doc = await read();
    expect(doc.state).toBe("unavailable");
    expect(doc.unavailableReason).toBe("missing_identity_or_evidence");
    expect(doc.evidence.bundlePath).toBeNull();
    expect(meetsPassCondition(doc)).toBe(false);
  });

  it("an algorithm it does not know reads unavailable", async () => {
    write({ algorithm: "gs-patch-digest/v9" });
    const doc = await read();
    expect(doc.state).toBe("unavailable");
    expect(doc.unavailableReason).toBe("unsupported_digest_algorithm");
  });

  it("a verify-only record that disagrees with its own digest reads unavailable", async () => {
    write({ verify: { mode: "verify_only", changesetDigest: `sha256:${"9".repeat(64)}` } });
    const doc = await read();
    expect(doc.state).toBe("unavailable");
    expect(doc.unavailableReason).toBe("verify_record_inconsistent");
  });

  it("carries a verify object of another mode through without granting it verify-only standing", async () => {
    write({ verify: { mode: "something_else", changesetDigest: DIGEST } });
    const doc = await read();
    expect(doc.verify?.mode).toBe("something_else");
    expect(doc.state).toBe("passed"); // the digest rule is unchanged
  });

  it("drops a malformed verify object", async () => {
    write({ verify: { changesetDigest: DIGEST } as never });
    const doc = await read();
    expect(doc.verify).toBeUndefined();
  });

  it("a running verify-only cycle already reads its digest and algorithm", async () => {
    write({ terminal: false, algorithm: null, startAlgorithm: "gs-patch-digest/v1" });
    const doc = await read();
    expect(doc.state).toBe("running");
    expect(doc.identity.patchDigestAlgorithm).toBe("gs-patch-digest/v1");
    expect(doc.identity.patchDigest).toBe(DIGEST);
  });

  it("the algorithm needs its evidence: without a bundle path the pass condition fails", async () => {
    write();
    const doc = await read();
    expect(meetsPassCondition({ ...doc, evidence: { ...doc.evidence, bundlePath: null } })).toBe(false);
    const { bundlePath: _omit, ...evidenceWithout } = doc.evidence;
    expect(meetsPassCondition({ ...doc, evidence: evidenceWithout })).toBe(false);
  });

  it("cycles without the new fields read exactly as before", async () => {
    write({ algorithm: null, startAlgorithm: null, verify: null, writeDigestInput: false });
    const patch = "diff --git a/x b/x\n+human readable\n";
    // Legacy rule: the digest is sha256 of diff.patch.
    writeFileSync(join(CYCLE_DIR, "diff.patch"), patch);
    const legacy = patchDigestFromBytes(patch);
    write({ algorithm: null, startAlgorithm: null, verify: null, writeDigestInput: false, recordedDigest: legacy });
    writeFileSync(join(CYCLE_DIR, "diff.patch"), patch);
    const doc = await read();
    expect(doc.state).toBe("passed");
    expect(doc.identity.patchDigest).toBe(legacy);
    expect(Object.keys(doc.identity)).not.toContain("patchDigestAlgorithm");
    expect(Object.keys(doc.evidence)).not.toContain("bundlePath");
    expect(Object.keys(doc)).not.toContain("verify");
    expect(validateAgainstSchema(doc, SCHEMA, SCHEMA)).toEqual([]);
  });
});
