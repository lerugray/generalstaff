// GeneralStaff — doctor command: check prerequisites + diagnose
// auto-resolvable issues. Pass { fix: true } to prompt for each fix.

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { unlink } from "fs/promises";
import { join } from "path";
import { $ } from "bun";
import { createInterface } from "readline";
import { getRootDir, botWorktreePath } from "./state";
import type { ProjectConfig } from "./types";

interface CheckResult {
  name: string;
  found: boolean;
  version: string | null;
  // Prereq-specific failure (e.g. installed but below minimum version).
  // Distinct from `found: false`, which means not on PATH at all.
  belowMinimum?: { parsed: string; required: string };
}

// gs-179: bun's parser supports features (e.g. stable Bun.spawn stderr
// piping) and workspace semantics we rely on. 1.3.0 is the earliest
// release we've exercised — older versions may silently misbehave.
const MIN_BUN_VERSION = "1.3.0";

function parseSemverPrefix(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function meetsMinimum(version: string, minimum: string): boolean {
  const got = parseSemverPrefix(version);
  const want = parseSemverPrefix(minimum);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (got[i] !== want[i]) return got[i] > want[i];
  }
  return true;
}

// A fixable issue surfaced by a diagnostic check.
export interface DiagnosticIssue {
  id: string;
  description: string;
  fix: () => Promise<void>;
}

export interface DoctorOptions {
  fix?: boolean;
  assumeYes?: boolean;
  prompt?: (question: string) => Promise<boolean>;
  // Optional override for listing registered projects — tests inject a
  // pre-loaded list so they don't have to stage a projects.yaml.
  loadProjects?: () => Promise<ProjectConfig[]>;
  // When false, runDoctor still reports failures but does not call
  // process.exit(1). Tests use this to run doctor in-process with
  // synthetic project configs whose paths don't exist.
  exitOnFailure?: boolean;
  // gs-246: when true, each passing sanity check prints additional
  // indented context lines (resolved paths, git HEAD SHAs, byte sizes,
  // task counts). Failing checks print the same detail as without it.
  verbose?: boolean;
  // gs-251: when true, emit a single structured JSON object on stdout
  // instead of the usual human-readable text. --json + --fix emits the
  // post-fix state; --json + --verbose is accepted but a no-op (verbose
  // only affects text rendering).
  json?: boolean;
}

// gs-251: shape of a single check in --json output.
export interface DoctorJsonCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
  fixable?: boolean;
}

// gs-251: shape of the overall --json payload.
export interface DoctorJsonReport {
  ok: boolean;
  checks: DoctorJsonCheck[];
}

async function checkCommand(
  name: string,
  versionArg: string,
  minVersion?: string,
): Promise<CheckResult> {
  try {
    const proc = Bun.spawn([name, versionArg], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { name, found: false, version: null };
    }
    const version = stdout.trim().split("\n")[0] ?? "";
    const result: CheckResult = { name, found: true, version };
    if (minVersion && !meetsMinimum(version, minVersion)) {
      result.belowMinimum = { parsed: version, required: minVersion };
    }
    return result;
  } catch {
    return { name, found: false, version: null };
  }
}

const PREREQUISITES: Array<{
  name: string;
  versionArg: string;
  minVersion?: string;
}> = [
  { name: "bun", versionArg: "--version", minVersion: MIN_BUN_VERSION },
  { name: "git", versionArg: "--version" },
  { name: "claude", versionArg: "--version" },
];

// gs-179: flag projects whose path is missing or isn't a git repo.
// Returns human-readable problem strings rather than DiagnosticIssues
// because neither failure is auto-fixable — the user has to
// re-clone/re-point the project themselves.
export async function findProjectPathProblems(
  projects: ProjectConfig[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const p of projects) {
    if (!existsSync(p.path)) {
      problems.push(
        `${p.id}: path does not exist — ${p.path}. ` +
          `Fix: update projects.yaml or re-clone the repo at that path.`,
      );
      continue;
    }
    // `.git` is a directory in a normal repo and a file in a worktree;
    // existsSync matches both. Absence means not a git repo.
    if (!existsSync(join(p.path, ".git"))) {
      problems.push(
        `${p.id}: not a git repository — ${p.path}. ` +
          `Fix: run 'git init' there, or update projects.yaml to point at the correct directory.`,
      );
    }
  }
  return problems;
}

