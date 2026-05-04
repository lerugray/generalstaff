import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  formatSessionMessage,
  loadTelegramCredentials,
  notifySessionEnd,
  sendTelegramMessage,
  truncateForTelegram,
  type SessionNotificationParams,
} from "../src/notify";

const TEST_HOME = join(import.meta.dir, "fixtures", "notify_home");

function writeCredentials(token: string | null, chatId: string | number | null): void {
  const claudeDir = join(TEST_HOME, ".claude");
  const channelsDir = join(claudeDir, "channels", "telegram");
  mkdirSync(channelsDir, { recursive: true });

  if (token !== null) {
    writeFileSync(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "telegram-channel": { env: { TELEGRAM_BOT_TOKEN: token } },
        },
      }),
    );
  }
  if (chatId !== null) {
    writeFileSync(
      join(channelsDir, "access.json"),
      JSON.stringify({ allowFrom: [chatId] }),
    );
  }
}

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("loadTelegramCredentials", () => {
  it("returns credentials when both files are present and valid", () => {
    writeCredentials("bot-token-abc", "123456789");
    const result = loadTelegramCredentials(TEST_HOME);
    expect(result).toEqual({ token: "bot-token-abc", chatId: "123456789" });
  });

  it("coerces numeric chat_id to string", () => {
    writeCredentials("tok", 987654321);
    const result = loadTelegramCredentials(TEST_HOME);
    expect(result?.chatId).toBe("987654321");
  });

  it("returns null when .mcp.json is missing", () => {
    writeCredentials(null, "123");
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });

  it("returns null when access.json is missing", () => {
    writeCredentials("tok", null);
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });

  it("returns null when token is empty string", () => {
    writeCredentials("", "123");
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });

  it("returns null when allowFrom is empty array", () => {
    const claudeDir = join(TEST_HOME, ".claude");
    const channelsDir = join(claudeDir, "channels", "telegram");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "telegram-channel": { env: { TELEGRAM_BOT_TOKEN: "tok" } } } }),
    );
    writeFileSync(join(channelsDir, "access.json"), JSON.stringify({ allowFrom: [] }));
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });

  it("returns null when .mcp.json is malformed JSON", () => {
    const claudeDir = join(TEST_HOME, ".claude");
    const channelsDir = join(claudeDir, "channels", "telegram");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(claudeDir, ".mcp.json"), "{ not valid json");
    writeFileSync(join(channelsDir, "access.json"), JSON.stringify({ allowFrom: ["123"] }));
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });

  it("returns null when the telegram-channel server entry is absent", () => {
    const claudeDir = join(TEST_HOME, ".claude");
    const channelsDir = join(claudeDir, "channels", "telegram");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "some-other-server": { env: {} } } }),
    );
    writeFileSync(join(channelsDir, "access.json"), JSON.stringify({ allowFrom: ["123"] }));
    expect(loadTelegramCredentials(TEST_HOME)).toBeNull();
  });
});

