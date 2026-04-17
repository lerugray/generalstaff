import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  startStopFileWatcher,
  type FsWatchListener,
  type FsWatchLike,
  type WatchFn,
} from "../src/stop_watcher";

// A test-mode synchronous watcher — exposes a `fire` handle so tests can
// simulate an fs event without touching the real watch infrastructure.
function makeFakeWatch() {
  let currentListener: FsWatchListener | null = null;
  let watchedDir = "";
  let closed = false;
  const watchFn: WatchFn = (dir, listener): FsWatchLike => {
    watchedDir = dir;
    currentListener = listener;
    return {
      close: () => {
        closed = true;
      },
    };
  };
  return {
    watchFn,
    fire: (event: string, filename: string | null) => {
      if (currentListener) currentListener(event, filename);
    },
    getDir: () => watchedDir,
    isClosed: () => closed,
    hasListener: () => currentListener !== null,
  };
}

const FIXTURES = join(import.meta.dir, "fixtures", "stop_watcher");

describe("startStopFileWatcher", () => {
  it("watches the parent directory of the STOP path", () => {
    const fake = makeFakeWatch();
    const stopPath = "/tmp/generalstaff/STOP";
    const w = startStopFileWatcher(stopPath, () => {}, {
      watchFn: fake.watchFn,
      existsFn: () => false,
    });
    expect(fake.getDir()).toBe("/tmp/generalstaff");
    w.close();
  });

  it("fires onStop when STOP filename appears and exists on disk", () => {
    const fake = makeFakeWatch();
    let fired = 0;
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        fired++;
      },
      { watchFn: fake.watchFn, existsFn: () => true },
    );
    fake.fire("rename", "STOP");
    expect(fired).toBe(1);
  });

  it("ignores events for unrelated filenames", () => {
    const fake = makeFakeWatch();
    let fired = 0;
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        fired++;
      },
      { watchFn: fake.watchFn, existsFn: () => true },
    );
    fake.fire("rename", "other-file.txt");
    fake.fire("change", "PROGRESS.jsonl");
    expect(fired).toBe(0);
  });

  it("ignores events when the STOP file does not actually exist", () => {
    // fs.watch is notorious for ghost events — a rename that fires when the
    // file was briefly created then immediately deleted shouldn't trigger.
    const fake = makeFakeWatch();
    let fired = 0;
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        fired++;
      },
      { watchFn: fake.watchFn, existsFn: () => false },
    );
    fake.fire("rename", "STOP");
    expect(fired).toBe(0);
  });

  it("fires at most once even if multiple events arrive", () => {
    const fake = makeFakeWatch();
    let fired = 0;
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        fired++;
      },
      { watchFn: fake.watchFn, existsFn: () => true },
    );
    fake.fire("rename", "STOP");
    fake.fire("change", "STOP");
    fake.fire("rename", "STOP");
    expect(fired).toBe(1);
  });

  it("honours null filenames (some platforms omit it) by using existsFn", () => {
    const fake = makeFakeWatch();
    let fired = 0;
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        fired++;
      },
      { watchFn: fake.watchFn, existsFn: () => true },
    );
    fake.fire("rename", null);
    expect(fired).toBe(1);
  });

  it("swallows errors thrown by the onStop callback", () => {
    const fake = makeFakeWatch();
    startStopFileWatcher(
      "/tmp/gs/STOP",
      () => {
        throw new Error("bad onStop");
      },
      { watchFn: fake.watchFn, existsFn: () => true },
    );
    // Must not throw — watcher failures should never crash the session.
    expect(() => fake.fire("rename", "STOP")).not.toThrow();
  });

  it("close() invokes the underlying watcher's close()", () => {
    const fake = makeFakeWatch();
    const w = startStopFileWatcher("/tmp/gs/STOP", () => {}, {
      watchFn: fake.watchFn,
      existsFn: () => false,
    });
    expect(fake.isClosed()).toBe(false);
    w.close();
    expect(fake.isClosed()).toBe(true);
  });

  it("close() is idempotent and swallows underlying close errors", () => {
    const watchFn: WatchFn = () => ({
      close: () => {
        throw new Error("already closed");
      },
    });
    const w = startStopFileWatcher("/tmp/gs/STOP", () => {}, {
      watchFn,
      existsFn: () => false,
    });
    expect(() => w.close()).not.toThrow();
    // Second close is also safe.
    expect(() => w.close()).not.toThrow();
  });

  it("end-to-end with the real fs.watch: writing STOP triggers onStop", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    const stopPath = join(FIXTURES, "STOP");
    try {
      let fired = 0;
      const w = startStopFileWatcher(stopPath, () => {
        fired++;
      });
      // Give the watcher a tick to arm on Windows (ReadDirectoryChangesW).
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(stopPath, "stop\n", "utf8");
      // Wait for the fs event to propagate.
      for (let i = 0; i < 40 && fired === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      w.close();
      expect(fired).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(FIXTURES, { recursive: true, force: true });
    }
  });
});
