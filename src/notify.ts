// GeneralStaff — end-of-session notification module.
//
// Fires a Telegram message when a session completes so the user knows
// their overnight/background run is done without tailing the log.
//
// Previously lived in scripts/notify_telegram.ps1, invoked from the
// run_session.bat wrapper. That path is unreliable — when the .bat is
// spawned in a detached context (as happens when launched from a
// background shell), post-bun steps don't always execute, and the
// notification never fires. Moving the logic into session.ts so any
// launcher path produces the notification.
//
// The .ps1 script is preserved for manual invocation (e.g. re-sending
// a notification after the fact), but the authoritative send happens
// here now.
//
// Non-fatal in every failure mode: missing credentials, malformed
// config, network errors, and Telegram 4xx/5xx responses all result
// in a silent skip. Notification failure must never fail a session.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Resolve the user's home directory in a way that respects runtime
// changes to HOME / USERPROFILE. Bun's os.homedir() caches its value
// at process startup on POSIX, so tests that set process.env.HOME =
// fixture in beforeEach get back the real homedir from os.homedir()
// instead of the fixture path. Reading the env vars directly keeps
// the tests honest and matches standard Unix HOME-override semantics
// (env wins over passwd lookup) for users who, for example, run with
// a sandboxed HOME pointing at a profile dir.
function getEffectiveHomedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** One verified task, with the project it touched. Caller produces
 *  these from the session's verified-cycle bucket; formatSessionMessage
 *  groups them by project_id so the user can scan what moved on which
 *  project at a glance (gs-303). */
export interface SessionTaskEntry {
  project_id: string;
  /** Already-formatted human-readable line (e.g. "gs-091: validate
   *  task add input"). The project prefix is added at format time. */
  subject: string;
}

/** Per-project cycle count for the "Touched:" breakdown line.
 *  cycles = verified + failed + skipped for that project (gs-303). */
export interface SessionProjectCount {
  project_id: string;
  cycles: number;
}

export interface SessionNotificationParams {
  budgetMinutes: number;
  durationMinutes: number;
  verified: number;
  failed: number;
  skipped: number;
  /** Verified tasks with their project_id, for grouping + prefixing
   *  in the "What got done" section. (gs-303) */
  tasksDone: SessionTaskEntry[];
  /** Per-project total-cycle counts for the "Touched:" line. Empty
   *  array suppresses the line. (gs-303) */
  projectCounts: SessionProjectCount[];
  /** Optional log file path for the user to find the full transcript. */
  logPath?: string;
}

// gs-303: header tag is threshold-based, not all-or-nothing. The old
// "[FAIL] if any cycle failed" rule fired [FAIL] on 11/12 verified
// (91.7%) — Ray flagged this as cryptic on 2026-04-24 because the
// session looked like a wash at first glance when it was actually
// a productive run with one bad cycle. Thresholds match the gs-303
// spec: [OK] >=75%, [PARTIAL] 25-74%, [FAIL] <25%. Skipped cycles
// don't move the ratio (the bot didn't try and fail; it abstained).
function computeHeaderTag(
  verified: number,
  failed: number,
): "[OK]" | "[PARTIAL]" | "[FAIL]" {
  const attempts = verified + failed;
  // Zero attempts (e.g. all skipped) reads as [OK] — nothing failed.
  if (attempts === 0) return "[OK]";
  const ratio = verified / attempts;
  if (ratio >= 0.75) return "[OK]";
  if (ratio >= 0.25) return "[PARTIAL]";
  return "[FAIL]";
}

interface TelegramCredentials {
  token: string;
  chatId: string;
}

export function loadTelegramCredentials(
  homeDir: string = getEffectiveHomedir(),
): TelegramCredentials | null {
  try {
    const mcpPath = join(homeDir, ".claude", ".mcp.json");
    const accessPath = join(homeDir, ".claude", "channels", "telegram", "access.json");
    if (!existsSync(mcpPath) || !existsSync(accessPath)) return null;

    const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers?: Record<string, { env?: { TELEGRAM_BOT_TOKEN?: string } }>;
    };
    const token = mcp?.mcpServers?.["telegram-channel"]?.env?.TELEGRAM_BOT_TOKEN;

    const access = JSON.parse(readFileSync(accessPath, "utf8")) as {
      allowFrom?: Array<string | number>;
    };
    const firstId = access?.allowFrom?.[0];

    if (typeof token !== "string" || token.length === 0) return null;
    if (firstId === undefined || firstId === null) return null;
    const chatId = String(firstId);
    if (chatId.length === 0) return null;

    return { token, chatId };
  } catch {
    return null;
  }
}

