import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { quotaExhaustionProjection } from "../public/lib.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
// A ten-hour window that opened exactly ten hours ago.
const RESET_AT = new Date(NOW + 2 * HOUR).toISOString();
function windowAt({
  usedPercent = 10,
  remainingPercent = 90,
  durationMinutes = 720,
  resetAt = RESET_AT,
  observedAt = new Date(NOW).toISOString(),
  status = "live",
} = {}) {
  return quotaExhaustionProjection({
    usedPercent, remainingPercent, durationMinutes, resetAt, observedAt, status,
    now: NOW,
  });
}

test("the owner-confirmed ratio uses elapsed time over used share, then the remaining share", () => {
  // Twelve-hour window, ten hours elapsed, ten percent used: the pace implies
  // 12 / 10 * 90 = 108 hours of supply, and the reset is two hours away.
  const projection = windowAt({ durationMinutes: 720 });
  assert.equal(projection.state, "projected");
  assert.equal(projection.elapsedHours, 10);
  assert.equal(projection.usedPercent, 10);
  assert.equal(projection.remainingPercent, 90);
  assert.ok(Math.abs(projection.remainingHours - 90) < 1e-9,
    "10 h elapsed at 10% used implies 90 h left, not a slope-based pace");
  assert.equal(projection.projectedAt, NOW + 90 * HOUR);
  assert.equal(projection.beforeReset, false, "the reset happens long before this pace runs out");
});

test("the projection is anchored at the window start, not at the observation", () => {
  // The same used share observed five hours ago covers five fewer elapsed hours,
  // so the estimate stays bound to the reading instead of extending to now.
  const fresh = windowAt({ observedAt: new Date(NOW).toISOString() });
  const older = windowAt({ observedAt: new Date(NOW - 5 * HOUR).toISOString() });
  assert.equal(older.elapsedHours, 5);
  assert.ok(Math.abs(older.remainingHours - 45) < 1e-9);
  assert.equal(older.projectedAt, NOW - 5 * HOUR + 45 * HOUR);
  assert.ok(older.remainingHours < fresh.remainingHours);
});

test("zero usage is not evidence of infinite supply", () => {
  const projection = windowAt({ usedPercent: 0, remainingPercent: 100 });
  assert.equal(projection.state, "no_usage");
  assert.equal(projection.reason, "no_usage");
  assert.equal(projection.remainingHours, null);
  assert.equal(projection.projectedAt, null);
});

test("a fully used or empty window reports exhaustion, never a negative duration", () => {
  for (const shares of [
    { usedPercent: 100, remainingPercent: 0 },
    { usedPercent: 100, remainingPercent: null },
  ]) {
    const used = windowAt({ ...shares, remainingPercent: shares.remainingPercent ?? 0 });
    assert.equal(used.state, "exhausted");
    assert.equal(used.remainingHours, 0);
    assert.equal(used.beforeReset, true);
  }
});

test("missing window groundwork stays explicitly unavailable instead of guessing", () => {
  const cases = [
    [{ resetAt: null }, "no_reset"],
    [{ resetAt: "not-a-date" }, "no_reset"],
    [{ durationMinutes: null }, "no_window_duration"],
    [{ durationMinutes: 0 }, "no_window_duration"],
    [{ usedPercent: null }, "no_share"],
    [{ remainingPercent: null }, "no_share"],
    [{ usedPercent: -1 }, "share_out_of_range"],
    [{ remainingPercent: 101 }, "share_out_of_range"],
    [{ observedAt: "bad" }, "no_observation_time"],
    [{ usedPercent: 10, remainingPercent: 40 }, "inconsistent_share"],
    [{ observedAt: new Date(NOW - 11 * HOUR).toISOString() }, "observation_outside_window"],
    [{ observedAt: new Date(NOW + HOUR).toISOString() }, "observation_in_future"],
    [{ resetAt: new Date(NOW - HOUR).toISOString() }, "window_expired"],
    [{ resetAt: new Date(NOW + 13 * HOUR).toISOString() }, "window_not_started"],
    [{ observedAt: null, status: "stale" }, "no_observation_time"],
    [{ observedAt: null, status: "live" }, "no_observation_time"],
  ];
  for (const [overrides, reason] of cases) {
    const projection = windowAt(overrides);
    assert.notEqual(projection.state, "projected", JSON.stringify(overrides));
    assert.equal(projection.reason, reason, JSON.stringify(overrides));
    assert.equal(projection.projectedAt, null);
    assert.equal(projection.remainingHours, null);
  }
  const noClock = quotaExhaustionProjection({
    usedPercent: 10, remainingPercent: 90, durationMinutes: 720, resetAt: RESET_AT,
    now: Number.NaN,
  });
  assert.equal(noClock.reason, "no_clock");
  // A window opened moments ago has no elapsed evidence to extrapolate from.
  const justOpened = quotaExhaustionProjection({
    usedPercent: 10, remainingPercent: 90, durationMinutes: 720,
    resetAt: new Date(NOW + 720 * 60_000).toISOString(),
    observedAt: new Date(NOW).toISOString(), now: NOW,
  });
  assert.equal(justOpened.reason, "no_elapsed_time");
});

