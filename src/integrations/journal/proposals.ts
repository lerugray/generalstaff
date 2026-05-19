// gs-313: journal proposal → task queue surface (seen-file + accept/dismiss).

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { addTask } from "../../tasks";
import type { GreenfieldTask } from "../../types";
import { getRootDir } from "../../state";
import type { JournalProposal } from "./types";

const SEEN_FILE_VERSION = 1;

export interface JournalProposalsSeenFile {
  version: number;
  /** Stable ids from {@link proposalStableId} — dismissed bullets only. */
  dismissed: string[];
}

/**
 * Local dismiss ledger for journal proposals. Lives beside tasks.json under
 * GeneralStaff state — never inside the journal tree (`mission_bullet_root`).
 */
export function journalProposalsSeenPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "journal-proposals-seen.json");
}

/** Short hash of bullet text so an edited journal line is not treated as seen. */
export function bulletTextHash(bulletText: string): string {
  return createHash("sha256").update(bulletText, "utf8").digest("hex").slice(0, 12);
}

export function proposalStableId(proposal: JournalProposal): string {
  return `${proposal.sourcePath}:${proposal.lineNumber}:${bulletTextHash(proposal.bulletText)}`;
}

export async function loadDismissedProposalIds(
  projectId: string,
): Promise<Set<string>> {
  const path = journalProposalsSeenPath(projectId);
  if (!existsSync(path)) {
    return new Set();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`invalid JSON in ${path}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`expected object in ${path}`);
  }
  const dismissed = (raw as JournalProposalsSeenFile).dismissed;
  if (!Array.isArray(dismissed) || dismissed.some((d) => typeof d !== "string")) {
    throw new Error(`expected dismissed: string[] in ${path}`);
  }
  return new Set(dismissed);
}

export async function saveDismissedProposalIds(
  projectId: string,
  dismissed: ReadonlySet<string>,
): Promise<void> {
  const path = journalProposalsSeenPath(projectId);
  const payload: JournalProposalsSeenFile = {
    version: SEEN_FILE_VERSION,
    dismissed: [...dismissed].sort(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function filterUnseenProposals(
  proposals: JournalProposal[],
  dismissed: ReadonlySet<string>,
): JournalProposal[] {
  return proposals.filter((p) => !dismissed.has(proposalStableId(p)));
}

/** Strip mission-bullet markers; the remainder becomes the GS task title. */
export function proposalToTaskTitle(proposal: JournalProposal): string {
  const trimmed = proposal.bulletText.trimStart();
  const withoutCheckbox = trimmed.replace(/^-\s*\[\s*\]\s*/, "");
  const withoutAlert = withoutCheckbox.replace(/^-\s*!\s*/, "");
  return withoutAlert.trim();
}

/** Fields that {@link acceptJournalProposal} passes to {@link addTask}. */
export function buildTaskFromProposal(
  proposal: JournalProposal,
  titleOverride?: string,
): Pick<GreenfieldTask, "title" | "status" | "priority"> {
  const title = (titleOverride ?? proposalToTaskTitle(proposal)).trim();
  return { title, status: "pending", priority: 2 };
}

export async function acceptJournalProposal(
  projectId: string,
  proposal: JournalProposal,
  options: { title?: string; priority?: number } = {},
): Promise<GreenfieldTask> {
  const draft = buildTaskFromProposal(proposal, options.title);
  return addTask(projectId, draft.title, options.priority ?? draft.priority);
}

export async function dismissJournalProposal(
  projectId: string,
  proposal: JournalProposal,
): Promise<void> {
  const dismissed = await loadDismissedProposalIds(projectId);
  dismissed.add(proposalStableId(proposal));
  await saveDismissedProposalIds(projectId, dismissed);
}

export type EditTextFn = (initialText: string) => Promise<string>;

/** Open `initialText` in $EDITOR (vi / notepad fallback) and return trimmed body. */
export async function editTextWithEditor(
  initialText: string,
  editFn?: EditTextFn,
): Promise<string> {
  if (editFn) {
    return (await editFn(initialText)).trim();
  }
  const tmpDir = join(
    tmpdir(),
    `gs-journal-proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, "proposal.txt");
  const seed = initialText.endsWith("\n") ? initialText : `${initialText}\n`;
  writeFileSync(filePath, seed, "utf8");
  const editor =
    process.env.EDITOR?.trim() ||
    (process.platform === "win32" ? "notepad" : "vi");
  const proc = Bun.spawn([editor, filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  let edited: string;
  try {
    if (code !== 0) {
      throw new Error(`editor exited with code ${code}`);
    }
    edited = readFileSync(filePath, "utf8").trim();
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  return edited;
}
