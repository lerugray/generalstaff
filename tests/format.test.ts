import { describe, it, expect } from "bun:test";
import { formatDuration, formatBytes } from "../src/format";

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

describe("formatBytes", () => {
  it("renders sub-kilobyte values as integer bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders kilobytes with one decimal place", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1023)).toBe("1023.0 KB");
  });

  it("renders megabytes with one decimal place", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2.0 MB");
    expect(formatBytes(1024 * 1024 * 1023)).toBe("1023.0 MB");
  });

  it("renders gigabytes with one decimal place", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 3 * 3)).toBe("3.0 GB");
  });

  it("returns ? for invalid inputs", () => {
    expect(formatBytes(-1)).toBe("?");
    expect(formatBytes(NaN)).toBe("?");
    expect(formatBytes(Infinity)).toBe("?");
    expect(formatBytes(-Infinity)).toBe("?");
  });
});
