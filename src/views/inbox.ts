// GeneralStaff — Phase 6 data-contract: inbox view module (gs-225).
//
// Groups fleet-channel messages by local date for the Phase 5 Inbox HTML
// reference. Pure data — no rendering. CLI wiring lives in a later task.

import { readFleetMessagesSince, type FleetMessage } from "../fleet_messages";

export interface InboxRef {
  session_id?: string;
  task_id?: string;
  cycle_id?: string;
}

export type InboxFromType = "bot" | "human" | "system";
export type InboxKind = "blocker" | "handoff" | "fyi" | "decision" | null;

export interface InboxMessage {
  timestamp: string;
  from: string;
  from_type: InboxFromType;
  kind: InboxKind;
  body: string;
  refs: InboxRef[];
}

export interface InboxGroup {
  date_label: string;
  date_iso: string;
  messages: InboxMessage[];
}

export interface InboxData {
  groups: InboxGroup[];
  unread_count: number;
  oldest_shown: string;
  rendered_at: string;
}

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxError";
  }
}

const BOT_FROM_RE = /^(generalstaff|gamr|raybrain|\w+)-bot$/;

function classifyFrom(from: string): InboxFromType {
  if (BOT_FROM_RE.test(from) || from.startsWith("bot:")) return "bot";
  if (from === "dispatcher" || from === "system") return "system";
  return "human";
}

const KIND_SET = new Set<string>(["blocker", "handoff", "fyi", "decision"]);

function classifyKind(raw: unknown): InboxKind {
  if (typeof raw !== "string") return null;
  return KIND_SET.has(raw) ? (raw as InboxKind) : null;
}

function parseRefs(raw: unknown): InboxRef[] {
  if (!Array.isArray(raw)) return [];
  const out: InboxRef[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const o = entry as Record<string, unknown>;
    const ref: InboxRef = {};
    if (typeof o.session_id === "string") ref.session_id = o.session_id;
    if (typeof o.task_id === "string") ref.task_id = o.task_id;
    if (typeof o.cycle_id === "string") ref.cycle_id = o.cycle_id;
    out.push(ref);
  }
  return out;
}

function localDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a: Date, b: Date): number {
  const ms = startOfLocalDay(a).getTime() - startOfLocalDay(b).getTime();
  return Math.round(ms / 86_400_000);
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function dateLabel(dateIso: string, now: Date): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const diff = daysBetween(now, d);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff > 1 && diff < 7) return WEEKDAY_NAMES[d.getDay()];
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function toInboxMessage(msg: FleetMessage): InboxMessage {
  return {
    timestamp: msg.timestamp,
    from: msg.from,
    from_type: classifyFrom(msg.from),
    kind: classifyKind((msg as Record<string, unknown>).kind),
    body: msg.body,
    refs: parseRefs((msg as Record<string, unknown>).refs),
  };
}

function sevenDaysAgoIso(now: Date): string {
  const d = new Date(now.getTime() - 7 * 86_400_000);
  return d.toISOString();
}

export interface GetInboxViewOptions {
  now?: Date;
}

export async function getInboxView(
  since?: string,
  opts: GetInboxViewOptions = {},
): Promise<InboxData> {
  const now = opts.now ?? new Date();
  const effectiveSince = since ?? sevenDaysAgoIso(now);

  if (since !== undefined) {
    const parsed = Date.parse(since);
    if (!Number.isFinite(parsed)) {
      throw new InboxError(`invalid since timestamp: ${since}`);
    }
  }

  const renderedAt = now.toISOString();
  const messages = await readFleetMessagesSince(effectiveSince);

  if (messages.length === 0) {
    return {
      groups: [],
      unread_count: 0,
      oldest_shown: effectiveSince,
      rendered_at: renderedAt,
    };
  }

  const byDate = new Map<string, InboxMessage[]>();
  for (const raw of messages) {
    const key = localDateKey(raw.timestamp);
    const bucket = byDate.get(key);
    const converted = toInboxMessage(raw);
    if (bucket) bucket.push(converted);
    else byDate.set(key, [converted]);
  }

  const groups: InboxGroup[] = [];
  for (const [dateIso, msgs] of byDate) {
    msgs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    groups.push({
      date_label: dateLabel(dateIso, now),
      date_iso: dateIso,
      messages: msgs,
    });
  }
  groups.sort((a, b) => (a.date_iso < b.date_iso ? 1 : -1));

  let oldest = messages[0].timestamp;
  for (const m of messages) {
    if (m.timestamp < oldest) oldest = m.timestamp;
  }

  return {
    groups,
    unread_count: messages.length,
    oldest_shown: oldest,
    rendered_at: renderedAt,
  };
}
