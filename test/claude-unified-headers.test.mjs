import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claudeSharedRejection,
  parseClaudeUnifiedHeaders,
} from "../src/rate-limit-headers.mjs";

function headers(map) {
  return new Headers(map);
}

const NOW = 1_700_000_000_000;

test("full unified reading parses all windows and statuses", () => {
  const reading = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 3600),
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(NOW / 1000) + 86400),
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d_oi-utilization": "0.1",
    "anthropic-ratelimit-unified-7d_oi-reset": String(Math.floor(NOW / 1000) + 172800),
    "anthropic-ratelimit-unified-7d_oi-status": "allowed",
    "anthropic-ratelimit-unified-status": "allowed",
  }), { now: NOW });
  assert.equal(reading.fiveHour.usedPercent, 25);
  assert.equal(reading.fiveHour.remainingPercent, 75);
  assert.equal(reading.fiveHour.resetsAtMs, Math.floor(NOW / 1000) * 1000 + 3_600_000);
  assert.equal(reading.weekly.usedPercent, 50);
  assert.equal(reading.weekly.remainingPercent, 50);
  assert.equal(reading.fable.usedPercent, 10);
  assert.equal(reading.fable.seenAtMs, NOW);
  assert.equal(reading.status, "allowed");
  assert.deepEqual(reading.windowStatuses, { fiveHour: "allowed", weekly: "allowed", fable: "allowed" });
  assert.equal(reading.observedAtMs, NOW);
});

test("partial readings are allowed and emptiness yields undefined", () => {
  const onlyFiveHour = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
  }), { now: NOW });
  assert.equal(onlyFiveHour.fiveHour.usedPercent, 25);
  assert.equal(onlyFiveHour.weekly, undefined);
  assert.equal(onlyFiveHour.fable, undefined);
  assert.equal(onlyFiveHour.status, undefined);

  assert.equal(parseClaudeUnifiedHeaders(headers({}), { now: NOW }), undefined);
  assert.equal(parseClaudeUnifiedHeaders(undefined, { now: NOW }), undefined);
  assert.equal(parseClaudeUnifiedHeaders(headers({
    "content-type": "application/json",
  }), { now: NOW }), undefined);
});

test("non-integer and non-positive resets are treated as absent", () => {
  const reading = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": "not-a-number",
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": "0",
    "anthropic-ratelimit-unified-7d_oi-reset": "-5",
  }), { now: NOW });
  assert.equal(reading.fiveHour.resetsAtMs, undefined);
  assert.equal(reading.weekly.resetsAtMs, undefined);
  assert.equal(reading.fable, undefined, "utilization absent with an invalid reset alone yields no window");
});

test("fraction utilization maps to percent with rounding and clamping", () => {
  const reading = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.985",
    "anthropic-ratelimit-unified-7d-utilization": "1.15",
  }), { now: NOW });
  assert.equal(reading.fiveHour.usedPercent, 99);
  assert.equal(reading.fiveHour.remainingPercent, 2);
  assert.equal(reading.weekly.usedPercent, 115, "overage may exceed 100");
  assert.equal(reading.weekly.remainingPercent, 0);
});

test("invalid utilization values are ignored, valid resets survive", () => {
  const reading = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-5h-utilization": "abc",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 60),
  }), { now: NOW });
  assert.equal(reading.fiveHour.usedPercent, undefined);
  assert.equal(reading.fiveHour.resetsAtMs, Math.floor(NOW / 1000) * 1000 + 60_000);
});

test("unknown status strings are dropped, known ones kept case-insensitively", () => {
  const reading = parseClaudeUnifiedHeaders(headers({
    "anthropic-ratelimit-unified-status": "ALLOWED_WARNING",
    "anthropic-ratelimit-unified-5h-status": "weird",
  }), { now: NOW });
  assert.equal(reading.status, "allowed_warning");
  assert.equal(reading.windowStatuses.fiveHour, undefined);
});

test("shared rejection: overall rejected with silent shared windows is shared", () => {
  assert.equal(claudeSharedRejection({
    status: "rejected",
    windowStatuses: {},
  }), true);
});

test("shared rejection: 5h rejected names the shared window", () => {
  assert.equal(claudeSharedRejection({
    status: "rejected",
    windowStatuses: { fiveHour: "rejected" },
  }), true);
});

test("shared rejection: only the family window rejected is NOT shared", () => {
  assert.equal(claudeSharedRejection({
    status: "rejected",
    windowStatuses: { fable: "rejected" },
  }), false);
});

test("shared rejection: family rejected but shared allowed is NOT shared", () => {
  assert.equal(claudeSharedRejection({
    status: "rejected",
    windowStatuses: { fiveHour: "allowed", weekly: "allowed", fable: "rejected" },
  }), false);
});

test("shared rejection: allowed overall is never a rejection", () => {
  assert.equal(claudeSharedRejection({
    status: "allowed",
    windowStatuses: { fable: "rejected" },
  }), false);
  assert.equal(claudeSharedRejection(undefined), false);
});
