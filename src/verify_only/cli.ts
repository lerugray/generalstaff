// Command-line surface for the verify-only path:
//
//   generalstaff cycle verify      verify a bundled change-set, write a receipt
//   generalstaff changeset bundle  snapshot a checkout's uncommitted change-set
//
// Exit codes for `cycle verify`:
//   0   the check ran and passed (verified or verified_weak)
//   1   the check ran and did not pass; a receipt exists
//   2   usage error (bad or missing flag); no receipt
//   3   preflight refusal; no receipt
//   4   internal error; a recorded cycle may lack a terminal receipt
//   128+N  interrupted by signal N; terminal receipt is not guaranteed
//
// With --json the only thing written to stdout is one JSON object: the start
// object (cycleId, projectId, state "running") or, if no start was reported,
// an object with refused: true and a stable reason code. An internal error may
// leave a recorded cycle without a terminal receipt. Everything
// else goes to stderr. The receipt is read afterwards with
// `generalstaff cycle result <cycle-id> --json`; it is the only verdict.

import { realpathSync, statSync } from "fs";
import { isAbsolute, relative, sep } from "path";
import { parseArgs } from "util";
import { BundleError, writeBundle } from "./bundle";
import { PATCH_DIGEST_ALGORITHM } from "./constants";
import { DigestError } from "./digest";
import { killAndReapLiveGitGroups, reapLiveGitGroups, scrubLine, withGitAbort } from "./git";
import { toRefusal, VerifyRefusal, type RefusalCode } from "./refusal";
import { killAllOwnedGroups } from "./runner";
import { DEFAULT_VERIFY_BUDGETS, runVerifyOnlyCycle } from "./run";
import {
  loadProjectsYaml,
  ProjectsYamlNotFoundError,
} from "../projects";

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_INTERNAL = 4;

/**
 * An explicit --overall-timeout is used as given (run.ts refuses one below
 * verification + reviewer). Without one, the default is raised to cover the
 * verification and reviewer budgets the caller did set, so lengthening just
 * --verification-timeout does not trip the refusal.
 */
function resolveBudgets(b: {
  verificationSec?: number;
  reviewerSec?: number;
  overallSec?: number;
  graceSec?: number;
}) {
  if (b.overallSec !== undefined) return b;
  if (b.verificationSec === undefined && b.reviewerSec === undefined) return b;
  const needed =
    (b.verificationSec ?? DEFAULT_VERIFY_BUDGETS.verificationSec) +
    (b.reviewerSec ?? DEFAULT_VERIFY_BUDGETS.reviewerSec);
  return { ...b, overallSec: Math.max(DEFAULT_VERIFY_BUDGETS.overallSec, needed) };
}

export const CYCLE_VERIFY_HELP = `Usage: generalstaff cycle verify --project=<id> --checkout=<abs path>
                               --base=<40-hex> --branch=<name> --bundle=<abs dir>
                               --digest=sha256:<64-hex>
                               --digest-algorithm=${PATCH_DIGEST_ALGORITHM}
                               [--exclude=<path>]... [--json]
                               [--verification-timeout=<sec>] [--reviewer-timeout=<sec>]
                               [--overall-timeout=<sec>] [--grace=<sec>]

Verify a snapshot of an uncommitted change in an isolated worktree and write a
cycle-result/v1 receipt bound to the snapshot's digest. Runs the project's
verification command, then the reviewer, and nothing else: no engineer, no
advisor, no judgment gate, no bot. Working files, index, HEAD and refs are
untouched; git worktree metadata is added under .git/worktrees/<id> and removed
afterward.

  --project      Registered project id (its registered path must be --checkout)
  --checkout     Absolute path of the checkout the snapshot was taken from
  --base         Commit the snapshot was taken against (full hex id)
  --branch       Recorded identity only; no branch is created or moved
  --bundle       Absolute path of the snapshot directory (see: changeset bundle)
  --digest       Expected ${PATCH_DIGEST_ALGORITHM} digest; the check refuses if the
                 bundle does not reproduce it
  --exclude      Repeatable. Repo-relative paths left out of the snapshot
  --json         Write one machine-readable object to stdout

Time budgets (seconds): verification ${DEFAULT_VERIFY_BUDGETS.verificationSec}, reviewer ${DEFAULT_VERIFY_BUDGETS.reviewerSec}, overall ${DEFAULT_VERIFY_BUDGETS.overallSec}, grace ${DEFAULT_VERIFY_BUDGETS.graceSec}.
--overall-timeout must be at least --verification-timeout + --reviewer-timeout
(default ${DEFAULT_VERIFY_BUDGETS.verificationSec + DEFAULT_VERIFY_BUDGETS.reviewerSec}); a lower value is refused (exit 3, no receipt). If you give
--verification-timeout and/or --reviewer-timeout but no --overall-timeout, the
overall budget is raised to their sum when that exceeds ${DEFAULT_VERIFY_BUDGETS.overallSec}.
The reviewer is chosen by the project's configuration and GENERALSTAFF_REVIEWER_*
variables; there is no provider or model flag.

Exit codes: 0 passed, 1 not passed (receipt written), 2 usage error, 3 refused
(no receipt), 4 internal error (receipt may be incomplete), 128+N interrupted by signal N.
Read the receipt with: generalstaff cycle result <cycle-id> --json
`;

