import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MIN_RULING_WORDS, readForkLedger, recordForkResolution } from "../src/fork_ledger";

const TS = "2026-06-01T00:00:00.000Z";

describe("recordForkResolution", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-fork-res-"));
    path = join(dir, "forks.json");
    writeFileSync(
      path,
      JSON.stringify({
        forks: [
          { id: "p::one", project: "p", title: "one", kind: "fork", status: "pending", first_seen: "t0", last_seen: "t0" },
          { id: "p::old", project: "p", title: "old", kind: "fork", status: "resolved", resolution: "legacy answer", first_seen: "t0", last_seen: "t0" },
        ],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("needs at least three words to count as a ruling", () => {
    expect(MIN_RULING_WORDS).toBe(3);
  });

  it("stores a ruling with the owner's words", () => {
    const r = recordForkResolution(path, "p::one", { resolution: "ship the grid", ownerWords: "  I want   the grid view " }, TS);
    expect(r.ok).toBe(true);
    const e = readForkLedger(path).forks.find((f) => f.id === "p::one")!;
    expect(e.status).toBe("resolved");
    expect(e.resolution).toBe("ship the grid");
    expect(e.resolution_kind).toBe("ruling");
    expect(e.owner_words).toBe("I want the grid view");
    expect(e.last_seen).toBe(TS);
  });

  it("stores a pick without owner words as a seat option", () => {
    const r = recordForkResolution(path, "p::one", { resolution: "option B" }, TS);
    expect(r.ok).toBe(true);
    const e = readForkLedger(path).forks.find((f) => f.id === "p::one")!;
    expect(e.resolution_kind).toBe("seat_option");
    expect(e.owner_words).toBeUndefined();
  });

  it("stores a seat option when the words are too short to be a ruling", () => {
    recordForkResolution(path, "p::one", { resolution: "option B", ownerWords: "B please" }, TS);
    const e = readForkLedger(path).forks.find((f) => f.id === "p::one")!;
    expect(e.resolution_kind).toBe("seat_option");
    expect(e.owner_words).toBeUndefined();
  });

  it("refuses an explicit ruling without owner words and leaves the entry alone", () => {
    const r = recordForkResolution(path, "p::one", { resolution: "x", kind: "ruling" }, TS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("owner");
    expect(readForkLedger(path).forks.find((f) => f.id === "p::one")!.status).toBe("pending");
  });

  it("keeps an explicit seat_option even when words are given", () => {
    recordForkResolution(path, "p::one", { resolution: "x", ownerWords: "words from the owner here", kind: "seat_option" }, TS);
    const e = readForkLedger(path).forks.find((f) => f.id === "p::one")!;
    expect(e.resolution_kind).toBe("seat_option");
    expect(e.owner_words).toBeUndefined();
  });

  it("refuses an empty resolution and an unknown id", () => {
    expect(recordForkResolution(path, "p::one", { resolution: "   " }, TS).ok).toBe(false);
    const r = recordForkResolution(path, "p::missing", { resolution: "x" }, TS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("p::missing");
  });

  it("leaves records that predate the field unchanged", () => {
    recordForkResolution(path, "p::one", { resolution: "x" }, TS);
    const old = readForkLedger(path).forks.find((f) => f.id === "p::old")!;
    expect(old.resolution).toBe("legacy answer");
    expect(old.resolution_kind).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).forks).toHaveLength(2);
  });
});
