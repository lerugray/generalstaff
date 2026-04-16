import { describe, it, expect } from "bun:test";
import { formatDuration } from "../src/format";

describe("formatDuration", () => {
  it("renders sub-minute values as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("renders minutes-only when seconds component is zero", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(600)).toBe("10m");
  });

  it("renders minutes with seconds when both are nonzero", () => {
    expect(formatDuration(90)).toBe("1m30s");
    expect(formatDuration(150)).toBe("2m30s");
    expect(formatDuration(3599)).toBe("59m59s");
  });

  it("renders hours-only when minutes component is zero", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(7200)).toBe("2h");
  });

  it("renders hours with minutes when both are nonzero", () => {
    expect(formatDuration(3660)).toBe("1h1m");
    expect(formatDuration(4500)).toBe("1h15m");
    expect(formatDuration(7380)).toBe("2h3m");
  });

  it("drops remainder seconds once minutes or hours are shown", () => {
    // 1h 15m 30s — seconds are dropped at hour granularity
    expect(formatDuration(4530)).toBe("1h15m");
    // 2m 30.9s — fractional floored
    expect(formatDuration(150.9)).toBe("2m30s");
  });

  it("floors fractional sub-minute seconds", () => {
    expect(formatDuration(45.9)).toBe("45s");
    expect(formatDuration(0.4)).toBe("0s");
  });

  it("returns ? for invalid inputs", () => {
    expect(formatDuration(-1)).toBe("?");
    expect(formatDuration(NaN)).toBe("?");
    expect(formatDuration(Infinity)).toBe("?");
    expect(formatDuration(-Infinity)).toBe("?");
  });
});