describe("formatSessionMessage", () => {
  function makeParams(
    overrides: Partial<SessionNotificationParams> = {},
  ): SessionNotificationParams {
    return {
      budgetMinutes: 90,
      durationMinutes: 44.0,
      verified: 9,
      failed: 0,
      skipped: 0,
      tasksDone: [],
      projectCounts: [],
      ...overrides,
    };
  }

  // gs-303: header tag is threshold-based on verified/(verified+failed).
  describe("header tag (gs-303)", () => {
    it("[OK] when ratio is 100% (no failures)", () => {
      const msg = formatSessionMessage(
        makeParams({ verified: 9, failed: 0 }),
      );
      expect(msg).toContain("[OK]");
      expect(msg).not.toContain("[FAIL]");
      expect(msg).not.toContain("[PARTIAL]");
    });

    it("[OK] when ratio is exactly 75%", () => {
      const msg = formatSessionMessage(
        makeParams({ verified: 3, failed: 1 }),
      );
      expect(msg).toContain("[OK]");
    });

    it("[OK] when ratio is 91.7% (gs-303 acceptance: 11 verified + 1 failed)", () => {
      const msg = formatSessionMessage(
        makeParams({ verified: 11, failed: 1 }),
      );
      expect(msg).toContain("[OK]");
      expect(msg).not.toContain("[FAIL]");
    });

    it("[PARTIAL] when ratio is in [25%, 75%)", () => {
      // 5 verified out of 10 = 50%
      const msg = formatSessionMessage(
        makeParams({ verified: 5, failed: 5 }),
      );
      expect(msg).toContain("[PARTIAL]");
      expect(msg).not.toContain("[OK]");
      expect(msg).not.toContain("[FAIL]");
    });

    it("[PARTIAL] when ratio is exactly 25%", () => {
      const msg = formatSessionMessage(
        makeParams({ verified: 1, failed: 3 }),
      );
      expect(msg).toContain("[PARTIAL]");
    });

    it("[FAIL] when ratio is below 25%", () => {
      // 1 verified out of 5 = 20%
      const msg = formatSessionMessage(
        makeParams({ verified: 1, failed: 4 }),
      );
      expect(msg).toContain("[FAIL]");
      expect(msg).not.toContain("[OK]");
    });

    it("[FAIL] on gs-303 acceptance: 0 verified + 5 failed", () => {
      const msg = formatSessionMessage(
        makeParams({ verified: 0, failed: 5 }),
      );
      expect(msg).toContain("[FAIL]");
    });

    it("[OK] when there were no attempts (all skipped)", () => {
      // attempts == 0 reads as healthy — nothing failed.
      const msg = formatSessionMessage(
        makeParams({ verified: 0, failed: 0, skipped: 3 }),
      );
      expect(msg).toContain("[OK]");
    });

    it("skipped cycles do not move the ratio", () => {
      // 9 verified, 1 failed, 100 skipped → still 90% → [OK]
      const msg = formatSessionMessage(
        makeParams({ verified: 9, failed: 1, skipped: 100 }),
      );
      expect(msg).toContain("[OK]");
    });
  });

  it("includes duration, budget, and cycle counts", () => {
    const msg = formatSessionMessage(
      makeParams({
        budgetMinutes: 90,
        durationMinutes: 44.0,
        verified: 9,
        failed: 1,
      }),
    );
    expect(msg).toContain("Duration: 44.0 min (budget 90)");
    expect(msg).toContain("Cycles: 10 total");
    expect(msg).toContain("9 verified");
    expect(msg).toContain("1 failed");
  });

  it("omits the skipped clause when skipped is zero", () => {
    const msg = formatSessionMessage(makeParams({ skipped: 0 }));
    expect(msg).not.toContain("skipped");
  });

  it("includes the skipped clause when skipped is nonzero", () => {
    const msg = formatSessionMessage(makeParams({ skipped: 2 }));
    expect(msg).toContain("2 skipped");
  });

  // gs-303: "Touched:" breakdown.
  describe("project breakdown (gs-303)", () => {
    it("emits 'Touched: ...' when projectCounts is populated", () => {
      const msg = formatSessionMessage(
        makeParams({
          projectCounts: [
            { project_id: "zero-page-private", cycles: 3 },
            { project_id: "sandkasten", cycles: 3 },
            { project_id: "wargame-design-book", cycles: 1 },
          ],
        }),
      );
      expect(msg).toContain(
        "Touched: zero-page-private (3), sandkasten (3), wargame-design-book (1)",
      );
    });

    it("omits the 'Touched:' line when projectCounts is empty", () => {
      const msg = formatSessionMessage(makeParams({ projectCounts: [] }));
      expect(msg).not.toContain("Touched:");
    });
  });

  // gs-303: tasks grouped by project + prefixed with [project_id].
  describe("'What got done' grouping (gs-303)", () => {
    it("renders tasks prefixed with their project_id and grouped by first-seen project order", () => {
      const msg = formatSessionMessage(
        makeParams({
          tasksDone: [
            { project_id: "zero-page-private", subject: "zpp-001: port manual" },
            { project_id: "sandkasten", subject: "sk-013: do thing" },
            { project_id: "zero-page-private", subject: "zpp-002: another" },
          ],
        }),
      );
      expect(msg).toContain("What got done:");
      // first-seen order: zpp's two tasks group, then sk-013
      expect(msg).toContain("1. [zero-page-private] zpp-001: port manual");
      expect(msg).toContain("2. [zero-page-private] zpp-002: another");
      expect(msg).toContain("3. [sandkasten] sk-013: do thing");
    });

    it("omits the task list when tasksDone is empty", () => {
      const msg = formatSessionMessage(makeParams({ tasksDone: [] }));
      expect(msg).not.toContain("What got done:");
    });
  });

  it("includes the log path when provided", () => {
    const msg = formatSessionMessage(makeParams({ logPath: "logs/session_123.log" }));
    expect(msg).toContain("Log: logs/session_123.log");
  });

  it("omits the log path when undefined", () => {
    const msg = formatSessionMessage(makeParams({ logPath: undefined }));
    expect(msg).not.toContain("Log:");
  });
});

