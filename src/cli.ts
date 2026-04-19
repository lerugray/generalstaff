#!/usr/bin/env bun

import { parseArgs } from "util";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import { runSession, runSessionChain } from "./session";
import { runSingleCycle, countCommitsAhead } from "./cycle";
import { $ } from "bun";
import { loadFleetState, getProjectSummary, getRootDir, cycleDir } from "./state";
import {
  loadProjects,
  loadProjectsYaml,
  loadDispatcherConfig,
  getProject,
  ProjectNotFoundError,
} from "./projects";
import {
  isStopFilePresent,
  createStopFile,
  removeStopFile,
  stopForce,
  writeSessionPid,
  removeSessionPid,
} from "./safety";
import { tailProgressLog, loadCycleHistory, loadCycleHistoryJson, printHistoryTable, printHistoryCompact, summarizeCosts, compileGrepPattern, parseSinceFlag, setColorOverride, stripNoColorArgs, loadProgressEvents, VALID_OUTCOME_FILTERS, type OutcomeFilter } from "./audit";
import { initProject } from "./init";
import { runDoctor } from "./doctor";
import { runClean } from "./clean";
import {
  loadTasks,
  pendingTasks,
  addTask,
  botPickableTasks,
  markTaskDone,
  markTaskInteractive,
  markTaskPending,
  removeTask,
  countTasks,
  TasksLoadError,
  TaskValidationError,
} from "./tasks";
import { pickNextProjects } from "./dispatcher";

// gs-250: pull the trailing digit run out of a task id so the preview
// matches the engineer bot's "lowest gs-NNN numeric suffix first" sort
// convention. Ids with no digits collapse to 0; `localeCompare` on the
// original id tiebreaks those.
function numericIdSuffix(id: string): number {
  const m = /(\d+)(?!.*\d)/.exec(id);
  return m ? parseInt(m[1]!, 10) : 0;
}
import {
  buildFleetSummary,
  buildTodaySessionSummary,
  computeDiskUsage,
  countTests,
  formatSummary,
  formatTodaySessionSummary,
} from "./summary";
import { formatRelativeTime } from "./format";
import { parseWatchFlag, runWatchLoop, stripWatchArgs } from "./watch";
import {
  loadRecentSessions,
  formatSessionsTable,
  formatBacklogTable,
  computeBacklogTotals,
  computeSessionTotals,
  formatSessionTotals,
  formatFleetTable,
  parseSessionsFlag,
  stripSessionsArgs,
  parseSinceIso,
  filterSessionsSince,
  type BacklogRow,
  type FleetRow,
  type SessionSummary,
} from "./sessions";
import { countRemainingWorkDetailed } from "./work_detection";
import {
  loadProviderRegistry,
  getProviderById,
  ProviderConfigError,
} from "./providers/registry";
import type { ProviderHealth, ProviderRole } from "./providers/types";
import { appendFleetMessage } from "./fleet_messages";

const VERSION = "0.0.1";

function printUsage() {
  console.log(`generalstaff v${VERSION}

Usage:
  generalstaff session [--budget=<minutes>] [--max-cycles=<n>] [--dry-run]
                       [--exclude-project=<id>[,<id>...]] [--project=<id>[,<id>...]]
                       [--verbose] [--chain=<n>] [--provider=<claude|openrouter|ollama>]
                                                          Run a session (multiple cycles)
    Example: generalstaff session --budget=480          # overnight 8-hour run
    Example: generalstaff session --max-cycles=5        # stop after 5 cycles
    Example: generalstaff session --dry-run             # preview without committing
    Example: generalstaff session --exclude-project=catalogdna,retrogaze
    Example: generalstaff session --project=raybrain    # run only the listed project(s); sugar for --exclude-project=<everything-else>
    Example: generalstaff session --provider=ollama     # override GENERALSTAFF_REVIEWER_PROVIDER for this session
    Example: generalstaff session --verbose             # stream PROGRESS.jsonl events to stdout
    Example: generalstaff session --chain=3             # run 3 back-to-back sessions with the same options

  generalstaff cycle --project=<id> [--dry-run]           Run one cycle on a project
    Example: generalstaff cycle --project=myapp
    Example: generalstaff cycle --project=myapp --dry-run

  generalstaff status [--json] [--watch[=N]] [--sessions[=N]] [--summary] [--backlog] [--totals] [--fleet] [--auto-merge-failed]
                                                          Show fleet state
    Example: generalstaff status
    Example: generalstaff status --json                 # machine-readable output
    Example: generalstaff status --watch                # refresh every 5s until Ctrl-C
    Example: generalstaff status --watch=10             # refresh every 10s
    Example: generalstaff status --sessions             # last 10 sessions as a table
    Example: generalstaff status --sessions=20 --json   # last 20 sessions, JSON
    Example: generalstaff status --summary              # today's cycle/session metrics (UTC)
    Example: generalstaff status --summary --json       # same, as JSON
    Example: generalstaff status --backlog              # per-project backlog buckets
    Example: generalstaff status --backlog --json       # same, as JSON
    Example: generalstaff status --totals               # all-time aggregate session metrics
    Example: generalstaff status --totals --json        # same, as JSON
    Example: generalstaff status --fleet                # one-row-per-project fleet snapshot
    Example: generalstaff status --fleet --json         # same, as JSON

  generalstaff projects                                   List registered projects
    Example: generalstaff projects

  generalstaff init <path> [--id=<id>] [--priority=N]     Scaffold state dir for a new project
    Example: generalstaff init ./myapp
    Example: generalstaff init ../other-repo --id=other
    Example: generalstaff init ./lowprio --priority=3   # seed template task at priority 3

  generalstaff bootstrap <target-dir> "<idea>" [--stack=<stack>] [--id=<id>] [--force]
                                                          Propose scaffolding for a new project (propose-don't-impose)
    Example: generalstaff bootstrap ../gamr "Tinder for gamers, strictly platonic" --stack=bun-next
    Example: generalstaff bootstrap ./util "utility library" --stack=bun-plain --id=util
    Example: generalstaff bootstrap ./raybrain "local-first second brain" --stack=python-uv
    # Stacks: bun-next, bun-plain, node-next, rust-cargo, python-uv, python-poetry, python-pip, go-mod
    # Writes .generalstaff-proposal/ staging dir — review then move files + register manually.

  generalstaff register <project-id> --path=<target-dir> [--priority=N] [--stack=<stack>] [--yes] [--allow-non-git]
                                                          Append a bootstrapped project to projects.yaml (after review)
    Example: generalstaff register gamr --path=../gamr
    Example: generalstaff register gamr --path=../gamr --priority=3 --yes
    Example: generalstaff register raybrain --path=../raybrain --stack=python-uv
    # Reads state/<id>/tasks.json + hands_off.yaml (from project root or .generalstaff-proposal/).
    # Validates path exists + is git (use --allow-non-git to skip) + engineer_command script is present.
    # Rejects duplicates; prompts y/N before editing. projects.yaml IS in hands_off for the bot,
    # but 'register' is the tool's own write path to its own config — equivalent to 'init'.

  generalstaff stop [--force] | [--status|--check]        Create STOP file (halt dispatcher)
    Example: generalstaff stop                          # halt before next cycle
    Example: generalstaff stop --force                  # also kill the running session process
    Example: generalstaff stop --status                 # read-only: print STOP file + session pid state
    Example: generalstaff stop --check                  # alias of --status

  generalstaff start                                      Remove STOP file (allow dispatch)
    Example: generalstaff start                         # resume after a stop

  generalstaff history [--project=<id>] [--lines=<n>] [--format=compact|json] [--costs]
                       [--since=YYYYMMDD] [--until=YYYYMMDD] [--verified-only]
                       [--outcome=verified|verified_weak|verification_failed|cycle_skipped]
                                                          Cycle history (compact: tab-delimited, no headers)
    Example: generalstaff history --lines=50
    Example: generalstaff history --project=myapp --format=compact
    Example: generalstaff history --format=json          # machine-readable cycle history
    Example: generalstaff history --format=compact --costs  # add reviewer-invocation + est-token columns
    Example: generalstaff history --since=20260401 --until=20260430  # April 2026 cycles only
    Example: generalstaff history --verified-only         # hide cycle_skipped and verification_failed rows
    Example: generalstaff history --outcome=verification_failed  # show only failed cycles

  generalstaff log [--project=<id>] [--lines=<n>|--tail] [--level=error] [--grep=<pattern>] [--since=<ts>]
                                                          Tail PROGRESS.jsonl
    Example: generalstaff log --project=myapp --lines=50
    Example: generalstaff log --tail                     # equivalent to --lines=9999, show everything
    Example: generalstaff log --level=error              # only cycle_skipped / verification_failed / *_error
    Example: generalstaff log --grep='verified|weak'     # case-insensitive regex over event + data
    Example: generalstaff log --since=1h                 # last hour only (also: 30m, 2d, or ISO timestamp)

  generalstaff summary [--no-tests] [--format=json] [--project=<id>]
                                                          Dashboard: cycles, outcomes, duration, tasks, tests
    Example: generalstaff summary                       # one-screen fleet overview
    Example: generalstaff summary --no-tests            # skip scanning tests/ dir
    Example: generalstaff summary --format=json         # machine-readable output
    Example: generalstaff summary --project=myapp       # filter to a single project

  generalstaff doctor [--fix] [--yes] [--verbose] [--json]
                                                          Check prerequisites + diagnose resolvable issues
    Example: generalstaff doctor                        # diagnose only
    Example: generalstaff doctor --fix                  # prompt y/N for each fix
    Example: generalstaff doctor --fix --yes            # auto-apply fixes (non-interactive)
    Example: generalstaff doctor --verbose              # add context under each passing sanity check
    Example: generalstaff doctor --json                 # machine-readable {ok, checks[]} on stdout
    Example: generalstaff doctor --json --fix --yes     # emit post-fix state as JSON
  generalstaff clean [--keep=N] [--log-days=N] [--dry-run] Remove stale worktrees + prune old cycles + rotate logs
    Example: generalstaff clean --keep=10
    Example: generalstaff clean --log-days=7             # delete logs older than 7 days
    Example: generalstaff clean --dry-run                # preview without deleting

  generalstaff task list --project=<id> [--priority=N]    Show pending tasks for a project
    Example: generalstaff task list --project=myapp
    Example: generalstaff task list --project=myapp --priority=1
  generalstaff task add --project=<id> [--priority=N] <title>
                                                          Append a new task to tasks.json
    Example: generalstaff task add --project=myapp "Fix login bug"
  generalstaff task done --project=<id> --task=<task-id>  Mark a task as done
    Example: generalstaff task done --project=myapp --task=my-042
  generalstaff task rm --project=<id> --task=<task-id>    Delete a task from tasks.json
    Example: generalstaff task rm --project=myapp --task=my-042
  generalstaff task interactive --project=<id> <task-id> [--off]
                                                          Flip a task's interactive_only flag
    Example: generalstaff task interactive --project=myapp my-042
    Example: generalstaff task interactive --project=myapp my-042 --off
  generalstaff task count [--project=<id>]                Report pending vs done counts
    Example: generalstaff task count                     # all projects
    Example: generalstaff task count --project=myapp     # single project
  generalstaff task next [--project=<id>] [--json]        Preview the next task(s) the picker would pick (non-mutating)
    Example: generalstaff task next                      # up to max_parallel_slots rows
    Example: generalstaff task next --project=myapp      # restrict preview to one project
    Example: generalstaff task next --json               # { slots: [{project_id, task_id, title}] }

  generalstaff cycle-redo --project=<id> --task=<task-id>  Reopen a done task as pending
    Example: generalstaff cycle-redo --project=myapp --task=my-042

  generalstaff digest [--latest] [--date=YYYYMMDD] [--list] [--json] [--path] [--regen=<file>]
                                                          Print a session digest to stdout, or list all
    Example: generalstaff digest --latest                # most recent digest
    Example: generalstaff digest --date=20260416         # first digest from that day
    Example: generalstaff digest --list                  # enumerate digests, newest first
    Example: generalstaff digest --latest --json         # structured JSON of the latest digest
    Example: generalstaff digest --list --json           # JSON array of digest summaries
    Example: generalstaff digest --latest --path         # absolute path of the latest digest (for scripting)
    Example: generalstaff digest --regen=digests/digest_20260417_100000.md  # re-render from PROGRESS.jsonl

  generalstaff version                                    Show version + environment info (for bug reports)
    Example: generalstaff version                       # includes bun version, platform, projects.yaml path

  generalstaff config                                     Pretty-print the parsed+validated projects.yaml (with resolved defaults)
    Example: generalstaff config                        # useful for debugging config issues

  generalstaff providers list [--json]                    List configured LLM providers + role routes from provider_config.yaml
    Example: generalstaff providers list
    Example: generalstaff providers list --json         # machine-readable registry
  generalstaff providers ping <provider-id> [--json]      Probe a single provider's health() endpoint
  generalstaff providers ping --all [--json]              Probe every configured provider in parallel
    Example: generalstaff providers ping ollama_llama3
    Example: generalstaff providers ping ollama_llama3 --json
    Example: generalstaff providers ping --all          # summary table (exit 1 if any unreachable)

  generalstaff bot-status [--project=<id>]                Show unmerged commits on each project's bot branch
    Example: generalstaff bot-status                    # all projects
    Example: generalstaff bot-status --project=myapp    # single project

  generalstaff diff <project-id> <cycle-id> [--stat]      Show a past cycle's diff
    Example: generalstaff diff myapp 20260416125750_8w9n
    Example: generalstaff diff myapp 20260416125750_8w9n --stat

  generalstaff view <name> [options]                      Structured fleet views (Phase 6)
    Example: generalstaff view fleet-overview            # one row per project + aggregates
    Example: generalstaff view fleet-overview --json     # same, as JSON
    # Valid views: fleet-overview, task-queue, session-tail, dispatch-detail, inbox

  generalstaff message send --from=<str> --body=<str> [--kind=<...>] [--session-id=<id>]
                           [--task-id=<id>] [--cycle-id=<id>] [--json]
                                                          Append a message to the fleet inbox (gs-240)
    Example: generalstaff message send --from=ray --body="heads up on the next run"
    Example: generalstaff message send --from=bot --kind=handoff --task-id=gs-240 "body as final arg"

  generalstaff --version                                  Show version
  generalstaff --help                                     Show this help

Global flags:
  --no-color                                              Disable ANSI color output (also honors NO_COLOR env var)`);
}

