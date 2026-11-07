// Date-bomb check (v0.18.1). With GENERALSTAFF_TEST_CLOCK_SKEW_DAYS=<n> set,
// the system clock reads n days ahead for the whole run, so a test that
// mixes a fixed date with the real clock fails today instead of on the day
// the two drift apart. CI runs the co-seat suites that inject their clock this
// way. File times and child processes keep the real clock, so suites that
// poll the clock or compare against file ages are not run with a skew.

import { setSystemTime } from "bun:test";

const days = Number(process.env.GENERALSTAFF_TEST_CLOCK_SKEW_DAYS ?? "");
if (Number.isFinite(days) && days !== 0) {
  setSystemTime(new Date(Date.now() + days * 86_400_000));
}
