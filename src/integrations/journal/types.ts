// jr-003 / gs-312: journal scan result shapes (library-only; no I/O here).

export type JournalBulletKind = "task" | "alert";

export interface JournalProposal {
  /** Absolute path to the markdown file containing the bullet. */
  sourcePath: string;
  /** 1-based line index in the file. */
  lineNumber: number;
  /** Trimmed full bullet line (including leading `-`). */
  bulletText: string;
  kind: JournalBulletKind;
  /** ISO calendar date YYYY-MM-DD used for the scan window (from filename or file mtime). */
  entryDate: string;
  /** Non-overlapping substring hit counts summed across normalized keywords. */
  affinityScore: number;
}

export interface ScanJournalOptions {
  /** Overrides `project.journal?.scan_days` and the jr-003 default of 7. */
  scanDays?: number;
  /** Clock anchor for the scan window (tests inject a fixed instant). */
  now?: Date;
}
