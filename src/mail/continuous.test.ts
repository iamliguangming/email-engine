import assert from "node:assert/strict";
import test from "node:test";
import {
  continuousDue,
  DEFAULT_CONTINUOUS_INTERVAL_SECONDS,
  parseContinuousIntervalSeconds,
} from "./continuous.js";

test("continuous interval defaults to 180 seconds and validates bounds", () => {
  assert.equal(DEFAULT_CONTINUOUS_INTERVAL_SECONDS, 180);
  assert.equal(parseContinuousIntervalSeconds(undefined), 180);
  assert.equal(parseContinuousIntervalSeconds(""), 180);
  assert.equal(parseContinuousIntervalSeconds("300"), 300);
  assert.equal(parseContinuousIntervalSeconds("30"), 30);
  assert.equal(parseContinuousIntervalSeconds("0"), 0);
  assert.throws(() => parseContinuousIntervalSeconds("29"), /between 30 and 86400/);
  assert.throws(() => parseContinuousIntervalSeconds("1.5"), /between 30 and 86400/);
  assert.throws(() => parseContinuousIntervalSeconds("-1"), /between 30 and 86400/);
  assert.throws(() => parseContinuousIntervalSeconds("abc"), /between 30 and 86400/);
  assert.throws(() => parseContinuousIntervalSeconds("86401"), /between 30 and 86400/);
});

test("continuousDue only allows a new scan after the interval", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  assert.equal(continuousDue(null, now, 180), true);
  assert.equal(continuousDue(undefined, now, 180), true);
  assert.equal(
    continuousDue(new Date(now - 179_000).toISOString(), now, 180),
    false,
  );
  assert.equal(
    continuousDue(new Date(now - 180_000).toISOString(), now, 180),
    true,
  );
  assert.equal(continuousDue(new Date(now - 1_000), now, 0), true);
});
