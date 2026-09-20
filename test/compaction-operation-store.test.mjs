import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CompactionOperationStore,
  compactionOperationId,
  compactionSourceBoundary,
} from "../src/compaction-operation-store.mjs";

function store(filePath, now = () => 1_000) {
  return new CompactionOperationStore({ filePath, now });
}

test("operation identity is stable and sensitive to owner, root, conversation, boundary, model", () => {
  const base = {
    owner: "owner-a",
    rootSession: "root-a",
    conversationBoundary: "conversation-a",
    sourceBoundary: compactionSourceBoundary([{ type: "message", content: "one" }]),
    model: "kiro-prism/gpt-5.6-sol",
  };
  assert.equal(compactionOperationId(base), compactionOperationId({ ...base }));
  for (const changed of [
    { owner: "owner-b" },
    { rootSession: "root-b" },
    { conversationBoundary: "conversation-b" },
    { sourceBoundary: "different" },
    { model: "other" },
  ]) {
    assert.notEqual(compactionOperationId(base), compactionOperationId({ ...base, ...changed }));
  }
});

test("begin is durable single-flight and completed results survive restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-router-compaction-"));
  const filePath = path.join(directory, "operations.json");
  const first = store(filePath);
  const input = {
    id: "cmpop_one",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { orientation: { objective: "continue" } },
  };
  assert.equal(first.begin(input).created, true);
  assert.equal(first.begin(input).created, false);
  first.complete(input.id, input.owner, { orientation: { objective: "done" } });

  const restarted = store(filePath);
  const recovered = restarted.get(input.id, input.owner);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.attemptCount, 1);
  assert.equal(recovered.checkpoint.orientation.objective, "done");
  assert.deepEqual(restarted.snapshot(), {
    retainedOperations: 1,
    states: {
      pending: 0,
      running: 0,
      completed: 1,
      failed_retriable: 0,
      failed_terminal: 0,
      abandoned_or_expired: 0,
    },
    idempotentReuses: 1,
    concurrentDuplicatesPrevented: 1,
    completedAfterDisconnect: 0,
    storedResults: 1,
    storedResultsReattached: 0,
    resultsDelivered: 0,
    resultsInstalled: 0,
    continuationsSubmitted: 0,
    sessionsAutoContinued: 0,
    deterministicFallbacks: 0,
    recoveryLatencyMs: { count: 1, max: 0, average: 0 },
    failuresByCode: {},
    compaction_jobs_created: 1,
    compaction_jobs_deduplicated: 1,
    compaction_jobs_completed: 1,
    compaction_sol_attempts: 0,
    compaction_opus_fallbacks: 0,
    compaction_results_validated: 1,
    compaction_results_reattached: 0,
    compaction_results_installed: 0,
    compaction_sessions_auto_continued: 0,
    compaction_sessions_manual_intervention: 0,
  });
});

test("snapshot distinguishes in-flight duplicate prevention from fallback delivery", () => {
  let now = 100;
  const store = new CompactionOperationStore({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), "compaction-metrics-")), "ops.json"),
    now: () => now,
  });
  const spec = {
    id: "operation-metrics",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "model-a",
    fallbackCheckpoint: { safe: true },
  };
  store.begin(spec);
  now = 125;
  store.begin(spec);
  now = 150;
  store.fail(spec.id, spec.owner, { failureCode: "compaction_transport_timeout" });
  now = 175;
  store.recordFallback(spec.id, spec.owner);
  assert.deepEqual(store.snapshot(), {
    retainedOperations: 1,
    states: {
      pending: 0,
      running: 0,
      completed: 0,
      failed_retriable: 1,
      failed_terminal: 0,
      abandoned_or_expired: 0,
    },
    idempotentReuses: 1,
    concurrentDuplicatesPrevented: 1,
    completedAfterDisconnect: 0,
    storedResults: 0,
    storedResultsReattached: 0,
    resultsDelivered: 0,
    resultsInstalled: 0,
    continuationsSubmitted: 0,
    sessionsAutoContinued: 0,
    deterministicFallbacks: 1,
    recoveryLatencyMs: { count: 1, max: 75, average: 75 },
    failuresByCode: { compaction_transport_timeout: 1 },
    compaction_jobs_created: 1,
    compaction_jobs_deduplicated: 1,
    compaction_jobs_completed: 0,
    compaction_sol_attempts: 0,
    compaction_opus_fallbacks: 0,
    compaction_results_validated: 0,
    compaction_results_reattached: 0,
    compaction_results_installed: 0,
    compaction_sessions_auto_continued: 0,
    compaction_sessions_manual_intervention: 0,
  });
});

