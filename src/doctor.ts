// GeneralStaff — doctor command: check prerequisites + diagnose
// auto-resolvable issues. Pass { fix: true } to prompt for each fix.

import { existsSync, mkdirSync, rmSync, statSync } from "fs";
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
