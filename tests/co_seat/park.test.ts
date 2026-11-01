import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { consumeAideMessage, countersPath, dailyUse, forkLedgerPath, parkItem } from "../../src/co_seat/park";
import { pendingForks, readForkLedger, updateForkLedger } from "../../src/fork_ledger";
import { loadCtx, makeSandbox, seatBlock, writeProjectsYaml, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime(); // local noon
const NEXT_DAY = NOW + 24 * 3_600_000;

async function seat(authority: Record<string, unknown> = {}, projects = ["app"], ids = ["app", "site"]) {
  writeProjectsYaml(sb.root, [seatBlock("main", { projects, authority })], ids);
  return loadCtx("main");
}

describe("parkItem", () => {
  it("writes a namespaced kind:co-seat entry to the shared fork ledger, visible to `forks`", async () => {
    const ctx = await seat();
    const r = parkItem(ctx, "app", "Pick the pricing page copy", "docs/evidence.md", NOW);
    expect(r).toEqual({ id: "co-seat:main::app::pick-the-pricing-page-copy", outcome: "added", used: 1, cap: 2 });
    const ledger = readForkLedger(forkLedgerPath(ctx));
    expect(ledger.forks).toHaveLength(1);
    expect(ledger.forks[0]).toMatchObject({
      id: "co-seat:main::app::pick-the-pricing-page-copy",
      project: "app",
      title: "Pick the pricing page copy",
      kind: "co-seat",
      status: "pending",
      resolution: null,
      evidence: "docs/evidence.md",
    });
    expect(pendingForks(ledger)).toHaveLength(1);
    expect(forkLedgerPath(ctx)).toBe(join(sb.root, "state", "fork-ledger.json"));
  });

  it("never collides with an autonomous-mode fork of the same title, and keeps its entries", async () => {
    const ctx = await seat();
    updateForkLedger(
      forkLedgerPath(ctx),
      [{ project: "app", title: "Pick the pricing page copy", verdict: "keep", cls: "design-fork" }],
      new Set(),
      "2026-11-01T00:00:00Z",
    );
    parkItem(ctx, "app", "Pick the pricing page copy", undefined, NOW);
    const ids = readForkLedger(forkLedgerPath(ctx)).forks.map((f) => f.id);
    expect(ids).toEqual(["app::pick-the-pricing-page-copy", "co-seat:main::app::pick-the-pricing-page-copy"]);
  });

  it("refuses a project outside the seat, and an empty or symbol-only description", async () => {
    const ctx = await seat();
    expect(() => parkItem(ctx, "site", "Something", undefined, NOW)).toThrow(/may only park for its own projects \(app\), not "site"/);
    expect(() => parkItem(ctx, "app", "  ", undefined, NOW)).toThrow(/one-line description/);
    expect(() => parkItem(ctx, "app", "two\nlines", undefined, NOW)).toThrow(/one-line description/);
    expect(() => parkItem(ctx, "app", "!!! ???", undefined, NOW)).toThrow(/letters or digits/);
  });

  it("enforces park_per_day per local day; re-parking an existing id refreshes it and costs nothing", async () => {
    const ctx = await seat({ park_per_day: 2 });
    expect(parkItem(ctx, "app", "First decision", undefined, NOW).used).toBe(1);
    expect(parkItem(ctx, "app", "Second decision", undefined, NOW).used).toBe(2);
    expect(() => parkItem(ctx, "app", "Third decision", undefined, NOW)).toThrow(/parked 2 of 2 items today; park_per_day is reached/);
    // At the cap, an existing id still refreshes, and does not count.
    const again = parkItem(ctx, "app", "First decision", "new/evidence.md", NOW + 60_000);
    expect(again).toMatchObject({ outcome: "refreshed", used: 2 });
    const ledger = readForkLedger(forkLedgerPath(ctx));
    expect(ledger.forks).toHaveLength(2);
    const first = ledger.forks.find((f) => f.title === "First decision")!;
    expect(first.first_seen).toBe(new Date(NOW).toISOString());
    expect(first.last_seen).toBe(new Date(NOW + 60_000).toISOString());
    expect(first.evidence).toBe("new/evidence.md");
    expect(dailyUse(ctx.dir, NOW)).toEqual({ park: 2, aide: 0 });
    // The next local day starts the count over.
    expect(parkItem(ctx, "app", "Third decision", undefined, NEXT_DAY).used).toBe(1);
  });

  it("re-parking an id the person already resolved is refused and prints their answer, costing nothing", async () => {
    const ctx = await seat({ park_per_day: 2 });
    parkItem(ctx, "app", "Decide it", undefined, NOW);
    const path = forkLedgerPath(ctx);
    const ledger = readForkLedger(path);
    ledger.forks[0]!.status = "resolved";
    ledger.forks[0]!.resolution = "ship the blue one";
    writeFileSync(path, JSON.stringify(ledger));
    expect(() => parkItem(ctx, "app", "Decide it", undefined, NOW + 1000)).toThrow(
      /the person already decided this \(co-seat:main::app::decide-it\): ship the blue one\. Act on that answer; do not park it again/,
    );
    const after = readForkLedger(path).forks[0]!;
    expect(after).toMatchObject({ status: "resolved", resolution: "ship the blue one", last_seen: new Date(NOW).toISOString() });
    expect(dailyUse(ctx.dir, NOW)).toEqual({ park: 1, aide: 0 });
    // A resolution with no note still says it was decided.
    ledger.forks[0]!.resolution = null;
    writeFileSync(path, JSON.stringify(ledger));
    expect(() => parkItem(ctx, "app", "Decide it", undefined, NOW)).toThrow(/resolved, no note recorded/);
  });

  it("park_per_day: 0 refuses everything", async () => {
    const ctx = await seat({ park_per_day: 0 });
    expect(() => parkItem(ctx, "app", "Anything", undefined, NOW)).toThrow(/may not park items \(park_per_day is 0\)/);
  });

  it("fails closed on a damaged counters file instead of resetting the cap", async () => {
    const ctx = await seat();
    parkItem(ctx, "app", "One", undefined, NOW);
    writeFileSync(countersPath(ctx.dir), "{garbage");
    expect(() => parkItem(ctx, "app", "Two", undefined, NOW)).toThrow(/daily counters are unreadable/);
    expect(dailyUse(ctx.dir, NOW)).toBeNull();
    writeFileSync(countersPath(ctx.dir), JSON.stringify({ day: "x" }));
    expect(() => parkItem(ctx, "app", "Two", undefined, NOW)).toThrow(/malformed/);
  });
});

describe("consumeAideMessage", () => {
  it("0 means none", async () => {
    const ctx = await seat({ aide_messages_per_day: 0 });
    expect(() => consumeAideMessage(ctx, NOW)).toThrow(/may not message Aides \(aide_messages_per_day is 0\)/);
  });

  it("counts per local day and refuses past the cap", async () => {
    const ctx = await seat({ aide_messages_per_day: 2 });
    expect(consumeAideMessage(ctx, NOW)).toEqual({ used: 1, cap: 2 });
    expect(consumeAideMessage(ctx, NOW)).toEqual({ used: 2, cap: 2 });
    expect(() => consumeAideMessage(ctx, NOW)).toThrow(/sent 2 of 2 Aide messages today/);
    expect(JSON.parse(readFileSync(countersPath(ctx.dir), "utf8"))).toMatchObject({ aide: 2 });
    expect(consumeAideMessage(ctx, NEXT_DAY)).toEqual({ used: 1, cap: 2 });
  });

  it("parking and Aide messages are counted separately", async () => {
    const ctx = await seat({ park_per_day: 1, aide_messages_per_day: 1 });
    parkItem(ctx, "app", "One", undefined, NOW);
    expect(consumeAideMessage(ctx, NOW).used).toBe(1);
    expect(dailyUse(ctx.dir, NOW)).toEqual({ park: 1, aide: 1 });
  });
});

describe("daily caps under concurrency (real processes)", () => {
  const src = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "..", "src", name)).href);

  function worker() {
    const path = join(sb.root, "cap-worker.mjs");
    writeFileSync(
      path,
      `
import { setRootDir } from ${src("state.ts")};
import { loadSeatContext } from ${src("co_seat/context.ts")};
import { consumeAideMessage, parkItem } from ${src("co_seat/park.ts")};
setRootDir(process.argv[2]);
const ctx = await loadSeatContext("main", { quiet: true });
try {
  if (process.argv[3] === "aide") consumeAideMessage(ctx);
  else parkItem(ctx, "app", "Decision number " + process.argv[4]);
  console.log("ok");
} catch (error) {
  console.log("refused: " + error.message);
}
`,
    );
    return path;
  }

  async function swarm(mode: "aide" | "park", count: number): Promise<string[]> {
    const script = worker();
    const children = Array.from({ length: count }, (_, i) =>
      Bun.spawn([process.execPath, script, sb.root, mode, String(i)], { cwd: sb.root, stdout: "pipe", stderr: "pipe" }),
    );
    return Promise.all(
      children.map(async (c) => {
        const [out, err] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text()]);
        await c.exited;
        return out.trim() || `crashed: ${err.slice(0, 200)}`;
      }),
    );
  }

  it("20 concurrent Aide sends with a cap of 3 let exactly 3 through", async () => {
    const ctx = await seat({ aide_messages_per_day: 3 });
    const results = await swarm("aide", 20);
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r.startsWith("refused: ") && r.includes("aide_messages_per_day is reached"))).toHaveLength(17);
    expect(dailyUse(ctx.dir)).toMatchObject({ aide: 3 });
  }, 60_000);

  it("concurrent parks never exceed park_per_day and never lose a ledger entry", async () => {
    const ctx = await seat({ park_per_day: 3 });
    const results = await swarm("park", 14);
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r.includes("park_per_day is reached"))).toHaveLength(11);
    expect(readForkLedger(forkLedgerPath(ctx)).forks).toHaveLength(3);
    expect(dailyUse(ctx.dir)).toMatchObject({ park: 3 });
  }, 60_000);
});