test("owner mismatch fails closed and stale running work becomes retriable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-router-compaction-"));
  const filePath = path.join(directory, "operations.json");
  let now = 1_000;
  const first = store(filePath, () => now);
  first.begin({
    id: "cmpop_private",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { safe: true },
  });
  assert.throws(
    () => first.get("cmpop_private", "owner-b"),
    (error) => error.code === "compaction_operation_conflict",
  );
  now = 2_000;
  const restarted = store(filePath, () => now);
  const recovered = restarted.get("cmpop_private", "owner-a");
  assert.equal(recovered.state, "failed_retriable");
  assert.equal(recovered.failureCode, "compaction_router_restart");
  const reclaimed = restarted.begin({
    id: "cmpop_private",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { safe: true },
  });
  assert.equal(reclaimed.created, true);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.operation.state, "running");
  assert.equal(reclaimed.operation.attemptCount, 2);
});

test("delivery and accepted continuation are recorded separately", () => {
  let now = 10;
  const operations = new CompactionOperationStore({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), "compaction-delivery-")), "ops.json"),
    now: () => now,
  });
  const spec = {
    id: "cmpop_delivery",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { safe: true },
  };
  operations.begin(spec);
  now = 20;
  operations.complete(spec.id, spec.owner, { complete: true });
  now = 30;
  operations.recordDelivered(spec.id, spec.owner, { reattached: true });
  let current = operations.get(spec.id, spec.owner);
  assert.equal(current.deliveredAt, 30);
  assert.equal(current.installedAt, null);
  assert.equal(current.continuationAcceptedAt, null);
  now = 40;
  operations.recordContinuationSubmitted(spec.owner, spec.rootSession);
  current = operations.get(spec.id, spec.owner);
  assert.equal(current.installedAt, 40);
  assert.equal(current.continuationSubmittedAt, 40);
  now = 50;
  operations.recordContinuationAccepted(spec.owner, spec.rootSession);
  current = operations.get(spec.id, spec.owner);
  assert.equal(current.installedAt, 40);
  assert.equal(current.continuationAcceptedAt, 50);
  assert.equal(operations.snapshot().storedResultsReattached, 1);
  assert.equal(operations.snapshot().continuationsSubmitted, 1);
  assert.equal(operations.snapshot().sessionsAutoContinued, 1);
});

test("records model attempts and exposes the requested end-to-end metric names", () => {
  const operations = new CompactionOperationStore({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), "compaction-attempts-")), "ops.json"),
    now: () => 10,
  });
  const spec = {
    id: "cmpop_attempts",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "kiro-prism/gpt-5.6-sol",
    fallbackCheckpoint: { safe: true },
  };
  operations.begin(spec);
  operations.recordModelAttempts(spec.id, spec.owner, [
    "kiro-prism/gpt-5.6-sol",
    "kiro-prism/claude-opus-5",
  ]);
  operations.complete(spec.id, spec.owner, { complete: true });
  operations.recordDelivered(spec.id, spec.owner, { reattached: true });
  operations.recordContinuationSubmitted(spec.owner, spec.rootSession);
  operations.recordContinuationAccepted(spec.owner, spec.rootSession);
  const metrics = operations.snapshot();
  assert.equal(metrics.compaction_jobs_created, 1);
  assert.equal(metrics.compaction_jobs_completed, 1);
  assert.equal(metrics.compaction_sol_attempts, 1);
  assert.equal(metrics.compaction_opus_fallbacks, 1);
  assert.equal(metrics.compaction_results_validated, 1);
  assert.equal(metrics.compaction_results_reattached, 1);
  assert.equal(metrics.compaction_results_installed, 1);
  assert.equal(metrics.compaction_sessions_auto_continued, 1);
  assert.equal(metrics.compaction_sessions_manual_intervention, 0);
});
