// GeneralStaff — co-seats: config defaults and pure path helpers.
//
// Deliberately free of any src/state import: src/projects.ts (which loads the
// registry in nearly every command) imports this, and several test helpers
// replace src/state with a partial mock.

import { isAbsolute, relative, resolve } from "path";
import type { CoSeatAuthority, CoSeatWake } from "../types";

export const CO_SEAT_AUTHORITY_DEFAULTS: CoSeatAuthority = {
  verify: true,
  land: false,
  park_per_day: 2,
  aide_messages_per_day: 0,
};

export const CO_SEAT_WAKE_DEFAULTS: CoSeatWake = {
  heartbeat_seconds: 1800,
  min_gap_seconds: 300,
  cycles: true,
  aide_inboxes: true,
  done_globs: [],
};

export const CO_SEAT_DEFAULTS = {
  turn_timeout_seconds: 1800,
  run_days: 7,
  max_run_days: 30,
  /** A turn is killed at turn_timeout_seconds; two hours is the ceiling. */
  max_turn_timeout_seconds: 7200,
  remote: "origin",
} as const;

/** True when `child` is `parent` or lies inside it (path-segment aware). */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) return false;
  return !isAbsolute(rel);
}
