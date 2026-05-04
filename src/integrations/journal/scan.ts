// jr-003 / gs-312: scan mission-bullet-style markdown trees for bullets that
// affinity-match a GeneralStaff project. Library-only — not wired into cycles.

import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { basename, join } from "path";
import type { ProjectConfig } from "../../types";
import type { JournalBulletKind, JournalProposal, ScanJournalOptions } from "./types";

const DEFAULT_SCAN_DAYS = 7;
const DATED_MD = /^(\d{4}-\d{2}-\d{2})\.md$/i;

/** Default scan window: optional override, else journal.scan_days, else 7. */
export function resolveScanDays(
  project: ProjectConfig,
  options?: ScanJournalOptions,
): number {
  return options?.scanDays ?? project.journal?.scan_days ?? DEFAULT_SCAN_DAYS;
}

function dateOnlyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseISODateUtc(ymd: string): Date {
  const [y, m, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function addDaysUtc(ymd: string, deltaDays: number): string {
  const d = parseISODateUtc(ymd);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dateOnlyUTC(d);
}

/** Inclusive lower bound for entry dates: entries strictly before this are out of window. */
function windowStartInclusive(now: Date, scanDays: number): string {
  const today = dateOnlyUTC(now);
  return addDaysUtc(today, -(scanDays - 1));
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function entryDateForFile(absPath: string): Promise<string> {
  const base = basename(absPath);
  const m = base.match(DATED_MD);
  if (m) {
    return m[1]!;
  }
  const s = await stat(absPath);
  return dateOnlyUTC(s.mtime);
}

function buildAffinityKeywords(project: ProjectConfig): string[] {
  const raw = new Set<string>();
  raw.add(project.id.trim().toLowerCase());
  raw.add(basename(project.path).trim().toLowerCase());
  for (const a of project.journal?.affinity_aliases ?? []) {
    const t = a.trim().toLowerCase();
    if (t.length > 0) {
      raw.add(t);
    }
  }
  return [...raw].sort((a, b) => a.localeCompare(b));
}

function extractTagHaystack(line: string): string {
  const tags = [...line.matchAll(/#([\w-]+)/g)].map((x) => x[1]!.toLowerCase());
  return tags.join(" ");
}

function countNonOverlapping(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let i = 0;
  while (i <= haystack.length - needle.length) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) {
      break;
    }
    count += 1;
    i = j + needle.length;
  }
  return count;
}

function affinityScore(line: string, keywordsSorted: string[]): number {
  const text = line.toLowerCase();
  const haystack = `${text} ${extractTagHaystack(line)}`.trim();
  let sum = 0;
  for (const kw of keywordsSorted) {
    sum += countNonOverlapping(haystack, kw);
  }
  return sum;
}

function classifyBullet(trimmedLine: string): JournalBulletKind | null {
  // Observations and plain notes are excluded by gs-312.
  if (/^-\s*\*\s*/.test(trimmedLine)) {
    return null;
  }
  if (/^-\s*\[\s*\]\s*/.test(trimmedLine)) {
    return "task";
  }
  if (/^-\s*!\s*/.test(trimmedLine)) {
    return "alert";
  }
  if (/^-\s/.test(trimmedLine)) {
    return null;
  }
  return null;
}

function compareProposals(a: JournalProposal, b: JournalProposal): number {
  if (b.affinityScore !== a.affinityScore) {
    return b.affinityScore - a.affinityScore;
  }
  const pc = a.sourcePath.localeCompare(b.sourcePath);
  if (pc !== 0) {
    return pc;
  }
  if (a.lineNumber !== b.lineNumber) {
    return a.lineNumber - b.lineNumber;
  }
  return a.bulletText.localeCompare(b.bulletText);
}

/**
 * Recursively reads `*.md` under `journalRoot`, keeps bullets dated within the
 * scan window, and returns open tasks (`- [ ]`) and alerts (`- !`) whose text
 * or `#tags` match project id, repo folder name (`basename(path)`), and optional
 * `journal.affinity_aliases`. Does not read `journal.reviewer_context` (jr-005).
 */
export async function scanJournalBulletsByProjectAffinity(
  journalRoot: string,
  project: ProjectConfig,
  options?: ScanJournalOptions,
): Promise<JournalProposal[]> {
  if (!existsSync(journalRoot)) {
    return [];
  }

  const now = options?.now ?? new Date();
  const scanDays = resolveScanDays(project, options);
  const start = windowStartInclusive(now, scanDays);
  const keywords = buildAffinityKeywords(project);

  const files = await collectMarkdownFiles(journalRoot);
  const proposals: JournalProposal[] = [];

  for (const absPath of files) {
    const entryDate = await entryDateForFile(absPath);
    if (entryDate < start) {
      continue;
    }

    let body: string;
    try {
      body = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const trimmed = rawLine.trimStart();
      const kind = classifyBullet(trimmed);
      if (kind === null) {
        continue;
      }
      const score = affinityScore(rawLine, keywords);
      if (score <= 0) {
        continue;
      }
      proposals.push({
        sourcePath: absPath,
        lineNumber: i + 1,
        bulletText: rawLine.trimEnd(),
        kind,
        entryDate,
        affinityScore: score,
      });
    }
  }

  proposals.sort(compareProposals);
  return proposals;
}
