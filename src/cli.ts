#!/usr/bin/env bun

import { parseArgs } from "util";
import { basename, resolve } from "path";
import { runSession } from "./session";
import { runSingleCycle } from "./cycle";
import { loadFleetState } from "./state";
import { loadProjects } from "./projects";
import { isStopFilePresent, createStopFile, removeStopFile } from "./safety";
import { tailProgressLog, loadCycleHistory, printHistoryTable, printHistoryCompact, summarizeCosts } from "./audit";
import { initProject } from "./init";
import { runDoctor } from "./doctor";
import { runClean } from "./clean";
import { loadTasks, pendingTasks, addTask } from "./tasks";
import { buildFleetSummary, countTests, formatSummary } from "./summary";

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
                                                          Cycle history (compact: tab-delimited, no headers)
    Example: generalstaff history --lines=50
    Example: generalstaff history --project=myapp --format=compact
    Example: generalstaff history --format=compact --costs  # add reviewer-invocation + est-token columns

  generalstaff log [--project=<id>] [--lines=<n>]         Tail PROGRESS.jsonl
    Example: generalstaff log --project=myapp --lines=50

  generalstaff summary [--no-tests]                       Dashboard: cycles, outcomes, duration, tasks, tests
    Example: generalstaff summary                       # one-screen fleet overview
    Example: generalstaff summary --no-tests            # skip scanning tests/ dir

  generalstaff doctor                                     Check prerequisites (bun, git, claude)
    Example: generalstaff doctor
  generalstaff clean [--keep=N]                           Remove stale worktrees + prune old cycles
    Example: generalstaff clean --keep=10

  generalstaff task list --project=<id>                   Show pending tasks for a project
    Example: generalstaff task list --project=myapp
  generalstaff task add --project=<id> [--priority=N] <title>
                                                          Append a new task to tasks.json
    Example: generalstaff task add --project=myapp "Fix login bug"

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
      const output = {
        stopped,
        projects: projects.map((p) => ({
          id: p.id,
          priority: p.priority,
          state: fleet.projects[p.id] ?? null,
        })),
      };
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
      },
      allowPositionals: false,
    });
    const rows = await loadCycleHistory(
      historyValues.project,
      parseInt(historyValues.lines!, 10),
    );
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
      },
      allowPositionals: false,
    });
    const summary = await buildFleetSummary();
    const tests = summaryValues["no-tests"]
      ? null
      : countTests(resolve("tests"));
    console.log(formatSummary(summary, tests));
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
      },
      allowPositionals: false,
    });
    console.log("=== GeneralStaff Clean ===\n");
    await runClean(parseInt(cleanValues.keep!, 10));
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
      const tasks = await loadTasks(values.project);
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
      const task = await addTask(taskValues.project, title, priority);
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
