import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CYCLE_RESULT_SCHEMA_VERSION,
  getCycleResultV1,
  meetsPassCondition,
  patchDigestFromBytes,
  type CycleResultV1,
} from "../src/cycle_result_v1";
import { setRootDir } from "../src/state";

const ROOT = join(import.meta.dir, "..");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "cycle-result-v1");
const SCHEMA_PATH = join(
  ROOT,
  "docs",
  "contracts",
  "cycle-result-v1.schema.json",
);
const CLI_PATH = join(ROOT, "src", "cli.ts");
const ORIGINAL_ROOT = process.cwd();

const FIXTURE_FILES = [
  "passed.json",
  "failed.json",
  "unavailable.json",
  "mismatched-patch.json",
  "stale-uncertain.json",
] as const;

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minLength?: number;
  uniqueItems?: boolean;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
};

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const m = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!m || !root.$defs?.[m[1]]) {
    throw new Error(`unresolved $ref ${schema.$ref}`);
  }
  return root.$defs[m[1]];
}

function typeOk(value: unknown, type: string | string[] | undefined): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === "null") return value === null;
    if (t === "array") return Array.isArray(value);
    if (t === "object") {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    return typeof value === t;
  });
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
): string[] {
  const s = resolveRef(schema, root);
  const errors: string[] = [];
  if (s.const !== undefined && value !== s.const) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (s.enum && !s.enum.includes(value)) {
    errors.push(`${path}: value not in enum`);
  }
  if (!typeOk(value, s.type)) {
    errors.push(`${path}: type mismatch`);
    return errors;
  }
  if (typeof value === "string" && s.minLength !== undefined) {
    if (value.length < s.minLength) errors.push(`${path}: minLength`);
  }
  if (Array.isArray(value) && s.items) {
    if (s.uniqueItems) {
      const seen = new Set(value.map((x) => JSON.stringify(x)));
      if (seen.size !== value.length) errors.push(`${path}: uniqueItems`);
    }
    value.forEach((item, i) => {
      errors.push(
        ...validateAgainstSchema(item, s.items!, root, `${path}[${i}]`),
      );
    });
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    s.properties
  ) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in s.properties)) {
          errors.push(`${path}.${key}: additional property`);
        }
      }
    }
    for (const [key, child] of Object.entries(s.properties)) {
      if (key in obj) {
        errors.push(
          ...validateAgainstSchema(obj[key], child, root, `${path}.${key}`),
        );
      }
    }
  }
  return errors;
}

async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    cwd,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("cycle-result-v1 fixtures", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as JsonSchema;

  for (const file of FIXTURE_FILES) {
    it(`${file} validates against cycle-result-v1.schema.json`, () => {
      const doc = JSON.parse(
        readFileSync(join(FIXTURE_DIR, file), "utf8"),
      ) as unknown;
      const errors = validateAgainstSchema(doc, schema, schema, "$");
      expect(errors).toEqual([]);
    });
  }

  it("passed fixture meets pass condition; failed does not", () => {
    const passed = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "passed.json"), "utf8"),
    ) as CycleResultV1;
    const failed = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "failed.json"), "utf8"),
    ) as CycleResultV1;
    expect(meetsPassCondition(passed)).toBe(true);
    expect(meetsPassCondition(failed)).toBe(false);
  });
});

