// GeneralStaff — usage-budget integration tests (gs-301a/b/c/d/e).
// Matrix: gs-301a 1,9,10; gs-301b 2,3; gs-301c 4,5; gs-301d 6,7; gs-301e 8,11.
// YAML: tests/usage/fixtures/gs301{a,b,c,d,e}-*.projects.yaml

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
const SUBPROCESS_C = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301c_subprocess.ts",
);
const SUBPROCESS_D = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301d_subprocess.ts",
);
const SUBPROCESS_E = join(
  import.meta.dir,
  "helpers",
  "usage_budget_gs301e_subprocess.ts",
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

async function runScenario301c(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  return runSubprocess(SUBPROCESS_C, id);
}

async function runScenario301d(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  return runSubprocess(SUBPROCESS_D, id);
}

async function runScenario301e(
  id: string,
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
  return runSubprocess(SUBPROCESS_E, id);
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

// YAML: tests/usage/fixtures/gs301c-scenario{4,5}.projects.yaml
describe("usage-budget integration (gs-301c)", () => {
  it("scenario 4: max_tokens hard-stop — same gate as max_usd on token axis", async () => {
    const { exitCode, json } = await runScenario301c("4");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.stop_reason).toBe("usage-budget");
    expect(json.execute_cycle_calls).toBe(1);
    expect(json.exceeded_count).toBe(1);
  });

  it("scenario 5: max_cycles hard-stop — two cycles complete then usage-budget before a third", async () => {
    const { exitCode, json } = await runScenario301c("5");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.stop_reason).toBe("usage-budget");
    expect(json.execute_cycle_calls).toBe(2);
    expect(json.exceeded_count).toBe(1);
  });
});

// YAML: tests/usage/fixtures/gs301d-scenario{6,7}.projects.yaml
describe("usage-budget integration (gs-301d)", () => {
  it("scenario 6: per-project skip-project — proj-a budget binds first, session continues on proj-b", async () => {
    const { exitCode, json } = await runScenario301d("6");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.skipped_count).toBe(1);
    expect(json.exceeded_fleet_count).toBe(0);
    expect(json.execute_cycle_calls).toBe(2);
    expect(json.stop_reason).toBe("max-cycles");
  });

  it("scenario 7: per-project max_usd > fleet max_usd — ProjectValidationError at load", async () => {
    const { exitCode, json } = await runScenario301d("7");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
  });
});

// YAML: tests/usage/fixtures/gs301e-scenario{8,11}.projects.yaml
describe("usage-budget integration (gs-301e)", () => {
  it("scenario 8: max_usd + max_tokens together — ProjectValidationError names both units", async () => {
    const { exitCode, json } = await runScenario301e("8");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
  });

  it("scenario 11: Claude Code 5h-window attribution — fresh / mid-window / post-rollover blocks + budget gate", async () => {
    const { exitCode, json } = await runScenario301e("11");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.cases_passed).toBe(3);
  });
});
