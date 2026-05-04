// gs-291: structured task-claim line for engineer stdout. The session
// loop parses this so cycle_end can record attempted_task_id for
// retrospective analysis (empty-diff correlation, gs-290 exclusion).

/** Machine-parseable prefix; must stay stable for downstream grep + parsers. */
export const GENERALSTAFF_TASK_CLAIM_PREFIX =
  "GENERALSTAFF_TASK_CLAIM_JSON:" as const;

/**
 * Scan captured engineer stdout for claim lines. If multiple lines match,
 * the last wins (model may re-print after changing its mind).
 */
export function parseTaskClaimFromEngineerStdout(
  stdout: string,
): string | undefined {
  const prefix = GENERALSTAFF_TASK_CLAIM_PREFIX;
  let last: string | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const jsonPart = line.slice(prefix.length).trim();
    try {
      const o = JSON.parse(jsonPart) as { attempted_task_id?: unknown };
      if (
        typeof o.attempted_task_id === "string" &&
        o.attempted_task_id.length > 0
      ) {
        last = o.attempted_task_id;
      }
    } catch {
      // ignore malformed JSON on this line
    }
  }
  return last;
}

/**
 * Instructions appended to generated engineer prompts (aider). Per-project
 * claude engineer_command.sh should mirror this contract when tasks_json
 * mode is used — see GENERALSTAFF_PEEKED_TASK_ID in runEngineer env.
 */
export function engineerTaskClaimPromptSection(): string {
  return `## Task claim signal (gs-291 — required for audit)
After you decide which task id you will implement this cycle, print exactly
one line to **stdout** (plain text, not inside a markdown fence), before
heavy tool output if possible:

${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"<task-id>"}

Replace \`<task-id>\` with the real id from tasks.json (e.g. \`"gs-123"\`).
If you revise your choice, print an updated line — the **last** line wins.
The dispatcher reads this for PROGRESS.jsonl correlation; omitting it
weakens session analytics.`;
}
