import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  runBootstrap,
  detectStack,
  scaffoldMinimalRepo,
} from "../src/bootstrap";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "bootstrap_test");

function freshDir(name: string): string {
  const dir = join(FIXTURE_ROOT, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  return dir;
}

beforeEach(() => {
  if (!existsSync(FIXTURE_ROOT)) mkdirSync(FIXTURE_ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("detectStack", () => {
  it("returns unknown for nonexistent dir", () => {
    const dir = freshDir("detect-nonexistent");
    const s = detectStack(dir);
    expect(s.kind).toBe("unknown");
  });

  it("returns unknown for empty dir", () => {
    const dir = freshDir("detect-empty");
    mkdirSync(dir, { recursive: true });
    const s = detectStack(dir);
    expect(s.kind).toBe("unknown");
  });

  it("detects bun-next from package.json with next + @types/bun", () => {
    const dir = freshDir("detect-bunnext");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: { next: "^15.0.0" },
        devDependencies: { "@types/bun": "latest" },
      }),
    );
    expect(detectStack(dir).kind).toBe("bun-next");
  });

  it("detects node-next from package.json with next but no bun types", () => {
    const dir = freshDir("detect-nodenext");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "^15.0.0" } }),
    );
    expect(detectStack(dir).kind).toBe("node-next");
  });

  it("detects rust-cargo from Cargo.toml", () => {
    const dir = freshDir("detect-rust");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
    expect(detectStack(dir).kind).toBe("rust-cargo");
  });

  it("detects python-poetry from pyproject.toml", () => {
    const dir = freshDir("detect-python");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pyproject.toml"), "[tool.poetry]\nname = 'x'\n");
    expect(detectStack(dir).kind).toBe("python-poetry");
  });

  it("detects go-mod from go.mod", () => {
    const dir = freshDir("detect-go");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module x\n");
    expect(detectStack(dir).kind).toBe("go-mod");
  });

  it("explicit stack overrides detection", () => {
    const dir = freshDir("detect-override");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
    expect(detectStack(dir, "bun-next").kind).toBe("bun-next");
  });

  it("includes expected verify + engineer commands per stack", () => {
    expect(detectStack("/nope", "bun-next").verifyCommand).toContain("bun test");
    expect(detectStack("/nope", "bun-next").engineerCommand).toContain("claude -p");
    expect(detectStack("/nope", "rust-cargo").verifyCommand).toContain("cargo test");
    expect(detectStack("/nope", "python-poetry").verifyCommand).toContain("pytest");
    expect(detectStack("/nope", "go-mod").verifyCommand).toContain("go test");
  });
});

describe("scaffoldMinimalRepo", () => {
  it("scaffolds bun-next with package.json, tsconfig, .gitignore, README", () => {
    const dir = freshDir("scaffold-bunnext");
    scaffoldMinimalRepo(dir, "bun-next", "platonic gamer match", "gamr");
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("gamr");
    expect(pkg.dependencies.next).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeDefined();

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("gamr");
    expect(readme).toContain("platonic gamer match");
  });

  it("scaffolds bun-plain without next dep", () => {
    const dir = freshDir("scaffold-bunplain");
    scaffoldMinimalRepo(dir, "bun-plain", "utility library", "util");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("util");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
  });
});

