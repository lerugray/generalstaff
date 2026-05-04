// GeneralStaff — usage-budget integration tests (gs-301a, gs-301b).
// Matrix: gs-301a scenarios 1, 9, 10; gs-301b scenarios 2, 3.
// YAML: tests/usage/fixtures/gs301a-*.projects.yaml, gs301b-*.projects.yaml

import { describe, expect, it } from "bun:test";
import { join } from "path";

const SUBPROCESS_A = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301a_subprocess.ts",
);
const SUBPROCESS_B = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301b_subprocess.ts",
);

const REPO_ROOT = join(import.meta.dir, "..", "..");

async function runSubprocess(
  scriptPath: string,
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", scriptPath, id], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO_ROOT,
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

async function runScenario301a(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  return runSubprocess(SUBPROCESS_A, id);
}

async function runScenario301b(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  return runSubprocess(SUBPROCESS_B, id);
}

describe("usage-budget integration (gs-301a)", () => {
  it("scenario 1: no session_budget — additive regression (no fail-open noise)", async () => {
    const { exitCode, json } = await runScenario301a("1");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(0);
    expect(json.stop_reason).toBe("max-cycles");
  });

  it("scenario 9: openrouter reader unavailable (null factory) — fail-open, session completes", async () => {
    const { exitCode, json } = await runScenario301a("9");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(1);
    expect(json.stop_reason).toBe("max-cycles");
  });

  it("scenario 10: Claude Code reader missing JSONL (loader throws) — same fail-open path", async () => {
    const { exitCode, json } = await runScenario301a("10");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.unavailable_count).toBe(1);
    expect(json.stop_reason).toBe("max-cycles");
  });
});

// YAML references: tests/usage/fixtures/gs301b-scenario{2,3}.projects.yaml
describe("usage-budget integration (gs-301b)", () => {
  it("scenario 2: max_usd hard-stop — usage-budget + session_budget_exceeded + consumption on session_complete", async () => {
    const { exitCode, json } = await runScenario301b("2");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.stop_reason).toBe("usage-budget");
    expect(json.execute_cycle_calls).toBe(1);
    expect(json.exceeded_count).toBe(1);
    expect(json.advisory_count).toBe(0);
  });

  it("scenario 3: max_usd advisory — PROGRESS advisory events, max-cycles natural end, consumption above cap in report", async () => {
    const { exitCode, json } = await runScenario301b("3");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.stop_reason).toBe("max-cycles");
    expect(json.execute_cycle_calls).toBe(3);
    expect(json.exceeded_count).toBe(0);
    expect(json.advisory_count).toBeGreaterThanOrEqual(2);
  });
});
