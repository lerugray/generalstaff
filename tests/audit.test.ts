import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { appendProgress } from "../src/audit";
import { setRootDir } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";

const TEST_DIR = join(import.meta.dir, "fixtures", "audit_test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("audit writer", () => {
  it("creates PROGRESS.jsonl and appends entries", async () => {
    await appendProgress("test-proj", "cycle_start", {
      start_sha: "abc123",
    }, "cycle-001");

    const filePath = join(TEST_DIR, "state", "test-proj", "PROGRESS.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("cycle_start");
    expect(entry.project_id).toBe("test-proj");
    expect(entry.cycle_id).toBe("cycle-001");
    expect(entry.data.start_sha).toBe("abc123");
    expect(entry.timestamp).toBeTruthy();
  });

  it("appends multiple entries", async () => {
    await appendProgress("proj", "cycle_start", { start_sha: "a" }, "c1");
    await appendProgress("proj", "engineer_invoked", { cmd: "test" }, "c1");
    await appendProgress("proj", "cycle_end", { outcome: "verified" }, "c1");

    const filePath = join(TEST_DIR, "state", "proj", "PROGRESS.jsonl");
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe("cycle_start");
    expect(JSON.parse(lines[1]).event).toBe("engineer_invoked");
    expect(JSON.parse(lines[2]).event).toBe("cycle_end");
  });
});