describe("runBootstrap", () => {
  it("rejects empty idea", async () => {
    const dir = freshDir("rb-emptyidea");
    const r = await runBootstrap({ targetDir: dir, idea: "" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Idea is required");
  });

  it("rejects invalid project id", async () => {
    const dir = freshDir("rb-badid");
    const r = await runBootstrap({
      targetDir: dir,
      idea: "thing",
      projectId: "bad id with spaces",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Project id");
  });

  it("rejects empty dir without --stack flag", async () => {
    const dir = freshDir("rb-emptynostack");
    mkdirSync(dir, { recursive: true });
    const r = await runBootstrap({ targetDir: dir, idea: "thing" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Specify --stack");
  });

  it("scaffolds greenfield bun-next + writes full proposal", async () => {
    const dir = freshDir("rb-greenfield");
    const r = await runBootstrap({
      targetDir: dir,
      idea: "Tinder for gamers, strictly platonic",
      stack: "bun-next",
      projectId: "gamr",
    });
    expect(r.ok).toBe(true);
    expect(r.createdScaffold).toBe(true);
    expect(r.detectedStack?.kind).toBe("bun-next");
    expect(r.projectId).toBe("gamr");
    expect(r.proposalPath).toBe(join(dir, ".generalstaff-proposal"));

    // Scaffolded files (live, not in proposal dir)
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);

    // Proposal files
    const pDir = join(dir, ".generalstaff-proposal");
    expect(existsSync(join(pDir, "CLAUDE-AUTONOMOUS.md"))).toBe(true);
    expect(existsSync(join(pDir, "tasks.json"))).toBe(true);
    expect(existsSync(join(pDir, "hands_off.yaml"))).toBe(true);
    expect(existsSync(join(pDir, "verify_command.sh"))).toBe(true);
    expect(existsSync(join(pDir, "engineer_command.sh"))).toBe(true);
    expect(existsSync(join(pDir, "idea.md"))).toBe(true);
    expect(existsSync(join(pDir, "README-PROPOSAL.md"))).toBe(true);

    // Proposal content sanity
    const tasks = JSON.parse(readFileSync(join(pDir, "tasks.json"), "utf8"));
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    for (const t of tasks) {
      expect(t.id).toBeDefined();
      expect(t.title).toBeDefined();
      expect(t.status).toBe("pending");
      expect([1, 2, 3]).toContain(t.priority);
    }

    const claudeMd = readFileSync(join(pDir, "CLAUDE-AUTONOMOUS.md"), "utf8");
    expect(claudeMd).toContain("gamr");
    expect(claudeMd).toContain("Tinder for gamers, strictly platonic");
    expect(claudeMd).toContain("<FILL IN");
    expect(claudeMd).toContain("bot SHOULD NOT");

    const handsOff = readFileSync(join(pDir, "hands_off.yaml"), "utf8");
    expect(handsOff).toContain("node_modules/");
    expect(handsOff).toContain("CLAUDE-AUTONOMOUS.md");
    expect(handsOff).toContain("hands_off.yaml");

    const idea = readFileSync(join(pDir, "idea.md"), "utf8");
    expect(idea).toContain("Tinder for gamers");
  });

  it("does not re-scaffold when dir already has files; writes proposal only", async () => {
    const dir = freshDir("rb-existing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "existing",
        dependencies: { next: "^15.0.0" },
        devDependencies: { "@types/bun": "latest" },
      }),
    );
    const r = await runBootstrap({
      targetDir: dir,
      idea: "test idea",
      projectId: "existing",
    });
    expect(r.ok).toBe(true);
    expect(r.createdScaffold).toBe(false);
    expect(r.detectedStack?.kind).toBe("bun-next");

    // Didn't overwrite existing package.json
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("existing");
  });

  it("refuses to overwrite existing proposal without --force", async () => {
    const dir = freshDir("rb-noforce");
    const r1 = await runBootstrap({
      targetDir: dir,
      idea: "first",
      stack: "bun-next",
      projectId: "thing",
    });
    expect(r1.ok).toBe(true);

    const r2 = await runBootstrap({
      targetDir: dir,
      idea: "second",
      projectId: "thing",
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("--force");
  });

  it("overwrites existing proposal with --force", async () => {
    const dir = freshDir("rb-force");
    const r1 = await runBootstrap({
      targetDir: dir,
      idea: "first idea",
      stack: "bun-next",
      projectId: "thing",
    });
    expect(r1.ok).toBe(true);

    const r2 = await runBootstrap({
      targetDir: dir,
      idea: "second idea",
      projectId: "thing",
      force: true,
    });
    expect(r2.ok).toBe(true);

    const idea = readFileSync(
      join(dir, ".generalstaff-proposal", "idea.md"),
      "utf8",
    );
    expect(idea).toContain("second idea");
  });

  it("defaults project id to basename of targetDir", async () => {
    const dir = freshDir("gamr-xyz");
    const r = await runBootstrap({
      targetDir: dir,
      idea: "a thing",
      stack: "bun-next",
    });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe("gamr-xyz");
  });
});