describe("truncateForTelegram", () => {
  it("returns short text unchanged", () => {
    const text = "hello world";
    expect(truncateForTelegram(text)).toBe(text);
  });

  it("returns text exactly at the limit unchanged", () => {
    const text = "a".repeat(3900);
    const result = truncateForTelegram(text);
    expect(result).toBe(text);
    expect(result.length).toBe(3900);
  });

  it("truncates text over the limit to no more than 3900 chars", () => {
    const text = "a".repeat(10000);
    const result = truncateForTelegram(text);
    expect(result.length).toBeLessThanOrEqual(3900);
  });

  it("includes the truncation marker when the input is truncated", () => {
    const text = "a".repeat(5000);
    const result = truncateForTelegram(text);
    expect(result).toContain("[...truncated]");
  });

  it("omits the truncation marker when the input is short enough", () => {
    const result = truncateForTelegram("plenty of room");
    expect(result).not.toContain("[...truncated]");
  });

  it("respects a custom limit", () => {
    const result = truncateForTelegram("x".repeat(500), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("[...truncated]");
  });

  it("handles em-dashes at the truncation boundary without corruption", () => {
    // Em-dash (U+2014) is a single UTF-16 code unit but 3 UTF-8 bytes.
    // Truncation should still produce a round-trippable UTF-8 string.
    const text = "—".repeat(5000);
    const result = truncateForTelegram(text);
    const roundTripped = Buffer.from(result, "utf8").toString("utf8");
    expect(roundTripped).toBe(result);
    expect(result).toContain("[...truncated]");
  });

  it("does not leave a lone surrogate when an emoji straddles the truncation boundary", () => {
    // 🎉 (U+1F389) is a surrogate pair in UTF-16: [0xD83C, 0xDF89]. If
    // truncation lands between the high and low surrogate, the result
    // contains a lone surrogate that produces U+FFFD (replacement char)
    // when round-tripped through UTF-8 bytes.
    //
    // Construct input so that the default slice position (limit - 20 =
    // 3880) falls between the two code units of an emoji: pad so the
    // high surrogate lands at index 3879 and the low at index 3880.
    const pad = "a".repeat(3879);
    const text = pad + "🎉".repeat(100);
    const result = truncateForTelegram(text);

    const roundTripped = Buffer.from(result, "utf8").toString("utf8");
    expect(roundTripped).toBe(result);

    // No lone surrogate should remain anywhere in the output.
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }

    expect(result.length).toBeLessThanOrEqual(3900);
    expect(result).toContain("[...truncated]");
  });
});

