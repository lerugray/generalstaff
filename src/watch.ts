export interface ParsedWatch {
  enabled: boolean;
  intervalSeconds: number;
}

const DEFAULT_WATCH_SECONDS = 5;
const MIN_WATCH_SECONDS = 1;

export function parseWatchFlag(rawArgs: string[]): ParsedWatch {
  let enabled = false;
  let intervalSeconds = DEFAULT_WATCH_SECONDS;
  for (const arg of rawArgs) {
    if (arg === "--watch") {
      enabled = true;
    } else if (arg.startsWith("--watch=")) {
      enabled = true;
      const raw = arg.slice("--watch=".length);
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) {
        intervalSeconds = Math.max(MIN_WATCH_SECONDS, parsed);
      }
    }
  }
  return { enabled, intervalSeconds };
}

export function stripWatchArgs(rawArgs: string[]): string[] {
  return rawArgs.filter(
    (a) => a !== "--watch" && !a.startsWith("--watch="),
  );
}

export interface WatchTimer {
  setInterval: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface WatchOptions {
  timer?: WatchTimer;
  clearScreen?: () => void;
  maxIterations?: number;
}

export function runWatchLoop(
  renderFn: () => Promise<void> | void,
  intervalSeconds: number,
  opts: WatchOptions = {},
): Promise<number> {
  const timer: WatchTimer = opts.timer ?? {
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown,
    clearInterval: (h) =>
      clearInterval(h as ReturnType<typeof setInterval>),
  };
  const clearScreen =
    opts.clearScreen ??
    (() => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
    });

  let iterations = 0;

  return new Promise<number>((resolve) => {
    const tick = async () => {
      clearScreen();
      await renderFn();
      iterations++;
      if (
        opts.maxIterations !== undefined &&
        iterations >= opts.maxIterations
      ) {
        timer.clearInterval(handle);
        resolve(iterations);
      }
    };
    const handle = timer.setInterval(tick, intervalSeconds * 1000);
    void tick();
  });
}
