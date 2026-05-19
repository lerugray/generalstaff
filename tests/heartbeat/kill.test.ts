import { describe, expect, it } from "bun:test";
import { escalatingKill } from "../../src/heartbeat/kill";

const instantSleep = async () => {};

describe("escalatingKill", () => {
  it("returns killed without escalation when first kill succeeds", async () => {
    let killCount = 0;
    let alive = true;
    const logs: string[] = [];

    const result = await escalatingKill({
      pid: 42,
      kill: () => {
        killCount++;
        alive = false;
      },
      isRunning: () => alive,
      graceMs: 1,
      sleep: instantSleep,
      log: (msg) => logs.push(msg),
    });

    expect(result).toEqual({ killed: true, escalated: false });
    expect(killCount).toBe(1);
    expect(logs).toHaveLength(0);
  });

  it("escalates when process survives first grace window", async () => {
    let killCount = 0;
    const logs: string[] = [];

    const result = await escalatingKill({
      pid: 99,
      kill: () => {
        killCount++;
      },
      isRunning: (pid) => {
        expect(pid).toBe(99);
        return killCount < 2;
      },
      graceMs: 1,
      sleep: instantSleep,
      log: (msg) => logs.push(msg),
    });

    expect(result).toEqual({ killed: true, escalated: true });
    expect(killCount).toBe(2);
    expect(logs.some((l) => l.includes("ESCALATION"))).toBe(true);
  });

  it("returns killed:false and logs FATAL when process never dies", async () => {
    let killCount = 0;
    const logs: string[] = [];

    const result = await escalatingKill({
      pid: 7,
      kill: () => {
        killCount++;
      },
      isRunning: () => true,
      graceMs: 1,
      sleep: instantSleep,
      log: (msg) => logs.push(msg),
    });

    expect(result).toEqual({ killed: false, escalated: true });
    expect(killCount).toBe(2);
    expect(logs.some((l) => l.includes("FATAL"))).toBe(true);
  });
});
