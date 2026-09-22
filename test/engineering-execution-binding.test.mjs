import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertBindingMatchesAssignment,
  bindExecutionIdentity,
  codexExecutionOverrides,
  createExecutionBinding,
  executionBindingFingerprint,
  validateExecutionBinding,
} from "../src/engineering/execution-binding.mjs";

const assignment = {
  agentType: "router_kiro_prism_claude_sonnet_5",
  model: "kiro-prism/claude-sonnet-5",
  provider: "kiro-prism",
  upstreamModel: "claude-sonnet-5",
  family: "claude",
  requestedEffort: "high",
  effectiveEffort: "high",
  effortSource: "task_override",
  capacityHost: "kiro",
};

function binding(overrides = {}) {
  return createExecutionBinding({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    dispatchOperationId: "dispatch-1",
    assignment,
    role: "complex_coder",
    preset: "balanced",
    policyRevision: 3,
    attempt: 1,
    worktree: "/tmp/repo-worktree",
    branch: "engineering/task-1",
    leaseToken: "lease-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  });
}

test("execution binding freezes exact route, effort, and checkout identity", () => {
  const value = binding();
  assert.equal(value.model, assignment.model);
  assert.equal(value.effectiveEffort, "high");
  assert.equal(value.family, "claude");
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(codexExecutionOverrides(value), {
    model: assignment.model,
    modelProvider: "codex-router",
    cwd: path.resolve("/tmp/repo-worktree"),
    effort: "high",
  });
  assertBindingMatchesAssignment(value, assignment);
  validateExecutionBinding(value);
  assert.match(executionBindingFingerprint(value), /^[a-f0-9]{64}$/);
});

test("assignment drift and unsupported mutation are rejected", () => {
  const value = binding();
  assert.throws(
    () => assertBindingMatchesAssignment(value, { ...assignment, effectiveEffort: "low" }),
    /effectiveEffort/,
  );
  assert.throws(() => { value.model = "other"; }, TypeError);
  assert.throws(
    () => validateExecutionBinding({ ...value, model: "kiro-prism/other" }),
    /digest/,
  );
});

test("runtime identity is attached without changing the assignment fingerprint fields", () => {
  const value = binding();
  const attached = bindExecutionIdentity(value, {
    agentId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(attached.agentId, "thread-1");
  assert.equal(attached.threadId, "thread-1");
  assert.equal(attached.turnId, "turn-1");
  assert.equal(attached.assignmentBindingId, value.bindingId);
  assert.notEqual(attached.bindingId, value.bindingId);
  assertBindingMatchesAssignment(attached, assignment);
  assert.throws(
    () => validateExecutionBinding({ ...attached, assignmentBindingId: "binding-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    /digest/,
  );
  assert.throws(
    () => bindExecutionIdentity(attached, { agentId: "thread-other", threadId: "thread-other" }),
    /different agentId/,
  );
});
