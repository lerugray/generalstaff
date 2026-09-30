// Fixtures for the verify-only tests: a throwaway GeneralStaff root with one
// registered project, a real git repository for that project, and a fake
// `claude` binary that stands in for the reviewer provider. Nothing here
// starts a real engineer, `claude`, codex or any model CLI.

import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { installTestCli } from "./test_cli";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("GIT_"))),
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.error ?? r.stderr}`);
  }
  return r.stdout.trim();
}

export interface RepoOptions {
  files?: Record<string, string>;
}

/** A committed repository with a couple of files; returns dir and base sha. */
export function makeRepo(parent: string, name: string, opts: RepoOptions = {}) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  const files = opts.files ?? {
    "a.txt": "one\n",
    "b.txt": "two\n",
    "src/main.ts": "export const x = 1;\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]) };
}

export interface VerifyFixture {
  /** Scratch directory holding everything below; removed by cleanup(). */
  scratch: string;
  /** The GeneralStaff root (cwd of every CLI call). */
  root: string;
  /** The registered project's checkout. */
  checkout: string;
  base: string;
  projectId: string;
  /** Directory holding the fake `claude`; put first on PATH. */
  binDir: string;
  /** Hermetic HOME the CLI subprocess runs under (empty unless a test writes it). */
  home: string;
  /** Log written by the fake `claude`: one JSON line per invocation. */
  claudeLog: string;
  /** File the project's engineer_command would create if it ever ran. */
  engineerSentinel: string;
  cleanup(): void;
  env(extra?: Record<string, string>): Record<string, string>;
  runCli(
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Start the CLI without waiting; the caller owns the process. */
  spawnCli(
    args: string[],
    opts?: { env?: Record<string, string> },
  ): {
    proc: ReturnType<typeof Bun.spawn>;
    result: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  claudeInvocations(): Array<{ args: string[]; stdinLength: number; cwd: string }>;
  /** Invocations of any other agent CLI stub on PATH (codex, aider, ...). Must stay empty. */
  vendorCalls(): string[];
  lastReviewerPrompt(): string;
}

export interface FixtureOptions {
  /** The project's verification command; a function receives the scratch directory. */
  verificationCommand?: string | ((ctx: { scratch: string }) => string);
  handsOff?: string[];
  files?: Record<string, string>;
  /** JSON the fake reviewer answers with. */
  reviewerVerdict?: {
    verdict: "verified" | "verified_weak" | "verification_failed";
    reason?: string;
  };
  /** Delay in milliseconds before the fake reviewer answers. */
  claudeDelay?: number;
  /** Capture the native reviewer PID in scratch/claude.pid. */
  claudePid?: boolean;
  /** Make the fake `claude` exit with this code and print nothing. */
  claudeExit?: number;
  extraProjectYaml?: string;
}

export function makeVerifyFixture(opts: FixtureOptions = {}): VerifyFixture {
  // Match the CLI's canonical paths, including Windows 8.3 temp-directory names.
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "gs-verify-test-")));
  const root = join(scratch, "gs-root");
  mkdirSync(join(root, "state"), { recursive: true });
  const { dir: checkout, base } = makeRepo(scratch, "project", { files: opts.files });
  const projectId = "vproj";
  const engineerSentinel = join(scratch, "ENGINEER-RAN");

  const verification =
    typeof opts.verificationCommand === "function"
      ? opts.verificationCommand({ scratch })
      : (opts.verificationCommand ?? "test -f a.txt");
  const handsOff = opts.handsOff ?? ["secrets/**"];
  writeFileSync(
    join(root, "projects.yaml"),
    [
      "projects:",
      `  - id: ${projectId}`,
      `    path: ${JSON.stringify(checkout)}`,
      "    priority: 1",
      `    engineer_command: ${JSON.stringify(`touch ${engineerSentinel}`)}`,
      `    verification_command: ${JSON.stringify(verification)}`,
      "    cycle_budget_minutes: 5",
      "    work_detection: tasks_json",
      "    concurrency_detection: none",
      "    branch: bot/work",
      "    auto_merge: false",
      "    hands_off:",
      ...handsOff.map((h) => `      - ${JSON.stringify(h)}`),
      opts.extraProjectYaml ?? "",
      "dispatcher:",
      "  state_dir: ./state",
      "  fleet_state_file: ./fleet_state.json",
      "  stop_file: ./STOP",
      "  override_file: ./next_project.txt",
      "  picker: priority_x_staleness",
      "  max_cycles_per_project_per_session: 3",
      "  log_dir: ./logs",
      "  digest_dir: ./digests",
      "",
    ].join("\n"),
  );

  const binDir = join(scratch, "bin");
  mkdirSync(binDir, { recursive: true });
  // Hermetic HOME for the CLI subprocess: global git config (and so the
  // global excludes resolution) is read from scratch, never from the real
  // user's environment, unless a test passes its own HOME in `extra`.
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const claudeLog = join(scratch, "claude-calls.jsonl");
  const promptCopy = join(scratch, "last-reviewer-prompt.txt");
  const verdict = opts.reviewerVerdict ?? {
    verdict: "verified",
    reason: "fake reviewer: change looks fine",
  };
  const answer = JSON.stringify({
    verdict: verdict.verdict,
    reason: verdict.reason ?? "fake reviewer",
    scope_drift_files: [],
    hands_off_violations: [],
    task_evidence: [],
    silent_failures: [],
    notes: "fake",
  });
  installTestCli(binDir, "claude", `
