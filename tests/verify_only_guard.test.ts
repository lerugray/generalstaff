// The verify-only path may run the project's verification command and the
// reviewer, and nothing else. Two walls enforce it: the verify modules cannot
// import the agent-dispatching modules (checked here by walking the import
// graph), and a runtime guard refuses those entry points while a check runs.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { buildAdvisorPlan, runAdvisor } from "../src/advisor";
import { executeCycle } from "../src/cycle";
import { runEngineer } from "../src/engineer";
import { runJudgmentGate } from "../src/judgment_gate";
import { runMissionSwarmPreview } from "../src/integrations/mission_swarm/hook";
import {
  assertNotVerifyOnly,
  enterVerifyOnlyMode,
  isVerifyOnlyActive,
  VerifyOnlyGuardError,
  verifyOnlyProjectView,
} from "../src/verify_only/guard";
import { makeDispatcherConfig, makeProjectConfig } from "./helpers/fixtures";

const SRC = join(import.meta.dir, "..", "src");
const VERIFY_DIR = join(SRC, "verify_only");

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) specs.add(m[1]!);
  }
  return [...specs];
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const option of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (existsSync(option) && option.endsWith(".ts")) return option;
  }
  return null;
}

/** Every source file reachable from `roots` through relative imports. */
function reachable(roots: string[]): Map<string, string> {
  const seen = new Map<string, string>(); // file -> first importer
  const queue = [...roots];
  for (const r of roots) seen.set(r, "(root)");
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of importsOf(file)) {
      const target = resolveRelative(file, spec);
      if (target !== null && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("verify-only import graph", () => {
  const roots = readdirSync(VERIFY_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(VERIFY_DIR, f));

  it("has verify modules to check", () => {
    expect(roots.length).toBeGreaterThanOrEqual(8);
  });

  it("cannot reach the engineer, advisor, judgment gate, mission swarm, a full cycle or any bot", () => {
    const graph = reachable(roots);
    const banned = [
      "engineer.ts",
      "active_engineer.ts",
      "advisor.ts",
      "judgment_gate.ts",
      "cycle.ts",
      `${"sess"}ion.ts`,
      "dispatcher.ts",
      "autonomous_session.ts",
      "stop_watcher.ts",
    ].map((f) => join(SRC, f));
    const bannedDirs = [
      join(SRC, "engineer_providers"),
      join(SRC, "integrations"),
      join(SRC, "heartbeat"),
    ];
    for (const file of graph.keys()) {
      expect(banned).not.toContain(file);
      for (const dir of bannedDirs) {
        expect(file.startsWith(`${dir}/`)).toBe(false);
      }
    }
  });

  it("the walk itself works: it does see the reviewer and the state module", () => {
    const graph = reachable(roots);
    expect(graph.has(join(SRC, "reviewer.ts"))).toBe(true);
    expect(graph.has(join(SRC, "state.ts"))).toBe(true);
    // ...and it would notice a forbidden import if one were added.
    const engineerGraph = reachable([join(SRC, "cycle.ts")]);
    expect(engineerGraph.has(join(SRC, "engineer.ts"))).toBe(true);
  });
});

describe("verify-only runtime guard", () => {
  const project = makeProjectConfig({ id: "guarded", path: "/tmp/guarded-nowhere" });
  const dispatcher = makeDispatcherConfig();

  it("is off by default, on inside a check, and off again after", () => {
    expect(isVerifyOnlyActive()).toBe(false);
    expect(() => assertNotVerifyOnly("anything")).not.toThrow();
    const leave = enterVerifyOnlyMode();
    expect(isVerifyOnlyActive()).toBe(true);
    expect(() => assertNotVerifyOnly("anything")).toThrow(VerifyOnlyGuardError);
    leave();
    leave(); // ending twice does not underflow
    expect(isVerifyOnlyActive()).toBe(false);
  });

  it("nested checks keep it on until the last one ends", () => {
    const a = enterVerifyOnlyMode();
    const b = enterVerifyOnlyMode();
    a();
    expect(isVerifyOnlyActive()).toBe(true);
    b();
    expect(isVerifyOnlyActive()).toBe(false);
  });

  it("refuses the engineer, advisor, judgment gate, mission swarm and a full cycle", async () => {
    const leave = enterVerifyOnlyMode();
    try {
      await expect(runEngineer(project, "c1", dispatcher)).rejects.toBeInstanceOf(VerifyOnlyGuardError);
      await expect(
        runAdvisor(buildAdvisorPlan(project, { taskTitle: "t", taskBody: "", handsOff: [], recentCycles: [] }), {
          enabled: true,
        } as never),
      ).rejects.toBeInstanceOf(VerifyOnlyGuardError);
      await expect(runJudgmentGate({ id: "p" }, { id: "t" })).rejects.toBeInstanceOf(VerifyOnlyGuardError);
      await expect(runMissionSwarmPreview({ id: "t", title: "t" } as never, project)).rejects.toBeInstanceOf(
        VerifyOnlyGuardError,
      );
      await expect(executeCycle(project, dispatcher, true)).rejects.toBeInstanceOf(VerifyOnlyGuardError);
    } finally {
      leave();
    }
  });

  it("turns every agent-dispatching field off in the project view, without touching the original", () => {
    const original = makeProjectConfig({
      engineer_command: "touch /tmp/should-never-run",
      engineer_provider: "codex",
      engineer_model: "x",
      judgment_gate: "skip",
      creative_work_allowed: true,
      advisor: { enabled: true, gate: true } as never,
    });
    const view = verifyOnlyProjectView(original);
    expect(view.engineer_command).toBe("");
    expect(view.engineer_provider).toBeUndefined();
    expect(view.advisor).toBeUndefined();
    expect(view.judgment_gate).toBe("off");
    expect(view.missionswarm).toBeUndefined();
    expect(view.creative_work_allowed).toBe(false);
    expect(view.verification_command).toBe(original.verification_command);
    expect(original.engineer_command).toBe("touch /tmp/should-never-run");
    expect(original.judgment_gate).toBe("skip");
  });
});

describe("public vocabulary", () => {
  it("keeps paid-app terms out of the new verify-only sources, tests, fixtures and docs", () => {
    const files = [
      ...readdirSync(VERIFY_DIR).map((f) => join(VERIFY_DIR, f)),
      join(import.meta.dir, "verify_only_cycle.test.ts"),
      join(import.meta.dir, "verify_only_bundle.test.ts"),
      join(import.meta.dir, "verify_only_digest.test.ts"),
      join(import.meta.dir, "verify_only_guard.test.ts"),
      join(import.meta.dir, "verify_only_receipt.test.ts"),
      join(import.meta.dir, "helpers", "verify_only_fixture.ts"),
      join(import.meta.dir, "helpers", "digest_vectors.ts"),
      join(import.meta.dir, "helpers", "json_schema.ts"),
      join(import.meta.dir, "fixtures", "gs-patch-digest-v1", "vectors.json"),
      join(import.meta.dir, "..", "docs", "contracts", "gs-patch-digest-v1.md"),
      join(import.meta.dir, "..", "docs", "contracts", "verify-only-cycle.md"),
    ];
    // Built from pieces so this file does not trip over itself.
    const forbidden = new RegExp(
      `\\b(${["cand" + "idate", "des" + "k", "ord" + "er", "sess" + "ion"].join("|")})s?\\b`,
      "i",
    );
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (file.endsWith("verify_only_guard.test.ts") && line.includes("forbidden")) return;
        if (forbidden.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