describe("getCycleResultV1", () => {
  const VIEW_DIR = join(import.meta.dir, "fixtures", "cycle_result_v1_live");
  const PROJECT = "alpha";
  const CYCLE_ID = "20260925129999_live";
  const FLEET_LOG = join(VIEW_DIR, "state", "_fleet", "PROGRESS.jsonl");

  beforeEach(() => {
    rmSync(VIEW_DIR, { recursive: true, force: true });
    mkdirSync(join(VIEW_DIR, "state", PROJECT, "cycles", CYCLE_ID), {
      recursive: true,
    });
    mkdirSync(join(VIEW_DIR, "state", "_fleet"), { recursive: true });
    setRootDir(VIEW_DIR);
  });

  afterEach(() => {
    setRootDir(ORIGINAL_ROOT);
    rmSync(VIEW_DIR, { recursive: true, force: true });
  });

  function writePassedLog(): string {
    const patch = "diff --git a/x.ts b/x.ts\n+export const ok = true;\n";
    writeFileSync(
      join(VIEW_DIR, "state", PROJECT, "cycles", CYCLE_ID, "diff.patch"),
      patch,
    );
    const lines = [
      {
        timestamp: "2026-09-25T12:00:00Z",
        event: "cycle_start",
        cycle_id: CYCLE_ID,
        project_id: PROJECT,
        data: { start_sha: "aaa111", branch: "bot/work" },
      },
      {
        timestamp: "2026-09-25T12:01:00Z",
        event: "verification_outcome",
        cycle_id: CYCLE_ID,
        project_id: PROJECT,
        data: { outcome: "passed" },
      },
      {
        timestamp: "2026-09-25T12:02:00Z",
        event: "reviewer_verdict",
        cycle_id: CYCLE_ID,
        project_id: PROJECT,
        data: { verdict: "verified", reason: "ok" },
      },
      {
        timestamp: "2026-09-25T12:03:00Z",
        event: "cycle_end",
        cycle_id: CYCLE_ID,
        project_id: PROJECT,
        data: {
          outcome: "verified",
          reason: "ok",
          start_sha: "aaa111",
          end_sha: "bbb222",
          verification_outcome: "passed",
          reviewer_verdict: "verified",
        },
      },
    ];
    writeFileSync(
      FLEET_LOG,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return patchDigestFromBytes(patch);
  }

  it("emits passed v1 with digest matching diff.patch", async () => {
    const digest = writePassedLog();
    const doc = await getCycleResultV1(CYCLE_ID, {
      fleetLogPath: FLEET_LOG,
      checkoutPathOverride: "/tmp/alpha",
    });
    expect(doc.schemaVersion).toBe(CYCLE_RESULT_SCHEMA_VERSION);
    expect(doc.state).toBe("passed");
    expect(doc.identity.patchDigest).toBe(digest);
    expect(doc.identity.projectId).toBe(PROJECT);
    expect(doc.identity.branch).toBe("bot/work");
    expect(doc.identity.checkoutPath).toBe("/tmp/alpha");
    expect(doc.receipts.verification.present).toBe(true);
    expect(doc.receipts.reviewer.present).toBe(true);
    expect(meetsPassCondition(doc)).toBe(true);
  });

  it("marks duplicate cycle_end as unavailable", async () => {
    writePassedLog();
    const extra = {
      timestamp: "2026-09-25T12:04:00Z",
      event: "cycle_end",
      cycle_id: CYCLE_ID,
      project_id: PROJECT,
      data: {
        outcome: "verified",
        reason: "second",
        start_sha: "aaa111",
        end_sha: "bbb222",
        verification_outcome: "passed",
        reviewer_verdict: "verified",
      },
    };
    writeFileSync(
      FLEET_LOG,
      readFileSync(FLEET_LOG, "utf8") + JSON.stringify(extra) + "\n",
    );
    const doc = await getCycleResultV1(CYCLE_ID, {
      fleetLogPath: FLEET_LOG,
      checkoutPathOverride: null,
    });
    expect(doc.state).toBe("unavailable");
    expect(doc.unavailableReason).toBe("duplicate_terminal_records");
  });

  it("marks in-progress cycle as running", async () => {
    writeFileSync(
      FLEET_LOG,
      JSON.stringify({
        timestamp: "2026-09-25T12:00:00Z",
        event: "cycle_start",
        cycle_id: CYCLE_ID,
        project_id: PROJECT,
        data: { start_sha: "aaa111", branch: "bot/work" },
      }) + "\n",
    );
    const doc = await getCycleResultV1(CYCLE_ID, {
      fleetLogPath: FLEET_LOG,
      checkoutPathOverride: null,
    });
    expect(doc.state).toBe("running");
    expect(doc.timestamps.endedAt).toBeNull();
  });

  it("marks verification_failed as failed", async () => {
    writeFileSync(
      FLEET_LOG,
      [
        {
          timestamp: "2026-09-25T12:00:00Z",
          event: "cycle_start",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: { start_sha: "aaa", branch: "bot/work" },
        },
        {
          timestamp: "2026-09-25T12:03:00Z",
          event: "cycle_end",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: {
            outcome: "verification_failed",
            reason: "tests failed",
            start_sha: "aaa",
            end_sha: "aaa",
            verification_outcome: "failed",
            reviewer_verdict: "verification_failed",
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const doc = await getCycleResultV1(CYCLE_ID, {
      fleetLogPath: FLEET_LOG,
      checkoutPathOverride: null,
    });
    expect(doc.state).toBe("failed");
    expect(meetsPassCondition(doc)).toBe(false);
  });
});

describe("cycle result CLI", () => {
  const VIEW_DIR = join(import.meta.dir, "fixtures", "cycle_result_cli");
  const PROJECT = "alpha";
  const CYCLE_ID = "20260925128888_cli";
  const PATCH = "diff --git a/x.ts b/x.ts\n+export const ok = true;\n";

  beforeEach(() => {
    rmSync(VIEW_DIR, { recursive: true, force: true });
    mkdirSync(join(VIEW_DIR, "state", PROJECT, "cycles", CYCLE_ID), {
      recursive: true,
    });
    mkdirSync(join(VIEW_DIR, "state", "_fleet"), { recursive: true });
    writeFileSync(
      join(VIEW_DIR, "state", PROJECT, "cycles", CYCLE_ID, "diff.patch"),
      PATCH,
    );
    writeFileSync(
      join(VIEW_DIR, "state", "_fleet", "PROGRESS.jsonl"),
      [
        {
          timestamp: "2026-09-25T12:00:00Z",
          event: "cycle_start",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: { start_sha: "aaa", branch: "bot/work" },
        },
        {
          timestamp: "2026-09-25T12:01:00Z",
          event: "verification_outcome",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: { outcome: "passed" },
        },
        {
          timestamp: "2026-09-25T12:02:00Z",
          event: "reviewer_verdict",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: { verdict: "verified" },
        },
        {
          timestamp: "2026-09-25T12:03:00Z",
          event: "cycle_end",
          cycle_id: CYCLE_ID,
          project_id: PROJECT,
          data: {
            outcome: "verified",
            reason: "ok",
            start_sha: "aaa",
            end_sha: "bbb",
            verification_outcome: "passed",
            reviewer_verdict: "verified",
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
  });

  afterEach(() => {
    rmSync(VIEW_DIR, { recursive: true, force: true });
  });

  it("cycle result --json emits cycle-result/v1", async () => {
    const result = await runCli(
      ["cycle", "result", CYCLE_ID, "--json"],
      VIEW_DIR,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as CycleResultV1;
    expect(parsed.schemaVersion).toBe("cycle-result/v1");
    expect(parsed.cycleId).toBe(CYCLE_ID);
    expect(parsed.state).toBe("passed");
    expect(parsed.identity.patchDigest).toBe(
      "sha256:" + createHash("sha256").update(PATCH).digest("hex"),
    );
  });

  it("cycle result without --json exits 1", async () => {
    const result = await runCli(["cycle", "result", CYCLE_ID], VIEW_DIR);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires --json");
  });

  it("unknown cycle exits 1", async () => {
    const result = await runCli(
      ["cycle", "result", "no-such-cycle", "--json"],
      VIEW_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cycle not found");
  });
});