import { readFileSync, writeFileSync, appendFileSync } from "fs";
const prompt = readFileSync(0);
writeFileSync(${JSON.stringify(promptCopy)}, prompt);
appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args: process.argv.slice(2), stdinLength: prompt.length, cwd: process.cwd() }) + "\\n");
${opts.claudePid ? `writeFileSync(${JSON.stringify(join(scratch, "claude.pid"))}, String(process.pid));` : ""}
await new Promise(resolve => setTimeout(resolve, ${opts.claudeDelay ?? 0}));
${opts.claudeExit !== undefined ? `process.exit(${opts.claudeExit});` : ""}
process.stdout.write(${JSON.stringify(answer)});
`);

  const vendorLog = join(scratch, "vendor-calls.log");
  for (const vendor of ["codex", "aider", "grok", "kimi", "gemini", "cursor-agent", "opencode"]) {
    installTestCli(binDir, vendor, `
import { appendFileSync } from "fs";
appendFileSync(${JSON.stringify(vendorLog)}, ${JSON.stringify(vendor)} + " " + process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`);
  }

  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith("GENERALSTAFF_REVIEWER")) continue;
      // Hermetic global git config: see `home` above.
      if (k.toUpperCase() === "PATH") continue;
      if (k === "HOME" || k === "XDG_CONFIG_HOME" || k === "GIT_CONFIG_GLOBAL" || k === "GIT_CONFIG_SYSTEM") continue;
      base[k] = v;
    }
    base.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    base.HOME = home;
    return { ...base, ...extra };
  };

  return {
    scratch,
    root,
    checkout,
    base,
    projectId,
    binDir,
    home,
    claudeLog,
    engineerSentinel,
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
    env,
    async runCli(args, o = {}) {
      const proc = Bun.spawn([process.execPath, "run", CLI_PATH, ...args], {
        cwd: root,
        // Model the supervising caller: the CLI leads the owned group.
        detached: process.platform != "win32",
        env: env(o.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = o.timeoutMs
        ? setTimeout(() => proc.kill("SIGKILL"), o.timeoutMs)
        : undefined;
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (timer) clearTimeout(timer);
      return { stdout, stderr, exitCode };
    },
    spawnCli(args, o = {}) {
      const proc = Bun.spawn([process.execPath, "run", CLI_PATH, ...args], {
        cwd: root,
        // Model the supervising caller: the CLI leads the owned group.
        detached: process.platform != "win32",
        env: env(o.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
        ]);
        return { stdout, stderr, exitCode: await proc.exited };
      })();
      return { proc, result };
    },
    vendorCalls() {
      return existsSync(vendorLog)
        ? readFileSync(vendorLog, "utf8").split("\n").filter(Boolean)
        : [];
    },
    claudeInvocations() {
      if (!existsSync(claudeLog)) return [];
      return readFileSync(claudeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; stdinLength: number; cwd: string });
    },
    lastReviewerPrompt() {
      return existsSync(promptCopy) ? readFileSync(promptCopy, "utf8") : "";
    },
  };
}
