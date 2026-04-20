import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir, getRootDir } from "../src/state";
import { syncProject, syncAllProjects, SyncError } from "../src/sync";

const FIXTURE_DIR = join(tmpdir(), `gs-sync-${process.pid}`);

function writeProjectsYaml(
  projects: Array<{
    id: string;
    path: string;
    hands_off?: string[];
  }>,
): void {
  const yaml = [
    "projects:",
    ...projects.flatMap((p) => [
      `  - id: ${p.id}`,
      `    path: ${p.path.replace(/\\/g, "/")}`,
      `    priority: 1`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: bot/work`,
      `    auto_merge: false`,
      `    hands_off:`,
      ...(p.hands_off ?? ["secret/"]).map((h) => `      - "${h}"`),
    ]),
  ].join("\n");
  writeFileSync(join(FIXTURE_DIR, "projects.yaml"), yaml, "utf8");
}

function mkProjectDir(id: string): string {
  const dir = join(FIXTURE_DIR, `proj-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMission(id: string, content: string): void {
  const dir = join(FIXTURE_DIR, "state", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MISSION.md"), content, "utf8");
}

function writeTasks(id: string, tasks: Array<Record<string, unknown>>): void {
  const dir = join(FIXTURE_DIR, "state", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
}

let originalRoot: string;

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  originalRoot = getRootDir();
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  setRootDir(originalRoot);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("syncProject", () => {
  it("writes .claude/CLAUDE-GS.md with mission, hands_off, and open tasks rendered", async () => {
    const projectDir = mkProjectDir("alpha");
    writeProjectsYaml([
      {
        id: "alpha",
        path: projectDir,
        hands_off: ["CLAUDE.md", "src/secret.ts", "docs/"],
      },
    ]);
    writeMission("alpha", "# alpha mission\n\nShip the thing. No creative work.\n");
    writeTasks("alpha", [
      { id: "a-1", title: "First task", status: "pending", priority: 1 },
      {
        id: "a-2",
        title: "Taste work",
        status: "pending",
        priority: 2,
        interactive_only: true,
      },
      { id: "a-3", title: "Already done", status: "done", priority: 1 },
    ]);

    const result = await syncProject("alpha");
    expect(result.project_id).toBe("alpha");
    expect(result.mission_present).toBe(true);
    expect(result.hands_off_count).toBe(3);
    expect(result.open_tasks).toBe(2); // a-1 + a-2, not a-3
    expect(result.written).toContain(".claude");
    expect(result.written).toContain("CLAUDE-GS.md");

    const written = readFileSync(result.written, "utf8");
    // Mission section present.
    expect(written).toContain("# alpha mission");
    expect(written).toContain("Ship the thing");
    // Hands-off rendered as bullet list with backticks.
    expect(written).toContain("`CLAUDE.md`");
    expect(written).toContain("`src/secret.ts`");
    expect(written).toContain("`docs/`");
    // Open tasks rendered by priority.
    expect(written).toContain("**a-1**");
    expect(written).toContain("**a-2**");
    expect(written).toContain("_(interactive-only)_");
    // Done tasks excluded.
    expect(written).not.toContain("a-3");
    // Hammerstein framing embedded.
    expect(written).toContain("industriousness without judgment");
    // CLI hint present.
    expect(written).toContain("generalstaff task done");
    // GS root reference present.
    expect(written).toContain("state/alpha/PROGRESS.jsonl");
  });

  it("creates .claude directory if it doesn't exist", async () => {
    const projectDir = mkProjectDir("beta");
    writeProjectsYaml([{ id: "beta", path: projectDir }]);
    writeMission("beta", "# beta\n\nScope.\n");
    writeTasks("beta", []);

    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
    const result = await syncProject("beta");
    expect(existsSync(join(projectDir, ".claude"))).toBe(true);
    expect(existsSync(result.written)).toBe(true);
  });

  it("renders helpful placeholder when MISSION.md is missing", async () => {
    const projectDir = mkProjectDir("gamma");
    writeProjectsYaml([{ id: "gamma", path: projectDir }]);
    // no MISSION.md
    writeTasks("gamma", []);

    const result = await syncProject("gamma");
    expect(result.mission_present).toBe(false);

    const written = readFileSync(result.written, "utf8");
    expect(written).toContain("no state/gamma/MISSION.md yet");
  });

  it("renders 'queue empty' placeholder when no open tasks", async () => {
    const projectDir = mkProjectDir("delta");
    writeProjectsYaml([{ id: "delta", path: projectDir }]);
    writeMission("delta", "# delta\n");
    writeTasks("delta", [
      { id: "d-1", title: "Done", status: "done", priority: 1 },
    ]);

    const result = await syncProject("delta");
    expect(result.open_tasks).toBe(0);

    const written = readFileSync(result.written, "utf8");
    expect(written).toContain("queue empty");
    expect(written).toContain("generalstaff task add");
  });

  it("throws SyncError when project is not registered", async () => {
    // Register a real project so projects.yaml parses, then ask for a
    // different id.
    const realDir = mkProjectDir("real");
    writeProjectsYaml([{ id: "real", path: realDir }]);
    await expect(syncProject("nonexistent")).rejects.toThrow(SyncError);
    await expect(syncProject("nonexistent")).rejects.toThrow(
      "project not registered: nonexistent",
    );
  });

  it("throws SyncError when project path does not exist on disk", async () => {
    writeProjectsYaml([
      { id: "missing", path: join(FIXTURE_DIR, "does-not-exist") },
    ]);
    await expect(syncProject("missing")).rejects.toThrow(SyncError);
    await expect(syncProject("missing")).rejects.toThrow(
      "project path does not exist",
    );
  });

  it("sorts open tasks by priority ascending", async () => {
    const projectDir = mkProjectDir("epsilon");
    writeProjectsYaml([{ id: "epsilon", path: projectDir }]);
    writeMission("epsilon", "# eps\n");
    writeTasks("epsilon", [
      { id: "e-3", title: "Low prio", status: "pending", priority: 3 },
      { id: "e-1", title: "High prio", status: "pending", priority: 1 },
      { id: "e-2", title: "Mid prio", status: "pending", priority: 2 },
    ]);

    const result = await syncProject("epsilon");
    const written = readFileSync(result.written, "utf8");
    const idx1 = written.indexOf("**e-1**");
    const idx2 = written.indexOf("**e-2**");
    const idx3 = written.indexOf("**e-3**");
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it("truncates very long task titles with ellipsis", async () => {
    const projectDir = mkProjectDir("zeta");
    writeProjectsYaml([{ id: "zeta", path: projectDir }]);
    writeMission("zeta", "# zeta\n");
    const longTitle = "A".repeat(500);
    writeTasks("zeta", [
      { id: "z-1", title: longTitle, status: "pending", priority: 1 },
    ]);

    const result = await syncProject("zeta");
    const written = readFileSync(result.written, "utf8");
    // Title was truncated with ellipsis.
    expect(written).toContain("…");
    // Full 500-char title not present.
    expect(written).not.toContain("A".repeat(400));
  });
});

describe("syncAllProjects", () => {
  it("syncs every registered project, reports each result", async () => {
    const alphaDir = mkProjectDir("alpha");
    const betaDir = mkProjectDir("beta");
    writeProjectsYaml([
      { id: "alpha", path: alphaDir },
      { id: "beta", path: betaDir },
    ]);
    writeMission("alpha", "# alpha\n");
    writeMission("beta", "# beta\n");
    writeTasks("alpha", []);
    writeTasks("beta", []);

    const results = await syncAllProjects();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project_id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    for (const r of results) {
      expect(r.mission_present).toBe(true);
      expect(existsSync(r.written)).toBe(true);
    }
  });

  it("records partial failure without aborting the whole run", async () => {
    const alphaDir = mkProjectDir("alpha");
    writeProjectsYaml([
      { id: "alpha", path: alphaDir },
      { id: "broken", path: join(FIXTURE_DIR, "never-created") },
    ]);
    writeMission("alpha", "# alpha\n");
    writeTasks("alpha", []);

    const results = await syncAllProjects();
    expect(results).toHaveLength(2);
    const alphaResult = results.find((r) => r.project_id === "alpha");
    const brokenResult = results.find((r) => r.project_id === "broken");
    expect(alphaResult?.written).toContain("CLAUDE-GS.md");
    expect(brokenResult?.written).toContain("(failed:");
    expect(brokenResult?.written).toContain("project path does not exist");
  });
});
