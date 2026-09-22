import assert from "node:assert/strict";
import test from "node:test";

import {
  EngineeringAttemptBudget,
  EngineeringCapacityCircuits,
  normalizeEngineeringFailure,
  parseRetryAfter,
} from "../src/engineering/capacity.mjs";

test("normalizes HTTP and semantic failures with dispatch and output state", () => {
  const cases = [
    [{ status: 408 }, "TIMEOUT"],
    [{ status: 409 }, "BUSY"],
    [{ status: 425 }, "BUSY"],
    [{ status: 429 }, "RATE_LIMIT"],
    [{ status: 500 }, "MODEL_UNAVAILABLE"],
    [{ status: 503 }, "MODEL_UNAVAILABLE"],
    [{ status: 401 }, "AUTH"],
    [{ status: 403 }, "ENTITLEMENT"],
    [{ status: 402 }, "BUDGET_EXHAUSTED"],
    [{ code: "ETIMEDOUT", message: "generation timed out", dispatched: false }, "TIMEOUT"],
    [{ code: "bad_schema", message: "malformed response schema", dispatched: true }, "PROTOCOL_ERROR"],
    [{ code: "quality", message: "failed gate: incorrect answer", dispatched: true }, "MODEL_QUALITY_FAILURE"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeEngineeringFailure(input).failureClass, expected);
  }

  const rateLimit = normalizeEngineeringFailure({ status: 429, headers: { "retry-after": "120" } }, {
    retryAfterCapMs: 10_000,
    now: 1_000,
  });
  assert.deepEqual({
    class: rateLimit.failureClass,
    dispatch: rateLimit.dispatchState,
    output: rateLimit.outputState,
    retryable: rateLimit.retryable,
    sameRoute: rateLimit.mayRetrySameRoute,
    switchRoute: rateLimit.maySwitchRoute,
    retryAfterMs: rateLimit.retryAfterMs,
  }, {
    class: "RATE_LIMIT",
    dispatch: "dispatched",
    output: "none",
    retryable: true,
    sameRoute: false,
    switchRoute: true,
    retryAfterMs: 10_000,
  });
});

test("first output byte and ambiguous tool actions prohibit retry and route switching", () => {
  const streamed = normalizeEngineeringFailure({ status: 429 }, { outputBytes: 1 });
  assert.equal(streamed.outputState, "started");
  assert.equal(streamed.retryable, false);
  assert.equal(streamed.mayRetrySameRoute, false);
  assert.equal(streamed.maySwitchRoute, false);
  assert.equal(streamed.requiresReconciliation, true);

  const ambiguousTool = normalizeEngineeringFailure({ status: 503 }, {
    dispatched: true,
    toolActionState: "ambiguous",
  });
  assert.equal(ambiguousTool.retryable, false);
  assert.equal(ambiguousTool.maySwitchRoute, false);
  assert.equal(ambiguousTool.requiresReconciliation, true);

  const transportUnknown = normalizeEngineeringFailure(new Error("connection reset"));
  assert.equal(transportUnknown.dispatchState, "ambiguous");
  assert.equal(transportUnknown.maySwitchRoute, false);
  assert.equal(transportUnknown.requiresReconciliation, true);

  const completedQualityResult = normalizeEngineeringFailure({ message: "failed test gate" }, {
    dispatched: true,
    outputState: "complete",
  });
  assert.equal(completedQualityResult.failureClass, "MODEL_QUALITY_FAILURE");
  assert.equal(completedQualityResult.maySwitchRoute, true, "completed work may enter task-level remediation");
  assert.equal(completedQualityResult.requiresReconciliation, false);
});

test("explicit nonretryable errors stay nonretryable while independent auth fallback remains possible", () => {
  const capacity = normalizeEngineeringFailure({ status: 429, retryable: false });
  assert.equal(capacity.retryable, false);
  assert.equal(capacity.mayRetrySameRoute, false);
  assert.equal(capacity.maySwitchRoute, true);

  const auth = normalizeEngineeringFailure({ status: 401 });
  assert.equal(auth.retryable, false);
  assert.equal(auth.mayRetrySameRoute, false);
  assert.equal(auth.maySwitchRoute, true);

  const schema = normalizeEngineeringFailure({ status: 422, message: "invalid response schema" });
  assert.equal(schema.maySwitchRoute, false);
});

