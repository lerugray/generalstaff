import { describe, expect, it } from "bun:test";
import { join } from "path";

async function runHook(mode: string, verdict: string) {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "helpers", "verify_spec_gate_hook.ts")], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SG_MODE: mode, SG_VERDICT: verdict },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
  return JSON.parse(stdout.trim().split("\n").pop()!) as {
    engineer_called: boolean;
    fetch_calls: number;
    final_outcome: string;
    reason: string;
    spec_events: Array<{ event: string; verdict: string }>;
  };
}

describe("spec gate in the cycle (step 3c)", () => {
  it("off: no check, no call, engineer reached", async () => {
    const r = await runHook("off", "OFF-SPEC");
    expect(r.fetch_calls).toBe(0);
    expect(r.spec_events).toEqual([]);
    expect(r.engineer_called).toBe(true);
  }, 60_000);

  it("unset behaves like off", async () => {
    const r = await runHook("none", "OFF-SPEC");
    expect(r.fetch_calls).toBe(0);
    expect(r.spec_events).toEqual([]);
    expect(r.engineer_called).toBe(true);
  }, 60_000);

  it("block: OFF-SPEC skips the cycle before the engineer", async () => {
    const r = await runHook("block", "OFF-SPEC");
    expect(r.engineer_called).toBe(false);
    expect(r.reason).toContain("spec_gate_off_spec");
    expect(r.spec_events).toEqual([{ event: "spec_verdict", verdict: "off-spec" }]);
  }, 60_000);

  it("block: a checker reply that does not parse fails closed", async () => {
    const r = await runHook("block", "BROKEN");
    expect(r.engineer_called).toBe(false);
    expect(r.reason).toContain("spec_gate_error");
  }, 60_000);

  it("block: ON-SPEC proceeds to the engineer", async () => {
    const r = await runHook("block", "ON-SPEC");
    expect(r.engineer_called).toBe(true);
    expect(r.spec_events).toEqual([{ event: "spec_verdict", verdict: "on-spec" }]);
  }, 60_000);

  it("flag: OFF-SPEC is logged and the cycle proceeds", async () => {
    const r = await runHook("flag", "OFF-SPEC");
    expect(r.engineer_called).toBe(true);
    expect(r.spec_events).toEqual([{ event: "spec_verdict", verdict: "off-spec" }]);
  }, 60_000);
});