// Stale-worktree threshold. `isBotRunning` uses a 10-min freshness
// window; we use the same cutoff so we only flag worktrees that are
// definitely not an active session's.
const STALE_WORKTREE_MINUTES = 10;

export async function findStateDirIssues(
  projects: ProjectConfig[],
): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];
  const stateRoot = join(getRootDir(), "state");
  for (const p of projects) {
    const dir = join(stateRoot, p.id);
    if (!existsSync(dir)) {
      issues.push({
        id: `state-dir-missing:${p.id}`,
        description: `Missing state directory: state/${p.id}/`,
        fix: async () => {
          mkdirSync(dir, { recursive: true });
        },
      });
    }
  }
  return issues;
}

export async function findStaleWorktreeIssues(
  projects: ProjectConfig[],
): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];
  for (const p of projects) {
    const wt = botWorktreePath(p);
    if (!existsSync(wt)) continue;
    let ageMin = Infinity;
    try {
      ageMin = (Date.now() - statSync(wt).mtimeMs) / 60_000;
    } catch { /* treat as stale */ }
    if (ageMin < STALE_WORKTREE_MINUTES) continue;
    issues.push({
      id: `stale-worktree:${p.id}`,
      description:
        `Stale .bot-worktree at ${wt} ` +
        `(modified ${ageMin.toFixed(0)} min ago)`,
      fix: async () => {
        // Prefer `git worktree remove` so the parent repo's
        // worktree registry stays consistent; fall back to rmSync
        // if git refuses (directory already orphaned or locked).
        await $`git -C ${p.path} worktree remove ${wt} --force`
          .quiet()
          .nothrow();
        if (existsSync(wt)) {
          rmSync(wt, { recursive: true, force: true });
        }
      },
    });
  }
  return issues;
}

// gs-242: four additional sanity checks surfaced by `doctor` with
// ✓/✗ markers. These run alongside (not in place of) the pre-existing
// PASS/FAIL/WARN checks so existing behaviour is preserved.
//
// Each helper returns a `SanityCheckResult` with a human-readable
// detail line. Empty `problems` array means the check passed.

export interface SanityCheckResult {
  name: string;
  problems: string[];
  okDetail: string;
}

// Check (1): each registered project's path exists and is a git repo.
// Mirrors findProjectPathProblems but presented as a single ✓/✗ check
// so the doctor output can summarize "all projects point at real repos".
export function checkProjectPaths(
  projects: ProjectConfig[],
): SanityCheckResult {
  const problems: string[] = [];
  for (const p of projects) {
    if (!existsSync(p.path)) {
      problems.push(`${p.id}: path does not exist — ${p.path}`);
      continue;
    }
    if (!existsSync(join(p.path, ".git"))) {
      problems.push(`${p.id}: not a git repository — ${p.path}`);
    }
  }
  return {
    name: "project paths",
    problems,
    okDetail: `${projects.length} project(s) point at valid git repos`,
  };
}

// Check (2): each registered project has a state/<id>/ dir and its
// PROGRESS.jsonl (if present) is readable. We do NOT require the file
// to exist — a freshly-registered project won't have one yet.
export function checkProjectStateDirs(
  projects: ProjectConfig[],
): SanityCheckResult {
  const problems: string[] = [];
  const stateRoot = join(getRootDir(), "state");
  for (const p of projects) {
    const dir = join(stateRoot, p.id);
    if (!existsSync(dir)) {
      problems.push(`${p.id}: missing state dir — ${dir}`);
      continue;
    }
    const progress = join(dir, "PROGRESS.jsonl");
    if (existsSync(progress)) {
      try {
        accessSync(progress, fsConstants.R_OK);
      } catch {
        problems.push(`${p.id}: PROGRESS.jsonl not readable — ${progress}`);
      }
    }
  }
  return {
    name: "state dirs",
    problems,
    okDetail:
      projects.length === 0
        ? "no projects registered"
        : `state/<id>/ present and PROGRESS.jsonl readable for ${projects.length} project(s)`,
  };
}

