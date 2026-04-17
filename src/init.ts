// GeneralStaff — init command: scaffold state dir for a new project

import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { getRootDir } from "./state";

const MISSION_TEMPLATE = (id: string, path: string) =>
  `# ${id} — Mission (GeneralStaff context)

<!-- Describe what this project is and what the bot should focus on. -->

Project path: ${path}

## Bot scope (what the autonomous bot can work on)

- (fill in)

## Bot scope exclusions (hands-off)

- (fill in — these must match the hands_off list in projects.yaml)

## What GeneralStaff controls

- When to start a cycle (dispatcher picker)
- Whether to chain another cycle (work detection + budget check)
- Whether the cycle's output is verified (verification gate)
- Whether the claimed work matches the diff (Reviewer agent)
- Audit trail of all the above (PROGRESS.jsonl)

## What GeneralStaff does NOT control

- What task the bot picks (per-project protocol)
- How the bot executes (per-project instructions)
- What the bot commits (per-project git workflow)
`;

const YAML_SNIPPET = (id: string, path: string, priority: number) =>
  `  - id: ${id}
    path: ${path}
    priority: ${priority}
    engineer_command: "<TODO>"
    verification_command: "<TODO>"
    cycle_budget_minutes: 45
    work_detection: tasks_json
    concurrency_detection: none
    branch: bot/work
    auto_merge: false
    hands_off:
      - CLAUDE.md
      - "<TODO — add real hands-off patterns>"`;

function templateTaskId(projectId: string): string {
  return `${projectId}-001`;
}

function templateTask(projectId: string, priority: number) {
  return {
    id: templateTaskId(projectId),
    title: `Describe first task for ${projectId} (edit me or run generalstaff task rm)`,
    status: "pending" as const,
    priority,
  };
}

export async function initProject(
  projectId: string,
  projectPath: string,
  options: { priority?: number } = {},
): Promise<void> {
  const priority = options.priority ?? 2;
  const stateDir = join(getRootDir(), "state", projectId);

  if (existsSync(stateDir)) {
    console.error(
      `Error: state/${projectId}/ already exists. Remove it first if you want to re-init.`,
    );
    process.exit(1);
  }

  mkdirSync(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "MISSION.md"),
    MISSION_TEMPLATE(projectId, projectPath),
    "utf8",
  );
  const seeded = [templateTask(projectId, priority)];
  await writeFile(
    join(stateDir, "tasks.json"),
    JSON.stringify(seeded, null, 2) + "\n",
    "utf8",
  );

  console.log(`Created state/${projectId}/`);
  console.log(`  MISSION.md  — edit to describe bot scope`);
  console.log(
    `  tasks.json  — seeded with 1 pending task (${templateTaskId(projectId)}, priority ${priority})\n`,
  );
  console.log(`Add this to projects.yaml:\n`);
  console.log(YAML_SNIPPET(projectId, projectPath, priority));
}
