// GeneralStaff — co-seats (DESIGN.md §v11): defaults, seat lookup, paths, config pin.
//
// Pure helpers only. The YAML validator lives in src/projects.ts (it needs the
// parsed project list); loading a context from disk lives in ./context.ts.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { getRootDir, getStateDir } from "../state";
import type {
  CoSeatConfig,
  DispatcherConfig,
  ProjectConfig,
  ProjectsYaml,
} from "../types";

// The defaults and path helpers live in ./defaults (no src/state import), so
// src/projects.ts can use them without pulling this module's state imports into
// every graph that loads the project registry.
export {
  CO_SEAT_AUTHORITY_DEFAULTS,
  CO_SEAT_DEFAULTS,
  CO_SEAT_WAKE_DEFAULTS,
  isInsidePath,
} from "./defaults";

/** The driver ticks this often (DESIGN.md §v11 "The driver"). */
export const TICK_MS = 60_000;
/** Wait before re-checking when no runner is available. */
export const NO_RUNNER_WAIT_MS = 600_000;
/** In-flight checks while a turn runs. */
export const LOCAL_STOP_CHECK_MS = 10_000;
export const REMOTE_STOP_CHECK_MS = 60_000;
/** Meter commands get this long before they read as 100. */
export const METER_TIMEOUT_MS = 15_000;

/** The six fixed headings every state file keeps (`## ` level). */
export const REQUIRED_STATE_HEADINGS = [
  "Open items",
  "Owned work",
  "Waiting on",
  "Held by a person",
  "Parked",
  "Last turn",
] as const;

/** Everything one driver tick, command or guard needs about a seat. */
export interface SeatContext {
  seat: CoSeatConfig;
  dispatcher: DispatcherConfig;
  /** Every registered project, in registry order. */
  allProjects: ProjectConfig[];
  /** The seat's own projects (full config objects), in the seat's order. */
  projects: ProjectConfig[];
  /** The GeneralStaff root dir (cwd for runners and meters). */
  root: string;
  /** `<stateDir>/_co-seat/<id>/` */
  dir: string;
  briefPath: string;
  statePath: string;
}

/** `<stateDir>/_co-seat/<id>/` — every driver file for one seat lives here. */
export function seatDir(id: string, dispatcher?: DispatcherConfig): string {
  return join(getStateDir(dispatcher), "_co-seat", id);
}

/** Resolve a config path against the GeneralStaff root. */
export function resolveSeatPath(root: string, p: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}

/**
 * The seat to act on. `id` may be omitted only when exactly one seat is
 * declared. Throws one plain line otherwise.
 */
export function findSeat(
  yaml: Pick<ProjectsYaml, "dispatcher">,
  id?: string,
): CoSeatConfig {
  const seats = yaml.dispatcher.co_seats ?? [];
  if (seats.length === 0) {
    throw new Error("no co-seats are declared under dispatcher.co_seats in projects.yaml");
  }
  if (id === undefined || id === "") {
    if (seats.length === 1) return seats[0]!;
    throw new Error(
      `several co-seats are declared (${seats.map((s) => s.id).join(", ")}); pass --id=<id>`,
    );
  }
  const seat = seats.find((s) => s.id === id);
  if (!seat) {
    throw new Error(
      `co-seat "${id}" is not declared (declared: ${seats.map((s) => s.id).join(", ")})`,
    );
  }
  return seat;
}

export function buildSeatContext(
  yaml: ProjectsYaml,
  seat: CoSeatConfig,
  root: string = getRootDir(),
): SeatContext {
  const byId = new Map(yaml.projects.map((p) => [p.id, p]));
  const projects: ProjectConfig[] = [];
  for (const id of seat.projects) {
    const p = byId.get(id);
    if (!p) throw new Error(`co-seat "${seat.id}": project "${id}" is not registered`);
    projects.push(p);
  }
  return {
    seat,
    dispatcher: yaml.dispatcher,
    allProjects: yaml.projects,
    projects,
    root,
    dir: seatDir(seat.id, yaml.dispatcher),
    briefPath: resolveSeatPath(root, seat.brief),
    statePath: resolveSeatPath(root, seat.state_file),
  };
}

// --- Config pin ---

/** JSON with every object's keys sorted and undefined dropped: a stable hash input. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[k];
        if (item !== undefined) out[k] = norm(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The pin `go` records: sha256 over the seat block, the full config of each of
 * its projects (auto_merge and hands_off included), the brief bytes and
 * `dispatcher.state_dir` (so the seat directory cannot move under a running
 * seat). If any changes, turns hold until a person runs `go` again.
 */
export function configPin(
  seat: CoSeatConfig,
  projects: ProjectConfig[],
  briefText: string | Uint8Array,
  stateDir: string = "",
): string {
  const sorted = [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(
    canonicalJson({ seat, projects: sorted, brief_sha256: sha256Hex(briefText), state_dir: stateDir }),
  );
}

/** The pin of a loaded context, reading the brief from disk now. Throws if the brief cannot be read. */
export function pinOfContext(ctx: SeatContext): string {
  return configPin(ctx.seat, ctx.projects, readFileSync(ctx.briefPath), ctx.dispatcher.state_dir);
}

// --- Small shared helpers ---

/** `YYYY-MM-DD` in local time (the "local day" the daily caps count in). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The six required `## ` headings missing from a state file's text. */
export function missingStateHeadings(text: string): string[] {
  const present = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) present.add(m[1]!.toLowerCase());
  }
  return REQUIRED_STATE_HEADINGS.filter((h) => !present.has(h.toLowerCase()));
}
