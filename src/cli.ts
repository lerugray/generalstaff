#!/usr/bin/env bun

import { parseArgs } from "util";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import { runSession } from "./session";
import { runSingleCycle } from "./cycle";
import { loadFleetState, getProjectSummary, getRootDir } from "./state";
import { loadProjects, loadProjectsYaml, loadDispatcherConfig } from "./projects";
import { isStopFilePresent, createStopFile, removeStopFile } from "./safety";
import { tailProgressLog, loadCycleHistory, printHistoryTable, printHistoryCompact, summarizeCosts } from "./audit";
import { initProject } from "./init";
import { runDoctor } from "./doctor";
import { runClean } from "./clean";
import { loadTasks, pendingTasks, addTask, TasksLoadError } from "./tasks";
import {
  buildFleetSummary,
  computeDiskUsage,
  countTests,
  formatSummary,
} from "./summary";

const VERSION = "0.0.1";

function printUsage() {
  console.log(`generalstaff v${VERSION}

Usage:
  generalstaff session [--budget=<minutes>] [--dry-run]   Run a session (multiple cycles)
    Example: generalstaff session --budget=480          # overnight 8-hour run
    Example: generalstaff session --dry-run             # preview without committing

  generalstaff cycle --project=<id> [--dry-run]           Run one cycle on a project
    Example: generalstaff cycle --project=myapp
    Example: generalstaff cycle --project=myapp --dry-run

  generalstaff status [--json]                            Show fleet state
    Example: generalstaff status
    Example: generalstaff status --json                 # machine-readable output

  generalstaff projects                                   List registered projects
    Example: generalstaff projects

  generalstaff init <path> [--id=<id>]                    Scaffold state dir for a new project
    Example: generalstaff init ./myapp
    Example: generalstaff init ../other-repo --id=other

  generalstaff stop                                       Create STOP file (halt dispatcher)
    Example: generalstaff stop                          # halt before next cycle

  generalstaff start                                      Remove STOP file (allow dispatch)
    Example: generalstaff start                         # resume after a stop

  generalstaff history [--project=<id>] [--lines=<n>] [--format=compact] [--costs]
                       [--since=YYYYMMDD] [--until=YYYYMMDD]
                                                          Cycle history (compact: tab-delimited, no headers)
    Example: generalstaff history --lines=50
    Example: generalstaff history --project=myapp --format=compact
    Example: generalstaff history --format=compact --costs  # add reviewer-invocation + est-token columns
    Example: generalstaff history --since=20260401 --until=20260430  # April 2026 cycles only

  generalstaff log [--project=<id>] [--lines=<n>]         Tail PROGRESS.jsonl
    Example: generalstaff log --project=myapp --lines=50

  generalstaff summary [--no-tests] [--format=json]       Dashboard: cycles, outcomes, duration, tasks, tests
    Example: generalstaff summary                       # one-screen fleet overview
    Example: generalstaff summary --no-tests            # skip scanning tests/ dir
    Example: generalstaff summary --format=json         # machine-readable output

  generalstaff doctor                                     Check prerequisites (bun, git, claude)
    Example: generalstaff doctor
  generalstaff clean [--keep=N] [--log-days=N]            Remove stale worktrees + prune old cycles + rotate logs
    Example: generalstaff clean --keep=10
    Example: generalstaff clean --log-days=7             # delete logs older than 7 days

  generalstaff task list --project=<id>                   Show pending tasks for a project
    Example: generalstaff task list --project=myapp
  generalstaff task add --project=<id> [--priority=N] <title>
                                                          Append a new task to tasks.json
    Example: generalstaff task add --project=myapp "Fix login bug"

  generalstaff digest [--latest] [--date=YYYYMMDD] [--list]
                                                          Print a session digest to stdout, or list all
    Example: generalstaff digest --latest                # most recent digest
    Example: generalstaff digest --date=20260416         # first digest from that day
    Example: generalstaff digest --list                  # enumerate digests, newest first

  generalstaff version                                    Show version + environment info (for bug reports)
    Example: generalstaff version                       # includes bun version, platform, projects.yaml path

  generalstaff config                                     Pretty-print the parsed+validated projects.yaml (with resolved defaults)
    Example: generalstaff config                        # useful for debugging config issues

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
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const budget = parseInt(values.budget!, 10);
    if (isNaN(budget) || budget <= 0) {
      console.error("Error: --budget must be a positive integer (minutes)");
      process.exit(1);
    }
    await runSession({ budgetMinutes: budget, dryRun: values["dry-run"]! });
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
    const { values: statusValues } = parseArgs({
      args: args.slice(1),
      options: {
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const projects = await loadProjects();
    const fleet = await loadFleetState();
    const stopped = await isStopFilePresent();

    if (statusValues.json) {
      const summaries = await Promise.all(
        projects.map((p) => getProjectSummary(p, fleet)),
      );
      const output = { stopped, projects: summaries };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log("=== GeneralStaff Fleet Status ===\n");
      console.log(`STOP file: ${stopped ? "PRESENT (halted)" : "absent (ready)"}`);
      console.log(`Registered projects: ${projects.length}\n`);
      for (const p of projects) {
        const state = fleet.projects[p.id];
        console.log(`  ${p.id} (priority ${p.priority})`);
        if (state) {
          console.log(`    Last cycle: ${state.last_cycle_at ?? "never"}`);
          console.log(`    Last outcome: ${state.last_cycle_outcome ?? "none"}`);
          console.log(`    Total cycles: ${state.total_cycles}`);
        } else {
          console.log(`    No cycles yet`);
        }
      }
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
    await createStopFile();
    console.log("STOP file created. Dispatcher will halt before next cycle.");
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
        lines: { type: "string", default: "20" },
      },
      allowPositionals: false,
    });
    await tailProgressLog(values.project, parseInt(values.lines!, 10));
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
      },
      allowPositionals: false,
    });
    let rows;
    try {
      rows = await loadCycleHistory(
        historyValues.project,
        parseInt(historyValues.lines!, 10),
        { since: historyValues.since, until: historyValues.until },
      );
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(2);
    }
    if (historyValues.format === "compact") {
      if (historyValues.costs) {
        const summary = await summarizeCosts(historyValues.project);
        printHistoryCompact(rows, undefined, summary.by_cycle);
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
      },
      allowPositionals: false,
    });
    const format = summaryValues.format;
    if (format !== undefined && format !== "json") {
      console.error(`Error: unknown --format value: ${format} (supported: json)`);
      process.exit(1);
    }
    const summary = await buildFleetSummary();
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
    await runDoctor();
    break;
  }

  case "clean": {
    const { values: cleanValues } = parseArgs({
      args: args.slice(1),
      options: {
        keep: { type: "string", default: "20" },
        "log-days": { type: "string", default: "30" },
      },
      allowPositionals: false,
    });
    console.log("=== GeneralStaff Clean ===\n");
    await runClean(
      parseInt(cleanValues.keep!, 10),
      parseInt(cleanValues["log-days"]!, 10),
    );
    break;
  }

  case "task": {
    const sub = args[1];
    if (sub === "list") {
      const { values } = parseArgs({
        args: args.slice(2),
        options: { project: { type: "string" } },
        allowPositionals: false,
      });
      if (!values.project) {
        console.error("Error: --project=<id> is required");
        process.exit(1);
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
      const pending = pendingTasks(tasks);
      if (pending.length === 0) {
        console.log("No pending tasks.");
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
        console.error("Error: task title is required\n  Usage: generalstaff task add --project=<id> <title>");
        process.exit(1);
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
        if (err instanceof TasksLoadError) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      console.log(`Added ${task.id}: ${task.title}`);
    } else {
      console.error(
        "Error: task subcommand required (list or add)\n" +
          "  Usage: generalstaff task list --project=<id>\n" +
          "         generalstaff task add --project=<id> <title>",
      );
      process.exit(1);
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
    const dispatcher = await loadDispatcherConfig();
    const digestDir = resolve(getRootDir(), dispatcher.digest_dir);
    const files = existsSync(digestDir)
      ? readdirSync(digestDir)
          .filter((f) => /^digest_\d{8}_\d{6}\.md$/.test(f))
          .sort()
      : [];
    if (digestValues.list) {
      if (files.length === 0) {
        console.log("No digests found.");
        break;
      }
      const sorted = [...files].sort().reverse();
      for (const f of sorted) {
        const content = readFileSync(join(digestDir, f), "utf8");
        const m = f.match(/^digest_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.md$/);
        const date = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : f;
        const cyclesMatch = content.match(/\*\*Cycles:\*\*\s*(\d+)/);
        const cycles = cyclesMatch ? cyclesMatch[1] : "?";
        let verified = 0;
        let failed = 0;
        let skipped = 0;
        for (const om of content.matchAll(/\*\*Outcome:\*\*\s*(\w+)/g)) {
          const o = om[1];
          if (o === "verified" || o === "verified_weak") verified++;
          else if (o === "verification_failed") failed++;
          else if (o === "cycle_skipped") skipped++;
        }
        console.log(
          `${f}  ${date}  cycles=${cycles}  verified=${verified} failed=${failed} skipped=${skipped}`,
        );
      }
      break;
    }
    if (files.length === 0) {
      console.log("No digests found.");
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
        console.log(`No digests found for date ${digestValues.date}.`);
        break;
      }
    } else {
      chosen = files[files.length - 1];
    }
    process.stdout.write(readFileSync(join(digestDir, chosen), "utf8"));
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

  case "init": {
    const { values: initValues, positionals: initPositionals } = parseArgs({
      args: args.slice(1),
      options: {
        id: { type: "string" },
      },
      allowPositionals: true,
    });
    const projectPath = initPositionals[0];
    if (!projectPath) {
      console.error("Error: project path is required\n  Usage: generalstaff init <path> [--id=<id>]");
      process.exit(1);
    }
    const resolvedPath = resolve(projectPath);
    const projectId = initValues.id ?? basename(resolvedPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    await initProject(projectId, resolvedPath);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
