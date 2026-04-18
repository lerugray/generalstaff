// GeneralStaff — shared-inbox fleet messages (gs-219)
// Append-only JSONL at <rootDir>/state/_fleet/messages.jsonl. Each session
// writes structured breadcrumbs (status, handoffs, blockers) that other
// sessions can read at startup. Not a human-review substitute — purely a
// lightweight cross-session channel.

import { existsSync, mkdirSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";

export interface FleetMessage {
  timestamp: string;
  from: string;
  body: string;
  [key: string]: unknown;
}

function messagesPath(): string {
  return join(getRootDir(), "state", "_fleet", "messages.jsonl");
}

export async function appendFleetMessage(
  from: string,
  body: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const entry: FleetMessage = {
    timestamp: new Date().toISOString(),
    from,
    body,
    ...(extra ?? {}),
  };

  const filePath = messagesPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}

// Returns messages whose `timestamp` is strictly greater than the supplied
// ISO-8601 cutoff. Missing / empty file returns []. Malformed JSONL lines
// are skipped with a console.warn so a corrupt line doesn't crash the
// session-start log replay.
export async function readFleetMessagesSince(
  timestamp: string,
): Promise<FleetMessage[]> {
  const filePath = messagesPath();
  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, "utf8");
  const out: FleetMessage[] = [];
  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.warn(
        `fleet_messages: skipping malformed line ${lineNumber} in ${filePath}: ${(err as Error).message}`,
      );
      continue;
    }
    if (!isFleetMessage(parsed)) {
      console.warn(
        `fleet_messages: skipping line ${lineNumber} (missing required fields)`,
      );
      continue;
    }
    if (parsed.timestamp > timestamp) {
      out.push(parsed);
    }
  }
  return out;
}

function isFleetMessage(value: unknown): value is FleetMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "string" &&
    typeof v.from === "string" &&
    typeof v.body === "string"
  );
}