describe("sendTelegramMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the Telegram sendMessage endpoint with the token in the URL", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await sendTelegramMessage({ token: "my-token", chatId: "42" }, "hello");

    expect(capturedUrl).toBe("https://api.telegram.org/botmy-token/sendMessage");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe("hello");
  });

  it("truncates messages over the Telegram length limit with a marker", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const longText = "x".repeat(5000);
    await sendTelegramMessage({ token: "t", chatId: "1" }, longText);

    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody as unknown as string);
    expect(body.text.length).toBeLessThanOrEqual(3900);
    expect(body.text).toContain("[...truncated]");
  });

  it("swallows fetch exceptions silently (non-fatal)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    // Should not throw
    await sendTelegramMessage({ token: "t", chatId: "1" }, "msg");
  });
});

describe("loadTelegramCredentials default homedir path", () => {
  // The no-arg call resolves homedir() from os, which on Windows reads
  // USERPROFILE and on POSIX reads HOME. Manipulate both envs so the
  // fixture layout inside TEST_HOME is picked up regardless of platform.
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    process.env.HOME = TEST_HOME;
    process.env.USERPROFILE = TEST_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("resolves credentials from a fixture homedir when no arg is passed", () => {
    writeCredentials("bot-default-token", "555");
    const result = loadTelegramCredentials();
    expect(result).toEqual({ token: "bot-default-token", chatId: "555" });
  });

  it("returns null when the fixture homedir lacks the .claude config", () => {
    // TEST_HOME exists (beforeEach recreates it) but is empty.
    const result = loadTelegramCredentials();
    expect(result).toBeNull();
  });

  it("notifySessionEnd with no loader falls through to the default homedir path and fires fetch when credentials are present", async () => {
    writeCredentials("end-to-end-token", "777");
    let capturedUrl = "";
    let capturedBody: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await notifySessionEnd({
        budgetMinutes: 5,
        durationMinutes: 2,
        verified: 1,
        failed: 0,
        skipped: 0,
        tasksDone: [
          { project_id: "generalstaff", subject: "gs-115: add default homedir notify test" },
        ],
        projectCounts: [{ project_id: "generalstaff", cycles: 1 }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedUrl).toBe("https://api.telegram.org/botend-to-end-token/sendMessage");
    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody as unknown as string);
    expect(body.chat_id).toBe("777");
    expect(body.text).toContain("gs-115: add default homedir notify test");
  });

  it("notifySessionEnd with no loader is a silent no-op when the fixture homedir lacks credentials", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    try {
      await notifySessionEnd({
        budgetMinutes: 1,
        durationMinutes: 1,
        verified: 0,
        failed: 0,
        skipped: 0,
        tasksDone: [],
        projectCounts: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalled).toBe(false);
  });
});

describe("notifySessionEnd composition", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips silently when no credentials are provided via the loader hook", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await notifySessionEnd(
      {
        budgetMinutes: 1,
        durationMinutes: 1,
        verified: 0,
        failed: 0,
        skipped: 0,
        tasksDone: [],
        projectCounts: [],
      },
      { loader: () => null },
    );

    expect(fetchCalled).toBe(false);
  });

  it("sends a formatted message when credentials are provided via the loader hook", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await notifySessionEnd(
      {
        budgetMinutes: 90,
        durationMinutes: 44,
        verified: 9,
        failed: 1,
        skipped: 0,
        tasksDone: [
          { project_id: "generalstaff", subject: "gs-091: validate task add input" },
        ],
        projectCounts: [{ project_id: "generalstaff", cycles: 10 }],
        logPath: "logs/session_x.log",
      },
      { loader: () => ({ token: "T", chatId: "99" }) },
    );

    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody as unknown as string);
    expect(body.chat_id).toBe("99");
    // 9/10 = 90% verified → [OK] under gs-303 thresholds.
    expect(body.text).toContain("[OK] GeneralStaff session complete");
    expect(body.text).toContain("gs-091: validate task add input");
    expect(body.text).toContain("[generalstaff]");
    expect(body.text).toContain("Touched: generalstaff (10)");
    expect(body.text).toContain("Log: logs/session_x.log");
  });
});
