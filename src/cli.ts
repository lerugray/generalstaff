#!/usr/bin/env bun

import { parseArgs } from "util";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import { runSession, runSessionChain } from "./session";
import { runSingleCycle, countCommitsAhead } from "./cycle";
import { $ } from "bun";
import { loadFleetState, getProjectSummary, getRootDir } from "./state";
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
import { tailProgressLog, loadCycleHistory, loadCycleHistoryJson, printHistoryTable, printHistoryCompact, summarizeCosts, compileGrepPattern, parseSinceFlag, VALID_OUTCOME_FILTERS, type OutcomeFilter } from "./audit";
import { initProject } from "./init";
import { runDoctor } from "./doctor";
import { runClean } from "./clean";
import {
  loadTasks,
  pendingTasks,
  addTask,
  markTaskDone,
  markTaskPending,
  removeTask,
  countTasks,
  TasksLoadError,
  TaskValidationError,
} from "./tasks";
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
  parseSessionsFlag,
  stripSessionsArgs,
} from "./sessions";
import {
  loadProviderRegistry,
  getProviderById,
  ProviderConfigError,
} from "./providers/registry";
import type { ProviderHealth, ProviderRole } from "./providers/types";

const VERSION = "0.0.1";

function printUsage() {
  console.log(`generalstaff v${VERSION}

Usage:
  generalstaff session [--budget=<minutes>] [--max-cycles=<n>] [--dry-run]
                       [--exclude-project=<id>[,<id>...]] [--verbose] [--chain=<n>]
                                                          Run a session (multiple cycles)
    Example: generalstaff session --budget=480          # overnight 8-hour run
    Example: generalstaff session --max-cycles=5        # stop after 5 cycles
    Example: generalstaff session --dry-run             # preview without committing
    Example: generalstaff session --exclude-project=catalogdna,retrogaze
    Example: generalstaff session --verbose             # stream PROGRESS.jsonl events to stdout
    Example: generalstaff session --chain=3             # run 3 back-to-back sessions with the same options

  generalstaff cycle --project=<id> [--dry-run]           Run one cycle on a project
    Example: generalstaff cycle --project=myapp
    Example: generalstaff cycle --project=myapp --dry-run

  generalstaff status [--json] [--watch[=N]] [--sessions[=N]] [--summary]
                                                          Show fleet state
    Example: generalstaff status
    Example: generalstaff status --json                 # machine-readable output
    Example: generalstaff status --watch                # refresh every 5s until Ctrl-C
    Example: generalstaff status --watch=10             # refresh every 10s
    Example: generalstaff status --sessions             # last 10 sessions as a table
    Example: generalstaff status --sessions=20 --json   # last 20 sessions, JSON
    Example: generalstaff status --summary              # today's cycle/session metrics (UTC)
    Example: generalstaff status --summary --json       # same, as JSON

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

  generalstaff register <project-id> --path=<target-dir> [--priority=N] [--stack=<stack>] [--yes]
                                                          Append a bootstrapped project to projects.yaml (after review)
    Example: generalstaff register gamr --path=../gamr
    Example: generalstaff register gamr --path=../gamr --priority=3 --yes
    Example: generalstaff register raybrain --path=../raybrain --stack=python-uv
    # Reads state/<id>/tasks.json + hands_off.yaml (from project root or .generalstaff-proposal/).
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

  generalstaff doctor [--fix] [--yes]                     Check prerequisites + diagnose resolvable issues
    Example: generalstaff doctor                        # diagnose only
    Example: generalstaff doctor --fix                  # prompt y/N for each fix
    Example: generalstaff doctor --fix --yes            # auto-apply fixes (non-interactive)
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
  generalstaff task count [--project=<id>]                Report pending vs done counts
    Example: generalstaff task count                     # all projects
    Example: generalstaff task count --project=myapp     # single project

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

  generalstaff --version                                  Show version
  generalstaff --help                                     Show this help`);
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  printUsage();
  process.exit(0);
}

const command = args[0];

switch (command) {
  case "session": {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        budget: { type: "string", default: "480" },
        "max-cycles": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "exclude-project": { type: "string" },
        verbose: { type: "boolean", default: false },
        chain: { type: "string" },
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
    let excludeProjects: string[] | undefined;
    if (values["exclude-project"] !== undefined) {
      excludeProjects = values["exclude-project"]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
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
    const sessionOpts = {
      budgetMinutes: budget,
      dryRun: values["dry-run"]!,
      maxCycles,
      excludeProjects,
      verbose: values.verbose!,
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
    const rawStatusArgs = args.slice(1);
    const watch = parseWatchFlag(rawStatusArgs);
    const sessionsFlag = parseSessionsFlag(rawStatusArgs);
    const { values: statusValues } = parseArgs({
      args: stripSessionsArgs(stripWatchArgs(rawStatusArgs)),
      options: {
        json: { type: "boolean", default: false },
        summary: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });

    const renderStatus = async () => {
      if (statusValues.summary) {
        const todaySummary = await buildTodaySessionSummary();
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
        const sessions = await loadRecentSessions(sessionsFlag.limit);
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
      },
      allowPositionals: false,
    });
    await runDoctor({
      fix: Boolean(doctorValues.fix),
      assumeYes: Boolean(doctorValues.yes),
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
      let task;
      try {
        task = await addTask(taskValues.project, title, priority);
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
    } else {
      console.error(
        "Error: task subcommand required (list, add, done, rm, or count)\n" +
          "  Usage: generalstaff task list --project=<id>\n" +
          "         generalstaff task add --project=<id> <title>\n" +
          "         generalstaff task done --project=<id> --task=<task-id>\n" +
          "         generalstaff task rm --project=<id> --task=<task-id>\n" +
          "         generalstaff task count [--project=<id>]",
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
      },
      allowPositionals: true,
    });
    const regProjectId = regPositionals[0];
    if (!regProjectId) {
      console.error(
        "Error: project-id is required\n" +
          "  Usage: generalstaff register <project-id> --path=<target-dir> [--priority=N] [--stack=<stack>] [--yes]",
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

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
