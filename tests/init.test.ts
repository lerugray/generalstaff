import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: string[], cwd?: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    cwd,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("init command", () => {
  const TEST_DIR = join(import.meta.dir, "fixtures", "init_test");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates state/<id>/ with MISSION.md and tasks.json", async () => {
    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);

    const stateDir = join(TEST_DIR, "state", "myproj");
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "MISSION.md"))).toBe(true);
    expect(existsSync(join(stateDir, "tasks.json"))).toBe(true);
  });

  it("MISSION.md contains project id and path", async () => {
    await runCli(["init", "/tmp/my-project", "--id=myproj"], TEST_DIR);

    const mission = readFileSync(
      join(TEST_DIR, "state", "myproj", "MISSION.md"),
      "utf8",
    );
    expect(mission).toContain("# myproj");
    // resolve() produces platform-specific absolute paths
    expect(mission).toContain(resolve("/tmp/my-project"));
    expect(mission).toContain("Bot scope");
  });

  it("tasks.json is seeded with a pending template task at default priority 2", async () => {
    await runCli(["init", "/tmp/my-project", "--id=myproj"], TEST_DIR);

    const tasks = readFileSync(
      join(TEST_DIR, "state", "myproj", "tasks.json"),
      "utf8",
    );
    const parsed = JSON.parse(tasks);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("myproj-001");
    expect(parsed[0].status).toBe("pending");
    expect(parsed[0].priority).toBe(2);
    expect(parsed[0].title).toContain("myproj");
    expect(parsed[0].title).toContain("edit me");
  });

  it("accepts explicit --priority=N and propagates it into the seeded task + YAML snippet", async () => {
    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj", "--priority=3"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("priority: 3");

    const parsed = JSON.parse(
      readFileSync(join(TEST_DIR, "state", "myproj", "tasks.json"), "utf8"),
    );
    expect(parsed[0].priority).toBe(3);
  });

  it("rejects non-positive --priority values", async () => {
    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj", "--priority=0"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });

  it("rejects non-integer --priority values", async () => {
    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj", "--priority=abc"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });

  it("prints a projects.yaml snippet", async () => {
    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj"],
      TEST_DIR,
    );
    expect(result.stdout).toContain("Add this to projects.yaml:");
    expect(result.stdout).toContain("id: myproj");
    expect(result.stdout).toContain(`path: ${resolve("/tmp/my-project")}`);
    expect(result.stdout).toContain("hands_off:");
  });

  it("derives id from path basename when --id is omitted", async () => {
    const result = await runCli(["init", "/tmp/My-Project"], TEST_DIR);
    expect(result.exitCode).toBe(0);

    // Should lowercase and keep hyphens
    expect(existsSync(join(TEST_DIR, "state", "my-project"))).toBe(true);
    expect(result.stdout).toContain("id: my-project");
  });

  it("fails if state dir already exists", async () => {
    // Create the state dir first
    mkdirSync(join(TEST_DIR, "state", "myproj"), { recursive: true });

    const result = await runCli(
      ["init", "/tmp/my-project", "--id=myproj"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("sanitizes special characters in derived project ID", async () => {
    const result = await runCli(["init", "/tmp/My Project @v2!"], TEST_DIR);
    expect(result.exitCode).toBe(0);

    // Special chars replaced with hyphens, lowercased
    const expected = "my-project--v2-";
    expect(existsSync(join(TEST_DIR, "state", expected))).toBe(true);
    expect(result.stdout).toContain(`id: ${expected}`);
  });

  it("does not overwrite existing files when state dir already exists", async () => {
    // First init
    await runCli(["init", "/tmp/my-project", "--id=existing"], TEST_DIR);

    const missionPath = join(TEST_DIR, "state", "existing", "MISSION.md");
    const originalContent = readFileSync(missionPath, "utf8");

    // Second init should fail without touching files
    const result = await runCli(
      ["init", "/tmp/different-path", "--id=existing"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");

    // Original file must be unchanged
    const afterContent = readFileSync(missionPath, "utf8");
    expect(afterContent).toBe(originalContent);
  });

  it("creates parent state directory if it does not exist", async () => {
    // Remove the state dir entirely so mkdirSync must create it
    const stateDir = join(TEST_DIR, "state");
    rmSync(stateDir, { recursive: true, force: true });
    expect(existsSync(stateDir)).toBe(false);

    const result = await runCli(
      ["init", "/tmp/fresh-project", "--id=freshproj"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(stateDir, "freshproj", "MISSION.md"))).toBe(true);
    expect(existsSync(join(stateDir, "freshproj", "tasks.json"))).toBe(true);
  });

  it("fails if no path is provided", async () => {
    const result = await runCli(["init"], TEST_DIR);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("project path is required");
  });

  it("is listed in --help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("init");
  });
});
