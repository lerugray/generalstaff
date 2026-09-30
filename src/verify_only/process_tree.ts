// Verification commands inherit the CLI's group. Only a group led by this
// process is ours to sweep; never signal a terminal's or another caller's group.
import { readFileSync, readdirSync } from "fs";

let darwin: ReturnType<typeof openDarwin> | undefined;
function openDarwin() {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
    proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  return { symbols: lib.symbols, ptr };
}
function linuxGroup(pid: number): number {
  // comm may contain spaces and parentheses; fields after its LAST ')' start
  // at state, ppid, pgrp. Read a PID's own kernel record, never command text.
  return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) (?=[A-Z] )/).at(-1)!.split(" ")[2]);
}
export function verificationTreeId(): number {
  if (process.platform === "darwin") return (darwin ??= openDarwin()).symbols.getpgid(0);
  if (process.platform === "linux") return linuxGroup(process.pid);
  return process.pid;
}
/** null means enumeration is not proven, never an empty tree. */
export function verificationGroupMembers(): number[] | null {
  const group = verificationTreeId();
  if (group !== process.pid) return null;
  try {
    if (process.platform === "darwin") {
      const lib = darwin ??= openDarwin();
      let size = 256;
      for (; size <= 1_048_576; size *= 2) {
        const ids = new Int32Array(size);
        // PROC_PGRP_ONLY: scoped to our group (no system-wide ps permission).
        const bytes = lib.symbols.proc_listpids(2, group, lib.ptr(ids), ids.byteLength);
        if (bytes <= 0) return null;
        if (bytes >= ids.byteLength) continue;
        return Array.from(ids.subarray(0, bytes / 4)).filter(pid => pid > 0 && pid !== process.pid);
      }
      return null;
    }
    if (process.platform === "linux") {
      const members: number[] = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
        try { if (linuxGroup(Number(entry)) === group) members.push(Number(entry)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") return null; }
      }
      return members;
    }
  } catch { /* fail closed */ }
  return null;
}
export function signalVerificationMembers(signal: NodeJS.Signals): void {
  const members = verificationGroupMembers();
  if (members === null) return;
  for (const pid of members) {
    // Recheck group immediately before signalling: a recycled PID outside our
    // still-live group is not owned by us.
    try {
      const group = process.platform === "darwin"
        ? (darwin ??= openDarwin()).symbols.getpgid(pid) : linuxGroup(pid);
      if (group === process.pid) process.kill(pid, signal);
    } catch { /* exited between enumeration and signal */ }
  }
}
