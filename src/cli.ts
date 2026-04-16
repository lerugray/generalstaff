#!/usr/bin/env bun

import { parseArgs } from "util";
import { basename, resolve } from "path";
import { runSession } from "./session";
import { runSingleCycle } from "./cycle";
import { loadFleetState } from "./state";
import { loadProjects } from "./projects";
import { isStopFilePresent, createStopFile, removeStopFile } from "./safety";
import { tailProgressLog, loadCycleHistory, printHistoryTable, printHistoryCompact } from "./audit";
import { initProject } from "./init";
import { runDoctor } from "./doctor";

const VERSION = "0.0.1";

function printUsage() {
  console.log(`generalstaff v${VERSION}

Usage:
  generalstaff session [--budget=<minutes>]   Run a session (multiple cycles)
  generalstaff cycle --project=<id>           Run one cycle on a project
  generalstaff status [--json]                 Show fleet state
  generalstaff projects                        List registered projects
  generalstaff init <path> [--id=<id>]         Scaffold state dir for a new project
  generalstaff stop                           Create STOP file (halt dispatcher)
  generalstaff start                          Remove STOP file (allow dispatch)
  generalstaff history [--project=<id>] [--lines=<n>] [--format=compact]
                                         Cycle history (compact: tab-delimited, no headers)
  generalstaff log [--project=<id>]           Tail PROGRESS.jsonl
  generalstaff doctor                         Check prerequisites (bun, git, claude)
  generalstaff --version                      Show version
  generalstaff --help                         Show this help`);
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
      },
      allowPositionals: false,
    });
    const rows = await loadCycleHistory(
      historyValues.project,
      parseInt(historyValues.lines!, 10),
    );
    if (historyValues.format === "compact") {
      printHistoryCompact(rows);
    } else {
      printHistoryTable(rows);
    }
    break;
  }

  case "doctor": {
    await runDoctor();
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
