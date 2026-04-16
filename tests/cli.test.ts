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

describe("CLI", () => {
  describe("--version", () => {
    it("prints the version and exits 0", async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.0.1");
    });

    it("accepts -v shorthand", async () => {
      const result = await runCli(["-v"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.0.1");
    });
  });

  describe("--help", () => {
    it("prints usage and exits 0", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff v0.0.1");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("session");
      expect(result.stdout).toContain("cycle");
      expect(result.stdout).toContain("status");
    });

    it("accepts -h shorthand", async () => {
      const result = await runCli(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("no arguments", () => {
    it("prints usage and exits 0", async () => {
      const result = await runCli([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("unknown command", () => {
    it("prints error and exits 1", async () => {
      const result = await runCli(["bogus"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: bogus");
    });

    it("also prints usage after the error", async () => {
      const result = await runCli(["notacommand"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: notacommand");
      // Usage is printed to stdout after the error
      expect(result.stdout).toContain("Usage:");
    });
  });
});
