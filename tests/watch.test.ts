import { describe, it, expect } from "bun:test";
import {
  parseWatchFlag,
  stripWatchArgs,
  runWatchLoop,
  type WatchTimer,
} from "../src/watch";

describe("parseWatchFlag", () => {
  it("returns disabled when --watch absent", () => {
    expect(parseWatchFlag(["--json"])).toEqual({
      enabled: false,
      intervalSeconds: 5,
    });
  });

  it("defaults to 5 seconds when --watch given without value", () => {
    expect(parseWatchFlag(["--watch"])).toEqual({
      enabled: true,
      intervalSeconds: 5,
    });
  });

  it("accepts a custom interval via --watch=N", () => {
    expect(parseWatchFlag(["--watch=10"])).toEqual({
      enabled: true,
      intervalSeconds: 10,
    });
  });

  it("clamps values below 1 to 1", () => {
    expect(parseWatchFlag(["--watch=0"]).intervalSeconds).toBe(1);
    expect(parseWatchFlag(["--watch=-5"]).intervalSeconds).toBe(1);
  });

  it("ignores non-numeric values (keeps default)", () => {
    expect(parseWatchFlag(["--watch=foo"]).intervalSeconds).toBe(5);
  });

  it("works alongside other args in any order", () => {
    expect(parseWatchFlag(["--json", "--watch=3"])).toEqual({
      enabled: true,
      intervalSeconds: 3,
    });
  });
});

describe("stripWatchArgs", () => {
  it("removes --watch and --watch=N tokens", () => {
    expect(stripWatchArgs(["--json", "--watch", "--other"])).toEqual([
      "--json",
      "--other",
    ]);
    expect(stripWatchArgs(["--watch=10", "--json"])).toEqual(["--json"]);
  });

  it("leaves untouched when no watch flag", () => {
    expect(stripWatchArgs(["--json"])).toEqual(["--json"]);
  });
});

function makeFakeTimer() {
  let storedFn: (() => void | Promise<void>) | null = null;
  let storedMs: number | null = null;
  let cleared = false;
  const timer: WatchTimer = {
    setInterval: (fn, ms) => {
      storedFn = fn;
      storedMs = ms;
      return Symbol("handle");
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  return {
    timer,
    getMs: () => storedMs,
    wasCleared: () => cleared,
    tick: async () => {
      if (storedFn) await storedFn();
    },
  };
}

describe("runWatchLoop", () => {
  it("renders once with the default interval (5s -> 5000ms)", async () => {
    const fake = makeFakeTimer();
    let renders = 0;
    const p = runWatchLoop(
      () => {
        renders++;
      },
      5,
      {
        timer: fake.timer,
        clearScreen: () => {},
        maxIterations: 1,
      },
    );
    // With maxIterations=1, the initial render satisfies; but the loop
    // awaits the interval tick before resolving. Tick once.
    await fake.tick();
    const count = await p;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(renders).toBeGreaterThanOrEqual(1);
    expect(fake.getMs()).toBe(5000);
  });

  it("respects a custom interval (10s -> 10000ms)", async () => {
    const fake = makeFakeTimer();
    const p = runWatchLoop(() => {}, 10, {
      timer: fake.timer,
      clearScreen: () => {},
      maxIterations: 2,
    });
    await fake.tick();
    await fake.tick();
    await p;
    expect(fake.getMs()).toBe(10000);
  });

  it("passes the clamped minimum interval (1s -> 1000ms)", async () => {
    const fake = makeFakeTimer();
    const p = runWatchLoop(() => {}, 1, {
      timer: fake.timer,
      clearScreen: () => {},
      maxIterations: 2,
    });
    await fake.tick();
    await fake.tick();
    await p;
    expect(fake.getMs()).toBe(1000);
  });

  it("calls renderFn on each tick and clears the handle when done", async () => {
    const fake = makeFakeTimer();
    let renders = 0;
    const p = runWatchLoop(
      () => {
        renders++;
      },
      5,
      {
        timer: fake.timer,
        clearScreen: () => {},
        maxIterations: 3,
      },
    );
    expect(renders).toBe(1); // initial render before interval
    await fake.tick();
    expect(renders).toBe(2);
    await fake.tick();
    expect(renders).toBe(3);
    await p;
    expect(fake.wasCleared()).toBe(true);
  });

  it("invokes clearScreen before each render", async () => {
    const fake = makeFakeTimer();
    let clears = 0;
    const p = runWatchLoop(
      () => {},
      5,
      {
        timer: fake.timer,
        clearScreen: () => {
          clears++;
        },
        maxIterations: 2,
      },
    );
    expect(clears).toBe(1);
    await fake.tick();
    await p;
    expect(clears).toBe(2);
  });
});
