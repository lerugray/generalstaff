// Optional Aides layer. The registry describes contact surfaces, never credentials.
import { existsSync, readFileSync } from "fs";
import { mkdir, open, readFile, rename, unlink } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { getRootDir } from "./state";
import { redactSecrets } from "./secrets";

export type AideDoor =
  | { type: "command"; argv: string[] }
  | { type: "file"; path: string }
  | { type: "http"; url: string; headers: Record<string, string> };

export interface Aide {
  name: string;
  kind: string;
  owner: string;
  description: string;
  door: AideDoor;
  inbox: string;
  capabilities: string[];
  credential_scope: string;
  hard_lines: string[];
}

export interface InboxRow {
  timestamp: string;
  from: string;
  title: string;
  tags: string[];
  body: string[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function scanValues(value: unknown, field: string): void {
  if (typeof value === "string") {
    if (redactSecrets(value).hits.length) {
      throw new Error(`${field} contains a credential-shaped value; use a scope description or environment variable name`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanValues(item, `${field}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) scanValues(item, `${field}.${key}`);
  }
}

function parseDoor(value: unknown, field: string): AideDoor {
  const raw = record(value, field);
  const type = requiredString(raw.type, `${field}.type`);
  if (type === "command") {
    const argv = stringList(raw.argv, `${field}.argv`);
    if (!argv.length) throw new Error(`${field}.argv must contain an executable`);
    return { type, argv };
  }
  if (type === "file") {
    return { type, path: requiredString(raw.path, `${field}.path`) };
  }
  if (type === "http") {
    const url = requiredString(raw.url, `${field}.url`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`${field}.url must be a URL`); }
    if (!(["http:", "https:"].includes(parsed.protocol))) {
      throw new Error(`${field}.url must use http or https`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${field}.url must not contain user info, query parameters, or a fragment`);
    }
    const headers: Record<string, string> = {};
    if (raw.headers !== undefined) {
      for (const [name, envName] of Object.entries(record(raw.headers, `${field}.headers`))) {
        if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`${field}.headers has an invalid header name`);
        const env = requiredString(envName, `${field}.headers.${name}`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
          throw new Error(`${field}.headers.${name} must be an environment variable name`);
        }
        headers[name] = env;
      }
    }
    return { type, url, headers };
  }
  throw new Error(`${field}.type must be command, file, or http`);
}

/** A missing registry means the optional layer is disabled. */
export function loadAides(rootDir = getRootDir()): Aide[] {
  const registryPath = join(rootDir, "aides.yaml");
  if (!existsSync(registryPath)) return [];
  let document: unknown;
  try { document = parseYaml(readFileSync(registryPath, "utf8"), { uniqueKeys: true }); }
  catch (error) { throw new Error(`aides.yaml: ${(error as Error).message}`); }
  const registry = record(document, "aides.yaml");
  if (!Array.isArray(registry.aides)) throw new Error("aides.yaml: aides must be a list");
  scanValues(registry, "aides.yaml");
  const names = new Set<string>();
  return registry.aides.map((item, index) => {
    const field = `aides[${index}]`;
    const raw = record(item, field);
    const name = requiredString(raw.name, `${field}.name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
      throw new Error(`${field}.name must use letters, numbers, spaces, _ or -`);
    }
    if (names.has(name.toLowerCase())) throw new Error(`duplicate Aide name: ${name}`);
    names.add(name.toLowerCase());
    return {
      name,
      kind: requiredString(raw.kind, `${field}.kind`),
      owner: requiredString(raw.owner, `${field}.owner`),
      description: requiredString(raw.description, `${field}.description`),
      door: parseDoor(raw.door, `${field}.door`),
      inbox: requiredString(raw.inbox, `${field}.inbox`),
      capabilities: stringList(raw.capabilities, `${field}.capabilities`),
      credential_scope: requiredString(raw.credential_scope, `${field}.credential_scope`),
      hard_lines: stringList(raw.hard_lines, `${field}.hard_lines`),
    };
  });
}

export function aidePath(rootDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(rootDir, filePath);
}

export function findAide(aides: Aide[], name: string): Aide {
  const aide = aides.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!aide) throw new Error(`Aide not found: ${name}`);
  return aide;
}

function commandAvailable(executable: string, rootDir: string): boolean {
  if (executable.includes("/") || executable.includes("\\")) {
    return existsSync(aidePath(rootDir, executable));
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).some((dir) =>
    ["", ...extensions].some((extension) => existsSync(join(dir, executable + extension))));
}

/** Check the registry and the local contact/archive files without invoking a door. */
export function checkAides(rootDir = getRootDir()): string[] {
  if (!existsSync(join(rootDir, "aides.yaml"))) return ["aides.yaml is missing"];
  const aides = loadAides(rootDir);
  const errors: string[] = [];
  for (const aide of aides) {
    if (!existsSync(aidePath(rootDir, aide.inbox))) errors.push(`${aide.name}: inbox is missing (${aide.inbox})`);
    if (aide.door.type === "file" && !existsSync(aidePath(rootDir, aide.door.path))) {
      errors.push(`${aide.name}: file door is missing (${aide.door.path})`);
    }
    if (aide.door.type === "command" && !commandAvailable(aide.door.argv[0], rootDir)) {
      errors.push(`${aide.name}: command door executable is missing (${aide.door.argv[0]})`);
    }
  }
  return errors;
}

const ROW_HEADING = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z0-9_+:/-]+) ([^:\n]+): (.+)$/;

export function parseInbox(markdown: string): InboxRow[] {
  const rows: InboxRow[] = [];
  let current: InboxRow | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const match = line.match(ROW_HEADING);
      if (!match) throw new Error(`invalid inbox row heading: ${line}`);
      let title = match[3].trim();
      const tags: string[] = [];
      while (/ \[[^\[\]]+\]$/.test(title)) {
        const tag = title.match(/ \[([^\[\]]+)\]$/)!;
        tags.unshift(tag[1]);
        title = title.slice(0, -tag[0].length);
      }
      current = { timestamp: match[1], from: match[2], title, tags, body: [] };
      rows.push(current);
    } else if (current && line.startsWith("- ")) {
      current.body.push(line.slice(2));
    } else if (current && line.trim()) {
      throw new Error(`invalid inbox row body: ${line}`);
    }
  }
  return rows;
}

export function nowInboxTimestamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function singleLine(value: string, field: string): string {
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`${field} must be one non-empty line`);
  return value.trim();
}

export function formatInboxRow(row: InboxRow): string {
  const timestamp = singleLine(row.timestamp, "timestamp");
  const from = singleLine(row.from, "from");
  const title = singleLine(row.title, "title");
  if (!ROW_HEADING.test(`## ${timestamp} ${from}: ${title}`)) throw new Error("invalid inbox row heading fields");
  const tags = row.tags.map((tag) => `[${singleLine(tag, "tag")}]`).join(" ");
  const body = row.body.flatMap((line) => line.split(/\r?\n/)).map((line) => `- ${line}`).join("\n");
  return `## ${timestamp} ${from}: ${title}${tags ? ` ${tags}` : ""}\n${body}${body ? "\n" : ""}\n`;
}

const appendChains = new Map<string, Promise<void>>();

async function atomicReplace(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

/** Serializes read/modify/write per file in this process, then replaces atomically. */
export function appendInboxRow(filePath: string, row: InboxRow): Promise<void> {
  const destination = resolve(filePath);
  const addition = formatInboxRow(row);
  const previous = appendChains.get(destination) ?? Promise.resolve();
  const run = previous.then(async () => {
    let existing = "";
    try { existing = await readFile(destination, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await atomicReplace(destination, existing + separator + addition);
  });
  const settled = run.then(() => undefined, () => undefined);
  appendChains.set(destination, settled);
  void settled.then(() => { if (appendChains.get(destination) === settled) appendChains.delete(destination); });
  return run;
}

export async function readInbox(filePath: string): Promise<InboxRow[]> {
  return parseInbox(await readFile(filePath, "utf8"));
}

export function inboxRowDate(row: InboxRow): number {
  const utc = row.timestamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  if (utc) return Date.parse(`${utc[1]}T${utc[2]}:00Z`);
  return Date.parse(row.timestamp);
}

async function sendThroughDoor(aide: Aide, rootDir: string, text: string): Promise<void> {
  const door = aide.door;
  if (door.type === "file") {
    await appendInboxRow(aidePath(rootDir, door.path), {
      timestamp: nowInboxTimestamp(), from: "GeneralStaff", title: `Request for ${aide.name}`,
      tags: ["request"], body: text.split(/\r?\n/),
    });
    return;
  }
  if (door.type === "command") {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(door.argv[0], door.argv.slice(1), {
        cwd: rootDir, shell: false, stdio: ["pipe", "ignore", "ignore"],
      });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdin.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else reject(new Error(`${aide.name}: command door exited ${code}`));
      });
      child.stdin.end(text);
    });
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [name, envName] of Object.entries(door.headers)) {
    const value = process.env[envName];
    if (!value) throw new Error(`${aide.name}: required environment variable ${envName} is unset`);
    headers[name] = value;
  }
  const response = await fetch(door.url, {
    method: "POST", headers, body: JSON.stringify({ message: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${aide.name}: HTTP door returned ${response.status}`);
}

/** A successful door send is followed by a local outbound audit row. */
export async function sayToAide(aide: Aide, message: string, rootDir = getRootDir()): Promise<void> {
  if (!message.trim()) throw new Error("message must not be empty");
  const inboxPath = aidePath(rootDir, aide.inbox);
  if (!existsSync(inboxPath)) throw new Error(`${aide.name}: inbox is missing (${aide.inbox})`);
  const text = `Operator ${aide.owner} via GeneralStaff:\n${message}`;
  await sendThroughDoor(aide, rootDir, text);
  await appendInboxRow(inboxPath, {
    timestamp: nowInboxTimestamp(), from: "GeneralStaff", title: "Outbound request",
    tags: ["outbound"], body: message.split(/\r?\n/),
  });
}
