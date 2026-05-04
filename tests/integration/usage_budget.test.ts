// GeneralStaff — usage-budget integration tests (gs-301a).
// Scenarios 1, 9, 10 from docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md test matrix.
// YAML references: tests/usage/fixtures/gs301a-scenario*.projects.yaml

import { describe, expect, it } from "bun:test";
import { join } from "path";

const SUBPROCESS = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301a_subprocess.ts",
);

async function runScenario(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", SUBPROCESS, id], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, "..", ".."),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const last = stdout.trim().split("\n").pop() ?? "{}";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new Error(
      `failed to parse subprocess JSON (exit ${exitCode}). stderr:\n${stderr}\nstdout:\n${stdout}`,
    );
  }
  return { exitCode, json };
}

describe("usage-budget integration (gs-301a)", () => {
  it("scenario 1: no session_budget — additive regression (no fail-open noise)", async () => {
    const { exitCode, json } = await runScenario("1");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(0);
    expect(json.stop_reason).toBe("max-cycles");
  });

  it("scenario 9: openrouter reader unavailable (null factory) — fail-open, session completes", async () => {
    const { exitCode, json } = await runScenario("9");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(1);
    expect(json.stop_reason).toBe("max-cycles");
  });

  it("scenario 10: Claude Code reader missing JSONL (loader throws) — same fail-open path", async () => {
    const { exitCode, json } = await runScenario("10");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(1);
    expect(json.stop_reason).toBe("max-cycles");
  });
});
