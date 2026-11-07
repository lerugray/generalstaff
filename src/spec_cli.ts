// GeneralStaff — `generalstaff spec` subcommands (v0.18.0)
//
//   spec check --project <id> --task <id> [--json] [--override "<reason>"]
//   spec check --anchor <file> --card <file> [--json] [--override "<reason>"]
//   spec audit --project <id> [--out <file>]
//
// check exit codes: 0 ON-SPEC (or no anchor, with a warning), 3 OFF-SPEC,
// 4 UNCLEAR, 1 could not check, 2 bad usage. audit exit codes: 0 clean,
// 2 problems found, 1 could not run.

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import {
  type SpecCard,
  type SpecChecker,
  type SpecCheckRecord,
  type SpecVerdict,
  cardFromTask,
  checkCardAgainstAnchor,
  decideSpecGate,
  extractOwnerAsk,
  firstScreenExists,
  evaluateOwnerWords,
  loadSpecPrompt,
  normalizeWhitespace,
  parseOverride,
  readAnchor,
  readSpecChecks,
  recordSpecOverride,
  renderCardText,
  resolveAnchorPath,
  runSpecGate,
  specCacheKey,
  specChecksPath,
  DEFAULT_SPEC_ANCHOR,
} from "./spec_gate";
import type { GreenfieldTask, ProjectConfig } from "./types";