test("Retry-After and total attempt accounting are capped by one task deadline", () => {
  assert.equal(parseRetryAfter("120", { now: 0, capMs: 8_000 }), 8_000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:12 GMT", { now: 5_000, capMs: 20_000 }), 7_000);
  assert.equal(parseRetryAfter("bogus", { now: 0 }), undefined);

  let now = 1_000;
  const budget = new EngineeringAttemptBudget({
    deadlineMs: 5_000,
    attemptLimit: 2,
    retryAfterCapMs: 2_000,
    now: () => now,
  });
  assert.equal(budget.claim({ route: "modal/deepseek", host: "modal", layer: "prism" }).attempt.ordinal, 1);
  assert.equal(budget.boundedDelay(9_000).delayMs, 2_000);
  now = 4_500;
  assert.equal(budget.claim({ route: "cloudflare/glm", host: "cloudflare" }).attempt.ordinal, 2);
  assert.deepEqual(budget.claim({ route: "sol" }), { ok: false, reason: "attempt_limit" });
  assert.equal(budget.boundedDelay(2_000).delayMs, 1_500);
  now = 6_001;
  assert.deepEqual(budget.boundedDelay(1_000), { ok: false, reason: "deadline", delayMs: 0 });
  assert.equal(budget.snapshot().attemptsUsed, 2);
});

test("shared route and host circuits open, admit one half-open probe, and recover", () => {
  let now = 10_000;
  const circuits = new EngineeringCapacityCircuits({
    failureThreshold: 2,
    openMs: 5_000,
    retryAfterCapMs: 8_000,
    now: () => now,
  });
  const failure = normalizeEngineeringFailure({ status: 429 }, {
    dispatched: true,
    retryAfter: "3",
    now,
    retryAfterCapMs: 8_000,
  });
  circuits.recordFailure({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    taskId: "task-a",
    failure,
    at: now,
  });

  const unrelated = circuits.acquire({
    route: "other-modal/model",
    host: "modal",
    taskId: "task-b",
    at: now,
  });
  assert.equal(unrelated.allowed, false);
  assert.equal(unrelated.reason, "circuit_open");
  circuits.recordSuccess({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    taskId: "stale-task",
    at: now,
  });
  assert.equal(circuits.peek({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    at: now,
  }).available, false, "a stale success must not close an open circuit");

  now = 13_001;
  const probe = circuits.acquire({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    taskId: "task-probe",
    at: now,
  });
  assert.equal(probe.allowed, true);
  assert.equal(probe.probe, true);
  assert.equal(circuits.acquire({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    taskId: "task-c",
    at: now,
  }).allowed, false);

  circuits.recordSuccess({
    route: "kiro-prism/deepseek-v4.1-flash",
    host: "modal",
    taskId: "task-probe",
    at: now,
  });
  assert.equal(circuits.acquire({
    route: "other-modal/model",
    host: "modal",
    taskId: "task-d",
    at: now,
  }).allowed, true);
  assert.ok(circuits.snapshot().every((entry) => entry.state === "closed"));
});

test("a failed half-open probe reopens the route and host circuits", () => {
  let now = 0;
  const circuits = new EngineeringCapacityCircuits({ failureThreshold: 1, openMs: 100, now: () => now });
  const failure = normalizeEngineeringFailure({ status: 503 }, { dispatched: true, now });
  circuits.recordFailure({ route: "route", host: "host", taskId: "initial", failure, at: now });
  now = 101;
  assert.equal(circuits.acquire({ route: "route", host: "host", taskId: "probe", at: now }).probe, true);
  circuits.recordFailure({ route: "route", host: "host", taskId: "probe", failure, at: now });
  assert.equal(circuits.acquire({ route: "route", host: "host", taskId: "other", at: now }).allowed, false);
});

test("repeated capacity failures open a circuit even without Retry-After", () => {
  const circuits = new EngineeringCapacityCircuits({ failureThreshold: 2, openMs: 1_000, now: () => 0 });
  const failure = normalizeEngineeringFailure({ status: 503 }, { dispatched: true, now: 0 });
  circuits.recordFailure({ route: "route-a", host: "host-a", failure, at: 0 });
  assert.equal(circuits.peek({ route: "route-a", host: "host-a", at: 0 }).available, true);
  circuits.recordFailure({ route: "route-a", host: "host-a", failure, at: 0 });
  assert.equal(circuits.peek({ route: "route-a", host: "host-a", at: 0 }).available, false);
});
