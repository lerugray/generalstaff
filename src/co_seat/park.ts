// GeneralStaff — co-seats: parking items for a person, and the daily caps
// (DESIGN.md §v11 "Parking reuses the fork ledger", "Guards that do not trust
// the turn").
//
// Caps come from config, never from the caller, and are counted in the seat's
// state directory per local day. A parked item is a `kind: "co-seat"` entry in
// the same fork-ledger.json `generalstaff forks` reads.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { forkId, getFork, upsertCoSeatFork } from "../fork_ledger";
import { getStateDir } from "../state";
import { localDay, type SeatContext } from "./config";
import { writeFileAtomic } from "./control";
import { withDirLock } from "./dirlock";

interface Counters {
  day: string;
  park: number;
  aide: number;
}

export const countersPath = (dir: string) => join(dir, "counters.json");

/** A missing file or an earlier day starts at zero; a file that cannot be read fails closed. */
function readCounters(dir: string, day: string): Counters {
  if (!existsSync(countersPath(dir))) return { day, park: 0, aide: 0 };
  let o: Partial<Counters>;
  try {
    o = JSON.parse(readFileSync(countersPath(dir), "utf8")) as Partial<Counters>;
  } catch {
    throw new Error(`the co-seat's daily counters are unreadable (${countersPath(dir)}); fix or delete that file`);
  }
  if (typeof o.day !== "string" || typeof o.park !== "number" || typeof o.aide !== "number") {
    throw new Error(`the co-seat's daily counters are malformed (${countersPath(dir)}); fix or delete that file`);
  }
  return o.day === day ? { day, park: o.park, aide: o.aide } : { day, park: 0, aide: 0 };
}

function writeCounters(dir: string, c: Counters): void {
  writeFileAtomic(countersPath(dir), JSON.stringify(c) + "\n");
}

export interface DailyUse {
  park: number;
  aide: number;
}

/** Counts used so far on the local day containing `nowMs`; null when the counters file is unreadable. */
export function dailyUse(dir: string, nowMs: number = Date.now()): DailyUse | null {
  try {
    const c = readCounters(dir, localDay(nowMs));
    return { park: c.park, aide: c.aide };
  } catch {
    return null;
  }
}

export function forkLedgerPath(ctx: Pick<SeatContext, "dispatcher">): string {
  return join(getStateDir(ctx.dispatcher), "fork-ledger.json");
}

export interface ParkResult {
  id: string;
  outcome: "added" | "refreshed";
  used: number;
  cap: number;
}

export const countersLockPath = (dir: string) => join(dir, "counters.lock");

/**
 * Park a decision for a person. The project must belong to the seat. A new id
 * counts against `park_per_day` and is refused past it; a pending id already in
 * the ledger is only refreshed and costs nothing; an id the person has already
 * resolved is refused with their answer, so the turn learns it instead of
 * asking again. The check and the write happen under one lock, so concurrent
 * parks cannot exceed the cap.
 */
export function parkItem(
  ctx: SeatContext,
  project: string,
  title: string,
  evidence?: string,
  nowMs: number = Date.now(),
): ParkResult {
  const seat = ctx.seat;
  if (!seat.projects.includes(project)) {
    throw new Error(
      `co-seat "${seat.id}" may only park for its own projects (${seat.projects.join(", ")}), not "${project}"`,
    );
  }
  const cleanTitle = title.trim();
  if (cleanTitle === "" || /[\r\n]/.test(cleanTitle)) {
    throw new Error("the parked item needs a one-line description of what the person decides");
  }
  const base = forkId(project, cleanTitle);
  if (base.endsWith("::")) {
    throw new Error("the parked item's description needs letters or digits");
  }
  const id = `co-seat:${seat.id}::${base}`;
  const ledger = forkLedgerPath(ctx);
  const day = localDay(nowMs);
  const cap = seat.authority.park_per_day;
  const ts = new Date(nowMs).toISOString();

  return withDirLock(countersLockPath(ctx.dir), () => {
    const counters = readCounters(ctx.dir, day);
    const existing = getFork(ledger, id);
    if (existing) {
      if (existing.status === "resolved") {
        throw new Error(
          `the person already decided this (${id}): ${existing.resolution?.trim() ? existing.resolution : "resolved, no note recorded"}. Act on that answer; do not park it again`,
        );
      }
      upsertCoSeatFork(ledger, { id, project, title: cleanTitle, evidence }, ts);
      return { id, outcome: "refreshed" as const, used: counters.park, cap };
    }
    if (counters.park >= cap) {
      throw new Error(
        cap === 0
          ? `co-seat "${seat.id}" may not park items (park_per_day is 0)`
          : `co-seat "${seat.id}" has parked ${counters.park} of ${cap} items today; park_per_day is reached`,
      );
    }
    upsertCoSeatFork(ledger, { id, project, title: cleanTitle, evidence }, ts);
    counters.park += 1;
    writeCounters(ctx.dir, counters);
    return { id, outcome: "added" as const, used: counters.park, cap };
  });
}

/**
 * Count one Aide door send against `aide_messages_per_day`; throws a plain
 * refusal past the cap. Counted before the send is attempted, under a lock, so
 * concurrent sends cannot exceed the cap.
 */
export function consumeAideMessage(
  ctx: Pick<SeatContext, "seat" | "dir">,
  nowMs: number = Date.now(),
): { used: number; cap: number } {
  const cap = ctx.seat.authority.aide_messages_per_day;
  return withDirLock(countersLockPath(ctx.dir), () => {
    const counters = readCounters(ctx.dir, localDay(nowMs));
    if (counters.aide >= cap) {
      throw new Error(
        cap === 0
          ? `co-seat "${ctx.seat.id}" may not message Aides (aide_messages_per_day is 0)`
          : `co-seat "${ctx.seat.id}" has sent ${counters.aide} of ${cap} Aide messages today; aide_messages_per_day is reached`,
      );
    }
    counters.aide += 1;
    writeCounters(ctx.dir, counters);
    return { used: counters.aide, cap };
  });
}