export function formatSessionMessage(p: SessionNotificationParams): string {
  const header = computeHeaderTag(p.verified, p.failed);
  const total = p.verified + p.failed + p.skipped;
  const lines: string[] = [
    `${header} GeneralStaff session complete`,
    ``,
  ];

  // gs-303: per-project breakdown right after the header so a glance
  // tells you which projects moved. Empty list (single-project session
  // without per-project data, or zero cycles) suppresses the line.
  if (p.projectCounts.length > 0) {
    const breakdown = p.projectCounts
      .map((pc) => `${pc.project_id} (${pc.cycles})`)
      .join(", ");
    lines.push(`Touched: ${breakdown}`);
  }

  lines.push(
    `Duration: ${p.durationMinutes.toFixed(1)} min (budget ${p.budgetMinutes})`,
  );
  lines.push(
    `Cycles: ${total} total — ${p.verified} verified, ${p.failed} failed${p.skipped > 0 ? `, ${p.skipped} skipped` : ""}`,
  );
  lines.push(``);

  if (p.tasksDone.length > 0) {
    // gs-303: group by project_id (preserve first-seen project order),
    // prefix each bullet with [project_id]. Reading order matches the
    // "Touched:" breakdown order, so the eye can follow the same
    // narrative top-to-bottom.
    const grouped = groupTasksByProject(p.tasksDone);
    lines.push("What got done:");
    let n = 1;
    for (const [projectId, subjects] of grouped) {
      for (const subject of subjects) {
        lines.push(`${n}. [${projectId}] ${subject}`);
        n += 1;
      }
    }
    lines.push("");
  }
  if (p.logPath) {
    lines.push(`Log: ${p.logPath}`);
  }
  return lines.join("\n");
}

// First-seen-project ordering. Map preserves insertion order in JS, so
// iterating the result gives projects in the order they first appear in
// tasksDone — matching the order verified-cycles were appended in
// session.ts (which is by-project for sequential mode, by-completion-time
// for parallel mode).
function groupTasksByProject(
  entries: SessionTaskEntry[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const list = groups.get(e.project_id);
    if (list) list.push(e.subject);
    else groups.set(e.project_id, [e.subject]);
  }
  return groups;
}

/** Telegram sendMessage accepts up to 4096 UTF-8 chars. Truncate with
 *  a marker so the user knows to read the digest file for the full cut. */
export function truncateForTelegram(text: string, limit = 3900): string {
  if (text.length <= limit) return text;
  let cut = limit - 20;
  // Avoid splitting a UTF-16 surrogate pair. A high surrogate (0xD800-
  // 0xDBFF) at the final slice index would be separated from its
  // trailing low surrogate, producing a lone surrogate that serializes
  // to invalid UTF-8 bytes when the message is POSTed as JSON.
  const lastCode = text.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + "\n\n[...truncated]";
}

/** Sends a single message via the Telegram Bot API. Returns void —
 *  errors are silently swallowed (non-fatal). The caller should not
 *  condition session success on this function's behavior. */
export async function sendTelegramMessage(
  creds: TelegramCredentials,
  text: string,
): Promise<void> {
  try {
    const body = truncateForTelegram(text);
    await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: creds.chatId, text: body }),
    });
  } catch {
    // Non-fatal. A missing notification is less bad than a crashed session.
  }
}

/** Top-level entry point called by runSession at the end of a session.
 *  Loads credentials, formats the message, fires the send. Every step
 *  guards against failure so this can never crash the session. The
 *  optional loader hook lets tests inject fixture credentials without
 *  touching the real ~/.claude directory. */
export async function notifySessionEnd(
  params: SessionNotificationParams,
  deps: { loader?: () => TelegramCredentials | null } = {},
): Promise<void> {
  const loader = deps.loader ?? (() => loadTelegramCredentials());
  const creds = loader();
  if (!creds) return;

  const message = formatSessionMessage(params);
  await sendTelegramMessage(creds, message);
}
