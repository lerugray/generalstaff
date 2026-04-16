#!/usr/bin/env bun

import { parseArgs } from "util";
import { runSession } from "./session";
import { runSingleCycle } from "./cycle";
import { loadFleetState } from "./state";
import { loadProjects } from "./projects";
import { isStopFilePresent, createStopFile, removeStopFile } from "./safety";
import { tailProgressLog } from "./audit";

const VERSION = "0.0.1";

function printUsage() {
  console.log(`generalstaff v${VERSION}

Usage:
  generalstaff session [--budget=<minutes>]   Run a session (multiple cycles)
  generalstaff cycle --project=<id>           Run one cycle on a project
  generalstaff status                         Show fleet state
  generalstaff stop                           Create STOP file (halt dispatcher)
  generalstaff start                          Remove STOP file (allow dispatch)
  generalstaff log [--project=<id>]           Tail PROGRESS.jsonl
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
    const projects = await loadProjects();
    const fleet = await loadFleetState();
    console.log("=== GeneralStaff Fleet Status ===\n");
    console.log(`STOP file: ${(await isStopFilePresent()) ? "PRESENT (halted)" : "absent (ready)"}`);
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

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
