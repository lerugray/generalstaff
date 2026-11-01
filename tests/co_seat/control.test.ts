import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  clearGo,
  clearStop,
  decideTick,
  goPath,
  localStopPresent,
  readExit,
  readGo,
  defaultGitAsync,
  readRemoteControl,
  runAsync,
  setRemoteMarkers,
  writeExit,
  writeGo,
  writeStop,
  type GoMarker,
  type TickInputs,
} from "../../src/co_seat/control";
import { git, makeControlRepo, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = makeSandbox();
  dir = join(sb.root, "seat");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => sb.cleanup());

const NOW = Date.parse("2026-11-01T12:00:00Z");
const go = (over: Partial<GoMarker> = {}): GoMarker => ({
  version: 1,
  set_at: "2026-11-01T00:00:00Z",
  deadline: "2026-11-08T00:00:00Z",
  pin: "pin-1",
  days: 7,
  ...over,
});
const inputs = (over: Partial<TickInputs> = {}): TickInputs => ({
  now: NOW,
  go: { kind: "ok", go: go() },
  localStop: false,
  fleetStop: false,
  pinNow: "pin-1",
  ...over,
});

describe("decideTick", () => {
  it("is active when everything is in order, with or without remote control", () => {
    expect(decideTick(inputs())).toEqual({ kind: "active" });
    expect(decideTick(inputs({ remote: { state: "ok", go: true, stop: false } }))).toEqual({ kind: "active" });
  });

  it("exits past the deadline (and at it)", () => {
    expect(decideTick(inputs({ go: { kind: "ok", go: go({ deadline: "2026-11-01T11:59:59Z" }) } }))).toEqual({ kind: "exit", reason: "deadline" });
    expect(decideTick(inputs({ go: { kind: "ok", go: go({ deadline: "2026-11-01T12:00:00Z" }) } }))).toEqual({ kind: "exit", reason: "deadline" });
  });

  it("exits on the seat's own STOP", () => {
    expect(decideTick(inputs({ localStop: true }))).toEqual({ kind: "exit", reason: "stop" });
  });

  it("exits when GO is missing or invalid, but STOP is reported first", () => {
    expect(decideTick(inputs({ go: { kind: "missing" } }))).toEqual({ kind: "exit", reason: "no-go" });
    expect(decideTick(inputs({ go: { kind: "invalid", detail: "x" } }))).toEqual({ kind: "exit", reason: "go-invalid" });
    expect(decideTick(inputs({ go: { kind: "missing" }, localStop: true }))).toEqual({ kind: "exit", reason: "stop" });
  });

  it("idles on the fleet STOP", () => {
    expect(decideTick(inputs({ fleetStop: true }))).toEqual({ kind: "idle", reason: "fleet-stop" });
  });

  it("idles on an unreadable remote, a remote STOP, and a missing remote GO", () => {
    expect(decideTick(inputs({ remote: { state: "unreadable", detail: "offline" } }))).toEqual({ kind: "idle", reason: "remote-unreadable" });
    expect(decideTick(inputs({ remote: { state: "ok", go: true, stop: true } }))).toEqual({ kind: "idle", reason: "remote-stop" });
    expect(decideTick(inputs({ remote: { state: "ok", go: false, stop: false } }))).toEqual({ kind: "idle", reason: "remote-no-go" });
  });

  it("idles when the config could not be read, and when the pin changed", () => {
    expect(decideTick(inputs({ pinNow: null }))).toEqual({ kind: "idle", reason: "config-unreadable" });
    expect(decideTick(inputs({ pinNow: "pin-2" }))).toEqual({ kind: "idle", reason: "config-changed" });
  });

  it("orders the rails: deadline > STOP > GO > fleet STOP > remote > pin", () => {
    const expired = { kind: "ok" as const, go: go({ deadline: "2026-01-01T00:00:00Z" }) };
    expect(decideTick(inputs({ go: expired, localStop: true }))).toEqual({ kind: "exit", reason: "deadline" });
    expect(decideTick(inputs({ localStop: true, fleetStop: true }))).toEqual({ kind: "exit", reason: "stop" });
    expect(decideTick(inputs({ fleetStop: true, remote: { state: "ok", go: true, stop: true }, pinNow: "x" }))).toEqual({ kind: "idle", reason: "fleet-stop" });
    expect(decideTick(inputs({ remote: { state: "unreadable", detail: "x" }, pinNow: "x" }))).toEqual({ kind: "idle", reason: "remote-unreadable" });
  });
});

describe("local markers", () => {
  it("GO round-trips and a damaged GO is invalid, never a grant", () => {
    expect(readGo(dir)).toEqual({ kind: "missing" });
    writeGo(dir, go());
    expect(readGo(dir)).toMatchObject({ kind: "ok", go: { pin: "pin-1", days: 7 } });
    writeFileSync(goPath(dir), "{nope");
    expect(readGo(dir)).toMatchObject({ kind: "invalid" });
    writeFileSync(goPath(dir), JSON.stringify({ pin: "p", deadline: "not a date" }));
    expect(readGo(dir)).toMatchObject({ kind: "invalid" });
    writeFileSync(goPath(dir), JSON.stringify({ deadline: "2026-11-08T00:00:00Z" }));
    expect(readGo(dir)).toMatchObject({ kind: "invalid" });
    clearGo(dir);
    expect(readGo(dir)).toEqual({ kind: "missing" });
  });

  it("STOP and EXIT.json", () => {
    expect(localStopPresent(dir)).toBe(false);
    writeStop(dir, NOW);
    expect(localStopPresent(dir)).toBe(true);
    clearStop(dir);
    expect(localStopPresent(dir)).toBe(false);
    expect(readExit(dir)).toBeNull();
    writeExit(dir, { reason: "deadline", at: "2026-11-01T12:00:00Z", detail: "d" });
    expect(readExit(dir)).toEqual({ reason: "deadline", at: "2026-11-01T12:00:00Z", detail: "d" });
    expect(existsSync(join(dir, "EXIT.json"))).toBe(true);
  });
});

