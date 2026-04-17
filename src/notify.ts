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

export interface SessionNotificationParams {
  success: boolean;
  budgetMinutes: number;
  durationMinutes: number;
  verified: number;
  failed: number;
  skipped: number;
  /** Human-readable lines for the "What got done" section, already
   *  formatted (e.g. "gs-091: validate task add input"). */
  tasksDone: string[];
  /** Optional log file path for the user to find the full transcript. */
  logPath?: string;
}

interface TelegramCredentials {
  token: string;
  chatId: string;
}

export function loadTelegramCredentials(
  homeDir: string = homedir(),
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
  const header = p.success ? "[OK]" : "[FAIL]";
  const total = p.verified + p.failed + p.skipped;
  const lines: string[] = [
    `${header} GeneralStaff session complete`,
    ``,
    `Duration: ${p.durationMinutes.toFixed(1)} min (budget ${p.budgetMinutes})`,
    `Cycles: ${total} total — ${p.verified} verified, ${p.failed} failed${p.skipped > 0 ? `, ${p.skipped} skipped` : ""}`,
    ``,
  ];
  if (p.tasksDone.length > 0) {
    lines.push("What got done:");
    p.tasksDone.forEach((task, i) => {
      lines.push(`${i + 1}. ${task}`);
    });
    lines.push("");
  }
  if (p.logPath) {
    lines.push(`Log: ${p.logPath}`);
  }
  return lines.join("\n");
}

/** Telegram sendMessage accepts up to 4096 UTF-8 chars. Truncate with
 *  a marker so the user knows to read the digest file for the full cut. */
function truncateForTelegram(text: string, limit = 3900): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + "\n\n[...truncated]";
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
