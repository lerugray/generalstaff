// gs-332: autonomous-mode fork ledger — dedup, resolved-preservation,
// is_decision filtering, and the wintermute-faithful slug behavior.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import {
  forkId,
  readForkLedger,
  pendingForks,
  updateForkLedger,
  type HeldItem,
} from "../src/fork_ledger";
import type { ForkLedger } from "../src/types";

describe("forkId — wintermute-faithful slug", () => {
  it("slugs project::title with single-dash collapsing", () => {
    expect(forkId("retrogaze", "Free-vs-paid tier  gating!")).toBe(
      "retrogaze::free-vs-paid-tier-gating",
    );
  });

  it("strips leading/trailing dashes BEFORE truncating", () => {
    expect(forkId("p", "  Hello, World  ")).toBe("p::hello-world");
  });

  it("can leave a trailing dash AFTER the 56-char slice (reference quirk)", () => {
    // slug = 55×'x' + '-' + 'y' -> strip (no leading/trailing) -> slice(0,56)
    // = 55×'x' + '-'  (the dash survives at index 55).
    const title = "x".repeat(55) + " y";
    const slug = forkId("p", title).split("::")[1];
    expect(slug.length).toBe(56);
    expect(slug.endsWith("-")).toBe(true);
  });
});

describe("readForkLedger — never throws", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-fork-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns an empty ledger when the file is missing", () => {
    expect(readForkLedger(join(dir, "nope.json"))).toEqual({ forks: [] });
  });

  it("returns an empty ledger on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(readForkLedger(p)).toEqual({ forks: [] });
  });

  it("coerces a valid-but-wrong-shaped file to an empty ledger", () => {
    const p = join(dir, "wrong.json");
    writeFileSync(p, JSON.stringify({ forks: null }));
    expect(readForkLedger(p).forks).toEqual([]);
  });

  it("filters out null / non-object entries inside the forks array", () => {
    // A corrupted ledger must not crash pendingForks()/.status access.
    const p = join(dir, "corrupt.json");
    writeFileSync(
      p,
      JSON.stringify({
        forks: [
          {
            id: "ok",
            project: "p",
            title: "t",
            kind: "design-fork",
            status: "pending",
            first_seen: "t",
            last_seen: "t",
            resolution: null,
          },
          null,
          42,
          "garbage",
        ],
      }),
    );
    const led = readForkLedger(p);
    expect(led.forks).toHaveLength(1);
    expect(led.forks[0].id).toBe("ok");
    expect(pendingForks(led)).toHaveLength(1); // would throw on a null entry pre-fix
  });

  it("reads a well-formed ledger", () => {
    const led: ForkLedger = {
      forks: [
        {
          id: "p::a",
          project: "p",
          title: "a",
          kind: "design-fork",
          status: "pending",
          first_seen: "t0",
          last_seen: "t0",
          resolution: null,
        },
      ],
    };
    const p = join(dir, "good.json");
    writeFileSync(p, JSON.stringify(led));
    expect(readForkLedger(p).forks).toHaveLength(1);
  });
});

describe("updateForkLedger — is_decision + dedup + resolved-preservation", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-fork-"));
    path = join(dir, "fork-ledger.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const held = (over: Partial<HeldItem> = {}): HeldItem => ({
    project: "p",
    title: "t",
    verdict: "keep",
    cls: "design-fork",
    ...over,
  });

  it("ledgers a KEEP design-fork", () => {
    const n = updateForkLedger(path, [held()], new Set(), "t1");
    expect(n).toBe(1);
    const led = readForkLedger(path);
    expect(led.forks[0].kind).toBe("design-fork");
    expect(led.forks[0].status).toBe("pending");
  });

  it("ledgers a KEEP bot-safe item only when its project is live", () => {
    const item = held({ cls: "bot-safe" });
    // non-live → dropped (not a decision)
    expect(updateForkLedger(path, [item], new Set(), "t1")).toBe(0);
    // live → live-held
    expect(updateForkLedger(path, [item], new Set(["p"]), "t2")).toBe(1);
    expect(readForkLedger(path).forks[0].kind).toBe("live-held");
  });

  it("never ledgers a REJECT (slop)", () => {
    expect(
      updateForkLedger(path, [held({ verdict: "reject" })], new Set(["p"]), "t1"),
    ).toBe(0);
    expect(readForkLedger(path).forks).toHaveLength(0);
  });

  it("dedups by id and only refreshes last_seen on a re-seen item", () => {
    updateForkLedger(path, [held()], new Set(), "t1");
    const added2 = updateForkLedger(path, [held()], new Set(), "t2");
    expect(added2).toBe(0);
    const led = readForkLedger(path);
    expect(led.forks).toHaveLength(1);
    expect(led.forks[0].first_seen).toBe("t1");
    expect(led.forks[0].last_seen).toBe("t2");
  });

  it("preserves a resolved entry across runs (never re-surfaces)", () => {
    updateForkLedger(path, [held()], new Set(), "t1");
    // Ray resolves it out-of-band.
    const led = readForkLedger(path);
    led.forks[0].status = "resolved";
    led.forks[0].resolution = "did it via cursor";
    writeFileSync(path, JSON.stringify(led));
    // Same item re-seen on the next run.
    const added = updateForkLedger(path, [held()], new Set(), "t3");
    expect(added).toBe(0);
    const after = readForkLedger(path);
    expect(after.forks[0].status).toBe("resolved");
    expect(after.forks[0].resolution).toBe("did it via cursor");
    expect(pendingForks(after)).toHaveLength(0);
  });

  it("writes the file even with zero decisions only when called with held items", () => {
    updateForkLedger(path, [held()], new Set(), "t1");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).updated).toBe("t1");
  });

  it("creates the state dir if it does not exist yet (fresh setup)", () => {
    // The ledger may be the first thing written to a fresh state/ tree.
    const nested = join(dir, "does", "not", "exist", "fork-ledger.json");
    const n = updateForkLedger(nested, [held()], new Set(), "t1");
    expect(n).toBe(1);
    expect(existsSync(nested)).toBe(true);
  });
});
