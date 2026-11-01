// GeneralStaff — co-seats: guards that do not trust the turn (DESIGN.md §v11).
//
// With GS_CO_SEAT=1 in the environment (the driver sets it for every turn):
//   `start` (which clears the fleet STOP), `co-seat go` / `extend` (a turn
//   cannot lift a stop or extend its own life) and `co-seat run` / `watchdog`
//   (a turn cannot start drivers) refuse;
//   every command that dispatches cycles across projects or runs a wizard cycle
//   (`session`, `autonomous`, `welcome`, `engineer-benchmark`) refuses;
//   `cycle`, `cycle verify` and `cycle-redo` refuse any project outside the
//   seat's `projects` (every `--project` value is checked, and only one is
//   allowed), and `cycle verify` also refuses when `authority.verify` is false;
//   `aides say` counts against `aide_messages_per_day` and refuses past it;
//   `co-seat park` is checked the same way as the commands above.
// `co-seat stop` stays allowed. Caps and authority come from the CURRENT config
// only if it still matches the pin recorded by the last `go`: a turn that edits
// projects.yaml or the brief gets no new authority within its own turn.
// Outside a co-seat (GS_CO_SEAT unset) none of this changes any command.

import { resolve } from "path";
import { pinOfContext, type SeatContext } from "./config";
import { loadSeatContext } from "./context";
import { readGo, type GoMarker } from "./control";
import { consumeAideMessage } from "./park";

/** True when this process is running inside a co-seat turn. */
export function inCoSeat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GS_CO_SEAT === "1";
}

export const CONFIG_CHANGED_REFUSAL =
  "the config changed since go (or there is no valid GO); a person must run `generalstaff co-seat go` to accept it";

export type VerifiedSeat =
  | { ok: true; ctx: SeatContext; go: GoMarker }
  | { ok: false; refusal: string };

/**
 * The seat a turn may act as: GS_CO_SEAT_ID's config as it is NOW, but only if
 * it still matches the pin in GO, GO is valid and unexpired, and the seat's
 * state directory is the one the driver is using. Authority (projects, caps,
 * verify) then comes from this validated config, never from an edit made during
 * the turn.
 */
export async function verifySeatForTurn(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<VerifiedSeat> {
  const id = env.GS_CO_SEAT_ID;
  if (!id) return { ok: false, refusal: "not allowed inside a co-seat turn without GS_CO_SEAT_ID" };
  let ctx: SeatContext;
  try {
    ctx = await loadSeatContext(id, { quiet: true });
  } catch (error) {
    return { ok: false, refusal: `cannot check co-seat "${id}": ${(error as Error).message}` };
  }
  if (env.GS_CO_SEAT_DIR && resolve(env.GS_CO_SEAT_DIR) !== resolve(ctx.dir)) {
    return {
      ok: false,
      refusal: `co-seat "${id}" now resolves to a different state directory than its driver uses; a person must run \`generalstaff co-seat go\``,
    };
  }
  const go = readGo(ctx.dir);
  if (go.kind !== "ok") return { ok: false, refusal: CONFIG_CHANGED_REFUSAL };
  let pin: string;
  try {
    pin = pinOfContext(ctx);
  } catch {
    return { ok: false, refusal: CONFIG_CHANGED_REFUSAL };
  }
  if (pin !== go.go.pin) return { ok: false, refusal: CONFIG_CHANGED_REFUSAL };
  if (nowMs >= Date.parse(go.go.deadline)) {
    return { ok: false, refusal: `co-seat "${id}" is past its deadline; a person must run \`generalstaff co-seat extend\`` };
  }
  return { ok: true, ctx, go: go.go };
}

/** `verifySeatForTurn`, throwing the one-line refusal. */
export async function seatForTurn(env: NodeJS.ProcessEnv = process.env): Promise<SeatContext> {
  const v = await verifySeatForTurn(env);
  if (!v.ok) throw new Error(v.refusal);
  return v.ctx;
}

/** A one-line refusal for `generalstaff start`, or null when allowed. */
export function refuseStart(env: NodeJS.ProcessEnv = process.env): string | null {
  return inCoSeat(env)
    ? "generalstaff start is not allowed inside a co-seat turn (it clears the fleet STOP)"
    : null;
}

/** A one-line refusal for `generalstaff session`, or null when allowed. */
export function refuseSession(env: NodeJS.ProcessEnv = process.env): string | null {
  return inCoSeat(env)
    ? "generalstaff session is not allowed inside a co-seat turn (use gated cycles: generalstaff cycle --project=<id>)"
    : null;
}

/** Commands that dispatch cycles across projects, or run a wizard cycle: never inside a turn. */
export const TURN_FORBIDDEN_COMMANDS = ["session", "autonomous", "welcome", "engineer-benchmark"] as const;

/** A one-line refusal for a cycle-dispatching command run inside a turn, or null. */
export function refuseDispatcher(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!inCoSeat(env) || !(TURN_FORBIDDEN_COMMANDS as readonly string[]).includes(command)) return null;
  return `generalstaff ${command} is not allowed inside a co-seat turn (it dispatches cycles beyond the seat's own gated cycles; use generalstaff cycle --project=<id>)`;
}

