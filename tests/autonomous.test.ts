// gs-332: autonomous-mode loop helpers (disposition + model/count resolution)
// and the projects.yaml `autonomous` config validation.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import {
  disposition,
  resolveScoperModel,
  resolveScopeCount,
} from "../src/autonomous_session";
import { DEFAULT_SCOPER_MODEL, DEFAULT_SCOPE_COUNT } from "../src/scope";
import { validateProject, loadProjectsYaml } from "../src/projects";
import type {
  ClassifiedItem,
  ProjectConfig,
  ProjectsYaml,
} from "../src/types";

const item = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  title: "t",
  verdict: "keep",
  ...over,
});

describe("disposition — the dry-run bucketing", () => {
  it("REJECT → dropped", () => {
    expect(disposition(item({ verdict: "reject" }), false)).toBe("dropped");
  });
  it("error / no-class → unclassified", () => {
    expect(disposition(item({ verdict: "error" }), false)).toBe("unclassified");
    expect(disposition(item({ verdict: "keep", class: undefined }), false)).toBe(
      "unclassified",
    );
  });
  it("KEEP + design-fork → design-fork (regardless of live)", () => {
    expect(disposition(item({ class: "design-fork" }), false)).toBe(
      "design-fork",
    );
    expect(disposition(item({ class: "design-fork" }), true)).toBe(
      "design-fork",
    );
  });
  it("KEEP + bot-safe → dispatch-candidate (non-live) / live-held (live)", () => {
    expect(disposition(item({ class: "bot-safe" }), false)).toBe(
      "dispatch-candidate",
    );
    expect(disposition(item({ class: "bot-safe" }), true)).toBe("live-held");
  });
  it("KEEP + no class on a LIVE project → live-held (matches the ledger), not unclassified", () => {
    // The bug this guards: disposition must agree with updateForkLedger's
    // is_decision (keep && live), so the CLI summary and the written ledger
    // never disagree on a keep-with-no-class item on a revenue product.
    expect(disposition(item({ verdict: "keep", class: undefined }), true)).toBe(
      "live-held",
    );
  });
});

describe("resolveScoperModel / resolveScopeCount — precedence", () => {
  const cfg = (over: Partial<ProjectsYaml["dispatcher"]> = {}): ProjectsYaml =>
    ({ projects: [], dispatcher: over }) as unknown as ProjectsYaml;
  const proj = (over: Partial<ProjectConfig> = {}): ProjectConfig =>
    ({ id: "p", ...over }) as ProjectConfig;

  it("project override > fleet default > built-in", () => {
    expect(
      resolveScoperModel(
        proj({ autonomous: { enabled: true, scoper_model: "proj/model" } }),
        cfg({ autonomous: { scoper_model: "fleet/model" } }),
      ),
    ).toBe("proj/model");
    expect(
      resolveScoperModel(
        proj({ autonomous: { enabled: true } }),
        cfg({ autonomous: { scoper_model: "fleet/model" } }),
      ),
    ).toBe("fleet/model");
    expect(resolveScoperModel(proj(), cfg())).toBe(DEFAULT_SCOPER_MODEL);
  });

  it("scope_count precedence falls back to the built-in default", () => {
    expect(
      resolveScopeCount(
        proj({ autonomous: { enabled: true, scope_count: 5 } }),
        cfg(),
      ),
    ).toBe(5);
    expect(resolveScopeCount(proj(), cfg())).toBe(DEFAULT_SCOPE_COUNT);
  });
});

describe("validateProject — autonomous block", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: "ok",
    path: "/tmp/ok",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 30,
    hands_off: ["secret/"],
    ...over,
  });

  it("absent → undefined (zero overhead)", () => {
    expect(validateProject(raw()).autonomous).toBeUndefined();
  });

  it("accepts a full valid block", () => {
    const p = validateProject(
      raw({
        autonomous: {
          enabled: true,
          scoper_model: "qwen/qwen3.6-plus",
          scope_count: 3,
          live: true,
        },
      }),
    );
    expect(p.autonomous).toEqual({
      enabled: true,
      scoper_model: "qwen/qwen3.6-plus",
      scope_count: 3,
      live: true,
    });
  });

  it("requires enabled to be a boolean", () => {
    expect(() => validateProject(raw({ autonomous: {} }))).toThrow(
      /autonomous\.enabled/,
    );
    expect(() =>
      validateProject(raw({ autonomous: { enabled: "yes" } })),
    ).toThrow(/autonomous\.enabled/);
  });

  it("rejects a non-positive scope_count", () => {
    expect(() =>
      validateProject(raw({ autonomous: { enabled: true, scope_count: 0 } })),
    ).toThrow(/scope_count/);
  });

  it("rejects a non-boolean live", () => {
    expect(() =>
      validateProject(raw({ autonomous: { enabled: true, live: "yes" } })),
    ).toThrow(/autonomous\.live/);
  });

  it("rejects a non-object autonomous", () => {
    expect(() => validateProject(raw({ autonomous: [] }))).toThrow(
      /autonomous/,
    );
  });
});

describe("loadProjectsYaml — dispatcher.autonomous (validated in validateDispatcher)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-yaml-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PROJECT_YAML =
    "projects:\n" +
    "  - id: ok\n" +
    "    path: /tmp/ok\n" +
    "    priority: 1\n" +
    "    engineer_command: echo\n" +
    "    verification_command: echo\n" +
    "    cycle_budget_minutes: 30\n" +
    "    hands_off:\n" +
    "      - secret/\n";

  const write = (yaml: string): string => {
    const p = join(dir, "projects.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  it("parses a valid dispatcher.autonomous block onto the dispatcher", async () => {
    const p = write(
      "dispatcher:\n" +
        "  autonomous:\n" +
        "    scoper_model: fleet/model\n" +
        "    scope_count: 3\n" +
        "    dispatch_cap: 2\n" +
        PROJECT_YAML,
    );
    const cfg = await loadProjectsYaml(p);
    expect(cfg.dispatcher.autonomous).toEqual({
      scoper_model: "fleet/model",
      scope_count: 3,
      dispatch_cap: 2,
    });
  });

  it("throws on a non-positive dispatcher.autonomous.scope_count", async () => {
    const p = write(
      "dispatcher:\n" +
        "  autonomous:\n" +
        "    scope_count: 0\n" +
        PROJECT_YAML,
    );
    await expect(loadProjectsYaml(p)).rejects.toThrow(/autonomous\.scope_count/);
  });

  it("leaves dispatcher.autonomous undefined when absent", async () => {
    const cfg = await loadProjectsYaml(write(PROJECT_YAML));
    expect(cfg.dispatcher.autonomous).toBeUndefined();
  });
});
