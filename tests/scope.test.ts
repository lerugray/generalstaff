// gs-332: autonomous-mode SURVEY + SCOPE — the parse + prompt + survey
// digest, against real fixtures.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import {
  survey,
  buildScopePrompt,
  parseScopedItems,
  DEFAULT_SCOPER_MODEL,
} from "../src/scope";
import { setRootDir, getRootDir } from "../src/state";
import type { ProjectConfig, DispatcherConfig } from "../src/types";

describe("parseScopedItems — wintermute-faithful numbered list", () => {
  it("parses a numbered list and extracts the [MECHANICAL]/[DESIGN] tag", () => {
    const text = [
      "1. Add a retry to the upload path [MECHANICAL]",
      "2. Pick the launch hero copy [DESIGN]",
      "3. Wire the webhook receiver",
    ].join("\n");
    const items = parseScopedItems(text);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "Add a retry to the upload path",
      tag: "mechanical",
    });
    expect(items[1]).toEqual({ title: "Pick the launch hero copy", tag: "design" });
    expect(items[2]).toEqual({ title: "Wire the webhook receiver", tag: null });
  });

  it("strips markdown bold around the title", () => {
    const items = parseScopedItems("1. **Bold title** [DESIGN]");
    expect(items[0].title).toBe("Bold title");
    expect(items[0].tag).toBe("design");
  });

  it("strips a leading (a)/(b) enumerator the scoper echoes into the title", () => {
    const items = parseScopedItems(
      "1. (a) Implement the telemetry pipeline [MECHANICAL]\n2. a) Pick the hero copy",
    );
    expect(items[0].title).toBe("Implement the telemetry pipeline");
    expect(items[0].tag).toBe("mechanical");
    expect(items[1].title).toBe("Pick the hero copy");
  });

  it("strips a leading <think> reasoning block", () => {
    const text = "<think>let me consider…</think>\n1. Real item [MECHANICAL]";
    const items = parseScopedItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Real item");
  });

  it("honors the max cap", () => {
    const text = "1. a\n2. b\n3. c\n4. d";
    expect(parseScopedItems(text, 2)).toHaveLength(2);
  });

  it("ignores non-numbered lines", () => {
    const text = "Here are the items:\n1. Only this one\nthanks!";
    const items = parseScopedItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Only this one");
  });
});

describe("buildScopePrompt", () => {
  it("asks for exactly `count` items and includes the digest", () => {
    const p = buildScopePrompt("DIGEST-BODY", 4);
    expect(p).toContain("EXACTLY 4");
    expect(p).toContain("DIGEST-BODY");
    expect(p).toContain("[MECHANICAL]");
    expect(p).toContain("[DESIGN]");
  });
});

describe("survey — real MISSION + git log + tasks digest", () => {
  let root: string;
  let prevRoot: string;
  let repo: string;

  beforeEach(() => {
    prevRoot = getRootDir();
    root = mkdtempSync(join(tmpdir(), "gs-survey-"));
    setRootDir(root);
    // A project repo with one commit.
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) =>
      spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "hi");
    git("add", "-A");
    git("commit", "-q", "-m", "ZZTOPMARKER initial commit");
    // GS-side per-project state.
    const stateDir = join(root, "state", "demo");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "MISSION.md"),
      "# Demo\nUNIQUEMISSIONLINE the purpose.\n",
    );
    writeFileSync(
      join(stateDir, "tasks.json"),
      JSON.stringify({ tasks: [{ title: "QUEUEDTASKMARKER" }] }),
    );
  });

  afterEach(() => {
    setRootDir(prevRoot);
    rmSync(root, { recursive: true, force: true });
  });

  const project = (): ProjectConfig =>
    ({ id: "demo", path: repo }) as ProjectConfig;
  const config = (): DispatcherConfig =>
    ({ state_dir: "./state" }) as DispatcherConfig;

  it("includes MISSION, the shipped commit, and queued tasks", () => {
    const digest = survey(project(), config());
    expect(digest).toContain("### PROJECT: demo");
    expect(digest).toContain("UNIQUEMISSIONLINE");
    expect(digest).toContain("ZZTOPMARKER");
    expect(digest).toContain("QUEUEDTASKMARKER");
  });

  it("degrades gracefully when MISSION + tasks are absent", () => {
    rmSync(join(root, "state", "demo"), { recursive: true, force: true });
    const digest = survey(project(), config());
    expect(digest).toContain("### PROJECT: demo");
    expect(digest).toContain("ZZTOPMARKER"); // git log still there
    expect(digest).not.toContain("UNIQUEMISSIONLINE");
  });
});

describe("DEFAULT_SCOPER_MODEL", () => {
  it("is the real OpenRouter model id the gate uses (not the routing label)", () => {
    expect(DEFAULT_SCOPER_MODEL).toBe("qwen/qwen3.6-plus");
  });
});
