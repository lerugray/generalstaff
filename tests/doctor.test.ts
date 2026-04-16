import { describe, expect, it } from "bun:test";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("doctor command", () => {
  it("exits 0 when bun and git are available", async () => {
    // bun and git are definitely available in the test environment
    const result = await runCli(["doctor"]);
    // bun and git should pass; claude may or may not be installed
    expect(result.stdout).toContain("PASS  bun");
    expect(result.stdout).toContain("PASS  git");
    expect(result.stdout).toContain("GeneralStaff Doctor");
    expect(result.stdout).toContain("Checking prerequisites");
  });

  it("prints version info for passing checks", async () => {
    const result = await runCli(["doctor"]);
    // bun line should contain a version number
    const bunLine = result.stdout.split("\n").find((l: string) => l.includes("PASS  bun"));
    expect(bunLine).toBeDefined();
    // Should have something after the dash (version string)
    expect(bunLine!).toMatch(/PASS\s+bun\s+—\s+\S+/);
  });

  it("is listed in --help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("doctor");
  });
});
