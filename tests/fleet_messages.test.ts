import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  appendFleetMessage,
  readFleetMessagesSince,
} from "../src/fleet_messages";
import { setRootDir } from "../src/state";
import { join } from "path";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
} from "fs";

const TEST_DIR = join(import.meta.dir, "fixtures", "fleet_messages_test");
const MSG_PATH = join(TEST_DIR, "state", "_fleet", "messages.jsonl");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("appendFleetMessage", () => {
  it("writes a well-formed JSONL line at state/_fleet/messages.jsonl", async () => {
    await appendFleetMessage("raybrain-bot", "session_end: rayb-006 verified");

    expect(existsSync(MSG_PATH)).toBe(true);
    const lines = readFileSync(MSG_PATH, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.from).toBe("raybrain-bot");
    expect(parsed.body).toBe("session_end: rayb-006 verified");
    expect(typeof parsed.timestamp).toBe("string");
    expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("merges extra fields into the JSONL entry", async () => {
    await appendFleetMessage("gs-dispatcher", "soft-skipped", {
      project: "gamr",
      reason: "hands_off_intersect",
    });

    const entry = JSON.parse(readFileSync(MSG_PATH, "utf8").trim());
    expect(entry.project).toBe("gamr");
    expect(entry.reason).toBe("hands_off_intersect");
    expect(entry.from).toBe("gs-dispatcher");
    expect(entry.body).toBe("soft-skipped");
  });

  it("appends successive messages without clobbering earlier lines", async () => {
    await appendFleetMessage("a", "first");
    await appendFleetMessage("b", "second");
    await appendFleetMessage("c", "third");

    const lines = readFileSync(MSG_PATH, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).body).toBe("first");
    expect(JSON.parse(lines[1]).body).toBe("second");
    expect(JSON.parse(lines[2]).body).toBe("third");
  });
});

describe("readFleetMessagesSince", () => {
  it("returns [] when the file does not exist", async () => {
    const out = await readFleetMessagesSince("2020-01-01T00:00:00.000Z");
    expect(out).toEqual([]);
  });

  it("returns [] when the file is empty", async () => {
    mkdirSync(join(TEST_DIR, "state", "_fleet"), { recursive: true });
    writeFileSync(MSG_PATH, "", "utf8");

    const out = await readFleetMessagesSince("2020-01-01T00:00:00.000Z");
    expect(out).toEqual([]);
  });

  it("filters strictly by timestamp cutoff", async () => {
    mkdirSync(join(TEST_DIR, "state", "_fleet"), { recursive: true });
    const lines = [
      { timestamp: "2026-04-18T10:00:00.000Z", from: "a", body: "older" },
      { timestamp: "2026-04-18T12:00:00.000Z", from: "b", body: "cutoff" },
      { timestamp: "2026-04-18T14:00:00.000Z", from: "c", body: "newer" },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    writeFileSync(MSG_PATH, lines + "\n", "utf8");

    const out = await readFleetMessagesSince("2026-04-18T12:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("newer");
  });

  it("skips malformed lines with a warning and does not crash", async () => {
    mkdirSync(join(TEST_DIR, "state", "_fleet"), { recursive: true });
    const content = [
      JSON.stringify({
        timestamp: "2026-04-18T14:00:00.000Z",
        from: "a",
        body: "good",
      }),
      "{this is not valid json",
      JSON.stringify({ from: "b", body: "missing-timestamp" }),
      JSON.stringify({
        timestamp: "2026-04-18T15:00:00.000Z",
        from: "c",
        body: "also-good",
      }),
    ].join("\n");
    writeFileSync(MSG_PATH, content + "\n", "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const out = await readFleetMessagesSince("2020-01-01T00:00:00.000Z");
      expect(out).toHaveLength(2);
      expect(out.map((m) => m.body)).toEqual(["good", "also-good"]);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
    expect(warnings.some((w) => w.includes("missing required fields"))).toBe(
      true,
    );
  });

  it("skips blank lines without warning", async () => {
    mkdirSync(join(TEST_DIR, "state", "_fleet"), { recursive: true });
    const content =
      JSON.stringify({
        timestamp: "2026-04-18T14:00:00.000Z",
        from: "a",
        body: "x",
      }) + "\n\n\n";
    writeFileSync(MSG_PATH, content, "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const out = await readFleetMessagesSince("2020-01-01T00:00:00.000Z");
      expect(out).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(0);
  });

  it("round-trips appendFleetMessage output through readFleetMessagesSince", async () => {
    const cutoff = new Date(Date.now() - 1000).toISOString();
    await appendFleetMessage("round", "trip-1");
    await appendFleetMessage("round", "trip-2", { project: "p" });

    const out = await readFleetMessagesSince(cutoff);
    expect(out).toHaveLength(2);
    expect(out[0].body).toBe("trip-1");
    expect(out[1].body).toBe("trip-2");
    expect(out[1].project).toBe("p");
  });
});
