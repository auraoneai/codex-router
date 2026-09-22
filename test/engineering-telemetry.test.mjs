import assert from "node:assert/strict";
import test from "node:test";

import {
  createEngineeringUsageEvent,
  deduplicateEngineeringUsage,
  engineeringUsageFromRouterEvent,
  normalizeEngineeringUsage,
  summarizeEngineeringUsage,
  usageValue,
} from "../src/engineering/telemetry.mjs";

const correlation = {
  runId: "run-1", taskId: "task-1", attemptId: "attempt-1", role: "debugger",
  sourceRevision: "abc123", family: "deepseek",
};

test("unknown, estimated, and measured usage stay distinct", () => {
  const usage = normalizeEngineeringUsage({
    inputTokens: usageValue("estimated", 10),
    outputTokens: usageValue("measured", 4),
  });
  assert.deepEqual(usage.inputTokens, { kind: "estimated", value: 10 });
  assert.deepEqual(usage.outputTokens, { kind: "measured", value: 4 });
  assert.deepEqual(usage.costMicros, { kind: "unknown" });
  assert.throws(() => usageValue("unknown", 0), /cannot carry/);
});

test("router observations carry engineering correlation without inventing absent counts", () => {
  const event = engineeringUsageFromRouterEvent(correlation, {
    at: "2026-09-22T00:00:00.000Z", model: "deepseek-v4.1-flash", provider: "kiro-prism",
    requestId: "router-1", durationMs: 120, estimatedInputTokens: 8, outputTokens: 3,
  });
  assert.equal(event.runId, "run-1");
  assert.equal(event.routerRequestId, "router-1");
  assert.deepEqual(event.usage.inputTokens, { kind: "estimated", value: 8 });
  assert.deepEqual(event.usage.outputTokens, { kind: "measured", value: 3 });
  assert.deepEqual(event.usage.totalTokens, { kind: "unknown" });
});

test("duplicate provider observations prefer measured usage and are counted once", () => {
  const first = createEngineeringUsageEvent({
    ...correlation, model: "gpt-5.6-sol", provider: "kiro-prism", providerRequestId: "provider-1",
    usage: { inputTokens: usageValue("estimated", 12), outputTokens: usageValue("unknown") },
    source: "router", at: 1,
  });
  const second = createEngineeringUsageEvent({
    ...correlation, model: "gpt-5.6-sol", provider: "kiro-prism", providerRequestId: "provider-1",
    usage: { inputTokens: usageValue("measured", 11), outputTokens: usageValue("measured", 5) },
    source: "prism", at: 2,
  });
  const deduplicated = deduplicateEngineeringUsage([first, second]);
  assert.equal(deduplicated.length, 1);
  assert.deepEqual(deduplicated[0].usage.inputTokens, { kind: "measured", value: 11 });
  assert.deepEqual(deduplicated[0].usage.outputTokens, { kind: "measured", value: 5 });
  assert.deepEqual(deduplicated[0].sources, ["router", "prism"]);
  const summary = summarizeEngineeringUsage([first, second]);
  assert.equal(summary.requests, 1);
  assert.equal(summary.fields.inputTokens.measured, 11);
  assert.equal(summary.fields.outputTokens.measured, 5);
  assert.equal(summary.fields.costMicros.unknown, 1);
});

test("deduplication joins linked request ids within scope and exposes measured conflicts", () => {
  const bridge = createEngineeringUsageEvent({
    ...correlation, model: "gpt-5.6-sol", provider: "kiro-prism",
    providerRequestId: "provider-bridge", routerRequestId: "router-bridge",
    usage: { inputTokens: usageValue("measured", 10) }, source: "router", at: 1,
  });
  const routerOnly = createEngineeringUsageEvent({
    ...correlation, model: "gpt-5.6-sol", provider: "kiro-prism", routerRequestId: "router-bridge",
    usage: { inputTokens: usageValue("measured", 99) }, source: "native", at: 2,
  });
  const merged = deduplicateEngineeringUsage([bridge, routerOnly]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].usage.inputTokens, { kind: "unknown" });
  assert.deepEqual(merged[0].usageConflicts, [{
    field: "inputTokens", kind: "measured_disagreement", values: [10, 99],
  }]);

  const anotherTask = createEngineeringUsageEvent({
    ...correlation, taskId: "task-2", model: "gpt-5.6-sol", provider: "kiro-prism",
    providerRequestId: "provider-bridge", usage: { inputTokens: 10 }, at: 3,
  });
  assert.equal(deduplicateEngineeringUsage([bridge, anotherTask]).length, 2);
});

test("events require immutable engineering identifiers and exact source revision", () => {
  assert.throws(() => createEngineeringUsageEvent({
    taskId: "task-1", attemptId: "attempt-1", role: "worker", sourceRevision: "abc",
    model: "model", provider: "provider", family: "family",
  }), /runId/);
});
