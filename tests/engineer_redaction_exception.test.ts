import { describe, expect, it } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const HELPER = join(
  import.meta.dir,
  "helpers",
  "engineer_redaction_exception_isolated.ts",
);

describe("engineer secret redaction failure path", () => {
  it("does not fail the cycle when the secret scanner throws", async () => {
    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn("bun", ["test", HELPER], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        resolve({ exitCode: code, stdout, stderr });
      });
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "secret redaction failed",
    );
    expect(result.stdout + result.stderr).toContain("keep going");
  });
});