test("a stale observation is projected from its own reading and marked stale", () => {
  const projection = windowAt({ status: "stale", observedAt: new Date(NOW - HOUR).toISOString() });
  assert.equal(projection.stale, true);
  assert.equal(projection.state, "projected");
  assert.equal(projection.elapsedHours, 9);
  assert.ok(Math.abs(projection.remainingHours - 81) < 1e-9);
  // The unavailable states keep the same marker so a stale gap is not shown
  // as a fresh unknown.
  assert.equal(windowAt({ status: "stale", resetAt: null }).stale, true);
});

test("a projection that outlasts the window is reported as outlasting the reset", () => {
  // Two hours in, one percent used: 2 / 1 * 99 = 198 hours, far past the reset.
  const projection = windowAt({
    usedPercent: 1, remainingPercent: 99, durationMinutes: 24 * 60,
    resetAt: new Date(NOW + 22 * HOUR).toISOString(),
    observedAt: new Date(NOW).toISOString(),
  });
  assert.equal(projection.state, "projected");
  // 2 h elapsed at 1% used implies 198 h of supply, to be compared with the
  // 22 h left before the reset.
  assert.ok(Math.abs(projection.remainingHours - 198) < 1e-9);
  assert.equal(projection.beforeReset, false);
});

test("the dashboard renders the projection on every allowance card, including unknown states", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderQuotaExhaustionProjection(");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("\nfunction providerReportedPlanEvidence"));
  // Every branch is a fixed product string, not interpolated evidence text.
  for (const key of [
    "allowance.projection",
    "allowance.projectionValue",
    "allowance.projectionCaption",
    "allowance.projectionExhausted",
    "allowance.projectionNoUsage",
    "allowance.projectionUnavailable",
    "allowance.projectionStale",
    "allowance.projectionBeforeReset",
    "allowance.projectionAfterReset",
  ]) {
    assert.ok(body.includes(`"${key}"`), key);
  }
  assert.match(body, /quotaExhaustionProjection\(\{/u);
  assert.match(body, /dataset\.projectionState = projection\.state/u);
  assert.match(body, /dataset\.projectionStale = String\(projection\.stale === true\)/u);
  // The card must render it, and must keep the unknown reading unsubstituted.
  const cards = source.slice(source.indexOf("function renderQuotaCards("), start);
  assert.match(cards, /renderQuotaExhaustionProjection\(window, \{ remainingPercent: remaining \}\)/u);
  assert.doesNotMatch(body, /Math\.max\(0, projection\.remainingHours\)|\|\| 0/u);
});

test("every projection message is translated for each shipped locale", async () => {
  const { translate } = await import("../public/localization.js");
  const { SUPPORTED_LOCALES } = await import("../public/localization.js");
  const values = { duration: "12 h", percent: "10%" };
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "allowance.projection",
      "allowance.projectionValue",
      "allowance.projectionCaption",
      "allowance.projectionExhausted",
      "allowance.projectionExhaustedCaption",
      "allowance.projectionNoUsage",
      "allowance.projectionNoUsageCaption",
      "allowance.projectionUnavailable",
      "allowance.projectionUnavailableCaption",
      "allowance.projectionStale",
      "allowance.projectionStaleCaption",
      "allowance.projectionAfterReset",
      "allowance.projectionBeforeReset",
      "allowance.projectionElapsed",
      "allowance.projectionUsed",
    ]) {
      const copy = translate(key, values, locale);
      assert.notEqual(copy, key, `${locale}: ${key}`);
      assert.doesNotMatch(copy, /\{[a-z]+\}/u, `${locale}: ${key} keeps a placeholder`);
    }
  }
});
