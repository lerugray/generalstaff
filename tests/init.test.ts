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

  it("tasks.json is an empty array", async () => {
    await runCli(["init", "/tmp/my-project", "--id=myproj"], TEST_DIR);

    const tasks = readFileSync(
      join(TEST_DIR, "state", "myproj", "tasks.json"),
      "utf8",
    );
    expect(JSON.parse(tasks)).toEqual([]);
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