describe("remote control markers (a git branch)", () => {
  const rcFor = (repo: string, over: Record<string, string> = {}) => ({
    repo,
    remote: "origin",
    branch: "main",
    dir: "co-seat/main",
    ...over,
  });

  it("reads absent, set and cleared GO and STOP markers", async () => {
    const { repo } = makeControlRepo(sb.root);
    const rc = rcFor(repo);
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: false, stop: false });

    setRemoteMarkers(rc, sb.root, { go: true, stop: false }, "go");
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: true, stop: false });

    setRemoteMarkers(rc, sb.root, { stop: true }, "stop");
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: true, stop: true });

    setRemoteMarkers(rc, sb.root, { go: true, stop: false }, "go again");
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: true, stop: false });

    setRemoteMarkers(rc, sb.root, { go: false }, "clear");
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: false, stop: false });
  });

  it("another checkout sees the pushed marker (it reached the remote, not just the local branch)", () => {
    const { origin, repo } = makeControlRepo(sb.root);
    setRemoteMarkers(rcFor(repo), sb.root, { stop: true }, "stop");
    const peek = join(sb.root, "peek");
    git(sb.root, "clone", "-q", origin, peek);
    expect(existsSync(join(peek, "co-seat", "main", "STOP"))).toBe(true);
  });

  it("setting a marker that is already set makes no new commit", () => {
    const { repo } = makeControlRepo(sb.root);
    const rc = rcFor(repo);
    setRemoteMarkers(rc, sb.root, { go: true }, "go");
    const before = git(repo, "rev-list", "--count", "HEAD");
    setRemoteMarkers(rc, sb.root, { go: true }, "go");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe(before);
  });

  it("pulls with rebase first, so a commit someone else pushed does not block it", async () => {
    const { origin, repo } = makeControlRepo(sb.root);
    const other = join(sb.root, "other");
    git(sb.root, "clone", "-q", origin, other);
    git(other, "config", "user.email", "o@example.invalid");
    git(other, "config", "user.name", "Other");
    writeFileSync(join(other, "note.txt"), "x\n");
    git(other, "add", "note.txt");
    git(other, "commit", "-q", "-m", "note");
    git(other, "push", "-q", "origin", "main");
    setRemoteMarkers(rcFor(repo), sb.root, { go: true }, "go");
    expect(await readRemoteControl(rcFor(repo), sb.root)).toMatchObject({ state: "ok", go: true });
  });

  it("is unreadable when the fetch fails or the branch is missing", async () => {
    const { repo } = makeControlRepo(sb.root);
    const bad = await readRemoteControl(rcFor(repo, { remote: "nowhere" }), sb.root);
    expect(bad.state).toBe("unreadable");
    const noBranch = await readRemoteControl(rcFor(repo, { branch: "no-such-branch" }), sb.root);
    expect(noBranch.state).toBe("unreadable");
    const notRepo = await readRemoteControl(rcFor(join(sb.root, "not-a-repo")), sb.root);
    expect(notRepo.state).toBe("unreadable");
  });

  it("refuses to write when the control repo is on another branch, and never switches it", () => {
    const { repo } = makeControlRepo(sb.root);
    git(repo, "checkout", "-q", "-b", "scratch");
    expect(() => setRemoteMarkers(rcFor(repo), sb.root, { go: true }, "go")).toThrow(/is on branch "scratch", expected "main"/);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scratch");
  });

  it("reports a failed push as one plain error", () => {
    const { repo } = makeControlRepo(sb.root);
    git(repo, "remote", "set-url", "origin", join(sb.root, "gone.git"));
    expect(() => setRemoteMarkers(rcFor(repo), sb.root, { go: true }, "go")).toThrow(/remote control: pull --rebase failed/);
  });
});

describe("reading the remote does not block the event loop", () => {
  it("a slow fetch lets timers (the in-turn stop check) keep running", async () => {
    const slow = async (args: string[]) => {
      await new Promise((r) => setTimeout(r, 400));
      return { status: args.includes("fetch") ? 1 : 0, stdout: "", stderr: "fatal: slow network" };
    };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const state = await readRemoteControl({ repo: join(sb.root, "x"), remote: "origin", branch: "main", dir: "d" }, sb.root, slow);
    clearInterval(timer);
    expect(state).toEqual({ state: "unreadable", detail: "fetch failed: fatal: slow network" });
    expect(ticks).toBeGreaterThan(8); // a blocking spawnSync would have allowed ~0
  });

  it("the default async git runs git, reports its exit status and kills it at the timeout", async () => {
    const ok = await defaultGitAsync(["--version"], 20_000);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("git version");
    const bad = await defaultGitAsync(["definitely-not-a-git-command"], 20_000);
    expect(bad.status).not.toBe(0);
    // A command that never answers is cut off at the timeout.
    const started = Date.now();
    const hang = await runAsync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], 700);
    expect(hang.status).toBeNull();
    expect(hang.stderr).toContain("timed out after 700 ms");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});
