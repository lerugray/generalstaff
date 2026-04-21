import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { readEnv, updateEnv } from "../../../src/integrations/basecamp/env";

const TEST_DIR = join(import.meta.dir, "..", "..", "fixtures", "basecamp_env_test");
const ENV_PATH = join(TEST_DIR, ".env");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readEnv", () => {
  it("returns empty object when file does not exist", () => {
    expect(readEnv(ENV_PATH)).toEqual({});
  });

  it("parses KEY=VALUE lines; ignores comments + blanks", () => {
    writeFileSync(
      ENV_PATH,
      "# comment line\n" +
        "\n" +
        "FOO=bar\n" +
        "BAZ=qux=contains=equals\n" +
        "  # indented comment\n" +
        "  SPACED  =  padded  \n",
    );
    expect(readEnv(ENV_PATH)).toEqual({
      FOO: "bar",
      BAZ: "qux=contains=equals",
      SPACED: "padded",
    });
  });

  it("handles CRLF line endings (Windows)", () => {
    writeFileSync(ENV_PATH, "FOO=bar\r\nBAZ=qux\r\n");
    expect(readEnv(ENV_PATH)).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("updateEnv", () => {
  it("creates the file if absent", () => {
    updateEnv(ENV_PATH, { FOO: "bar" });
    expect(readFileSync(ENV_PATH, "utf-8")).toContain("FOO=bar");
  });

  it("replaces existing keys in-place", () => {
    writeFileSync(
      ENV_PATH,
      "# preamble\nEXISTING=old\nOTHER=keep_me\n",
    );
    updateEnv(ENV_PATH, { EXISTING: "new" });
    const after = readFileSync(ENV_PATH, "utf-8");
    expect(after).toContain("EXISTING=new");
    expect(after).not.toContain("EXISTING=old");
    expect(after).toContain("OTHER=keep_me");
    expect(after).toContain("# preamble");
  });

  it("replaces commented-placeholder lines (# KEY=)", () => {
    writeFileSync(
      ENV_PATH,
      "SOMETHING=kept\n" +
        "# BASECAMP_ACCESS_TOKEN=\n" +
        "# BASECAMP_REFRESH_TOKEN=\n",
    );
    updateEnv(ENV_PATH, {
      BASECAMP_ACCESS_TOKEN: "abc123",
      BASECAMP_REFRESH_TOKEN: "def456",
    });
    const after = readFileSync(ENV_PATH, "utf-8");
    expect(after).toContain("BASECAMP_ACCESS_TOKEN=abc123");
    expect(after).toContain("BASECAMP_REFRESH_TOKEN=def456");
    expect(after).not.toContain("# BASECAMP_ACCESS_TOKEN=");
    expect(after).toContain("SOMETHING=kept");
  });

  it("appends new keys at the end", () => {
    writeFileSync(ENV_PATH, "EXISTING=value\n");
    updateEnv(ENV_PATH, { NEW_KEY: "new_value" });
    const after = readFileSync(ENV_PATH, "utf-8");
    expect(after).toContain("EXISTING=value");
    expect(after).toContain("NEW_KEY=new_value");
  });

  it("does a mixed pass: replace existing, replace commented, append new", () => {
    writeFileSync(
      ENV_PATH,
      "A=1\n# B=\nC=3\n",
    );
    updateEnv(ENV_PATH, { A: "updated", B: "filled", D: "fresh" });
    const after = readFileSync(ENV_PATH, "utf-8");
    expect(after).toContain("A=updated");
    expect(after).toContain("B=filled");
    expect(after).toContain("C=3");
    expect(after).toContain("D=fresh");
    // Ensure we didn't duplicate A or B
    expect((after.match(/^A=/gm) || []).length).toBe(1);
    expect((after.match(/^B=/gm) || []).length).toBe(1);
  });

  it("preserves trailing newline convention", () => {
    writeFileSync(ENV_PATH, "A=1\n");
    updateEnv(ENV_PATH, { B: "2" });
    const after = readFileSync(ENV_PATH, "utf-8");
    expect(after.endsWith("\n")).toBe(true);
  });

  it("round-trip: write then readEnv matches updates", () => {
    updateEnv(ENV_PATH, { FOO: "bar", BAZ: "qux" });
    expect(readEnv(ENV_PATH)).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});