export interface SpecCliDeps {
  loadProject?: (id: string) => Promise<ProjectConfig>;
  loadTasks?: (projectId: string) => Promise<GreenfieldTask[]>;
  /** Directory holding state/<project>/; defaults to the working directory. */
  rootDir?: string;
  checker?: SpecChecker;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export const SPEC_USAGE =
  "Usage:\n" +
  '  generalstaff spec check --project <id> --task <id> [--json] [--override "<reason>"]\n' +
  "  generalstaff spec check --anchor <file> --card <file> [--json]\n" +
  "  generalstaff spec audit --project <id> [--out <file>]\n" +
  "\n" +
  "Checks a task (or a card file) against the owner's SPEC.md. See docs/SPEC-GATE.md.\n" +
  "\n" +
  "check exit codes: 0 ON-SPEC (or no anchor file, with a warning), 3 OFF-SPEC,\n" +
  "  4 UNCLEAR, 1 could not check, 2 bad usage.\n" +
  "audit exit codes: 0 clean, 2 a user-facing done task lacks owner words or has an\n" +
  "  OFF-SPEC/UNCLEAR latest verdict, 1 could not run.\n" +
  "\n" +
  "An override reason (--override, or GENERALSTAFF_SPEC_GATE_OVERRIDE) lets a blocked\n" +
  "card proceed. It needs at least three words and never passes a stand-in verdict.";

export function checkExitCode(v: Pick<SpecVerdict, "verdict" | "no_anchor">): number {
  if (v.no_anchor) return 0;
  switch (v.verdict) {
    case "on-spec":
      return 0;
    case "off-spec":
      return 3;
    case "unclear":
      return 4;
    default:
      return 1;
  }
}

async function defaultLoadProject(id: string): Promise<ProjectConfig> {
  const { loadProjects, getProject } = await import("./projects");
  return getProject(await loadProjects(), id);
}

async function defaultLoadTasks(projectId: string): Promise<GreenfieldTask[]> {
  const { loadTasks } = await import("./tasks");
  return loadTasks(projectId);
}

/** Run a `spec` subcommand and return the process exit code. */
export async function runSpecCli(argv: string[], deps: SpecCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h" || argv.includes("--help") || argv.includes("-h")) {
    out(SPEC_USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== "check" && sub !== "audit") {
    err(`Unknown spec subcommand: ${sub}\n${SPEC_USAGE}`);
    return 2;
  }
  let values: {
    project?: string;
    task?: string;
    anchor?: string;
    card?: string;
    override?: string;
    out?: string;
    json?: boolean;
  };
  try {
    values = parseArgs({
      args: argv.slice(1),
      options: {
        project: { type: "string" },
        task: { type: "string" },
        anchor: { type: "string" },
        card: { type: "string" },
        override: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n${SPEC_USAGE}`);
    return 2;
  }
  return sub === "audit" ? runAudit(values, deps, out, err) : runCheck(values, deps, out, err);
}

function printVerdict(v: SpecVerdict, anchorLabel: string, out: (l: string) => void): void {
  if (v.no_anchor) {
    out(`WARNING: ${v.reason}`);
    return;
  }
  out(`${v.verdict.toUpperCase()}  (${v.source}${v.model ? `, ${v.model}` : ""}; anchor ${anchorLabel})`);
  if (v.kind) out(`  kind:        ${v.kind}`);
  if (v.user_can) out(`  user can:    ${v.user_can}`);
  if (v.anchor_step) out(`  anchor step: ${v.anchor_step}`);
  out(`  reason:      ${v.reason}`);
  out(`  owner words present: ${v.owner_words_present ? "yes" : "no"}${v.stand_in ? "; STAND-IN" : ""}`);
}

async function runCheck(
  values: { project?: string; task?: string; anchor?: string; card?: string; override?: string; json?: boolean },
  deps: SpecCliDeps,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const env = deps.env ?? process.env;
  const projectMode = values.project !== undefined || values.task !== undefined;
  const fileMode = values.anchor !== undefined || values.card !== undefined;
  if (projectMode === fileMode) {
    err(`spec check needs either --project and --task, or --anchor and --card.\n${SPEC_USAGE}`);
    return 2;
  }
  const override = parseOverride(values.override ?? env.GENERALSTAFF_SPEC_GATE_OVERRIDE);

  let verdict: SpecVerdict;
  let anchorLabel: string;
  let checksPath: string | undefined;
  let taskId: string;
  if (projectMode) {
    if (!values.project || !values.task) {
      err(`spec check --project needs --task too.\n${SPEC_USAGE}`);
      return 2;
    }
    let project: ProjectConfig;
    let task: GreenfieldTask | undefined;
    try {
      project = await (deps.loadProject ?? defaultLoadProject)(values.project);
      task = (await (deps.loadTasks ?? defaultLoadTasks)(project.id)).find((t) => t.id === values.task);
    } catch (e) {
      err(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (!task) {
      err(`Error: task ${values.task} not found for project ${values.project}`);
      return 1;
    }
    checksPath = specChecksPath(join(deps.rootDir ?? process.cwd(), "state", project.id));
    anchorLabel = project.spec_anchor ?? DEFAULT_SPEC_ANCHOR;
    taskId = task.id;
    verdict = await runSpecGate(project, task, { checksPath, checker: deps.checker });
  } else {
    if (!values.anchor || !values.card) {
      err(`spec check needs both --anchor and --card.\n${SPEC_USAGE}`);
      return 2;
    }
    const cardPath = resolve(values.card);
    if (!existsSync(cardPath)) {
      err(`Error: card file not found: ${values.card}`);
      return 1;
    }
    const text = readFileSync(cardPath, "utf8");
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? basename(cardPath);
    const card: SpecCard = {
      id: basename(cardPath),
      title: firstLine.replace(/^#+\s*/, "").trim(),
      body: text,
    };
    anchorLabel = values.anchor;
    taskId = card.id;
    verdict = await checkCardAgainstAnchor(
      {
        anchorText: readAnchor(resolve(values.anchor)),
        anchorLabel,
        card,
        project: { path: dirname(cardPath) },
      },
      { checker: deps.checker },
    );
  }

  let code = checkExitCode(verdict);
  let overridden: { reason: string } | undefined;
  let overrideNote: string | undefined;
  if (code !== 0) {
    const decision = decideSpecGate("block", verdict, override);
    if (decision.overridden) {
      overridden = decision.overridden;
      code = 0;
      if (checksPath) recordSpecOverride(checksPath, taskId, verdict, decision.overridden.reason);
    } else {
      overrideNote = decision.overrideNote;
    }
  }

  if (values.json) {
    out(
      JSON.stringify(
        {
          task_id: taskId,
          anchor: anchorLabel,
          verdict: verdict.verdict.toUpperCase(),
          kind: verdict.kind ?? null,
          user_can: verdict.user_can ?? null,
          anchor_step: verdict.anchor_step ?? null,
          reason: verdict.reason,
          owner_words_present: verdict.owner_words_present,
          stand_in: verdict.stand_in,
          source: verdict.source,
          model: verdict.model ?? null,
          no_anchor: verdict.no_anchor === true,
          overridden: overridden ? overridden.reason : null,
          override_note: overrideNote ?? null,
          exit_code: code,
        },
        null,
        2,
      ),
    );
  } else {
    printVerdict(verdict, anchorLabel, out);
    if (overridden) out(`OVERRIDDEN: ${overridden.reason}`);
    if (overrideNote) out(`override ignored: ${overrideNote}`);
  }
  return code;
}

// --- Drift audit ---

function cell(s: string, max = 240): string {
  const flat = normalizeWhitespace(s).replace(/\|/g, "\\|");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface AuditRow {
  id: string;
  title: string;
  status: string;
  ownerWords: string[];
  ownerQuote?: string;
  ownerQuoteProblem?: string;
  latest?: SpecCheckRecord;
  stale: boolean;
  overrides: SpecCheckRecord[];
  problems: string[];
}

export interface AuditResult {
  rows: AuditRow[];
  anchorFound: boolean;
  problems: number;
  markdown: string;
}

/** Build the drift-audit report for a project. Pure: callers do the I/O. */
export function buildSpecAudit(
  project: ProjectConfig,
  tasks: GreenfieldTask[],
  records: SpecCheckRecord[],
  now: Date = new Date(),
): AuditResult {
  const anchorText = readAnchor(resolveAnchorPath(project), project.path);
  let promptVersion: number | null = null;
  try {
    promptVersion = loadSpecPrompt().version;
  } catch {
    promptVersion = null;
  }
  const rows: AuditRow[] = [];
  for (const task of tasks) {
    if (task.user_facing !== true) continue;
    if (task.status === "skipped" || task.status === "superseded") continue;
    const card = cardFromTask(task);
    const owner = evaluateOwnerWords(card, project);
    const mine = records.filter((r) => r.task_id === task.id);
    const verdicts = mine.filter((r) => (r.record ?? "verdict") === "verdict" && r.verdict !== "error");
    const latest = verdicts[verdicts.length - 1];
    let stale = false;
    if (latest && latest.key && anchorText !== null && promptVersion !== null) {
      const fs = project.picture_first === true ? firstScreenExists(project.path, card.first_screen) : undefined;
      stale = latest.key !== specCacheKey(promptVersion, anchorText, renderCardText(card, owner, fs));
    }
    const problems: string[] = [];
    if (task.status === "done") {
      if (!owner.present) problems.push("done without owner words");
      if (latest && (latest.verdict === "off-spec" || latest.verdict === "unclear")) {
        problems.push(`latest spec verdict is ${latest.verdict.toUpperCase()}`);
      }
    }
    rows.push({
      id: task.id,
      title: task.title,
      status: task.status,
      ownerWords: owner.words,
      ownerQuote: owner.quote ? `"${normalizeWhitespace(owner.quote.text)}" (${owner.quote.source})` : undefined,
      ownerQuoteProblem: owner.quoteProblem,
      latest,
      stale,
      overrides: mine.filter((r) => r.record === "override"),
      problems,
    });
  }
  const problems = rows.reduce((n, r) => n + r.problems.length, 0);
  const done = rows.filter((r) => r.status === "done").length;

  const lines: string[] = [
    `# Drift audit: ${project.id}`,
    "",
    `Generated: ${now.toISOString()}`,
    `Anchor: ${project.spec_anchor ?? DEFAULT_SPEC_ANCHOR} (${anchorText === null ? "NOT FOUND" : "found"})`,
    `User-facing tasks: ${rows.length} (${done} done, ${rows.length - done} pending or in progress)`,
    `Problems: ${problems}`,
    "",
    "| Task | Status | Owner words | Latest spec verdict | Overrides | What a user sees now |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const words =
      r.ownerWords.length || r.ownerQuote
        ? [...r.ownerWords.map((w) => `"${w}"`), ...(r.ownerQuote ? [r.ownerQuote] : [])].join("; ")
        : "MISSING";
    const verdict = r.latest
      ? `${r.latest.verdict.toUpperCase()}${r.latest.stand_in ? " (stand-in)" : ""}${r.stale ? " (stale: card or anchor changed since)" : ""}: ${r.latest.reason}`
      : "not checked";
    const overrides = r.overrides.length
      ? r.overrides.map((o) => `${o.ts.slice(0, 10)}: ${o.override_reason ?? ""}`).join("; ")
      : "none";
    lines.push(
      `| ${cell(`${r.id}: ${r.title}`)} | ${r.status} | ${cell(words)} | ${cell(verdict)} | ${cell(overrides)} |  |`,
    );
  }
  if (rows.length === 0) lines.push("| (no user-facing tasks) | | | | | |");
  lines.push("");
  if (problems > 0) {
    lines.push("## Problems", "");
    for (const r of rows) for (const p of r.problems) lines.push(`- ${r.id}: ${p}`);
    lines.push("");
  }
  lines.push(
    "Fill in the last column by using the software as a user would, then put this report in front of the owner with the go question.",
    "",
  );
  return { rows, anchorFound: anchorText !== null, problems, markdown: lines.join("\n") };
}

async function runAudit(
  values: { project?: string; out?: string },
  deps: SpecCliDeps,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (!values.project) {
    err(`spec audit needs --project.\n${SPEC_USAGE}`);
    return 2;
  }
  let project: ProjectConfig;
  let tasks: GreenfieldTask[];
  try {
    project = await (deps.loadProject ?? defaultLoadProject)(values.project);
    tasks = await (deps.loadTasks ?? defaultLoadTasks)(project.id);
  } catch (e) {
    err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const checks = specChecksPath(join(deps.rootDir ?? process.cwd(), "state", project.id));
  const result = buildSpecAudit(project, tasks, readSpecChecks(checks));
  if (values.out) {
    try {
      writeFileSync(values.out, result.markdown);
    } catch (e) {
      err(`Error: could not write ${values.out}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    out(`Drift audit written to ${values.out} (${result.rows.length} user-facing task(s), ${result.problems} problem(s))`);
  } else {
    out(result.markdown);
  }
  if (!result.anchorFound) err("WARNING: no anchor file found; verdicts could not be checked for staleness");
  return result.problems > 0 ? 2 : 0;
}
