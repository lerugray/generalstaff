// gs-313: journal proposal seen-file + accept helpers.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  acceptJournalProposal,
  buildTaskFromProposal,
  bulletTextHash,
  dismissJournalProposal,
  filterUnseenProposals,
  journalProposalsSeenPath,
  loadDismissedProposalIds,
  proposalStableId,
  proposalToTaskTitle,
  saveDismissedProposalIds,
} from "../../../src/integrations/journal/proposals";
import type { JournalProposal } from "../../../src/integrations/journal/types";
import { setRootDir } from "../../../src/state";
import { loadTasks } from "../../../src/tasks";
import type { GreenfieldTask } from "../../../src/types";

const TEST_DIR = join(import.meta.dir, "fixtures", "journal_proposals_test");

function sampleProposal(overrides: Partial<JournalProposal> = {}): JournalProposal {
  return {
    sourcePath: "/tmp/journal/2026-05-02.md",
    lineNumber: 12,
    bulletText: "- [ ] generalstaff wire the CLI",
    kind: "task",
    entryDate: "2026-05-02",
    affinityScore: 2,
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "state", "myproj"), { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  setRootDir(process.cwd());
});

describe("journal proposals seen-file", () => {
  it("round-trips dismissed ids via load/save", async () => {
    const p = sampleProposal();
    const id = proposalStableId(p);
    await saveDismissedProposalIds("myproj", new Set([id]));
    const path = journalProposalsSeenPath("myproj");
    expect(path).toBe(join(TEST_DIR, "state", "myproj", "journal-proposals-seen.json"));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.dismissed).toEqual([id]);
    const loaded = await loadDismissedProposalIds("myproj");
    expect(loaded.has(id)).toBe(true);
  });

  it("stable id changes when bullet text changes", () => {
    const a = sampleProposal({ bulletText: "- [ ] alpha" });
    const b = sampleProposal({ bulletText: "- [ ] beta" });
    expect(proposalStableId(a)).not.toBe(proposalStableId(b));
    expect(bulletTextHash(a.bulletText)).not.toBe(bulletTextHash(b.bulletText));
  });
});

describe("filterUnseenProposals", () => {
  it("drops seen proposals and keeps unseen", () => {
    const seen = sampleProposal({ lineNumber: 1 });
    const unseen = sampleProposal({ lineNumber: 2, bulletText: "- ! alert gs" });
    const dismissed = new Set([proposalStableId(seen)]);
    const out = filterUnseenProposals([seen, unseen], dismissed);
    expect(out).toHaveLength(1);
    expect(out[0]!.lineNumber).toBe(2);
  });
});

describe("buildTaskFromProposal", () => {
  it("produces a well-formed pending task draft", () => {
    const draft = buildTaskFromProposal(sampleProposal());
    expect(draft).toEqual({
      title: "generalstaff wire the CLI",
      status: "pending",
      priority: 2,
    });
    expect(proposalToTaskTitle(sampleProposal({ bulletText: "- ! fix affinity" }))).toBe(
      "fix affinity",
    );
  });
});

describe("acceptJournalProposal", () => {
  it("appends to tasks.json without corrupting existing entries", async () => {
    const seed: GreenfieldTask[] = [
      { id: "gs-001", title: "seeded", status: "done", priority: 1 },
    ];
    writeFileSync(
      join(TEST_DIR, "state", "myproj", "tasks.json"),
      JSON.stringify(seed, null, 2) + "\n",
    );
    const task = await acceptJournalProposal("myproj", sampleProposal());
    expect(task.id).toBe("gs-002");
    expect(task.title).toBe("generalstaff wire the CLI");
    expect(task.status).toBe("pending");

    const stored = await loadTasks("myproj");
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(seed[0]);
    expect(stored[1]!.id).toBe("gs-002");
  });
});

describe("dismissJournalProposal", () => {
  it("records a proposal in the seen-file", async () => {
    const p = sampleProposal();
    await dismissJournalProposal("myproj", p);
    const dismissed = await loadDismissedProposalIds("myproj");
    expect(dismissed.has(proposalStableId(p))).toBe(true);
  });
});
