import { describe, expect, it } from "bun:test";
import { join } from "path";
import { $ } from "bun";

describe("executeCycle", () => {
  it("runs verification and reviewer even when engineer exits non-zero", async () => {
    // Run in a subprocess so mock.module calls don't leak into other test files
    const helperPath = join(import.meta.dir, "helpers", "verify_nonzero_engineer_continues.ts");
    const proc = Bun.spawn(["bun", "run", helperPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(
        `Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`,
      );
    }

    // Parse the JSON output for detailed assertions
    const lastLine = stdout.trim().split("\n").pop()!;
    const result = JSON.parse(lastLine);
    expect(result.engineer_exit_code).toBe(1);
    expect(result.verification_called).toBe(true);
    expect(result.reviewer_called).toBe(true);
    expect(result.final_outcome).toBe("verified");
  }, 30_000);
});