// Check (3): each project's tasks.json (if present) parses as valid
// JSON. Missing is fine — many projects carry work in bot_tasks.md or
// upstream issue trackers instead.
export function checkProjectTasksJson(
  projects: ProjectConfig[],
): SanityCheckResult {
  const problems: string[] = [];
  const stateRoot = join(getRootDir(), "state");
  let checkedCount = 0;
  for (const p of projects) {
    const path = join(stateRoot, p.id, "tasks.json");
    if (!existsSync(path)) continue;
    checkedCount++;
    try {
      const raw = readFileSync(path, "utf-8");
      JSON.parse(raw);
    } catch (e) {
      problems.push(
        `${p.id}: tasks.json does not parse — ${(e as Error).message}`,
      );
    }
  }
  return {
    name: "tasks.json",
    problems,
    okDetail:
      checkedCount === 0
        ? "no tasks.json files present"
        : `${checkedCount} tasks.json file(s) parse as valid JSON`,
  };
}

// Check (4): the digests/ directory is writable — either it exists
// and is writable, or it's missing but the parent dir is writable so
// it can be created. We do NOT create it here — doctor without --fix
// is read-only.
// gs-255: for each registered project with auto_merge=true, count
// commits on the bot branch that haven't been merged into HEAD yet.
// Warns (but does not fix) when > 0 — the fix either re-runs a session
// (so gs-254's session-end flush lands them) or runs the manual merge.
// Skipped for auto_merge=false projects (bot/work is source-of-truth
// by design there) and for paths that aren't git repos.
export async function checkStrandedBotCommits(
  projects: ProjectConfig[],
): Promise<SanityCheckResult> {
  const problems: string[] = [];
  let relevantCount = 0;
  for (const p of projects) {
    if (!p.auto_merge) continue;
    if (!existsSync(p.path)) continue;
    if (!existsSync(join(p.path, ".git"))) continue;
    relevantCount++;
    let count = 0;
    try {
      const proc = Bun.spawn(
        ["git", "-C", p.path, "rev-list", `HEAD..${p.branch}`, "--count"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) continue;
      const parsed = parseInt(stdout.trim(), 10);
      count = Number.isFinite(parsed) ? parsed : 0;
    } catch {
      continue;
    }
    if (count > 0) {
      problems.push(
        `Project ${p.id} has ${count} unmerged commit(s) on ${p.branch} — ` +
          `run \`git -C ${p.path} merge --no-ff ${p.branch}\` to land them, ` +
          `or re-run a session to trigger the gs-254 flush.`,
      );
    }
  }
  return {
    name: "stranded bot/work commits",
    problems,
    okDetail:
      relevantCount === 0
        ? "no auto_merge=true projects registered"
        : `${relevantCount} auto_merge=true project(s), 0 stranded commits`,
  };
}

// gs-258: first-run sanity checks. Surface the three common footguns
// a fresh-clone user hits before registering projects: an absent /
// empty projects.yaml, a projects.yaml left byte-identical to the
// shipped example, or a state_dir that the current user can't write
// to. Each failure message points straight at the fix. These three
// checks do NOT gate process.exit — they surface as sanity ✗ rows.

// Check (gs-258a): at least one project is registered. Failure
// triggers when projects.yaml is absent OR the loaded list is empty.
// Kept independent from the projects.yaml loader's own errors so a
// fresh-clone user without any projects.yaml still sees a pointed fix.
export function checkProjectsYamlHasProject(
  projects: ProjectConfig[],
  projectsYamlPath: string,
): SanityCheckResult {
  const problems: string[] = [];
  if (!existsSync(projectsYamlPath) || projects.length === 0) {
    problems.push(
      "No projects registered. Run `generalstaff register` or copy projects.yaml.example and edit.",
    );
  }
  return {
    name: "projects registered",
    problems,
    okDetail: `${projects.length} project(s) registered`,
  };
}

// Check (gs-258b): projects.yaml is not byte-identical to the shipped
// example. Detects the "copied the example and forgot to edit" case.
// Passes silently when either file is absent — (a) surfaces a missing
// projects.yaml and a missing example is unusual (repo state oddity,
// not a user mistake).
export function checkProjectsYamlCustomized(
  projectsYamlPath: string,
  examplePath: string,
): SanityCheckResult {
  const problems: string[] = [];
  if (!existsSync(projectsYamlPath)) {
    return {
      name: "projects.yaml customized",
      problems,
      okDetail: "no projects.yaml present",
    };
  }
  if (!existsSync(examplePath)) {
    return {
      name: "projects.yaml customized",
      problems,
      okDetail: "no example file to compare against",
    };
  }
  try {
    const yaml = readFileSync(projectsYamlPath);
    const example = readFileSync(examplePath);
    if (yaml.equals(example)) {
      problems.push(
        "projects.yaml is unmodified from the shipped example. Replace the placeholder project entries with real projects.",
      );
    }
  } catch {
    // Read errors don't block this check — checkProjectStateDirs etc.
    // surface them with better context.
  }
  return {
    name: "projects.yaml customized",
    problems,
    okDetail: "projects.yaml differs from shipped example",
  };
}

// Check (gs-258c): state_dir exists and is writable, or is absent but
// its parent is writable (auto-create on first write). Probes with a
// throwaway file because accessSync on Windows sometimes reports W_OK
// on paths that actually reject writes — same belt-and-braces approach
// as checkDigestsWritable.
export function checkStateDirWritable(): SanityCheckResult {
  const stateDir = join(getRootDir(), "state");
  const problems: string[] = [];
  let okDetail = `state_dir writable — ${stateDir}`;
  if (existsSync(stateDir)) {
    try {
      const st = statSync(stateDir);
      if (!st.isDirectory()) {
        throw new Error("state path is not a directory");
      }
      accessSync(stateDir, fsConstants.W_OK);
      const probe = join(stateDir, `.doctor-probe-${process.pid}`);
      writeFileSync(probe, "");
      unlinkSync(probe);
    } catch {
      problems.push(
        `state_dir not writable — check permissions on ${stateDir}`,
      );
    }
  } else {
    try {
      accessSync(getRootDir(), fsConstants.W_OK);
      okDetail = `state_dir will be created on first write — parent ${getRootDir()} is writable`;
    } catch {
      problems.push(
        `state_dir not writable — check permissions on ${stateDir}`,
      );
    }
  }
  return { name: "state_dir", problems, okDetail };
}

export function checkDigestsWritable(): SanityCheckResult {
  const root = getRootDir();
  const digests = join(root, "digests");
  const problems: string[] = [];
  let okDetail = `digests/ writable — ${digests}`;
  if (existsSync(digests)) {
    try {
      accessSync(digests, fsConstants.W_OK);
      // Belt-and-braces: accessSync on Windows sometimes reports W_OK
      // on directories that actually reject writes. Probe with a
      // throwaway file and clean up immediately.
      const probe = join(digests, `.doctor-probe-${process.pid}`);
      writeFileSync(probe, "");
      unlinkSync(probe);
    } catch (e) {
      problems.push(
        `digests/ exists but is not writable — ${digests}: ${(e as Error).message}`,
      );
    }
  } else {
    // Parent-dir writability determines whether digests/ can be created.
    try {
      accessSync(root, fsConstants.W_OK);
      okDetail = `digests/ will be created on first write — parent ${root} is writable`;
    } catch (e) {
      problems.push(
        `digests/ missing and parent dir not writable — ${root}: ${(e as Error).message}`,
      );
    }
  }
  return { name: "digests/", problems, okDetail };
}

export async function findOrphanedStopFileIssue(): Promise<DiagnosticIssue[]> {
  const stopPath = join(getRootDir(), "STOP");
  if (!existsSync(stopPath)) return [];
  return [
    {
      id: "orphaned-stop-file",
      description:
        `STOP file present at ${stopPath} — if no session is paused, ` +
        `this is likely orphaned from a crashed run`,
      fix: async () => {
        await unlink(stopPath);
      },
    },
  ];
}

// gs-246: verbose-detail helpers. Each returns the per-check extra
// lines rendered under a passing ✓ sanity check. Lines are indented
// 6 spaces to sit under the 3-space ✓ marker plus the 3-space check
// name indent already used by the non-verbose renderer.

async function gitHeadSha(repoPath: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", repoPath, "rev-parse", "--short", "HEAD"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return "unknown";
    const sha = stdout.trim();
    return sha.length > 0 ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

export async function projectPathsVerboseDetail(
  projects: ProjectConfig[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const p of projects) {
    const sha = await gitHeadSha(p.path);
    lines.push(`      ${p.id}: ${p.path} @ ${sha}`);
  }
  return lines;
}

export function stateDirsVerboseDetail(
  projects: ProjectConfig[],
): string[] {
  const lines: string[] = [];
  const stateRoot = join(getRootDir(), "state");
  for (const p of projects) {
    const progress = join(stateRoot, p.id, "PROGRESS.jsonl");
    if (existsSync(progress)) {
      let size = 0;
      try {
        size = statSync(progress).size;
      } catch { /* leave size as 0 */ }
      lines.push(`      ${p.id}: PROGRESS.jsonl ${size} bytes`);
    } else {
      lines.push(`      ${p.id}: PROGRESS.jsonl absent`);
    }
  }
  return lines;
}

export function tasksJsonVerboseDetail(
  projects: ProjectConfig[],
): string[] {
  const lines: string[] = [];
  const stateRoot = join(getRootDir(), "state");
  for (const p of projects) {
    const path = join(stateRoot, p.id, "tasks.json");
    if (!existsSync(path)) {
      lines.push(`      ${p.id}: tasks.json absent`);
      continue;
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      let count = 0;
      if (Array.isArray(parsed)) {
        count = parsed.length;
      } else if (
        parsed && typeof parsed === "object" &&
        Array.isArray((parsed as { tasks?: unknown }).tasks)
      ) {
        count = (parsed as { tasks: unknown[] }).tasks.length;
      }
      lines.push(`      ${p.id}: ${count} task(s)`);
    } catch {
      // Parse failure would make this a failing check; the ok branch
      // only runs when every tasks.json parsed, so this is defensive.
      lines.push(`      ${p.id}: tasks.json unreadable`);
    }
  }
  return lines;
}

export function digestsVerboseDetail(): string[] {
  return [`      ${join(getRootDir(), "digests")}`];
}

// gs-263: informational check that reports which reviewer provider
// would run based on current env. Mirrors the resolution logic in
// src/reviewer.ts (GENERALSTAFF_REVIEWER_PROVIDER default 'claude',
// model + host defaults matching reviewer.ts). A user asking "what
// happens if I run `session` right now" should see the answer here
// without reading code.
//
// Warn — not fail — when openrouter is selected without an API key:
// the cycle would fail-safe to verification_failed, so this is a
// misconfiguration surface, not a hard doctor failure.

export interface ReviewerProviderCheck {
  status: "pass" | "warn";
  provider: string;
  detail: string;
}

export function checkReviewerProvider(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): ReviewerProviderCheck {
  const provider = (
    env.GENERALSTAFF_REVIEWER_PROVIDER ?? "claude"
  ).toLowerCase();
  const modelOverride = env.GENERALSTAFF_REVIEWER_MODEL;

  if (provider === "openrouter") {
    const model = modelOverride ?? "qwen/qwen3-coder-30b-a3b-instruct";
    if (!env.OPENROUTER_API_KEY) {
      return {
        status: "warn",
        provider,
        detail:
          `reviewer: openrouter (model: ${model}) — ` +
          `OPENROUTER_API_KEY not set; cycles will fail-safe to verification_failed`,
      };
    }
    return {
      status: "pass",
      provider,
      detail: `reviewer: openrouter (model: ${model})`,
    };
  }

  if (provider === "ollama") {
    const model = modelOverride ?? "qwen3:8b";
    const host = env.OLLAMA_HOST ?? "http://localhost:11434";
    return {
      status: "pass",
      provider,
      detail: `reviewer: ollama (model: ${model}, OLLAMA_HOST: ${host})`,
    };
  }

  // claude (default) uses `claude -p` + subscription auth; no env
  // plumbing to surface beyond the provider name itself.
  return {
    status: "pass",
    provider,
    detail: `reviewer: ${provider}`,
  };
}

async function defaultPrompt(question: string): Promise<boolean> {
  // Simple y/N reader. Default (empty) answer is "no" — destructive
  // actions should require explicit consent.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  if (opts.json) {
    await runDoctorJson(opts);
    return;
  }
  const exitOnFailure = opts.exitOnFailure ?? true;
  console.log("GeneralStaff Doctor\n");
  console.log("Checking prerequisites...\n");

  const results: CheckResult[] = [];
  for (const prereq of PREREQUISITES) {
    const result = await checkCommand(
      prereq.name,
      prereq.versionArg,
      prereq.minVersion,
    );
    results.push(result);
  }

  let prereqsPassed = true;
  for (const r of results) {
    if (!r.found) {
      console.log(`  FAIL  ${r.name} — not found`);
      if (r.name === "bun") {
        console.log(`        Install from https://bun.sh`);
      }
      prereqsPassed = false;
    } else if (r.belowMinimum) {
      console.log(
        `  FAIL  ${r.name} — ${r.version} (need >=${r.belowMinimum.required})`,
      );
      if (r.name === "bun") {
        console.log(`        Upgrade: bun upgrade`);
      }
      prereqsPassed = false;
    } else {
      console.log(`  PASS  ${r.name} — ${r.version}`);
    }
  }

  // Load projects for the fixable-issue checks. If the config can't
  // load (e.g. running doctor in a fresh checkout with no projects.yaml),
  // skip these checks — they'd add noise, not signal.
  let projects: ProjectConfig[] = [];
  let projectsLoadError: string | null = null;
  try {
    const loader =
      opts.loadProjects ??
      (async () => (await import("./projects")).loadProjects());
    projects = await loader();
  } catch (e) {
    projectsLoadError = (e as Error).message;
  }

  const issues: DiagnosticIssue[] = [];
  let projectPathProblems: string[] = [];
  if (projectsLoadError === null) {
    issues.push(...(await findStateDirIssues(projects)));
    issues.push(...(await findStaleWorktreeIssues(projects)));
    projectPathProblems = await findProjectPathProblems(projects);
  }
  issues.push(...(await findOrphanedStopFileIssue()));

  console.log("\nChecking runtime state...\n");
  if (projectsLoadError !== null) {
    console.log(`  SKIP  project-level checks (${projectsLoadError})`);
  }
  for (const problem of projectPathProblems) {
    console.log(`  FAIL  ${problem}`);
  }
  if (issues.length === 0 && projectPathProblems.length === 0) {
    console.log("  PASS  no fixable issues detected");
  } else {
    for (const issue of issues) {
      console.log(`  WARN  ${issue.description}`);
    }
  }
  const projectHealthPassed = projectPathProblems.length === 0;

  // gs-242: sanity checks with ✓/✗ markers. These run regardless of
  // projectsLoadError (a missing projects.yaml simply means the
  // project-scoped checks evaluate against an empty list).
  console.log("\nSanity checks...\n");
  const projectsYamlPath = join(getRootDir(), "projects.yaml");
  const examplePath = join(getRootDir(), "projects.yaml.example");
  const sanityChecks: SanityCheckResult[] = [
    // gs-258: first-run checks go first so a fresh-clone user sees
    // "no projects registered" at the top instead of buried below
    // the project-iterating checks that have nothing to iterate.
    checkProjectsYamlHasProject(projects, projectsYamlPath),
    checkProjectsYamlCustomized(projectsYamlPath, examplePath),
    checkStateDirWritable(),
    checkProjectPaths(projects),
    checkProjectStateDirs(projects),
    checkProjectTasksJson(projects),
    checkDigestsWritable(),
    await checkStrandedBotCommits(projects),
  ];
  // gs-246: precompute verbose detail lines per passing sanity check.
  // Failing checks skip their verbose block so existing ✗ output is
  // untouched — the failure detail is already printed.
  const verboseDetails: string[][] = opts.verbose
    ? [
        [],
        [],
        [],
        await projectPathsVerboseDetail(projects),
        stateDirsVerboseDetail(projects),
        tasksJsonVerboseDetail(projects),
        digestsVerboseDetail(),
        [],
      ]
    : [[], [], [], [], [], [], [], []];
  for (let i = 0; i < sanityChecks.length; i++) {
    const check = sanityChecks[i]!;
    if (check.problems.length === 0) {
      console.log(`  ✓  ${check.name} — ${check.okDetail}`);
      if (opts.verbose) {
        for (const line of verboseDetails[i]!) {
          console.log(line);
        }
      }
    } else {
      for (const problem of check.problems) {
        console.log(`  ✗  ${check.name} — ${problem}`);
      }
    }
  }

  // gs-263: reviewer-provider informational check. Rendered below the
  // sanity list because it's env-driven, not state-driven: a ✓ here
  // only means "this is what would run", not "this project is healthy".
  const reviewerCheck = checkReviewerProvider();
  if (reviewerCheck.status === "pass") {
    console.log(`  ✓  ${reviewerCheck.detail}`);
  } else {
    console.log(`  ⚠  ${reviewerCheck.detail}`);
  }

  if (!opts.fix) {
    console.log("");
    if (issues.length > 0) {
      console.log(
        `Run \`generalstaff doctor --fix\` to resolve the ${issues.length} warning(s) above.`,
      );
    }
    if (!prereqsPassed) {
      console.log("Install missing prerequisites before using GeneralStaff.");
      if (exitOnFailure) process.exit(1);
    }
    if (!projectHealthPassed) {
      console.log("Fix project-path failures before using GeneralStaff.");
      if (exitOnFailure) process.exit(1);
    }
    if (prereqsPassed && issues.length === 0) {
      console.log("All prerequisites satisfied.");
    }
    return;
  }

  // --- Fix mode ---
  const promptFn = opts.prompt ?? defaultPrompt;
  console.log("\nApplying fixes...\n");
  let applied = 0;
  let skipped = 0;
  for (const issue of issues) {
    const approve =
      opts.assumeYes === true
        ? true
        : await promptFn(`Fix: ${issue.description}?`);
    if (!approve) {
      console.log(`  SKIP  ${issue.id}`);
      skipped++;
      continue;
    }
    try {
      await issue.fix();
      console.log(`  FIXED ${issue.id}`);
      applied++;
    } catch (e) {
      console.log(`  ERROR ${issue.id} — ${(e as Error).message}`);
    }
  }
  console.log(
    `\nFix summary: ${applied} applied, ${skipped} skipped, ` +
      `${issues.length - applied - skipped} errored.`,
  );
  if (!prereqsPassed) {
    console.log("Install missing prerequisites before using GeneralStaff.");
    if (exitOnFailure) process.exit(1);
  }
  if (!projectHealthPassed) {
    console.log("Fix project-path failures before using GeneralStaff.");
    if (exitOnFailure) process.exit(1);
  }
}

// gs-251: collect the doctor state as structured data. Does not print.
// Shared between the initial scan and the post-fix re-scan in JSON mode.
async function collectDoctorJsonReport(
  opts: DoctorOptions,
): Promise<DoctorJsonReport> {
  const checks: DoctorJsonCheck[] = [];

  // Prerequisites.
  for (const prereq of PREREQUISITES) {
    const result = await checkCommand(
      prereq.name,
      prereq.versionArg,
      prereq.minVersion,
    );
    if (!result.found) {
      checks.push({
        name: `prereq: ${prereq.name}`,
        status: "fail",
        detail: "not found on PATH",
      });
    } else if (result.belowMinimum) {
      checks.push({
        name: `prereq: ${prereq.name}`,
        status: "fail",
        detail: `${result.version} (need >=${result.belowMinimum.required})`,
      });
    } else {
      checks.push({
        name: `prereq: ${prereq.name}`,
        status: "pass",
        detail: result.version ?? undefined,
      });
    }
  }

  // Load projects. If unavailable, emit skipped entries for the
  // project-scoped checks so the consumer sees they were not run.
  let projects: ProjectConfig[] = [];
  let projectsLoadError: string | null = null;
  try {
    const loader =
      opts.loadProjects ??
      (async () => (await import("./projects")).loadProjects());
    projects = await loader();
  } catch (e) {
    projectsLoadError = (e as Error).message;
  }

  // gs-258: always-on first-run checks. These run whether or not
  // projects.yaml loaded — their whole point is to surface a missing
  // or unmodified projects.yaml, so gating them on a successful load
  // would hide the signal a first-run user needs.
  const projectsYamlPath = join(getRootDir(), "projects.yaml");
  const examplePath = join(getRootDir(), "projects.yaml.example");
  const firstRun: SanityCheckResult[] = [
    checkProjectsYamlHasProject(projects, projectsYamlPath),
    checkProjectsYamlCustomized(projectsYamlPath, examplePath),
    checkStateDirWritable(),
  ];
  for (const s of firstRun) {
    if (s.problems.length === 0) {
      checks.push({ name: s.name, status: "pass", detail: s.okDetail });
    } else {
      checks.push({
        name: s.name,
        status: "fail",
        detail: s.problems.join("; "),
      });
    }
  }

  if (projectsLoadError !== null) {
    for (const name of [
      "project paths",
      "state dirs",
      "tasks.json",
      "stranded bot/work commits",
    ]) {
      checks.push({
        name,
        status: "skipped",
        detail: `projects.yaml not loaded: ${projectsLoadError}`,
      });
    }
  } else {
    const sanity: SanityCheckResult[] = [
      checkProjectPaths(projects),
      checkProjectStateDirs(projects),
      checkProjectTasksJson(projects),
      await checkStrandedBotCommits(projects),
    ];
    for (const s of sanity) {
      if (s.problems.length === 0) {
        checks.push({ name: s.name, status: "pass", detail: s.okDetail });
      } else {
        checks.push({
          name: s.name,
          status: "fail",
          detail: s.problems.join("; "),
        });
      }
    }
  }

  const digests = checkDigestsWritable();
  if (digests.problems.length === 0) {
    checks.push({ name: digests.name, status: "pass", detail: digests.okDetail });
  } else {
    checks.push({
      name: digests.name,
      status: "fail",
      detail: digests.problems.join("; "),
    });
  }

  // Fixable issues — one check row per issue so the consumer can
  // iterate them and act. Absence of issues is reported as a single
  // pass row per category to keep the output stable.
  if (projectsLoadError === null) {
    const stateDirIssues = await findStateDirIssues(projects);
    if (stateDirIssues.length === 0) {
      checks.push({
        name: "state-dir-missing",
        status: "pass",
        detail: "no missing state/<id>/ dirs",
        fixable: true,
      });
    } else {
      for (const issue of stateDirIssues) {
        checks.push({
          name: issue.id,
          status: "fail",
          detail: issue.description,
          fixable: true,
        });
      }
    }

    const staleIssues = await findStaleWorktreeIssues(projects);
    if (staleIssues.length === 0) {
      checks.push({
        name: "stale-worktree",
        status: "pass",
        detail: "no stale worktrees",
        fixable: true,
      });
    } else {
      for (const issue of staleIssues) {
        checks.push({
          name: issue.id,
          status: "fail",
          detail: issue.description,
          fixable: true,
        });
      }
    }
  }

  const stopIssues = await findOrphanedStopFileIssue();
  if (stopIssues.length === 0) {
    checks.push({
      name: "orphaned-stop-file",
      status: "pass",
      detail: "no STOP file present",
      fixable: true,
    });
  } else {
    for (const issue of stopIssues) {
      checks.push({
        name: issue.id,
        status: "fail",
        detail: issue.description,
        fixable: true,
      });
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

async function runDoctorJson(opts: DoctorOptions): Promise<void> {
  const exitOnFailure = opts.exitOnFailure ?? true;

  // In --fix mode, collect issues, apply approved ones, then re-scan
  // so the emitted report reflects post-fix state (per task spec).
  if (opts.fix) {
    let projects: ProjectConfig[] = [];
    try {
      const loader =
        opts.loadProjects ??
        (async () => (await import("./projects")).loadProjects());
      projects = await loader();
    } catch {
      // If projects.yaml won't load we still attempt the orphan-STOP fix.
    }
    const issues: DiagnosticIssue[] = [];
    issues.push(...(await findStateDirIssues(projects)));
    issues.push(...(await findStaleWorktreeIssues(projects)));
    issues.push(...(await findOrphanedStopFileIssue()));
    const promptFn = opts.prompt ?? defaultPrompt;
    for (const issue of issues) {
      const approve =
        opts.assumeYes === true
          ? true
          : await promptFn(`Fix: ${issue.description}?`);
      if (!approve) continue;
      try {
        await issue.fix();
      } catch {
        // Swallow — post-fix re-scan will surface the remaining failure.
      }
    }
  }

  const report = await collectDoctorJsonReport(opts);
  console.log(JSON.stringify(report));
  if (!report.ok && exitOnFailure) process.exit(1);
}
