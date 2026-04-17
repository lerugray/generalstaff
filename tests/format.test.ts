import { describe, it, expect } from "bun:test";
import {
  formatDuration,
  formatBytes,
  formatPercent,
  formatRelativeTime,
} from "../src/format";

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

  it("floors fractional sub-kilobyte values (gs-060 convention)", () => {
    expect(formatBytes(1023.5)).toBe("1023 B");
    expect(formatBytes(999.9)).toBe("999 B");
    expect(formatBytes(0.4)).toBe("0 B");
    expect(formatBytes(1.99)).toBe("1 B");
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

describe("formatPercent", () => {
  it("renders representative ratios", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.42)).toBe("42%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("rounds to the nearest integer", () => {
    expect(formatPercent(0.425)).toBe("43%");
    expect(formatPercent(0.4249)).toBe("42%");
    expect(formatPercent(0.999)).toBe("100%");
    expect(formatPercent(0.001)).toBe("0%");
  });

  it("handles ratios above 1", () => {
    expect(formatPercent(1.5)).toBe("150%");
    expect(formatPercent(2)).toBe("200%");
  });

  it("returns ? for invalid inputs", () => {
    expect(formatPercent(NaN)).toBe("?");
    expect(formatPercent(Infinity)).toBe("?");
    expect(formatPercent(-Infinity)).toBe("?");
    expect(formatPercent(-0.1)).toBe("?");
    expect(formatPercent(-1)).toBe("?");
  });
});

describe("formatRelativeTime", () => {
  // Fixed "now" for deterministic bucket tests: Thu 2026-04-17 14:30:00 local.
  const now = new Date(2026, 3, 17, 14, 30, 0);
  const relative = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000).toISOString();

  it("renders sub-minute past as 'just now'", () => {
    expect(formatRelativeTime(relative(0), now)).toBe("just now");
    expect(formatRelativeTime(relative(30), now)).toBe("just now");
    expect(formatRelativeTime(relative(59), now)).toBe("just now");
  });

  it("renders sub-hour past in minutes", () => {
    expect(formatRelativeTime(relative(60), now)).toBe("1 min ago");
    expect(formatRelativeTime(relative(180), now)).toBe("3 min ago");
    expect(formatRelativeTime(relative(3599), now)).toBe("59 min ago");
  });

  it("renders same-calendar-day past in hours", () => {
    // 2h30m ago is same day (14:30 -> 12:00)
    expect(formatRelativeTime(relative(2 * 3600 + 1800), now)).toBe("2h ago");
    // 14h ago is same day (14:30 -> 00:30)
    expect(formatRelativeTime(relative(14 * 3600), now)).toBe("14h ago");
  });

  it("renders prior calendar day as 'yesterday at HH:MM'", () => {
    // Yesterday 23:45 (2026-04-16 23:45)
    const yesterday = new Date(2026, 3, 16, 23, 45, 0).toISOString();
    expect(formatRelativeTime(yesterday, now)).toBe("yesterday at 23:45");
    // Yesterday 09:05 — pads minutes
    const yesterdayMorning = new Date(2026, 3, 16, 9, 5, 0).toISOString();
    expect(formatRelativeTime(yesterdayMorning, now)).toBe(
      "yesterday at 09:05",
    );
  });

  it("renders older past in days", () => {
    // 3 calendar days ago
    const threeDaysAgo = new Date(2026, 3, 14, 14, 30, 0).toISOString();
    expect(formatRelativeTime(threeDaysAgo, now)).toBe("3 days ago");
    // 30 days ago
    const thirtyDaysAgo = new Date(2026, 2, 18, 14, 30, 0).toISOString();
    expect(formatRelativeTime(thirtyDaysAgo, now)).toBe("30 days ago");
  });

  it("renders near-future as 'in N min'", () => {
    const future = (secondsAhead: number) =>
      new Date(now.getTime() + secondsAhead * 1000).toISOString();
    expect(formatRelativeTime(future(30), now)).toBe("just now");
    expect(formatRelativeTime(future(60), now)).toBe("in 1 min");
    expect(formatRelativeTime(future(180), now)).toBe("in 3 min");
  });

  it("renders far-future in hours and days", () => {
    const future = (secondsAhead: number) =>
      new Date(now.getTime() + secondsAhead * 1000).toISOString();
    expect(formatRelativeTime(future(3600), now)).toBe("in 1h");
    expect(formatRelativeTime(future(5 * 3600), now)).toBe("in 5h");
    expect(formatRelativeTime(future(2 * 86400), now)).toBe("in 2 days");
  });

  it("returns ? for invalid inputs", () => {
    expect(formatRelativeTime("not a date", now)).toBe("?");
    expect(formatRelativeTime("", now)).toBe("?");
    expect(formatRelativeTime("2026-13-99T99:99:99Z", now)).toBe("?");
  });
});
