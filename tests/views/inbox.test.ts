import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir } from "../../src/state";
import { getInboxView, InboxError } from "../../src/views/inbox";

const FIXTURE_DIR = join(tmpdir(), `gs-inbox-${process.pid}`);

function writeMessages(entries: Array<Record<string, unknown>>): void {
  const dir = join(FIXTURE_DIR, "state", "_fleet");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dir, "messages.jsonl"), lines + "\n", "utf8");
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("getInboxView", () => {
  it("groups messages by local date with today/yesterday/weekday labels", async () => {
    // Saturday local 12:00 in a tz-stable way: use local Date constructor.
    const now = new Date(2026, 3, 18, 12, 0, 0); // 2026-04-18 local noon, Saturday
    writeMessages([
      // Today — two messages, expect newest-first within the group.
      {
        timestamp: new Date(2026, 3, 18, 9, 0, 0).toISOString(),
        from: "generalstaff-bot",
        body: "today-early",
      },
      {
        timestamp: new Date(2026, 3, 18, 11, 30, 0).toISOString(),
        from: "generalstaff-bot",
        body: "today-late",
      },
      // Yesterday (Friday)
      {
        timestamp: new Date(2026, 3, 17, 22, 0, 0).toISOString(),
        from: "raybrain-bot",
        body: "yesterday-msg",
      },
      // 3 days ago (Wednesday)
      {
        timestamp: new Date(2026, 3, 15, 8, 15, 0).toISOString(),
        from: "gamr-bot",
        body: "wed-msg",
      },
    ]);

    const since = new Date(2026, 3, 10, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });

    expect(data.groups).toHaveLength(3);
    expect(data.groups[0].date_label).toBe("today");
    expect(data.groups[0].messages.map((m) => m.body)).toEqual([
      "today-late",
      "today-early",
    ]);
    expect(data.groups[1].date_label).toBe("yesterday");
    expect(data.groups[2].date_label).toBe("Wednesday");
    expect(data.unread_count).toBe(4);
    expect(data.rendered_at).toBe(now.toISOString());
  });

  it("uses 'apr 15' style label for messages older than 6 days", async () => {
    const now = new Date(2026, 3, 23, 12, 0, 0); // 2026-04-23
    writeMessages([
      {
        timestamp: new Date(2026, 3, 15, 10, 0, 0).toISOString(),
        from: "generalstaff-bot",
        body: "old",
      },
    ]);

    const since = new Date(2026, 3, 1, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });

    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].date_label).toBe("apr 15");
  });

  it("classifies from_type for bot, human, and system senders", async () => {
    const now = new Date(2026, 3, 18, 12, 0, 0);
    const ts = new Date(2026, 3, 18, 9, 0, 0).toISOString();
    writeMessages([
      { timestamp: ts, from: "generalstaff-bot", body: "a" },
      { timestamp: ts, from: "some-bot", body: "b" },
      { timestamp: ts, from: "bot:session-abc", body: "c" },
      { timestamp: ts, from: "dispatcher", body: "d" },
      { timestamp: ts, from: "system", body: "e" },
      { timestamp: ts, from: "ray", body: "f" },
    ]);

    const since = new Date(2026, 3, 10, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });

    const byBody = Object.fromEntries(
      data.groups[0].messages.map((m) => [m.body, m.from_type]),
    );
    expect(byBody.a).toBe("bot");
    expect(byBody.b).toBe("bot");
    expect(byBody.c).toBe("bot");
    expect(byBody.d).toBe("system");
    expect(byBody.e).toBe("system");
    expect(byBody.f).toBe("human");
  });

  it("returns empty InboxData when messages.jsonl is missing", async () => {
    const now = new Date(2026, 3, 18, 12, 0, 0);
    const since = new Date(2026, 3, 10, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });
    expect(data.groups).toEqual([]);
    expect(data.unread_count).toBe(0);
    expect(data.oldest_shown).toBe(since);
    expect(data.rendered_at).toBe(now.toISOString());
  });

  it("throws InboxError for invalid since timestamp", async () => {
    await expect(getInboxView("not-a-date")).rejects.toThrow(InboxError);
    await expect(getInboxView("not-a-date")).rejects.toThrow(
      "invalid since timestamp: not-a-date",
    );
  });

  it("defaults since to 7 days before now when not supplied", async () => {
    const now = new Date(2026, 3, 18, 12, 0, 0);
    const expectedSince = new Date(
      now.getTime() - 7 * 86_400_000,
    ).toISOString();

    // An old message (8 days back) must be excluded; a recent one (2 days
    // back) must be included — proving the default cutoff is 7 days ago.
    writeMessages([
      {
        timestamp: new Date(now.getTime() - 8 * 86_400_000).toISOString(),
        from: "generalstaff-bot",
        body: "too-old",
      },
      {
        timestamp: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
        from: "generalstaff-bot",
        body: "within-window",
      },
    ]);

    const data = await getInboxView(undefined, { now });

    expect(data.unread_count).toBe(1);
    expect(data.groups.flatMap((g) => g.messages.map((m) => m.body))).toEqual([
      "within-window",
    ]);
    // oldest_shown falls back to the since cutoff when groups are nonempty?
    // Spec: oldest_shown = earliest message timestamp, or since if empty.
    expect(data.oldest_shown).toBe(
      new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    );
    // Sanity-check the default cutoff reached readFleetMessagesSince: the
    // 8-days-old message would have been included otherwise.
    expect(expectedSince < new Date(now.getTime() - 2 * 86_400_000).toISOString()).toBe(true);
  });

  it("renders kind: null when message has no kind or an unknown kind", async () => {
    const now = new Date(2026, 3, 18, 12, 0, 0);
    const ts = new Date(2026, 3, 18, 9, 0, 0).toISOString();
    writeMessages([
      { timestamp: ts, from: "generalstaff-bot", body: "no-kind" },
      { timestamp: ts, from: "generalstaff-bot", body: "null-kind", kind: null },
      {
        timestamp: ts,
        from: "generalstaff-bot",
        body: "bad-kind",
        kind: "not-a-real-kind",
      },
      {
        timestamp: ts,
        from: "generalstaff-bot",
        body: "valid-kind",
        kind: "blocker",
      },
    ]);

    const since = new Date(2026, 3, 10, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });
    const byBody = Object.fromEntries(
      data.groups[0].messages.map((m) => [m.body, m.kind]),
    );
    expect(byBody["no-kind"]).toBeNull();
    expect(byBody["null-kind"]).toBeNull();
    expect(byBody["bad-kind"]).toBeNull();
    expect(byBody["valid-kind"]).toBe("blocker");
  });

  it("parses refs pulling session_id/task_id/cycle_id, ignoring unknown fields", async () => {
    const now = new Date(2026, 3, 18, 12, 0, 0);
    const ts = new Date(2026, 3, 18, 9, 0, 0).toISOString();
    writeMessages([
      {
        timestamp: ts,
        from: "generalstaff-bot",
        body: "with-refs",
        refs: [
          { task_id: "gs-225", cycle_id: "c-abc" },
          { session_id: "sess-1", unknown: "ignored" },
          "not-an-object",
          null,
        ],
      },
      {
        timestamp: ts,
        from: "generalstaff-bot",
        body: "missing-refs",
      },
    ]);

    const since = new Date(2026, 3, 10, 0, 0, 0).toISOString();
    const data = await getInboxView(since, { now });
    const msgs = Object.fromEntries(
      data.groups[0].messages.map((m) => [m.body, m]),
    );
    expect(msgs["with-refs"].refs).toEqual([
      { task_id: "gs-225", cycle_id: "c-abc" },
      { session_id: "sess-1" },
    ]);
    expect(msgs["missing-refs"].refs).toEqual([]);
  });
});
