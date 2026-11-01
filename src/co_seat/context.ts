// GeneralStaff — co-seats: load a seat's context from projects.yaml.

import { getRootDir } from "../state";
import { loadProjectsYaml } from "../projects";
import { buildSeatContext, findSeat, type SeatContext } from "./config";

export interface LoadSeatOptions {
  /** Skip the per-project path warnings (long-running callers reload every tick). */
  quiet?: boolean;
  yamlPath?: string;
}

/**
 * Load and validate projects.yaml and return the context for one seat. `id`
 * may be omitted when exactly one seat is declared. Throws one plain-line
 * Error when the config is invalid or the seat is not declared.
 */
export async function loadSeatContext(id?: string, opts: LoadSeatOptions = {}): Promise<SeatContext> {
  const yaml = await loadProjectsYaml(opts.yamlPath, { quiet: opts.quiet });
  const seat = findSeat(yaml, id);
  return buildSeatContext(yaml, seat, getRootDir());
}