const rawArgs = process.argv.slice(2);

// gs-245: --no-color is global. Detect it before any subcommand parseArgs
// runs (parseArgs is strict-by-default and would reject the unknown flag),
// then strip it from the args array so each subcommand sees its own
// flags only. Combined with the NO_COLOR env var (no-color.org), this
// is the single source of truth for whether ANSI color is emitted.
if (rawArgs.includes("--no-color")) {
  setColorOverride(false);
}
const args = stripNoColorArgs(rawArgs);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// gs-244: subcommands with their own --help block short-circuit the
// global help dispatch so that e.g. `session --help` lands in the
// session case and prints session-specific usage instead of the
// global usage table.
const SUBCOMMANDS_WITH_OWN_HELP = new Set([
  "view",
  "session",
  "cycle",
  "status",
  "task",
]);
if (
  (args.includes("--help") || args.includes("-h") || args.length === 0) &&
  !SUBCOMMANDS_WITH_OWN_HELP.has(args[0] ?? "")
) {
  printUsage();
  process.exit(0);
}

const command = args[0];

switch (command) {
  case "session": {
    // gs-244: subcommand-level --help / help matching gs-233's view pattern.
    if (args.includes("--help") || args.includes("-h") || args[1] === "help") {
      console.log(
        "Usage: generalstaff session [options]\n" +
          "\n" +
          "Run a session: repeatedly pick the highest-priority project with pending\n" +
          "bot-pickable work and run one cycle, until budget exhausts or no work remains.\n" +
          "\n" +
          "Options:\n" +
          "  --budget=<minutes>            Budget in minutes (default: 480 = 8 hours)\n" +
          "  --max-cycles=<n>              Stop after N cycles even if budget remains\n" +
          "  --dry-run                     Preview without committing\n" +
          "  --exclude-project=<id>[,...]  Skip the listed project id(s)\n" +
          "  --project=<id>[,...]          Run only the listed project(s) (sugar for --exclude-project=<rest>)\n" +
          "  --verbose                     Stream PROGRESS.jsonl events to stdout\n" +
          "  --chain=<n>                   Run N back-to-back sessions with the same options\n" +
          "  --provider=<name>             Reviewer provider (claude|openrouter|ollama); overrides env for this session\n" +
          "\n" +
          "Examples:\n" +
          "  generalstaff session --budget=480             # overnight 8-hour run\n" +
          "  generalstaff session --max-cycles=5           # stop after 5 cycles\n" +
          "  generalstaff session --project=raybrain       # run only raybrain\n" +
          "  generalstaff session --chain=3 --budget=60    # three 1-hour sessions back-to-back\n" +
          "  generalstaff session --provider=ollama        # use Ollama reviewer for this session\n",
      );
      process.exit(0);
    }
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        budget: { type: "string", default: "480" },
        "max-cycles": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "exclude-project": { type: "string" },
        project: { type: "string" },
        verbose: { type: "boolean", default: false },
        chain: { type: "string" },
        provider: { type: "string" },
      },
      allowPositionals: false,
    });
    const budget = parseInt(values.budget!, 10);
    if (isNaN(budget) || budget <= 0) {
      console.error("Error: --budget must be a positive integer (minutes)");
      process.exit(1);
    }
    let maxCycles: number | undefined;
    if (values["max-cycles"] !== undefined) {
      const parsed = parseInt(values["max-cycles"], 10);
      if (isNaN(parsed) || parsed <= 0) {
        console.error("Error: --max-cycles must be a positive integer");
        process.exit(1);
      }
      maxCycles = parsed;
    }
    // gs-214: --project=<id>[,<id>] is the inverse of --exclude-project —
    // sugar for "run only these projects, exclude the rest". The translation
    // happens here so runSession keeps a single code path.
    if (values.project !== undefined && values["exclude-project"] !== undefined) {
      console.error("Error: --project cannot be combined with --exclude-project");
      process.exit(1);
    }
    let excludeProjects: string[] | undefined;
    if (values["exclude-project"] !== undefined) {
      excludeProjects = values["exclude-project"]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (values.project !== undefined) {
      const requested = values.project
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const all = await loadProjects();
      const known = new Set(all.map((p) => p.id));
      const resolved = new Set<string>();
      for (const id of requested) {
        if (!known.has(id)) {
          console.warn(
            `Warning: --project="${id}" does not match any registered project (ignored)`,
          );
          continue;
        }
        resolved.add(id);
      }
      excludeProjects = all.map((p) => p.id).filter((id) => !resolved.has(id));
    }
    let chain = 1;
    if (values.chain !== undefined) {
      const parsed = parseInt(values.chain, 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error("Error: --chain must be a positive integer");
        process.exit(1);
      }
      chain = parsed;
    }
    // gs-249: --provider=<name> overrides GENERALSTAFF_REVIEWER_PROVIDER for
    // this session only. Validated against the supported set here so the
    // reviewer module can assume a known-good value without re-checking.
    const VALID_PROVIDERS = ["claude", "openrouter", "ollama"] as const;
    let reviewerProviderOverride: string | undefined;
    if (values.provider !== undefined) {
      const normalized = values.provider.toLowerCase();
      if (!(VALID_PROVIDERS as readonly string[]).includes(normalized)) {
        console.error(
          `Error: unknown --provider: ${values.provider} (supported: ${VALID_PROVIDERS.join(", ")})`,
        );
        process.exit(1);
      }
      reviewerProviderOverride = normalized;
    }
    const sessionOpts = {
      budgetMinutes: budget,
      dryRun: values["dry-run"]!,
      maxCycles,
      excludeProjects,
      verbose: values.verbose!,
      reviewerProviderOverride,
    };
    // gs-119: record this process's PID so `stop --force` can locate
    // and kill it. Best-effort — failure must not prevent the session
    // from running. Cleared in a finally block on normal exit; abnormal
    // exits leave the file stale, which stop --force tolerates.
    try {
      await writeSessionPid(process.pid);
    } catch {
      // Writable state/ is nice-to-have, not load-bearing.
    }
    try {
      if (chain === 1) {
        await runSession(sessionOpts);
      } else {
        await runSessionChain(sessionOpts, chain);
      }
    } finally {
      try {
        await removeSessionPid();
      } catch {
        // May already be gone if stop --force ran concurrently.
      }
    }
    break;
  }

  case "cycle": {
    // gs-244: subcommand-level --help / help matching gs-233's view pattern.
    if (args.includes("--help") || args.includes("-h") || args[1] === "help") {
      console.log(
        "Usage: generalstaff cycle --project=<id> [options]\n" +
          "\n" +
          "Run exactly one cycle on a single project — pick one task, execute one\n" +
          "engineer + reviewer pass, and update state. Useful for probing a specific\n" +
          "project without committing to a full session.\n" +
          "\n" +
          "Options:\n" +
          "  --project=<id>   Project id (required)\n" +
          "  --dry-run        Preview without committing\n" +
          "\n" +
          "Examples:\n" +
          "  generalstaff cycle --project=myapp\n" +
          "  generalstaff cycle --project=myapp --dry-run\n",
      );
      process.exit(0);
    }
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    if (!values.project) {
      console.error("Error: --project=<id> is required");
      process.exit(1);
    }
    await runSingleCycle({
      projectId: values.project,
      dryRun: values["dry-run"]!,
    });
    break;
  }

  case "status": {
    // gs-244: subcommand-level --help / help matching gs-233's view pattern.
    if (args.includes("--help") || args.includes("-h") || args[1] === "help") {
      console.log(
        "Usage: generalstaff status [options]\n" +
          "\n" +
          "Show fleet state: per-project verification totals + optional subviews.\n" +
          "The --sessions / --summary / --backlog / --totals / --fleet flags are\n" +
          "mutually exclusive subviews; --json renders any of them as JSON.\n" +
          "\n" +
          "Options:\n" +
          "  --json              Machine-readable output\n" +
          "  --watch[=N]         Refresh every N seconds (default 5) until Ctrl-C\n" +
          "  --sessions[=N]      Last N sessions as a table (default 10)\n" +
          "  --summary           Today's cycle/session metrics (UTC)\n" +
          "  --backlog           Per-project backlog buckets\n" +
          "  --totals            All-time aggregate session metrics\n" +
          "  --fleet             One-row-per-project fleet snapshot\n" +
          "  --auto-merge-failed List session-end auto-merge failures (last 30 days by default)\n" +
          "  --since=<iso>       Filter --sessions/--summary/--auto-merge-failed to events at or after an ISO-8601 timestamp\n" +
          "\n" +
          "Examples:\n" +
          "  generalstaff status                           # default fleet state view\n" +
          "  generalstaff status --json                    # JSON of the default view\n" +
          "  generalstaff status --watch=10                # refresh every 10s\n" +
          "  generalstaff status --sessions=20 --json      # last 20 sessions as JSON\n" +
          "  generalstaff status --fleet                   # per-project snapshot\n",
      );
      process.exit(0);
    }
    const rawStatusArgs = args.slice(1);
    const watch = parseWatchFlag(rawStatusArgs);
    const sessionsFlag = parseSessionsFlag(rawStatusArgs);
    const { values: statusValues } = parseArgs({
      args: stripSessionsArgs(stripWatchArgs(rawStatusArgs)),
      options: {
        json: { type: "boolean", default: false },
        summary: { type: "boolean", default: false },
        backlog: { type: "boolean", default: false },
        totals: { type: "boolean", default: false },
        fleet: { type: "boolean", default: false },
        "auto-merge-failed": { type: "boolean", default: false },
        since: { type: "string" },
      },
      allowPositionals: false,
    });

    // gs-247: --since narrows --sessions / --summary to events at or
    // after an ISO-8601 timestamp. Only ISO is accepted (relative
    // durations live in the audit log's --since, not here). Validate
    // before the render so operators get a single clear error.
    // gs-257: --since also narrows --auto-merge-failed.
    let sinceMs: number | undefined;
    if (statusValues.since !== undefined) {
      const parsed = parseSinceIso(statusValues.since);
      if (parsed === null) {
        console.error("Error: --since requires an ISO timestamp");
        process.exit(1);
      }
      if (
        !sessionsFlag.enabled &&
        !statusValues.summary &&
        !statusValues["auto-merge-failed"]
      ) {
        console.error(
          "Error: --since requires --sessions or --summary",
        );
        process.exit(1);
      }
      sinceMs = parsed;
    }

    // gs-199: --backlog is mutually exclusive with the other status
    // subviews. Detect the clash early so the user gets a single clear
    // error instead of whichever branch runs first silently winning.
    if (
      statusValues.backlog &&
      (sessionsFlag.enabled || statusValues.summary || watch.enabled)
    ) {
      console.error(
        "Error: --backlog cannot be combined with --sessions/--summary/--watch",
      );
      process.exit(1);
    }

    // gs-202: --totals aggregates across the full session history; it
    // can't coexist with any other subview.
    if (
      statusValues.totals &&
      (sessionsFlag.enabled ||
        statusValues.summary ||
        statusValues.backlog ||
        watch.enabled)
    ) {
      console.error(
        "Error: --totals cannot be combined with --sessions/--summary/--backlog/--watch",
      );
      process.exit(1);
    }

    // gs-217: --fleet renders a one-row-per-project snapshot; mutually
    // exclusive with every other status subview.
    if (
      statusValues.fleet &&
      (sessionsFlag.enabled ||
        statusValues.summary ||
        statusValues.backlog ||
        statusValues.totals ||
        watch.enabled)
    ) {
      console.error(
        "Error: --fleet cannot be combined with --sessions/--summary/--backlog/--totals/--watch",
      );
      process.exit(1);
    }

    // gs-257: --auto-merge-failed scans PROGRESS.jsonl for session-end
    // auto-merge failures; it's its own subview, mutually exclusive with
    // every other one.
    if (
      statusValues["auto-merge-failed"] &&
      (sessionsFlag.enabled ||
        statusValues.summary ||
        statusValues.backlog ||
        statusValues.totals ||
        statusValues.fleet ||
        watch.enabled)
    ) {
      console.error(
        "Error: --auto-merge-failed cannot be combined with --sessions/--summary/--backlog/--totals/--fleet/--watch",
      );
      process.exit(1);
    }

    const renderStatus = async () => {
      // gs-257: --auto-merge-failed scans PROGRESS.jsonl across all
      // registered projects for `session_end_auto_merge` events where
      // data.result === "failed". Informational — exit 0 whether or not
      // failures exist. Default since = 30 days ago; --since=<iso>
      // overrides.
      if (statusValues["auto-merge-failed"]) {
        const DEFAULT_DAYS = 30;
        const nowMs = Date.now();
        const windowMs =
          sinceMs ?? nowMs - DEFAULT_DAYS * 24 * 60 * 60 * 1000;
        const days = Math.max(
          1,
          Math.round((nowMs - windowMs) / (24 * 60 * 60 * 1000)),
        );
        const projects = await loadProjects();
        const failed: Array<{
          timestamp: string;
          project_id: string;
          branch: string;
          reason: string;
        }> = [];
        for (const p of projects) {
          const events = await loadProgressEvents(
            p.id,
            (e) =>
              e.event === "session_end_auto_merge" &&
              e.data.result === "failed",
          );
          for (const e of events) {
            const ts = Date.parse(e.timestamp);
            if (Number.isNaN(ts) || ts < windowMs) continue;
            const branch =
              typeof e.data.branch === "string" ? e.data.branch : "";
            const rawReason =
              typeof e.data.reason === "string" ? e.data.reason : "";
            failed.push({
              timestamp: e.timestamp,
              project_id: e.project_id ?? p.id,
              branch,
              reason: rawReason,
            });
          }
        }
        failed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        if (statusValues.json) {
          console.log(JSON.stringify({ failed }, null, 2));
          return;
        }
        if (failed.length === 0) {
          console.log(
            `No auto-merge failures in the last ${days} day${days === 1 ? "" : "s"}.`,
          );
          return;
        }
        const rows = failed.map((f) => [
          f.timestamp,
          f.project_id,
          f.branch,
          f.reason.length > 80 ? f.reason.slice(0, 77) + "..." : f.reason,
        ]);
        const header = ["Timestamp", "Project", "Branch", "Reason"];
        const widths = header.map((h, i) =>
          Math.max(h.length, ...rows.map((r) => r[i]!.length)),
        );
        const pad = (cells: string[]) =>
          cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
        const lines = [
          pad(header),
          widths.map((w) => "-".repeat(w)).join("  "),
        ];
        for (const r of rows) lines.push(pad(r));
        console.log(lines.join("\n"));
        return;
      }
      if (statusValues.fleet) {
        const projects = await loadProjects();
        const fleet = await loadFleetState();
        const rows: FleetRow[] = [];
        for (const p of projects) {
          const state = fleet.projects[p.id] ?? null;
          const breakdown = await countRemainingWorkDetailed(p);
          rows.push({
            project_id: p.id,
            last_cycle_at: state?.last_cycle_at ?? null,
            total_cycles: state?.total_cycles ?? 0,
            total_verified: state?.total_verified ?? 0,
            total_failed: state?.total_failed ?? 0,
            bot_pickable: breakdown.pending_bot_pickable,
            auto_merge: p.auto_merge,
            branch: p.branch,
          });
        }
        if (statusValues.json) {
          const totals = rows.reduce(
            (a, r) => ({
              total_cycles: a.total_cycles + r.total_cycles,
              total_verified: a.total_verified + r.total_verified,
              total_failed: a.total_failed + r.total_failed,
              bot_pickable: a.bot_pickable + r.bot_pickable,
            }),
            {
              total_cycles: 0,
              total_verified: 0,
              total_failed: 0,
              bot_pickable: 0,
            },
          );
          console.log(
            JSON.stringify(
              {
                projects: rows.map((r) => ({
                  id: r.project_id,
                  last_cycle_at: r.last_cycle_at,
                  total_cycles: r.total_cycles,
                  total_verified: r.total_verified,
                  total_failed: r.total_failed,
                  bot_pickable: r.bot_pickable,
                  auto_merge: r.auto_merge,
                  branch: r.branch,
                })),
                totals,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(formatFleetTable(rows));
        }
        return;
      }
      if (statusValues.totals) {
        const sessions = await loadRecentSessions(Number.MAX_SAFE_INTEGER);
        const totals = computeSessionTotals(sessions);
        if (statusValues.json) {
          console.log(JSON.stringify(totals, null, 2));
        } else {
          console.log(formatSessionTotals(totals));
        }
        return;
      }
      if (statusValues.backlog) {
        const projects = await loadProjects();
        const rows: BacklogRow[] = [];
        for (const p of projects) {
          const b = await countRemainingWorkDetailed(p);
          rows.push({
            project_id: p.id,
            bot_pickable: b.pending_bot_pickable,
            interactive_only: b.pending_interactive_only,
            handsoff_conflict: b.pending_handsoff_conflict,
            in_progress: b.in_progress,
            done: b.done,
          });
        }
        if (statusValues.json) {
          const totals = computeBacklogTotals(rows);
          const out = {
            projects: rows.map((r) => ({
              id: r.project_id,
              bot_pickable: r.bot_pickable,
              interactive_only: r.interactive_only,
              handsoff_conflict: r.handsoff_conflict,
              in_progress: r.in_progress,
              done: r.done,
            })),
            totals,
          };
          console.log(JSON.stringify(out, null, 2));
        } else {
          console.log(formatBacklogTable(rows));
          // gs-234: friendly note when every project has zero bot-pickable
          // work, so the operator sees a prompt to seed tasks instead of
          // just a row of zeros.
          const totals = computeBacklogTotals(rows);
          if (totals.bot_pickable === 0) {
            console.log(
              "\nAll queues drained. Seed tasks with `generalstaff tasks add <project-id> --title=... --priority=N` or directly in `state/<project-id>/tasks.json`.",
            );
          }
        }
        return;
      }
      if (statusValues.summary) {
        const todaySummary = await buildTodaySessionSummary(
          new Date(),
          sinceMs,
        );
        if (statusValues.json) {
          console.log(JSON.stringify(todaySummary, null, 2));
        } else {
          console.log(formatTodaySessionSummary(todaySummary));
        }
        return;
      }

      const projects = await loadProjects();
      const fleet = await loadFleetState();
      const stopped = await isStopFilePresent();

      if (sessionsFlag.enabled) {
        // gs-247: when --since is set, pull the full history and filter
        // client-side so the requested limit applies to the filtered
        // window, not the raw tail. loadRecentSessions already sorts
        // newest-first, so slicing after the filter preserves ordering.
        let sessions: SessionSummary[];
        if (sinceMs !== undefined) {
          const all = await loadRecentSessions(Number.MAX_SAFE_INTEGER);
          sessions = filterSessionsSince(all, sinceMs).slice(
            0,
            sessionsFlag.limit,
          );
        } else {
          sessions = await loadRecentSessions(sessionsFlag.limit);
        }
        if (statusValues.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else {
          console.log(
            `=== Recent sessions (last ${sessionsFlag.limit}) ===\n`,
          );
          console.log(formatSessionsTable(sessions));
        }
        return;
      }

      if (statusValues.json) {
        const summaries = await Promise.all(
          projects.map((p) => getProjectSummary(p, fleet)),
        );
        const output = { stopped, projects: summaries };
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log("=== GeneralStaff Fleet Status ===\n");
        console.log(
          `STOP file: ${stopped ? "PRESENT (halted)" : "absent (ready)"}`,
        );
        console.log(`Registered projects: ${projects.length}\n`);
        for (const p of projects) {
          const state = fleet.projects[p.id];
          console.log(`  ${p.id} (priority ${p.priority})`);
          if (state) {
            if (state.last_cycle_at) {
              console.log(
                `    Last cycle: ${formatRelativeTime(state.last_cycle_at)} (${state.last_cycle_at})`,
              );
            } else {
              console.log(`    Last cycle: never`);
            }
            console.log(
              `    Last outcome: ${state.last_cycle_outcome ?? "none"}`,
            );
            console.log(`    Total cycles: ${state.total_cycles}`);
          } else {
            console.log(`    No cycles yet`);
          }
        }
      }
    };

    if (watch.enabled) {
      await runWatchLoop(renderStatus, watch.intervalSeconds);
    } else {
      await renderStatus();
    }
    break;
  }

  case "projects": {
    const projects = await loadProjects();
    if (projects.length === 0) {
      console.log("No projects registered.");
    } else {
      for (const p of projects) {
        console.log(`${p.id}`);
        console.log(`  path:     ${p.path}`);
        console.log(`  priority: ${p.priority}`);
        console.log(`  budget:   ${p.cycle_budget_minutes} min`);
        console.log(`  branch:   ${p.branch}`);
      }
    }
    break;
  }

  case "stop": {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        force: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const statusMode = values.status || values.check;
    if (statusMode && values.force) {
      console.error(
        "Error: --status/--check and --force are mutually exclusive",
      );
      process.exit(1);
    }
    if (statusMode) {
      // gs-165: read-only inspection of STOP file and recorded session pid.
      // Path computed inline — stopFilePath is module-private in safety.ts
      // by design; mirror the pattern used by src/stop_watcher.ts and
      // src/session.ts rather than exporting it.
      const stopPath = join(getRootDir(), "STOP");
      if (existsSync(stopPath)) {
        console.log(`STOP file: present at ${stopPath}`);
      } else {
        console.log("STOP file: absent");
      }
      const pidPath = join(getRootDir(), "state", "session.pid");
      let pidLine = "Session pid: none recorded";
      if (existsSync(pidPath)) {
        try {
          const raw = readFileSync(pidPath, "utf8").trim();
          if (raw.length > 0) {
            pidLine = `Session pid: ${raw}`;
          }
        } catch {
          // keep default "none recorded" — unreadable pid file is a no-signal.
        }
      }
      console.log(pidLine);
      break;
    }
    if (values.force) {
      const result = await stopForce();
      if (result.pid === null) {
        console.log(
          "STOP file created. No running session pid on record — nothing to kill.",
        );
      } else if (result.killed) {
        console.log(
          `STOP file created. Killed session pid ${result.pid} via ${result.method}.`,
        );
      } else {
        console.error(
          `STOP file created, but failed to kill pid ${result.pid}` +
            (result.error ? `: ${result.error}` : "") +
            ". The process may already be gone.",
        );
      }
    } else {
      await createStopFile();
      console.log("STOP file created. Dispatcher will halt before next cycle.");
    }
    break;
  }

  case "start": {
    await removeStopFile();
    console.log("STOP file removed. Dispatcher is ready.");
    break;
  }

  case "log": {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string" },
        lines: { type: "string" },
        tail: { type: "boolean", default: false },
        level: { type: "string" },
        grep: { type: "string" },
        since: { type: "string" },
      },
      allowPositionals: false,
    });
    if (values.tail && values.lines !== undefined) {
      console.error("Error: --tail and --lines are mutually exclusive");
      process.exit(2);
    }
    const linesValue = values.tail ? 9999 : parseInt(values.lines ?? "20", 10);
    if (values.level !== undefined && values.level !== "error") {
      console.error(`Error: --level must be 'error' (got '${values.level}')`);
      process.exit(2);
    }
    let grepRegex: RegExp | undefined;
    if (values.grep !== undefined) {
      try {
        grepRegex = compileGrepPattern(values.grep);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    let sinceMs: number | undefined;
    if (values.since !== undefined) {
      try {
        sinceMs = parseSinceFlag(values.since);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    await tailProgressLog(values.project, linesValue, {
      level: values.level as "error" | undefined,
      grep: grepRegex,
      sinceMs,
    });
    break;
  }

  case "history": {
    const { values: historyValues } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string" },
        lines: { type: "string", default: "20" },
        format: { type: "string", default: "table" },
        costs: { type: "boolean", default: false },
        since: { type: "string" },
        until: { type: "string" },
        "verified-only": { type: "boolean", default: false },
        outcome: { type: "string" },
      },
      allowPositionals: false,
    });
    const fmt = historyValues.format;
    if (fmt !== "table" && fmt !== "compact" && fmt !== "json") {
      console.error(`Error: unknown --format value: ${fmt} (supported: table, compact, json)`);
      process.exit(1);
    }
    if (historyValues["verified-only"] && historyValues.outcome !== undefined) {
      console.error("Error: --verified-only and --outcome are mutually exclusive");
      process.exit(1);
    }
    if (
      historyValues.outcome !== undefined &&
      !(VALID_OUTCOME_FILTERS as readonly string[]).includes(historyValues.outcome)
    ) {
      console.error(
        `Error: unknown --outcome value: ${historyValues.outcome} (supported: ${VALID_OUTCOME_FILTERS.join(", ")})`,
      );
      process.exit(1);
    }
    const loadOpts = {
      since: historyValues.since,
      until: historyValues.until,
      verifiedOnly: historyValues["verified-only"],
      outcome: historyValues.outcome as OutcomeFilter | undefined,
    };
    const limit = parseInt(historyValues.lines!, 10);
    if (fmt === "json") {
      let jsonRows;
      try {
        jsonRows = await loadCycleHistoryJson(historyValues.project, limit, loadOpts);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
      console.log(JSON.stringify(jsonRows, null, 2));
      break;
    }
    let rows;
    try {
      rows = await loadCycleHistory(historyValues.project, limit, loadOpts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(2);
    }
    if (fmt === "compact") {
      if (historyValues.costs) {
        const summary = await summarizeCosts(historyValues.project);
        const byProject = historyValues.project ? undefined : summary.by_project;
        printHistoryCompact(rows, undefined, summary.by_cycle, byProject);
      } else {
        printHistoryCompact(rows);
      }
    } else {
      printHistoryTable(rows);
    }
    break;
  }

  case "summary": {
    const { values: summaryValues } = parseArgs({
      args: args.slice(1),
      options: {
        "no-tests": { type: "boolean", default: false },
        "format": { type: "string" },
        "project": { type: "string" },
      },
      allowPositionals: false,
    });
    const format = summaryValues.format;
    if (format !== undefined && format !== "json") {
      console.error(`Error: unknown --format value: ${format} (supported: json)`);
      process.exit(1);
    }
    if (summaryValues.project) {
      try {
        const all = await loadProjects();
        getProject(all, summaryValues.project);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          console.error(`Error: project '${err.projectId}' not found`);
          if (err.availableIds.length > 0) {
            console.error(`  Available: ${err.availableIds.join(", ")}`);
          }
          process.exit(1);
        }
        throw err;
      }
    }
    const summary = await buildFleetSummary(summaryValues.project);
    const tests = summaryValues["no-tests"]
      ? null
      : countTests(resolve("tests"));
    const disk = computeDiskUsage();
    if (format === "json") {
      console.log(JSON.stringify({ summary, tests, disk }, null, 2));
    } else {
      console.log(formatSummary(summary, tests, disk));
    }
    break;
  }

  case "doctor": {
    const { values: doctorValues } = parseArgs({
      args: args.slice(1),
      options: {
        fix: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        // gs-246: opt-in context lines under each passing sanity
        // check. No short flag — top-level `-v` already means
        // --version and is consumed before the subcommand dispatch.
        verbose: { type: "boolean", default: false },
        // gs-251: machine-readable output, pairs with --fix and --verbose.
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    await runDoctor({
      fix: Boolean(doctorValues.fix),
      assumeYes: Boolean(doctorValues.yes),
      verbose: Boolean(doctorValues.verbose),
      json: Boolean(doctorValues.json),
    });
    break;
  }

  case "clean": {
    const { values: cleanValues } = parseArgs({
      args: args.slice(1),
      options: {
        keep: { type: "string", default: "20" },
        "log-days": { type: "string", default: "30" },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    console.log("=== GeneralStaff Clean ===\n");
    await runClean(
      parseInt(cleanValues.keep!, 10),
      parseInt(cleanValues["log-days"]!, 10),
      cleanValues["dry-run"] === true,
    );
    break;
  }

  case "task": {
    const sub = args[1];
    // gs-244: subcommand-level --help / help matching gs-233's view pattern.
    // `help` as args[1] is a new keyword here — it does not collide with an
    // existing sub-subcommand name (list/add/done/rm/interactive/count).
    if (
      args.includes("--help") ||
      args.includes("-h") ||
      sub === "--help" ||
      sub === "help"
    ) {
      console.log(
        "Usage: generalstaff task <subcommand> --project=<id> [options]\n" +
          "\n" +
          "Manage per-project task queues (reads/writes state/<id>/tasks.json).\n" +
          "\n" +
          "Subcommands:\n" +
          "  list --project=<id> [--priority=N]                 Show pending tasks\n" +
          "  add  --project=<id> [--priority=N] <title>         Append a new task\n" +
          "  done --project=<id> --task=<task-id>               Mark a task as done\n" +
          "  rm   --project=<id> --task=<task-id>               Delete a task\n" +
          "  interactive --project=<id> <task-id> [--off]       Flip interactive_only flag\n" +
          "  count [--project=<id>]                             Report pending vs done counts\n" +
          "  validate [--project=<id>] [--json]                 Validate tasks.json schema across projects\n" +
          "  next [--project=<id>] [--json]                     Preview next task(s) the picker would pick\n" +
          "\n" +
          "Examples:\n" +
          "  generalstaff task list --project=myapp\n" +
          "  generalstaff task add --project=myapp --priority=1 \"Fix login bug\"\n" +
          "  generalstaff task done --project=myapp --task=my-042\n" +
          "  generalstaff task interactive --project=myapp my-042\n" +
          "  generalstaff task count                             # all projects\n",
      );
      process.exit(0);
    }
    if (sub === "list") {
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          priority: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!values.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
      }
      let priorityFilter: number | undefined;
      if (values.priority !== undefined) {
        const parsed = parseInt(values.priority, 10);
        if (
          isNaN(parsed) ||
          parsed < 1 ||
          String(parsed) !== values.priority.trim()
        ) {
          console.error("Error: --priority must be a positive integer");
          process.exit(1);
        }
        priorityFilter = parsed;
      }
      // gs-238: when a projects.yaml is present, reject --project=<unknown-id>
      // eagerly so operators get a clear error instead of a silent empty list
      // (loadTasks returns [] for a missing state/<id>/tasks.json). Legacy
      // behaviour is preserved when projects.yaml is absent.
      if (existsSync(join(getRootDir(), "projects.yaml"))) {
        const registered = await loadProjects();
        if (!registered.find((p) => p.id === values.project)) {
          const ids =
            registered.map((p) => p.id).join(", ") || "(none)";
          console.error(
            `Error: project '${values.project}' not found. Registered: ${ids}`,
          );
          process.exit(1);
        }
      }
      let tasks;
      try {
        tasks = await loadTasks(values.project);
      } catch (err) {
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      let pending = pendingTasks(tasks);
      if (priorityFilter !== undefined) {
        pending = pending.filter((t) => t.priority === priorityFilter);
      }
      if (pending.length === 0) {
        if (priorityFilter !== undefined) {
          console.log(`No pending tasks at priority ${priorityFilter}.`);
        } else {
          console.log("No pending tasks.");
        }
      } else {
        for (const t of pending) {
          console.log(`${t.id}  p${t.priority}  ${t.status.padEnd(11)}  ${t.title}`);
        }
      }
    } else if (sub === "add") {
      const { values: taskValues, positionals: taskPositionals } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          priority: { type: "string" },
          // gs-253: queue-time bot-pickability hints.
          "interactive-only": { type: "boolean", default: false },
          "interactive-only-reason": { type: "string" },
          "expected-touches": { type: "string" },
        },
        allowPositionals: true,
      });
      if (!taskValues.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
      }
      const title = taskPositionals.join(" ").trim();
      if (!title) {
        console.error(
          "Error: task title cannot be empty\n  Usage: generalstaff task add --project=<id> <title>",
        );
        process.exit(1);
      }
      if (title.length > 500) {
        console.error(
          `Warning: task title is ${title.length} characters (over 500); consider shortening.`,
        );
      }
      let priority = 2;
      if (taskValues.priority !== undefined) {
        const parsed = parseInt(taskValues.priority, 10);
        if (isNaN(parsed) || parsed < 1) {
          console.error("Error: --priority must be a positive integer");
          process.exit(1);
        }
        priority = parsed;
      }
      const interactiveOnly = taskValues["interactive-only"] === true;
      const rawReason = taskValues["interactive-only-reason"];
      const interactiveOnlyReason =
        typeof rawReason === "string" ? rawReason.trim() : undefined;
      if (interactiveOnly && (interactiveOnlyReason === undefined || interactiveOnlyReason.length === 0)) {
        console.error(
          "Error: --interactive-only requires --interactive-only-reason=<string>",
        );
        process.exit(1);
      }
      let expectedTouches: string[] | undefined;
      const rawExpected = taskValues["expected-touches"];
      if (typeof rawExpected === "string") {
        const parts = rawExpected.split(",").map((p) => p.trim());
        if (parts.length === 0 || parts.some((p) => p.length === 0)) {
          console.error(
            "Error: --expected-touches entries must not be empty",
          );
          process.exit(1);
        }
        expectedTouches = parts;
      }
      let task;
      try {
        task = await addTask(taskValues.project, title, priority, {
          interactiveOnly,
          interactiveOnlyReason,
          expectedTouches,
        });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      console.log(`Added ${task.id}: ${task.title}`);
    } else if (sub === "done") {
      const { values: doneValues } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          task: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!doneValues.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
      }
      if (!doneValues.task) {
        console.error("Error: --task=<task-id> is required");
        process.exit(1);
      }
      let result;
      try {
        result = await markTaskDone(doneValues.project, doneValues.task);
      } catch (err) {
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (result.kind === "project_not_found") {
        console.error(
          `Error: no tasks file for project '${doneValues.project}' (${result.path})`,
        );
        process.exit(1);
      } else if (result.kind === "task_not_found") {
        console.error(
          `Error: task '${doneValues.task}' not found in project '${doneValues.project}'`,
        );
        if (result.availableIds.length > 0) {
          console.error(`  Available: ${result.availableIds.join(", ")}`);
        }
        process.exit(1);
      } else if (result.kind === "already_done") {
        console.log(`${result.task.id} is already done.`);
      } else {
        console.log(`Marked ${result.task.id} as done: ${result.task.title}`);
      }
    } else if (sub === "rm") {
      const { values: rmValues } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          task: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!rmValues.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
      }
      if (!rmValues.task) {
        console.error("Error: --task=<task-id> is required");
        process.exit(1);
      }
      let result;
      try {
        result = await removeTask(rmValues.project, rmValues.task);
      } catch (err) {
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (result.kind === "project_not_found") {
        console.error(
          `Error: no tasks file for project '${rmValues.project}' (${result.path})`,
        );
        process.exit(1);
      } else if (result.kind === "task_not_found") {
        console.error(
          `Error: task '${rmValues.task}' not found in project '${rmValues.project}'`,
        );
        if (result.availableIds.length > 0) {
          console.error(`  Available: ${result.availableIds.join(", ")}`);
        }
        process.exit(1);
      } else {
        console.log(`Removed ${result.task.id}: ${result.task.title}`);
      }
    } else if (sub === "interactive") {
      // gs-243: toggle a task's interactive_only flag from the CLI.
      // Default: set interactive_only=true. Pass --off to clear it.
      const { values: intValues, positionals: intPositionals } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          off: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      if (!intValues.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
      }
      const taskId = intPositionals[0];
      if (!taskId) {
        console.error(
          "Error: task-id positional is required\n" +
            "  Usage: generalstaff task interactive --project=<id> <task-id> [--off]",
        );
        process.exit(1);
      }
      if (intPositionals.length > 1) {
        console.error(
          `Error: unexpected extra positional(s): ${intPositionals.slice(1).join(" ")}`,
        );
        process.exit(1);
      }
      const target = intValues.off === true ? false : true;
      let result;
      try {
        result = await markTaskInteractive(
          intValues.project,
          taskId,
          target,
        );
      } catch (err) {
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (result.kind === "project_not_found") {
        console.error(
          `Error: no tasks file for project '${intValues.project}' (${result.path})`,
        );
        process.exit(1);
      } else if (result.kind === "task_not_found") {
        console.error(
          `Error: task '${taskId}' not found in project '${intValues.project}'`,
        );
        if (result.availableIds.length > 0) {
          console.error(`  Available: ${result.availableIds.join(", ")}`);
        }
        process.exit(1);
      } else if (result.kind === "unchanged") {
        console.log(
          `${result.task.id} interactive_only already ${result.value}.`,
        );
      } else {
        console.log(
          target
            ? `Marked ${result.task.id} as interactive_only: ${result.task.title}`
            : `Cleared interactive_only on ${result.task.id}: ${result.task.title}`,
        );
      }
    } else if (sub === "count") {
      const { values: countValues } = parseArgs({
        args: args.slice(2),
        options: { project: { type: "string" } },
        allowPositionals: false,
      });
      let targets: string[];
      if (countValues.project) {
        targets = [countValues.project];
      } else {
        const all = await loadProjects();
        if (all.length === 0) {
          console.log("No projects registered.");
          break;
        }
        targets = all.map((p) => p.id);
      }
      for (const id of targets) {
        let tasks;
        try {
          tasks = await loadTasks(id);
        } catch (err) {
          if (err instanceof TasksLoadError) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
          throw err;
        }
        const c = countTasks(tasks);
        console.log(
          `${id}: ${c.pending} pending, ${c.done} done (${c.total} total)`,
        );
      }
    } else if (sub === "validate") {
      // gs-248: schema-validate every project's tasks.json. Reuses the
      // TaskValidationError-raising loadTasks path from src/tasks.ts so
      // the validator and the runtime read the same schema. loadTasks
      // throws on the first invalid entry, so a project's `errors` array
      // contains at most one message; that's the granularity the existing
      // validator exposes and is sufficient for pass/fail signalling.
      const { values: valValues } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          json: { type: "boolean", default: false },
        },
        allowPositionals: false,
      });
      let targets: string[];
      const yamlExists = existsSync(join(getRootDir(), "projects.yaml"));
      if (valValues.project) {
        if (yamlExists) {
          const registered = await loadProjects();
          if (!registered.find((p) => p.id === valValues.project)) {
            const ids =
              registered.map((p) => p.id).join(", ") || "(none)";
            console.error(
              `Error: project '${valValues.project}' not found. Registered: ${ids}`,
            );
            process.exit(1);
          }
        }
        targets = [valValues.project];
      } else {
        const all = await loadProjects();
        if (all.length === 0) {
          if (valValues.json) {
            console.log(JSON.stringify({}, null, 2));
          } else {
            console.log("No projects registered.");
          }
          break;
        }
        targets = all.map((p) => p.id);
      }
      const results: Record<string, { ok: boolean; errors: string[] }> = {};
      let anyFail = false;
      for (const id of targets) {
        try {
          await loadTasks(id);
          results[id] = { ok: true, errors: [] };
        } catch (err) {
          anyFail = true;
          const msg = err instanceof Error ? err.message : String(err);
          results[id] = { ok: false, errors: [msg] };
        }
      }
      if (valValues.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const id of targets) {
          const r = results[id]!;
          if (r.ok) {
            console.log(`${id}: ok (0 issues)`);
          } else {
            const n = r.errors.length;
            console.log(
              `${id}: FAIL (${n} issue${n === 1 ? "" : "s"})`,
            );
            for (const e of r.errors) {
              console.log(`  - ${e}`);
            }
          }
        }
      }
      if (anyFail) process.exit(1);
    } else if (sub === "next") {
      // gs-250: preview which task the picker would select next, without
      // mutating any state. Runs the same pickNextProjects logic session.ts
      // uses when max_parallel_slots > 1, then — for each picked project —
      // loads tasks.json and picks the top bot-pickable task using the same
      // "lowest priority number first; among same-priority, lowest numeric
      // id suffix first" convention the engineer bot follows.
      const { values: nextValues } = parseArgs({
        args: args.slice(2),
        options: {
          project: { type: "string" },
          json: { type: "boolean", default: false },
        },
        allowPositionals: false,
      });
      const dispatcher = await loadDispatcherConfig();
      const allProjects = await loadProjects();
      let candidateProjects = allProjects;
      if (nextValues.project) {
        const match = allProjects.find((p) => p.id === nextValues.project);
        if (!match) {
          const ids = allProjects.map((p) => p.id).join(", ") || "(none)";
          console.error(
            `Error: project '${nextValues.project}' not found. Registered: ${ids}`,
          );
          process.exit(1);
        }
        candidateProjects = [match];
      }
      const fleet = await loadFleetState(dispatcher);
      const maxCount = nextValues.project ? 1 : dispatcher.max_parallel_slots;
      const picks = await pickNextProjects(
        candidateProjects,
        dispatcher,
        fleet,
        new Set<string>(),
        maxCount,
      );
      const slots: Array<{
        project_id: string;
        task_id: string | null;
        title: string | null;
      }> = [];
      for (const pick of picks) {
        let taskId: string | null = null;
        let taskTitle: string | null = null;
        try {
          const tasks = await loadTasks(pick.project.id);
          const pickable = botPickableTasks(tasks, pick.project.hands_off);
          const sorted = pickable.slice().sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const na = numericIdSuffix(a.id);
            const nb = numericIdSuffix(b.id);
            if (na !== nb) return na - nb;
            return a.id.localeCompare(b.id);
          });
          const top = sorted[0];
          if (top) {
            taskId = top.id;
            taskTitle = top.title;
          }
        } catch (err) {
          if (err instanceof TasksLoadError) {
            // Malformed tasks.json: report empty slot rather than crash
            // (preview should never fail-hard on per-project load errors).
            taskId = null;
            taskTitle = null;
          } else {
            throw err;
          }
        }
        slots.push({
          project_id: pick.project.id,
          task_id: taskId,
          title: taskTitle,
        });
      }
      if (nextValues.json) {
        const payload = {
          slots: slots.map((s) => ({
            project_id: s.project_id,
            task_id: s.task_id,
            title: s.title,
          })),
        };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        if (slots.length === 0) {
          console.log("No eligible project — nothing to preview.");
        } else {
          for (const s of slots) {
            if (s.task_id === null) {
              console.log(`${s.project_id}  (no bot-pickable task)`);
            } else {
              const title = (s.title ?? "").slice(0, 80);
              console.log(`${s.project_id}  ${s.task_id}  ${title}`);
            }
          }
        }
      }
    } else {
      console.error(
        "Error: task subcommand required (list, add, done, rm, interactive, count, validate, or next)\n" +
          "  Usage: generalstaff task list --project=<id>\n" +
          "         generalstaff task add --project=<id> <title>\n" +
          "         generalstaff task done --project=<id> --task=<task-id>\n" +
          "         generalstaff task rm --project=<id> --task=<task-id>\n" +
          "         generalstaff task interactive --project=<id> <task-id> [--off]\n" +
          "         generalstaff task count [--project=<id>]\n" +
          "         generalstaff task validate [--project=<id>] [--json]\n" +
          "         generalstaff task next [--project=<id>] [--json]",
      );
      process.exit(1);
    }
    break;
  }

  case "cycle-redo": {
    const { values: redoValues } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string" },
        task: { type: "string" },
      },
      allowPositionals: false,
    });
    if (!redoValues.project) {
      console.error("Error: --project=<id> is required");
      process.exit(1);
    }
    if (!redoValues.task) {
      console.error("Error: --task=<task-id> is required");
      process.exit(1);
    }
    let result;
    try {
      result = await markTaskPending(redoValues.project, redoValues.task);
    } catch (err) {
      if (err instanceof TasksLoadError) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    if (result.kind === "project_not_found") {
      console.error(
        `Error: no tasks file for project '${redoValues.project}' (${result.path})`,
      );
      process.exit(1);
    } else if (result.kind === "task_not_found") {
      console.error(
        `Error: task '${redoValues.task}' not found in project '${redoValues.project}'`,
      );
      if (result.availableIds.length > 0) {
        console.error(`  Available: ${result.availableIds.join(", ")}`);
      }
      process.exit(1);
    } else if (result.kind === "already_pending") {
      console.log(`${result.task.id} is already pending.`);
    } else {
      console.log(
        `Reopened ${result.task.id} as pending: ${result.task.title}`,
      );
    }
    break;
  }

  case "digest": {
    if (args[1] === "last") {
      const { values: lastValues } = parseArgs({
        args: args.slice(2),
        options: {
          json: { type: "boolean", default: false },
        },
        allowPositionals: false,
      });
      const dispatcher = await loadDispatcherConfig();
      const digestDir = resolve(getRootDir(), dispatcher.digest_dir);
      const files = existsSync(digestDir)
        ? readdirSync(digestDir).filter((f) => /^digest_\d{8}_\d{6}\.md$/.test(f))
        : [];
      if (files.length === 0) {
        console.log("No digests found.");
        break;
      }
      const { statSync } = await import("fs");
      let newest = files[0]!;
      let newestMtime = statSync(join(digestDir, newest)).mtimeMs;
      for (const f of files.slice(1)) {
        const m = statSync(join(digestDir, f)).mtimeMs;
        if (m > newestMtime) {
          newest = f;
          newestMtime = m;
        }
      }
      const chosenPath = join(digestDir, newest);
      const content = readFileSync(chosenPath, "utf8");
      if (lastValues.json) {
        console.log(
          JSON.stringify(
            { path: chosenPath, content, timestamp: new Date(newestMtime).toISOString() },
            null,
            2,
          ),
        );
      } else {
        process.stdout.write(content);
      }
      break;
    }
    const { values: digestValues } = parseArgs({
      args: args.slice(1),
      options: {
        latest: { type: "boolean", default: false },
        date: { type: "string" },
        list: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        path: { type: "boolean", default: false },
        regen: { type: "string" },
      },
      allowPositionals: false,
    });
    if (digestValues.latest && digestValues.date) {
      console.error("Error: --latest and --date are mutually exclusive");
      process.exit(1);
    }
    if (digestValues.list && (digestValues.latest || digestValues.date)) {
      console.error("Error: --list cannot be combined with --latest or --date");
      process.exit(1);
    }
    if (
      digestValues.regen &&
      (digestValues.latest || digestValues.date || digestValues.list || digestValues.path)
    ) {
      console.error(
        "Error: --regen cannot be combined with --latest, --date, --list, or --path",
      );
      process.exit(1);
    }
    const dispatcher = await loadDispatcherConfig();
    if (digestValues.regen) {
      const sourcePath = resolve(getRootDir(), digestValues.regen);
      if (!existsSync(sourcePath)) {
        console.error(`Error: digest file not found: ${sourcePath}`);
        process.exit(1);
      }
      const { regenerateDigest } = await import("./session");
      const { missing } = await regenerateDigest(sourcePath, {
        digest_dir: dispatcher.digest_dir,
      });
      if (missing.length > 0) {
        console.error(
          `Warning: ${missing.length} cycle(s) had no matching cycle_end event in PROGRESS.jsonl ` +
            `(used digest-only fallback): ${missing.map((m) => `${m.project_id}/${m.cycle_id}`).join(", ")}`,
        );
      }
      break;
    }
    const digestDir = resolve(getRootDir(), dispatcher.digest_dir);
    const files = existsSync(digestDir)
      ? readdirSync(digestDir)
          .filter((f) => /^digest_\d{8}_\d{6}\.md$/.test(f))
          .sort()
      : [];
    if (digestValues.list) {
      if (files.length === 0) {
        if (digestValues.json) console.log("[]");
        else console.log("No digests found.");
        break;
      }
      const sorted = [...files].sort().reverse();
      if (digestValues.path) {
        const paths = sorted.map((f) => join(digestDir, f));
        if (digestValues.json) console.log(JSON.stringify(paths, null, 2));
        else for (const p of paths) console.log(p);
        break;
      }
      const entries = sorted.map((f) => {
        const content = readFileSync(join(digestDir, f), "utf8");
        const m = f.match(/^digest_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.md$/);
        const date = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : f;
        const cyclesMatch = content.match(/\*\*Cycles:\*\*\s*(\d+)/);
        const cycles = cyclesMatch ? Number(cyclesMatch[1]) : null;
        let verified = 0;
        let failed = 0;
        let skipped = 0;
        for (const om of content.matchAll(/\*\*Outcome:\*\*\s*(\w+)/g)) {
          const o = om[1];
          if (o === "verified" || o === "verified_weak") verified++;
          else if (o === "verification_failed") failed++;
          else if (o === "cycle_skipped") skipped++;
        }
        return { file: f, date, cycles, verified, failed, skipped };
      });
      if (digestValues.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        for (const e of entries) {
          console.log(
            `${e.file}  ${e.date}  cycles=${e.cycles ?? "?"}  verified=${e.verified} failed=${e.failed} skipped=${e.skipped}`,
          );
        }
      }
      break;
    }
    if (files.length === 0) {
      if (digestValues.json) console.log("null");
      else console.log("No digests found.");
      break;
    }
    let chosen: string | undefined;
    if (digestValues.date) {
      if (!/^\d{8}$/.test(digestValues.date)) {
        console.error("Error: --date must be in YYYYMMDD format");
        process.exit(1);
      }
      chosen = files.find((f) => f.startsWith(`digest_${digestValues.date}_`));
      if (!chosen) {
        if (digestValues.json) console.log("null");
        else console.log(`No digests found for date ${digestValues.date}.`);
        break;
      }
    } else {
      chosen = files[files.length - 1];
    }
    const chosenPath = join(digestDir, chosen);
    if (digestValues.path) {
      if (digestValues.json) console.log(JSON.stringify(chosenPath));
      else console.log(chosenPath);
      break;
    }
    const chosenContent = readFileSync(chosenPath, "utf8");
    if (digestValues.json) {
      const { parseDigest } = await import("./session");
      console.log(JSON.stringify({ file: chosen, ...parseDigest(chosenContent) }, null, 2));
    } else {
      process.stdout.write(chosenContent);
    }
    break;
  }

  case "version": {
    const projectsYamlPath = join(getRootDir(), "projects.yaml");
    const projectsYamlFound = existsSync(projectsYamlPath);
    console.log(`generalstaff v${VERSION}`);
    console.log(`bun:           ${Bun.version}`);
    console.log(`platform:      ${process.platform} ${process.arch}`);
    console.log(
      `projects.yaml: ${projectsYamlPath}${projectsYamlFound ? "" : " (not found)"}`,
    );
    break;
  }

  case "config": {
    const yaml = await loadProjectsYaml();
    console.log("=== GeneralStaff Config ===\n");
    console.log(`Projects: ${yaml.projects.length}\n`);
    for (const p of yaml.projects) {
      console.log(`[${p.id}]`);
      console.log(`  path:                 ${p.path}`);
      console.log(`  priority:             ${p.priority}`);
      console.log(`  cycle_budget_minutes: ${p.cycle_budget_minutes}`);
      console.log(`  engineer_command:     ${p.engineer_command}`);
      console.log(`  verification_command: ${p.verification_command}`);
      console.log(`  work_detection:       ${p.work_detection}`);
      console.log(`  concurrency_detection:${p.concurrency_detection}`);
      console.log(`  branch:               ${p.branch}`);
      console.log(`  auto_merge:           ${p.auto_merge}`);
      console.log(`  hands_off (${p.hands_off.length}):`);
      for (const h of p.hands_off) {
        console.log(`    - ${h}`);
      }
      if (p.notes) {
        const lines = p.notes.split("\n").filter((l) => l.length > 0);
        console.log(`  notes:`);
        for (const line of lines) {
          console.log(`    ${line}`);
        }
      }
      console.log();
    }
    console.log("[dispatcher]");
    const d = yaml.dispatcher;
    console.log(`  state_dir:                         ${d.state_dir}`);
    console.log(`  fleet_state_file:                  ${d.fleet_state_file}`);
    console.log(`  stop_file:                         ${d.stop_file}`);
    console.log(`  override_file:                     ${d.override_file}`);
    console.log(`  picker:                            ${d.picker}`);
    console.log(`  max_cycles_per_project_per_session:${d.max_cycles_per_project_per_session}`);
    console.log(`  log_dir:                           ${d.log_dir}`);
    console.log(`  digest_dir:                        ${d.digest_dir}`);
    break;
  }

  case "providers": {
    const sub = args[1];
    if (sub !== "list" && sub !== "ping") {
      console.error(
        `Error: unknown providers subcommand '${sub ?? ""}'. Usage: generalstaff providers list [--json] | generalstaff providers ping <id>|--all [--json]`,
      );
      process.exit(2);
    }
    if (sub === "ping") {
      const { values: pingValues, positionals: pingPositionals } = parseArgs({
        args: args.slice(2),
        options: {
          json: { type: "boolean", default: false },
          all: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const configPath = join(getRootDir(), "provider_config.yaml");
      if (!existsSync(configPath)) {
        console.error(
          "Error: no provider_config.yaml found. See provider_config.yaml.example for format.",
        );
        process.exit(1);
      }
      let registry;
      try {
        registry = await loadProviderRegistry(configPath);
      } catch (err) {
        if (err instanceof ProviderConfigError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }

      const probeById = async (
        id: string,
      ): Promise<{ id: string; health: ProviderHealth }> => {
        try {
          const provider = getProviderById(registry, id);
          if (!provider.health) {
            return {
              id,
              health: {
                reachable: false,
                error: "provider has no health() method",
              },
            };
          }
          return { id, health: await provider.health() };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { id, health: { reachable: false, error: msg } };
        }
      };

      if (pingValues.all) {
        const ids = Array.from(registry.providers.keys());
        if (ids.length === 0) {
          if (pingValues.json) {
            console.log("[]");
          } else {
            console.log("No providers configured.");
          }
          break;
        }
        const results = await Promise.all(ids.map(probeById));
        if (pingValues.json) {
          console.log(
            JSON.stringify(
              results.map((r) => ({ id: r.id, ...r.health })),
              null,
              2,
            ),
          );
        } else {
          const idCol = Math.max(...ids.map((i) => i.length), 2);
          console.log(
            `${"id".padEnd(idCol)}  status       latency  detail`,
          );
          for (const r of results) {
            const status = r.health.reachable ? "reachable" : "unreachable";
            const lat =
              r.health.latencyMs !== undefined ? `${r.health.latencyMs}ms` : "-";
            const detail = r.health.reachable ? "" : (r.health.error ?? "");
            console.log(
              `${r.id.padEnd(idCol)}  ${status.padEnd(12)}  ${lat.padEnd(7)}  ${detail}`,
            );
          }
        }
        if (results.some((r) => !r.health.reachable)) process.exit(1);
        break;
      }

      const id = pingPositionals[0];
      if (!id) {
        console.error(
          "Error: provider id required. Usage: generalstaff providers ping <provider-id> [--json] | --all",
        );
        process.exit(2);
      }
      if (pingPositionals.length > 1) {
        console.error(
          "Error: only one provider id may be supplied (use --all to ping every provider)",
        );
        process.exit(2);
      }
      if (!registry.providers.has(id)) {
        const available = Array.from(registry.providers.keys()).join(", ");
        console.error(
          `Error: unknown provider id '${id}'${available ? ` (available: ${available})` : " (no providers configured)"}`,
        );
        process.exit(1);
      }
      const { health } = await probeById(id);
      if (pingValues.json) {
        console.log(JSON.stringify(health, null, 2));
      } else if (health.reachable) {
        const lat = health.latencyMs !== undefined ? `${health.latencyMs}ms` : "?";
        console.log(`Provider ${id}: reachable (${lat})`);
      } else {
        console.error(
          `Provider ${id}: unreachable — ${health.error ?? "unknown error"}`,
        );
      }
      if (!health.reachable) process.exit(1);
      break;
    }
    const { values: provValues } = parseArgs({
      args: args.slice(2),
      options: {
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const configPath = join(getRootDir(), "provider_config.yaml");
    if (!existsSync(configPath)) {
      if (provValues.json) {
        console.log(
          JSON.stringify(
            {
              providers: [],
              routes: { digest: null, cycle_summary: null, classifier: null },
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          "No provider_config.yaml found. See provider_config.yaml.example for format.",
        );
      }
      break;
    }
    let registry;
    try {
      registry = await loadProviderRegistry(configPath);
    } catch (err) {
      if (err instanceof ProviderConfigError) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    const roleOrder: ProviderRole[] = ["digest", "cycle_summary", "classifier"];
    if (provValues.json) {
      const providersArr = Array.from(registry.providers.values());
      const routesOut: Record<string, string | null> = {};
      for (const role of roleOrder) {
        const id = registry.routes[role];
        routesOut[role] =
          id === "noop" || !registry.providers.has(id) ? null : id;
      }
      console.log(
        JSON.stringify({ providers: providersArr, routes: routesOut }, null, 2),
      );
      break;
    }
    console.log("=== GeneralStaff Providers ===\n");
    if (registry.providers.size === 0) {
      console.log("Providers: (none configured)");
    } else {
      console.log(`Providers: ${registry.providers.size}\n`);
      for (const p of registry.providers.values()) {
        console.log(`[${p.id}]`);
        console.log(`  kind:        ${p.kind}`);
        console.log(`  model:       ${p.model}`);
        if (p.kind === "ollama") {
          console.log(`  host:        ${p.host ?? "http://localhost:11434 (default)"}`);
        }
        if (p.api_key_env !== undefined) {
          const present = process.env[p.api_key_env] ? "present" : "missing";
          console.log(`  api_key_env: ${p.api_key_env} (${present})`);
        }
        if (p.kind === "openrouter" || p.kind === "claude") {
          console.log(
            `  status:      not implemented in Phase 2 — parsed but not usable`,
          );
        }
        console.log();
      }
    }
    console.log("[routes]");
    for (const role of roleOrder) {
      const id = registry.routes[role];
      const label =
        id === "noop" || !registry.providers.has(id) ? "(unrouted)" : id;
      console.log(`  ${role.padEnd(14)} ${label}`);
    }
    break;
  }

  case "bot-status": {
    const { values: bsValues } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string" },
      },
      allowPositionals: false,
    });
    const all = await loadProjects();
    let target: typeof all;
    if (bsValues.project) {
      try {
        target = [getProject(all, bsValues.project)];
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          console.error(`Error: project '${err.projectId}' not found`);
          if (err.availableIds.length > 0) {
            console.error(`  Available: ${err.availableIds.join(", ")}`);
          }
          process.exit(1);
        }
        throw err;
      }
    } else {
      target = all;
    }
    if (target.length === 0) {
      console.log("No projects registered.");
      break;
    }
    for (const p of target) {
      let headBranch = "HEAD";
      try {
        const out = await $`git -C ${p.path} rev-parse --abbrev-ref HEAD`
          .quiet()
          .text();
        const trimmed = out.trim();
        if (trimmed && trimmed !== "HEAD") headBranch = trimmed;
      } catch {
        // fall through: project path may not be a git repo
      }
      const n = await countCommitsAhead(p.path, p.branch, "HEAD");
      console.log(
        `${p.id}: ${n} commit(s) on ${p.branch} not yet on ${headBranch}`,
      );
    }
    break;
  }

  case "diff": {
    const { values: diffValues, positionals: diffPositionals } = parseArgs({
      args: args.slice(1),
      options: {
        stat: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const diffProjectId = diffPositionals[0];
    const diffCycleId = diffPositionals[1];
    if (!diffProjectId || !diffCycleId) {
      console.error(
        "Error: project-id and cycle-id are required\n  Usage: generalstaff diff <project-id> <cycle-id> [--stat]",
      );
      process.exit(1);
    }
    const allDiffProjects = await loadProjects();
    const diffProject = allDiffProjects.find((p) => p.id === diffProjectId);
    if (!diffProject) {
      const registered = allDiffProjects.map((p) => p.id).join(", ");
      console.error(
        `Error: project '${diffProjectId}' not found. Registered: ${registered}`,
      );
      process.exit(1);
    }
    const diffDispatcher = await loadDispatcherConfig();
    const diffDir = cycleDir(diffProjectId, diffCycleId, diffDispatcher);
    if (!existsSync(diffDir)) {
      const cyclesRoot = join(
        getRootDir(),
        diffDispatcher.state_dir,
        diffProjectId,
        "cycles",
      );
      let recentIds: string[] = [];
      if (existsSync(cyclesRoot)) {
        recentIds = readdirSync(cyclesRoot).sort().reverse().slice(0, 5);
      }
      const recentLabel =
        recentIds.length > 0 ? recentIds.join(", ") : "(none)";
      console.error(
        `Error: cycle '${diffCycleId}' not found under project '${diffProjectId}'. Recent cycle ids: ${recentLabel}`,
      );
      process.exit(1);
    }
    const patchPath = join(diffDir, "diff.patch");
    let patchContent = "";
    if (existsSync(patchPath)) {
      patchContent = readFileSync(patchPath, "utf8");
    }
    if (patchContent.trim().length === 0) {
      console.log("(no diff captured for this cycle)");
      break;
    }
    if (diffValues.stat) {
      const lines = patchContent.split("\n");
      const files: Array<{
        path: string;
        insertions: number;
        deletions: number;
      }> = [];
      let current: { path: string; insertions: number; deletions: number } | null = null;
      for (const line of lines) {
        const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (gitMatch) {
          if (current) files.push(current);
          current = { path: gitMatch[2], insertions: 0, deletions: 0 };
          continue;
        }
        if (!current) continue;
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) current.insertions++;
        else if (line.startsWith("-")) current.deletions++;
      }
      if (current) files.push(current);
      const pad = files.reduce((m, f) => Math.max(m, f.path.length), 0);
      let totalIns = 0;
      let totalDel = 0;
      for (const f of files) {
        totalIns += f.insertions;
        totalDel += f.deletions;
        const total = f.insertions + f.deletions;
        const bar = "+".repeat(f.insertions) + "-".repeat(f.deletions);
        console.log(` ${f.path.padEnd(pad)} | ${String(total).padStart(4)} ${bar}`);
      }
      console.log(
        ` ${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalIns} insertion${totalIns === 1 ? "" : "s"}(+), ${totalDel} deletion${totalDel === 1 ? "" : "s"}(-)`,
      );
    } else {
      process.stdout.write(patchContent);
    }
    break;
  }

  case "init": {
    const { values: initValues, positionals: initPositionals } = parseArgs({
      args: args.slice(1),
      options: {
        id: { type: "string" },
        priority: { type: "string" },
      },
      allowPositionals: true,
    });
    const projectPath = initPositionals[0];
    if (!projectPath) {
      console.error("Error: project path is required\n  Usage: generalstaff init <path> [--id=<id>] [--priority=N]");
      process.exit(1);
    }
    let initPriority = 2;
    if (initValues.priority !== undefined) {
      const parsed = parseInt(initValues.priority, 10);
      if (isNaN(parsed) || parsed < 1 || String(parsed) !== initValues.priority.trim()) {
        console.error("Error: --priority must be a positive integer");
        process.exit(1);
      }
      initPriority = parsed;
    }
    const resolvedPath = resolve(projectPath);
    const projectId = initValues.id ?? basename(resolvedPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    await initProject(projectId, resolvedPath, { priority: initPriority });
    break;
  }

  case "register": {
    const { values: regValues, positionals: regPositionals } = parseArgs({
      args: args.slice(1),
      options: {
        path: { type: "string" },
        priority: { type: "string" },
        stack: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        "allow-non-git": { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const regProjectId = regPositionals[0];
    if (!regProjectId) {
      console.error(
        "Error: project-id is required\n" +
          "  Usage: generalstaff register <project-id> --path=<target-dir> [--priority=N] [--stack=<stack>] [--yes] [--allow-non-git]",
      );
      process.exit(1);
    }
    if (!regValues.path) {
      console.error("Error: --path=<target-dir> is required");
      process.exit(1);
    }
    let regPriority: number | undefined;
    if (regValues.priority !== undefined) {
      const parsed = parseInt(regValues.priority, 10);
      if (
        isNaN(parsed) ||
        parsed < 1 ||
        String(parsed) !== regValues.priority.trim()
      ) {
        console.error("Error: --priority must be a positive integer");
        process.exit(1);
      }
      regPriority = parsed;
    }
    // gs-190: explicit stack override for the chicken-and-egg where
    // stack-signal files aren't yet committed at register-time.
    const { ALL_STACK_KINDS: REG_STACKS } = await import("./bootstrap");
    if (
      regValues.stack !== undefined &&
      !REG_STACKS.includes(regValues.stack as (typeof REG_STACKS)[number])
    ) {
      console.error(
        `Error: --stack must be one of: ${REG_STACKS.join(", ")}`,
      );
      process.exit(1);
    }
    const { runRegister } = await import("./register");
    const regResult = await runRegister({
      projectId: regProjectId,
      projectPath: regValues.path,
      assumeYes: Boolean(regValues.yes),
      priority: regPriority,
      stack: regValues.stack as (typeof REG_STACKS)[number] | undefined,
      allowNonGit: Boolean(regValues["allow-non-git"]),
    });
    if (!regResult.ok) {
      console.error(`Error: ${regResult.reason}`);
      process.exit(1);
    }
    console.log(
      `Registered "${regProjectId}" in ${regResult.projectsYamlPath}.`,
    );
    console.log("Appended:\n");
    console.log(regResult.appendedYaml);
    break;
  }

  case "bootstrap": {
    const { values: bsValues, positionals: bsPositionals } = parseArgs({
      args: args.slice(1),
      options: {
        stack: { type: "string" },
        id: { type: "string" },
        force: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const bsTarget = bsPositionals[0];
    const bsIdea = bsPositionals[1];
    if (!bsTarget || !bsIdea) {
      console.error(
        'Error: target-dir and idea are required\n  Usage: generalstaff bootstrap <target-dir> "<idea>" [--stack=<stack>] [--id=<id>] [--force]',
      );
      process.exit(1);
    }
    const { ALL_STACK_KINDS } = await import("./bootstrap");
    if (
      bsValues.stack !== undefined &&
      !ALL_STACK_KINDS.includes(bsValues.stack as (typeof ALL_STACK_KINDS)[number])
    ) {
      console.error(
        `Error: --stack must be one of: ${ALL_STACK_KINDS.join(", ")}`,
      );
      process.exit(1);
    }
    const { runBootstrap } = await import("./bootstrap");
    const resolvedTarget = resolve(bsTarget);
    const result = await runBootstrap({
      targetDir: resolvedTarget,
      idea: bsIdea,
      stack: bsValues.stack as (typeof ALL_STACK_KINDS)[number] | undefined,
      projectId: bsValues.id,
      force: Boolean(bsValues.force),
    });
    if (!result.ok) {
      console.error(`Error: ${result.reason}`);
      process.exit(1);
    }
    console.log(`Bootstrap complete for project "${result.projectId}".`);
    console.log(`  Target:    ${resolvedTarget}`);
    console.log(`  Stack:     ${result.detectedStack?.kind}`);
    console.log(`  Proposal:  ${result.proposalPath}`);
    if (result.createdScaffold) {
      console.log(`  Scaffold:  wrote minimum-viable package.json/tsconfig.json/.gitignore/README.md`);
    }
    console.log(`\nNext steps:`);
    console.log(`  1. Review ${result.proposalPath}/README-PROPOSAL.md`);
    console.log(`  2. Fill in <FILL IN> sections of CLAUDE-AUTONOMOUS.md`);
    console.log(`  3. Move files into place + register in projects.yaml`);
    break;
  }

  case "view": {
    const VALID_VIEWS = [
      "fleet-overview",
      "task-queue",
      "session-tail",
      "dispatch-detail",
      "inbox",
    ] as const;
    const viewName = args[1];
    const viewArgs = args.slice(2);

    if (!viewName || viewName === "--help" || viewName === "help") {
      console.log(
        "Usage: generalstaff view <name> [options]\n" +
          "\n" +
          "Available views:\n" +
          "  fleet-overview              One row per project + aggregates\n" +
          "  task-queue <project-id>     Task buckets (In-flight/Ready/Blocked/Shipped) (gs-227)\n" +
          "  session-tail [--limit=N]    Newest sessions with per-cycle breakdown (gs-228)\n" +
          "  dispatch-detail <cycle-id>  Full cycle report: phases, diff, checks (gs-229)\n" +
          "  inbox [--since=<iso>]       Fleet message inbox (gs-230)\n",
      );
      process.exit(0);
    }

    if (!(VALID_VIEWS as readonly string[]).includes(viewName)) {
      console.error(
        `Error: unknown view '${viewName}'. Valid views: ${VALID_VIEWS.join(", ")}`,
      );
      process.exit(1);
    }

    if (viewName === "fleet-overview") {
      const { values: viewValues } = parseArgs({
        args: viewArgs,
        options: {
          json: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const { getFleetOverview } = await import("./views/fleet_overview");
      const data = await getFleetOverview();
      if (viewValues.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const headers = [
          "project",
          "last_cycle",
          "cycles",
          "verified",
          "failed",
          "pickable",
          "auto_merge",
          "branch",
        ];
        const cells = data.projects.map((p) => [
          p.id,
          p.last_cycle_at ? formatRelativeTime(p.last_cycle_at) : "never",
          String(p.cycles_total),
          String(p.verified),
          String(p.failed),
          String(p.bot_pickable),
          p.auto_merge ? "yes" : "no",
          p.branch,
        ]);
        const widths = headers.map((h, i) =>
          Math.max(h.length, ...cells.map((row) => row[i].length), 0),
        );
        const fmtRow = (row: string[]) =>
          row.map((v, i) => v.padEnd(widths[i])).join("  ");
        console.log(fmtRow(headers));
        for (const row of cells) console.log(fmtRow(row));
        const passRatePct = `${Math.round(data.aggregates.pass_rate * 100)}%`;
        const slotEff =
          data.aggregates.slot_efficiency_recent === null
            ? "n/a"
            : data.aggregates.slot_efficiency_recent.toFixed(2);
        console.log(
          `\nTotal cycles: ${data.aggregates.total_cycles}  pass_rate: ${passRatePct}  slot_efficiency_recent: ${slotEff}`,
        );
      }
      break;
    }

    if (viewName === "task-queue") {
      const { values: tqValues, positionals: tqPositionals } = parseArgs({
        args: viewArgs,
        options: {
          json: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const projectId = tqPositionals[0];
      if (!projectId) {
        console.error("Error: view task-queue requires <project-id>");
        process.exit(1);
      }
      const { getProjectTaskQueue, TaskQueueError } = await import(
        "./views/task_queue"
      );
      let data;
      try {
        data = await getProjectTaskQueue(projectId);
      } catch (err) {
        if (err instanceof TaskQueueError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (tqValues.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const MAX_TITLE = 60;
        const trunc = (s: string) =>
          s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1) + "…" : s;
        const renderBucket = (
          label: string,
          entries: typeof data.in_flight,
        ) => {
          if (entries.length === 0) {
            console.log(`${label}: (none)`);
            return;
          }
          console.log(`${label}:`);
          for (const e of entries) {
            const parts = [`  ${e.id}`, `[P${e.priority}]`, trunc(e.title)];
            if (e.block_reason) parts.push(`(block: ${e.block_reason})`);
            if (e.age_label) parts.push(`(${e.age_label})`);
            console.log(parts.join(" "));
          }
        };
        renderBucket("In-flight", data.in_flight);
        renderBucket("Ready", data.ready);
        renderBucket("Blocked", data.blocked);
        renderBucket("Shipped", data.shipped);
      }
      break;
    }

    if (viewName === "session-tail") {
      const { values: stValues } = parseArgs({
        args: viewArgs,
        options: {
          json: { type: "boolean", default: false },
          limit: { type: "string" },
        },
        allowPositionals: true,
      });
      let limit = 3;
      if (stValues.limit !== undefined) {
        const parsed = Number(stValues.limit);
        if (
          !Number.isInteger(parsed) ||
          parsed <= 0 ||
          !/^\d+$/.test(String(stValues.limit).trim())
        ) {
          console.error("Error: --limit must be a positive integer");
          process.exit(1);
        }
        limit = parsed;
      }
      const { getRecentSessions, formatAutoMergeSummary } = await import(
        "./views/session_tail"
      );
      const data = await getRecentSessions(limit);
      if (stValues.json) {
        console.log(JSON.stringify(data, null, 2));
      } else if (data.sessions.length === 0) {
        console.log("No sessions yet");
      } else {
        const verdictGlyph = (v: string) =>
          v === "verified" ? "✓" : v === "failed" ? "✗" : "·";
        for (let i = 0; i < data.sessions.length; i++) {
          const s = data.sessions[i];
          if (i > 0) console.log("");
          console.log(`Session: ${s.session_id}`);
          console.log(`  started_at:       ${s.started_at}`);
          console.log(`  duration_minutes: ${s.duration_minutes}`);
          console.log(`  reviewer:         ${s.reviewer ?? "(unknown)"}`);
          console.log(`  stop_reason:      ${s.stop_reason ?? "(in-progress)"}`);
          const autoMergeLine = formatAutoMergeSummary(s);
          if (autoMergeLine !== null) {
            console.log(`  ${autoMergeLine}`);
          }
          if (s.cycles.length === 0) {
            console.log("  cycles: (none)");
          } else {
            console.log("  cycles:");
            for (const c of s.cycles) {
              const taskId = c.task_id ?? "—";
              console.log(
                `    ${verdictGlyph(c.verdict)} ${c.cycle_id}  ${c.verdict.padEnd(8)}  ${taskId}  ${c.project_id}  ${c.duration_seconds}s`,
              );
            }
          }
        }
      }
      break;
    }

    if (viewName === "dispatch-detail") {
      const { values: ddValues, positionals: ddPositionals } = parseArgs({
        args: viewArgs,
        options: {
          json: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const cycleId = ddPositionals[0];
      if (!cycleId) {
        console.error("Error: view dispatch-detail requires <cycle-id>");
        process.exit(1);
      }
      const { getDispatchDetail, DispatchDetailError } = await import(
        "./views/dispatch_detail"
      );
      let data;
      try {
        data = await getDispatchDetail(cycleId);
      } catch (err) {
        if (err instanceof DispatchDetailError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (ddValues.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const fmtDur = (s: number | null) =>
          s === null ? "n/a" : `${Math.round(s)}s`;
        const taskLine =
          data.task_id === null
            ? "—"
            : data.task_title
              ? `${data.task_id} — ${data.task_title}`
              : data.task_id;
        console.log(`Cycle:    ${data.cycle_id}`);
        console.log(`Task:     ${taskLine}`);
        console.log(`Project:  ${data.project_id}`);
        console.log(`Verdict:  ${data.verdict}`);
        console.log(`Duration: ${Math.round(data.duration_seconds)}s`);
        console.log("");
        console.log("Phases:");
        for (const [label, phase] of [
          ["engineer", data.engineer],
          ["verification", data.verification],
          ["review", data.review],
        ] as const) {
          const detail = phase.detail ? `  ${phase.detail}` : "";
          console.log(
            `  ${label.padEnd(13)} ${fmtDur(phase.duration_seconds).padStart(5)}${detail}`,
          );
        }
        console.log("");
        console.log(`Diff: +${data.diff_added}/-${data.diff_removed}`);
        if (data.files_touched.length === 0) {
          console.log("Files touched: (none)");
        } else {
          console.log("Files touched:");
          for (const f of data.files_touched) {
            console.log(`  +${f.added}/-${f.removed}  ${f.path}`);
          }
        }
        console.log("");
        console.log("Checks:");
        if (data.checks.length === 0) {
          console.log("  (none recorded)");
        } else {
          for (const c of data.checks) {
            const status = c.passed ? "pass" : "FAIL";
            const detail = c.detail ? `  ${c.detail}` : "";
            console.log(`  ${c.name.padEnd(16)} ${status}${detail}`);
          }
        }
      }
      break;
    }

    if (viewName === "inbox") {
      const { values: ibValues } = parseArgs({
        args: viewArgs,
        options: {
          json: { type: "boolean", default: false },
          since: { type: "string" },
        },
        allowPositionals: true,
      });
      const { getInboxView, InboxError } = await import("./views/inbox");
      let data;
      try {
        data = await getInboxView(ibValues.since);
      } catch (err) {
        if (err instanceof InboxError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      if (ibValues.json) {
        console.log(JSON.stringify(data, null, 2));
      } else if (data.groups.length === 0) {
        console.log("No messages.");
      } else {
        const glyph = (t: string) =>
          t === "human" ? "▪" : t === "bot" ? "○" : "—";
        for (let gi = 0; gi < data.groups.length; gi++) {
          const g = data.groups[gi];
          if (gi > 0) console.log("");
          console.log(`${g.date_label} (${g.date_iso})`);
          for (const m of g.messages) {
            const parts = [
              `  ${m.timestamp}`,
              glyph(m.from_type),
              m.from,
            ];
            if (m.kind) parts.push(`[${m.kind}]`);
            parts.push(m.body);
            console.log(parts.join(" "));
            if (m.refs.length > 0) {
              const refStrs = m.refs.map((r) => {
                const bits: string[] = [];
                if (r.session_id) bits.push(`session=${r.session_id}`);
                if (r.task_id) bits.push(`task=${r.task_id}`);
                if (r.cycle_id) bits.push(`cycle=${r.cycle_id}`);
                return bits.join(",");
              });
              console.log(`      refs: ${refStrs.join("; ")}`);
            }
          }
        }
      }
      break;
    }

    // Unreachable — VALID_VIEWS guard above catches unknown names.
    console.error(`Error: view '${viewName}' handler missing`);
    process.exit(1);
  }

  case "message": {
    const sub = args[1];
    if (!sub || sub === "--help" || sub === "help") {
      console.log(
        "Usage: generalstaff message send --from=<str> --body=<str> [options]\n" +
          "\n" +
          "Options:\n" +
          "  --from=<str>         Required. Author identifier (e.g. 'ray', 'generalstaff-bot').\n" +
          "  --body=<str>         Required. Message body (or pass as final positional argument).\n" +
          "  --kind=<str>         Optional. One of: blocker, handoff, fyi, decision.\n" +
          "  --session-id=<id>    Optional. Reference a session id.\n" +
          "  --task-id=<id>       Optional. Reference a task id.\n" +
          "  --cycle-id=<id>      Optional. Reference a cycle id.\n" +
          "  --json               Emit the appended message object as JSON.\n",
      );
      process.exit(0);
    }
    if (sub !== "send") {
      console.error(
        `Error: unknown message subcommand '${sub}'. Valid: send`,
      );
      process.exit(1);
    }

    const { values: mValues, positionals: mPositionals } = parseArgs({
      args: args.slice(2),
      options: {
        from: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" },
        "session-id": { type: "string" },
        "task-id": { type: "string" },
        "cycle-id": { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });

    const from = mValues.from;
    const body =
      mValues.body !== undefined && mValues.body !== ""
        ? mValues.body
        : mPositionals.length > 0
          ? mPositionals.join(" ").trim()
          : undefined;

    if (!from || !body) {
      console.error(
        "Error: message send requires --from=<str> and --body=<str>",
      );
      process.exit(1);
    }

    const VALID_KINDS = ["blocker", "handoff", "fyi", "decision"] as const;
    let kind: string | undefined;
    if (mValues.kind !== undefined) {
      if (!(VALID_KINDS as readonly string[]).includes(mValues.kind)) {
        console.error(
          `Error: invalid --kind '${mValues.kind}'. Valid: ${VALID_KINDS.join(", ")}`,
        );
        process.exit(1);
      }
      kind = mValues.kind;
    }

    const refEntry: Record<string, string> = {};
    if (mValues["session-id"]) refEntry.session_id = mValues["session-id"];
    if (mValues["task-id"]) refEntry.task_id = mValues["task-id"];
    if (mValues["cycle-id"]) refEntry.cycle_id = mValues["cycle-id"];

    const timestamp = new Date().toISOString();
    const extra: Record<string, unknown> = { timestamp };
    if (kind) extra.kind = kind;
    if (Object.keys(refEntry).length > 0) extra.refs = [refEntry];

    await appendFleetMessage(from, body, extra);

    const entry: Record<string, unknown> = {
      timestamp,
      from,
      body,
      ...(kind ? { kind } : {}),
      ...(Object.keys(refEntry).length > 0 ? { refs: [refEntry] } : {}),
    };

    if (mValues.json) {
      console.log(JSON.stringify(entry));
    } else {
      console.log(`Appended message from ${from} at ${timestamp}`);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
