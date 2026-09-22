import assert from "node:assert/strict";
import test from "node:test";

import {
  createEngineeringRecord,
  immutableSnapshot,
  validateEngineeringRecord,
} from "../src/engineering/contracts.mjs";

function taskFields() {
  return {
    runId: "run-1",
    taskId: "task-1",
    objective: "repair the scheduler",
    role: "complex_coder",
    executionHost: "codex-app-server",
    baseRevision: "abc123",
    acceptanceCriteria: ["focused tests pass"],
    dependencies: [],
    ownedPaths: ["src/engineering/"],
    artifactRefs: [],
    policyRevision: 3,
    attemptLimit: 2,
    deadlineMs: 60_000,
    state: "planned",
  };
}

test("engineering records are versioned, strict, and deeply immutable", () => {
  const record = createEngineeringRecord("EngineeringTask", taskFields());
  assert.equal(record.version, 1);
  assert.equal(record.type, "EngineeringTask");
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.acceptanceCriteria), true);
  assert.throws(() => {
    record.acceptanceCriteria.push("mutate");
  }, TypeError);
  assert.throws(() => validateEngineeringRecord("EngineeringTask", {
    ...record,
    surprise: true,
  }), /unsupported field surprise/u);
  assert.throws(() => createEngineeringRecord("EngineeringTask", {
    ...taskFields(),
    state: "worker_says_done",
  }), /state is unsupported/u);
});

test("execution bindings require requested and effective effort provenance", () => {
  const fields = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    bindingId: "binding-1",
    agentType: "router_provider_model",
    model: "provider/model",
    provider: "provider",
    codexProvider: "codex-router",
    family: "provider",
    requestedEffort: "high",
    effectiveEffort: "high",
    effortSource: "task",
    role: "complex_coder",
    preset: "balanced",
    executionHost: "codex-app-server",
    worktree: "/tmp/worktree",
    branch: "engineering/task-1",
    leaseToken: "lease-1",
    dispatchOperationId: "dispatch-1",
    createdAt: "2026-09-22T10:00:00.000Z",
    policyRevision: 2,
    attempt: 1,
  };
  const record = createEngineeringRecord("ExecutionBinding", fields);
  assert.equal(record.requestedEffort, "high");
  assert.throws(() => createEngineeringRecord("ExecutionBinding", {
    ...fields,
    requestedEffort: "",
  }), /requestedEffort/u);
});

test("verification contracts represent exit, signal, and timeout outcomes without inventing success", () => {
  const base = {
    taskId: "task-1",
    verificationId: "verify-1",
    runner: "node-test",
    command: "node",
    cwd: "/workspace",
    host: "remote-runner",
    sourceRevision: "abc123",
    artifactDigest: "sha256:123",
    startedAt: "2026-09-22T10:00:00.000Z",
    finishedAt: "2026-09-22T10:00:01.000Z",
    testCount: 4,
    timedOut: false,
    arguments: ["--test"],
    artifactRefs: ["artifact://verify-1"],
  };
  assert.equal(createEngineeringRecord("VerificationResult", { ...base, exitCode: 0 }).exitCode, 0);
  assert.equal(createEngineeringRecord("VerificationResult", {
    ...base,
    timedOut: true,
  }).timedOut, true);
  assert.throws(() => createEngineeringRecord("VerificationResult", base), /exitCode, signal, or timedOut/u);
  assert.throws(() => createEngineeringRecord("VerificationResult", {
    ...base,
    exitCode: 0,
    finishedAt: "2026-09-22T09:59:59.000Z",
  }), /cannot precede/u);
});

test("immutable snapshots detach caller-owned data", () => {
  const source = { nested: { value: 1 } };
  const snapshot = immutableSnapshot(source);
  source.nested.value = 2;
  assert.equal(snapshot.nested.value, 1);
  assert.equal(Object.isFrozen(snapshot.nested), true);
});
