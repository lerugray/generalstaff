// gs-312 / jr-003: journal affinity scan library tests.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveScanDays,
  scanJournalBulletsByProjectAffinity,
} from "../../../src/integrations/journal/scan";
import type { ProjectConfig } from "../../../src/types";

const FIXED_NOW = new Date(Date.UTC(2026, 4, 4, 12, 0, 0)); // 2026-05-04

function baseProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "generalstaff",
    path: "/Users/dev/GeneralStaff",
    priority: 1,
    engineer_command: "true",
    verification_command: "true",
    cycle_budget_minutes: 10,
    work_detection: "tasks_json",
    concurrency_detection: "worktree",
    branch: "main",
    auto_merge: false,
    hands_off: ["x"],
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `gs-journal-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("scanJournalBulletsByProjectAffinity", () => {
  it("respects the scan window by entry date (dated filenames)", async () => {
    const project = baseProject();
    const inside = join(tmpRoot, "2026-05-02.md");
    const outside = join(tmpRoot, "2026-04-01.md");
    writeFileSync(
      inside,
      `- [ ] generalstaff inside window\n- * observation #generalstaff\n`,
      "utf8",
    );
    writeFileSync(
      outside,
      `- [ ] generalstaff should be excluded by date\n`,
      "utf8",
    );

    const hits = await scanJournalBulletsByProjectAffinity(tmpRoot, project, {
      now: FIXED_NOW,
      scanDays: 7,
    });

    expect(hits.some((h) => h.sourcePath === inside)).toBe(true);
    expect(hits.some((h) => h.sourcePath === outside)).toBe(false);
  });

  it("returns the same ranked list on repeated scans (deterministic)", async () => {
    const project = baseProject({
      journal: {
        mission_bullet_root: "/unused",
        affinity_aliases: ["dispatcher"],
      },
    });
    writeFileSync(
      join(tmpRoot, "2026-05-03.md"),
      [
        "- [ ] dispatcher only",
        "- [ ] generalstaff dispatcher",
        "- ! generalstaff dispatcher generalstaff",
      ].join("\n"),
      "utf8",
    );

    const a = await scanJournalBulletsByProjectAffinity(tmpRoot, project, {
      now: FIXED_NOW,
      scanDays: 14,
    });
    const b = await scanJournalBulletsByProjectAffinity(tmpRoot, project, {
      now: FIXED_NOW,
      scanDays: 14,
    });

    expect(a).toEqual(b);
    expect(a.map((x) => x.affinityScore)).toEqual([3, 2, 1]);
    expect(a[0]!.bulletText).toContain("generalstaff dispatcher generalstaff");
  });

  it("excludes bullets with no project-relevant keywords (and skips * / plain)", async () => {
    const project = baseProject({ id: "onlythisid", path: "/tmp/unrelated-folder-name" });
    writeFileSync(
      join(tmpRoot, "2026-05-04.md"),
      [
        "- [ ] totally unrelated work item",
        "- * onlythisid in observation must be ignored",
        "- onlythisid plain note must be ignored",
        "- [ ] onlythisid real task",
      ].join("\n"),
      "utf8",
    );

    const hits = await scanJournalBulletsByProjectAffinity(tmpRoot, project, {
      now: FIXED_NOW,
      scanDays: 7,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.bulletText).toContain("onlythisid real task");
    expect(hits[0]!.kind).toBe("task");
  });

  it("does not change results when journal.reviewer_context toggles (jr-005 boundary)", async () => {
    const body = "- [ ] generalstaff reviewer flag should not matter\n";
    writeFileSync(join(tmpRoot, "2026-05-04.md"), body, "utf8");

    const off = baseProject({
      journal: {
        mission_bullet_root: "/x",
        reviewer_context: false,
      },
    });
    const on = baseProject({
      journal: {
        mission_bullet_root: "/x",
        reviewer_context: true,
      },
    });

    const a = await scanJournalBulletsByProjectAffinity(tmpRoot, off, {
      now: FIXED_NOW,
    });
    const b = await scanJournalBulletsByProjectAffinity(tmpRoot, on, {
      now: FIXED_NOW,
    });

    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });

  it("matches #tags in addition to line text", async () => {
    const project = baseProject({ id: "myproj", path: "/tmp/x" });
    writeFileSync(
      join(tmpRoot, "2026-05-04.md"),
      "- [ ] ship widgets #myproj\n",
      "utf8",
    );
    const hits = await scanJournalBulletsByProjectAffinity(tmpRoot, project, {
      now: FIXED_NOW,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.affinityScore).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveScanDays", () => {
  it("prefers explicit options over journal.scan_days over default 7", () => {
    const p = baseProject({
      journal: { mission_bullet_root: "/j", scan_days: 14 },
    });
    expect(resolveScanDays(p, { scanDays: 3 })).toBe(3);
    expect(resolveScanDays(p, {})).toBe(14);
    expect(resolveScanDays(baseProject(), {})).toBe(7);
  });
});