export const CHANGESET_HELP = `Usage: generalstaff changeset bundle --checkout=<abs path> --base=<40-hex>
                                   --out=<abs dir> [--exclude=<path>]... [--json]

Snapshot the uncommitted change in a checkout (tracked changes plus untracked,
non-ignored files) into a patch bundle, and print its ${PATCH_DIGEST_ALGORITHM} digest.
The checkout is only read. Verify the bundle with \`generalstaff cycle verify\`.
`;

// --- Argument checks -------------------------------------------------------

class UsageError extends Error {}

/** Absolute, no NUL, no leading dash, no `.`/`..` segments. */
export function checkedPath(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} is required`);
  }
  if (value.includes("\0")) throw new UsageError(`${flag} contains a NUL byte`);
  if (value.startsWith("-")) throw new UsageError(`${flag} looks like an option`);
  if (!isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`);
  if (value.split(/[\\/]/).some((seg) => seg === "." || seg === "..")) {
    throw new UsageError(`${flag} must not contain . or .. segments`);
  }
  return value;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required`);
  return value;
}

function parsePositiveSeconds(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(value)) {
    throw new UsageError(`${flag} must be a positive whole number of seconds`);
  }
  return Number(value);
}

function checkBranch(value: string | undefined): string {
  const v = requireValue(value, "--branch");
  if (v.length > 255 || v.startsWith("-") || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new UsageError("--branch is not a plain branch name");
  }
  return v;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

// --- Output ----------------------------------------------------------------

function writeJsonLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function refusalObject(code: RefusalCode, message: string) {
  return {
    schemaVersion: "cycle-verify/v1",
    refused: true,
    state: "refused",
    cycleId: null,
    reason: code,
    message,
  };
}

function reportNoReceipt(
  json: boolean,
  code: RefusalCode,
  message: string,
  exit: number,
): number {
  const line = scrubLine(message);
  if (json) writeJsonLine(refusalObject(code, line));
  console.error(`generalstaff: verify refused (${code}): ${line}`);
  return exit;
}

// --- cycle verify ----------------------------------------------------------

export async function runCycleVerifyCli(
  argv: string[],
  cliVersion: string,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(CYCLE_VERIFY_HELP);
    return EXIT_PASSED;
  }
  const wantsJson = argv.includes("--json");

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        checkout: { type: "string" },
        base: { type: "string" },
        branch: { type: "string" },
        bundle: { type: "string" },
        digest: { type: "string" },
        "digest-algorithm": { type: "string" },
        exclude: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        "verification-timeout": { type: "string" },
        "reviewer-timeout": { type: "string" },
        "overall-timeout": { type: "string" },
        grace: { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    return reportNoReceipt(
      wantsJson,
      "invalid_argument",
      err instanceof Error ? err.message : String(err),
      EXIT_USAGE,
    );
  }

  let request;
  try {
    const projectId = requireValue(values.project, "--project");
    const checkout = checkedPath(values.checkout, "--checkout");
    const bundle = checkedPath(values.bundle, "--bundle");
    const base = requireValue(values.base, "--base");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) {
      throw new UsageError("--base must be a full lowercase hex commit id");
    }
    const digest = requireValue(values.digest, "--digest");
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new UsageError("--digest must be sha256:<64 lowercase hex>");
    }
    const digestAlgorithm = requireValue(values["digest-algorithm"], "--digest-algorithm");
    const branch = checkBranch(values.branch);
    request = {
      projectId,
      checkout,
      bundle,
      base,
      digest,
      digestAlgorithm,
      branch,
      exclude: values.exclude ?? [],
      budgets: resolveBudgets({
        verificationSec: parsePositiveSeconds(values["verification-timeout"], "--verification-timeout"),
        reviewerSec: parsePositiveSeconds(values["reviewer-timeout"], "--reviewer-timeout"),
        overallSec: parsePositiveSeconds(values["overall-timeout"], "--overall-timeout"),
        graceSec: parsePositiveSeconds(values.grace, "--grace"),
      }),
    };
  } catch (err) {
    if (err instanceof UsageError) {
      return reportNoReceipt(wantsJson, "invalid_argument", err.message, EXIT_USAGE);
    }
    throw err;
  }

  // In --json mode stdout carries exactly one object; keep stray logging off it.
  const originalLog = console.log;
  if (wantsJson) console.log = (...a: unknown[]) => console.error(...a);

  let startReported = false;
  const controller = new AbortController();
  let signalNumber: number | null = null;
  const handlers: Array<[NodeJS.Signals, number, () => void]> = [];
  for (const [name, num] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
    const handler = () => {
      if (signalNumber !== null) {
        // A second signal: stop waiting politely. Git runs in its own
        // process group, so exit without killing it would orphan that group.
        killAllOwnedGroups();
        killAndReapLiveGitGroups();
        process.exit(128 + num);
      }
      signalNumber = num;
      // Preflight owns an abort context that stops its git groups while
      // keeping cleanup immune to the first signal.
      controller.abort(name);
    };
    process.on(name, handler);
    handlers.push([name, num, handler]);
  }

  try {
    const yaml = await loadProjectsYaml().catch((err: unknown) => {
      if (err instanceof ProjectsYamlNotFoundError) {
        throw new VerifyRefusal("project_not_registered", "projects.yaml was not found");
      }
      throw new VerifyRefusal(
        "project_not_registered",
        `could not load projects.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const project = yaml.projects.find((p) => p.id === request.projectId);
    if (!project) {
      throw new VerifyRefusal(
        "project_not_registered",
        `project "${request.projectId}" is not registered`,
      );
    }
    let checkoutReal: string;
    let projectReal: string;
    try {
      checkoutReal = realpathSync.native(request.checkout);
      if (!statSync(checkoutReal).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new VerifyRefusal("checkout_invalid", "the checkout is not a directory");
    }
    try {
      projectReal = realpathSync.native(project.path);
    } catch {
      throw new VerifyRefusal(
        "project_not_registered",
        `the registered path of project "${project.id}" does not exist`,
      );
    }
    if (checkoutReal !== projectReal) {
      throw new VerifyRefusal(
        "project_not_registered",
        `the checkout is not the registered path of project "${project.id}"`,
      );
    }
    let bundleReal = request.bundle;
    try {
      bundleReal = realpathSync.native(request.bundle);
    } catch {
      // A missing bundle is reported by the bundle reader.
    }
    if (isInside(checkoutReal, bundleReal)) {
      throw new VerifyRefusal(
        "invalid_argument",
        "the bundle must be outside the checkout",
      );
    }

    const result = await runVerifyOnlyCycle({
      project,
      dispatcher: yaml.dispatcher,
      checkout: checkoutReal,
      base: request.base,
      branch: request.branch,
      bundleDir: bundleReal,
      digest: request.digest,
      digestAlgorithm: request.digestAlgorithm,
      exclude: request.exclude,
      budgets: Object.fromEntries(
        Object.entries(request.budgets).filter(([, v]) => v !== undefined),
      ),
      cliVersion,
      signal: controller.signal,
      onStarted: ({ cycleId, projectId }) => {
        startReported = true;
        if (wantsJson) {
          writeJsonLine({
            schemaVersion: "cycle-verify/v1",
            cycleId,
            projectId,
            state: "running",
            mode: "verify_only",
          });
        } else {
          console.log(`Verify-only cycle ${cycleId} started for ${projectId}`);
        }
      },
    });

    const verdictLine = `Cycle ${result.cycleId}: ${result.finalOutcome} — ${scrubLine(result.reason, 200)}`;
    if (wantsJson) console.error(verdictLine);
    else {
      console.log(verdictLine);
      console.log(`Receipt: generalstaff cycle result ${result.cycleId} --json`);
    }
    if (signalNumber !== null) return 128 + signalNumber;
    return result.passed ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    // After the start object, even a log-write failure must stay on stderr.
    const reportJson = wantsJson && !startReported;
    if (signalNumber !== null) {
      return reportNoReceipt(
        reportJson,
        "interrupted",
        startReported ? "Check interrupted" : "Check interrupted during preflight",
        128 + signalNumber,
      );
    }
    const mapped = toRefusal(err);
    if (mapped instanceof VerifyRefusal) {
      return reportNoReceipt(reportJson, mapped.code, mapped.message, EXIT_REFUSED);
    }
    return reportNoReceipt(
      reportJson,
      "internal_error",
      err instanceof Error ? err.message : String(err),
      EXIT_INTERNAL,
    );
  } finally {
    await reapLiveGitGroups();
    for (const [name, , handler] of handlers) process.off(name, handler);
    console.log = originalLog;
  }
}

