// A Windows job tracks descendants even after intermediate parents exit.
// The child wrapper joins before spawning the target, avoiding the race in
// assigning an already-running target process to a job.
import { randomUUID } from "crypto";
import { win32 } from "path";

export interface WindowsJob {
  name: string;
  activeProcesses(): number;
  terminate(): void;
  close(): void;
}

let native: ReturnType<typeof openKernel> | undefined;

function openKernel() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Windows job containment requires 64-bit Windows");
  }
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows job containment requires an absolute SystemRoot");
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  // HANDLE is an opaque integer, not a pointer (notably the -1 pseudo-handle).
  const { symbols } = dlopen(win32.join(root, "System32", "kernel32.dll"), {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    SetLastError: { args: [FFIType.u32], returns: FFIType.void },
  });
  return { symbols, ptr };
}

function kernel() { return native ??= openKernel(); }
function nativeError(operation: string, code = kernel().symbols.GetLastError()): Error {
  return new Error(`${operation} failed (Win32 error ${code})`);
}

/** The parent owns this handle until shutdown is proven, then closes it. */
export function createWindowsJob(): WindowsJob {
  const { symbols, ptr } = kernel();
  const name = `Local\\GeneralStaff-verify-${process.pid}-${randomUUID()}`;
  const encoded = Buffer.from(`${name}\0`, "utf16le");
  symbols.SetLastError(0);
  const handle = symbols.CreateJobObjectW(null, ptr(encoded));
  const createError = symbols.GetLastError();
  if (handle === 0n) throw nativeError("CreateJobObjectW", createError);
  if (createError === 183) {
    symbols.CloseHandle(handle);
    throw nativeError("CreateJobObjectW (job name already exists)", createError);
  }
  // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes; LimitFlags at 16.
  // Neither BREAKAWAY flag is enabled. The parent's handle is not inherited.
  const limits = new BigUint64Array(18);
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE
  if (!symbols.SetInformationJobObject(handle, 9, ptr(limits), limits.byteLength)) {
    const error = nativeError("SetInformationJobObject");
    symbols.CloseHandle(handle);
    throw error;
  }
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Windows job handle is already closed");
  };
  return {
    name,
    activeProcesses() {
      assertOpen();
      // BASIC_ACCOUNTING_INFORMATION is class 1, 48 bytes; ActiveProcesses 40.
      const accounting = new BigUint64Array(6);
      if (!symbols.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.byteLength, null)) {
        throw nativeError("QueryInformationJobObject");
      }
      return new DataView(accounting.buffer).getUint32(40, true);
    },
    terminate() {
      assertOpen();
      if (!symbols.TerminateJobObject(handle, 1)) throw nativeError("TerminateJobObject");
    },
    close() {
      if (closed) return;
      if (!symbols.CloseHandle(handle)) throw nativeError("CloseHandle(job)");
      closed = true;
    },
  };
}

/** Called only inside the wrapper, before the target can execute any code. */
export function assignCurrentProcessToWindowsJob(name: string): void {
  const { symbols, ptr } = kernel();
  const encoded = Buffer.from(`${name}\0`, "utf16le");
  const handle = symbols.OpenJobObjectW(0x0001, 0, ptr(encoded)); // JOB_OBJECT_ASSIGN_PROCESS
  if (handle === 0n) throw nativeError("OpenJobObjectW");
  const current = symbols.GetCurrentProcess();
  if (!symbols.AssignProcessToJobObject(handle, current)) {
    const error = nativeError("AssignProcessToJobObject");
    symbols.CloseHandle(handle);
    throw error;
  }
  // Leave the parent as the only handle owner: its death must kill the job.
  if (!symbols.CloseHandle(handle)) throw nativeError("CloseHandle(child job)");
}
