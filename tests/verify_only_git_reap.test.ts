import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import {
  GitReapError, reconcileWindowsGitReap, runGit, runGitRaw,
  type GitProcessDependencies,
} from "../src/verify_only/git";
import { gitFailure } from "../src/verify_only/digest";
import { toRefusal } from "../src/verify_only/refusal";

function fakeGit(
  complete: (child: ChildProcess) => void,
  releaseGroup?: GitProcessDependencies["releaseGroup"],
): GitProcessDependencies {
  return {
    spawn: (() => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null,
        stdout: new PassThrough(), stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      queueMicrotask(() => complete(child));
      return child;
    }) as GitProcessDependencies["spawn"],
    releaseGroup,
  };
}

function completed(code: number, signal: NodeJS.Signals | null = null) {
  return (child: ChildProcess) => {
    child.stdout!.emit("data", Buffer.from("git output"));
    Object.assign(child, { exitCode: signal ? null : code, signalCode: signal });
    child.emit("exit", child.exitCode, signal);
    child.emit("close", child.exitCode, signal);
  };
}

const opts = { cwd: process.cwd(), timeoutMs: 1000 };

describe("Windows git reap race (injected on every OS)", () => {
  it("accepts taskkill not-found only after a PID-gone proof", async () => {
    let probes = 0;
    expect(await reconcileWindowsGitReap(42, { status: 128 }, () => {
      probes++;
      return "gone";
    })).toEqual({ reaped: true });
    expect(probes).toBe(1);
  });

  it("waits for the PID to disappear after not-found, within the cap", async () => {
    let probes = 0;
    const result = await reconcileWindowsGitReap(42, { status: 128 }, () =>
      ++probes === 1 ? "alive" : "gone", 100);
    expect(result.reaped).toBe(true);
    expect(probes).toBe(2);
  });

  it("refuses not-found while the PID remains alive", async () => {
    const result = await reconcileWindowsGitReap(42, { status: 128 }, () => "alive", 0);
    expect(result.reaped).toBe(false);
    expect(result.error).toContain("taskkill exited 128");
  });

  it("a denied PID probe is not proof that the process is gone", async () => {
    expect((await reconcileWindowsGitReap(42, { status: 128 }, () => "unknown", 0)).reaped).toBe(false);
    expect((await reconcileWindowsGitReap(42, undefined, () => "unknown", 0)).reaped).toBe(false);
  });

  it("does not mask other taskkill failures with a dead leader", async () => {
    for (const result of [{ status: 1 }, { status: null, error: new Error("ENOENT") }]) {
      expect((await reconcileWindowsGitReap(42, result, () => "gone", 0)).reaped).toBe(false);
    }
  });

  it("successful taskkill needs no additional probe or process launch", async () => {
    expect(await reconcileWindowsGitReap(42, { status: 0 }, () => {
      throw new Error("unnecessary probe");
    })).toEqual({ reaped: true });
  });

  it("an already-gone leader needs no taskkill result", async () => {
    expect(await reconcileWindowsGitReap(42, undefined, () => "gone")).toEqual({ reaped: true });
  });

  it("post-exit not-found preserves stdout and exit 0 without a spawn error", async () => {
    let releases = 0;
    const result = await runGitRaw([], opts, fakeGit(completed(0), async () => {
      releases++;
      return reconcileWindowsGitReap(42, { status: 128 }, () => "gone");
    }));
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("git output");
    expect(result.reaped).toBe(true);
    expect(result.spawnError).toBeUndefined();
    expect(result.reapError).toBeUndefined();
    expect(releases).toBe(1);
  });

  it("preserves completed status when reaping fails and emits a distinct refusal", async () => {
    const deps = fakeGit(completed(0), async () => ({ reaped: false, error: "reap denied" }));
    const result = await runGitRaw([], opts, deps);
    expect(result.code).toBe(0);
    expect(result.spawnError).toBeUndefined();
    expect(result.reapError).toBe("reap denied");
    expect(result.reaped).toBe(false);
    expect(gitFailure("diff", result).code).toBe("git_reap_failed");
    const err = await runGit([], opts, deps).catch((error) => error);
    expect(err).toBeInstanceOf(GitReapError);
    expect(toRefusal(err)).toMatchObject({ code: "git_reap_failed", message: "reap denied" });
  });
});

describe("git settled exit status", () => {
  it("awaits exit settlement when both close status and exitCode start null", async () => {
    const result = await runGitRaw([], opts, fakeGit((child) => {
      expect(child.exitCode).toBeNull();
      child.emit("close", null, null);
      queueMicrotask(() => {
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
      });
    }));
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("uses the awaited exit value if the property and close argument lag", async () => {
    const result = await runGitRaw([], opts, fakeGit((child) => {
      child.emit("exit", 0, null);
      child.emit("close", null, null);
    }));
    expect(result.code).toBe(0);
  });

  it("keeps a real nonzero exit distinct from a spawn failure", async () => {
    const result = await runGitRaw([], opts, fakeGit(completed(2)));
    expect(result.code).toBe(2);
    expect(result.spawnError).toBeUndefined();
    expect(gitFailure("diff", result)).toMatchObject({ code: "git_failed", message: "git diff exited with code 2" });
  });

  it("retains signal termination and never describes it as exit code null", async () => {
    const result = await runGitRaw([], opts, fakeGit(completed(0, "SIGKILL")));
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(gitFailure("diff", result).message).toBe("git diff was terminated by SIGKILL");
  });

  it("reports an actual spawn error separately", async () => {
    const result = await runGitRaw([], opts, fakeGit((child) => child.emit("error", new Error("ENOENT"))));
    expect(result.spawnError).toBe("ENOENT");
    expect(result.reapError).toBeUndefined();
    expect(gitFailure("diff", result)).toMatchObject({ code: "git_missing", message: "git could not be started (diff)" });
  });
});