// --- changeset bundle ------------------------------------------------------

export async function runChangesetCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(CHANGESET_HELP);
    return sub === undefined ? EXIT_USAGE : EXIT_PASSED;
  }
  if (sub !== "bundle") {
    console.error(`Error: unknown changeset subcommand: ${sub}`);
    console.error(CHANGESET_HELP);
    return EXIT_USAGE;
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CHANGESET_HELP);
    return EXIT_PASSED;
  }
  const wantsJson = rest.includes("--json");
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        checkout: { type: "string" },
        base: { type: "string" },
        out: { type: "string" },
        exclude: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }
  const controller = new AbortController();
  let signalNumber: number | null = null;
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const [name, num] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
    const handler = () => {
      if (signalNumber !== null) {
        killAndReapLiveGitGroups();
        process.exit(128 + num);
      }
      signalNumber = num;
      controller.abort(name);
    };
    process.on(name, handler);
    handlers.push([name, handler]);
  }
  let exitCode: number;
  try {
    const checkout = checkedPath(values.checkout, "--checkout");
    const out = checkedPath(values.out, "--out");
    const base = requireValue(values.base, "--base");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) {
      throw new UsageError("--base must be a full lowercase hex commit id");
    }
    const info = await withGitAbort(controller.signal, () => writeBundle({
      checkout,
      base,
      outDir: out,
      exclude: values.exclude ?? [],
    }));
    controller.signal.throwIfAborted();
    if (wantsJson) {
      writeJsonLine({ schemaVersion: "changeset-bundle/v1", ...info });
    } else {
      console.log(`Bundle written to ${info.bundlePath}`);
      console.log(`Digest: ${info.digest} (${info.digestAlgorithm})`);
      console.log(
        `Untracked files: ${info.untrackedFileCount}; tracked patch: ${info.patchBytes} bytes`,
      );
      console.log("Verify it with:");
      console.log(
        `  generalstaff cycle verify --project=<id> --checkout=${checkout} --base=${base} ` +
          `--branch=<name> --bundle=${info.bundlePath} --digest=${info.digest} ` +
          `--digest-algorithm=${info.digestAlgorithm}`,
      );
    }
    exitCode = EXIT_PASSED;
  } catch (err) {
    if (signalNumber !== null) {
      console.error(`Error (interrupted): Bundle interrupted (${controller.signal.reason})`);
      exitCode = 128 + signalNumber;
    } else if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      exitCode = EXIT_USAGE;
    } else if (err instanceof BundleError || err instanceof DigestError) {
      console.error(`Error (${err.code}): ${scrubLine(err.message)}`);
      exitCode = EXIT_REFUSED;
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    await reapLiveGitGroups();
    for (const [name, handler] of handlers) process.off(name, handler);
  }
  return signalNumber === null ? exitCode : 128 + signalNumber;
}