/** `co-seat` subcommands a turn may not run: go/extend (own stop and life) and run/watchdog (driver start). */
export const TURN_FORBIDDEN_COSEAT = ["go", "extend", "run", "watchdog"] as const;

/** A one-line refusal for a forbidden `co-seat` subcommand inside a turn, or null when allowed. */
export function refuseGoOrExtend(sub: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!inCoSeat(env) || !(TURN_FORBIDDEN_COSEAT as readonly string[]).includes(sub)) return null;
  return sub === "go" || sub === "extend"
    ? `co-seat ${sub} is not allowed inside a co-seat turn (a turn cannot lift a stop or extend its own life)`
    : `co-seat ${sub} is not allowed inside a co-seat turn (a turn cannot start a driver)`;
}

/**
 * EVERY `--project` value in an argv slice, in both spellings (`--project=x`
 * and `--project x`). The commands parse with parseArgs, which keeps the LAST
 * one, so the guard must look at all of them. A flag with no value yields "".
 */
export function extractProjectFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--project") out.push(args[i + 1] ?? "");
    else if (a.startsWith("--project=")) out.push(a.slice("--project=".length));
  }
  return out;
}

export type ProjectCommand = "cycle" | "verify" | "redo";

/**
 * A one-line refusal when a turn runs `cycle`, `cycle verify` or `cycle-redo`
 * with any project outside its seat, with more than one distinct `--project`,
 * under a config that no longer matches the pin, or (for verify) with
 * `authority.verify: false`; null when allowed or not in a co-seat. No
 * `--project` at all is left to the command's own usage error.
 */
export async function refuseProjectCommand(
  kind: ProjectCommand,
  projects: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!inCoSeat(env) || projects.length === 0) return null;
  if (projects.some((p) => p === "")) return "--project needs a project id";
  const distinct = [...new Set(projects)];
  if (distinct.length > 1) {
    return `more than one --project value (${distinct.join(", ")}); a turn names exactly one project`;
  }
  const v = await verifySeatForTurn(env);
  if (!v.ok) return v.refusal;
  const project = distinct[0]!;
  const seat = v.ctx.seat;
  if (!seat.projects.includes(project)) {
    return `co-seat "${seat.id}" may only cycle its own projects (${seat.projects.join(", ")}), not "${project}"`;
  }
  if (kind === "verify" && !seat.authority.verify) {
    return `co-seat "${seat.id}" has authority.verify: false, so it may not run cycle verify`;
  }
  return null;
}

/**
 * Count one `aides say` against the seat's `aide_messages_per_day`; throws a
 * one-line refusal past the cap, when the seat cannot be identified, or when
 * the config no longer matches the pin. A no-op outside a co-seat.
 */
export async function guardAideSay(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!inCoSeat(env)) return;
  consumeAideMessage(await seatForTurn(env));
}
