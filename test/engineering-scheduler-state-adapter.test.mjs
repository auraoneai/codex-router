import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExecutionBinding } from "../src/engineering/execution-binding.mjs";
import { EngineeringScheduler } from "../src/engineering/scheduler.mjs";
import {
  createDurableSchedulerState,
  DurableSchedulerState,
  engineeringSchedulerStatePath,
  resolveEngineeringBinding,
} from "../src/engineering/scheduler-state-adapter.mjs";

const AT = "2026-09-22T00:00:00.000Z";

function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-scheduler-state-"));
  const target = engineeringSchedulerStatePath(root);
  return {
    root,
    target,
    state: createDurableSchedulerState(target, { clock: () => AT, ...options }),
  };
}

async function readyTask(state, overrides = {}) {
  let task = await state.putTask({
    version: 1,
    taskId: "task-1",
    runId: "run-1",
    state: "planned",
    dependencies: [],
    writableScopes: ["src/engineering"],
    attempt: 0,
    attemptLimit: 2,
    activeBinding: null,
    createdAt: AT,
    updatedAt: AT,
    revision: 0,
    ...overrides,
  }, { expectedRevision: 0 });
  task = await state.putTask({ ...task, state: "ready", updatedAt: AT }, { expectedRevision: task.revision });
  return task;
}

function attempt(overrides = {}) {
  return {
    attempt: 1,
    attemptId: "attempt-1",
    operationId: "dispatch-1",
    intentRecordedAt: AT,
    childId: null,
    ...overrides,
  };
}

function fenceMap(task) {
  return Object.fromEntries(task.activeBinding.leases.map((lease) => [lease.scope, lease.fence]));
}

test("durable assignment atomically persists task CAS and hierarchical writer fences", async () => {
  const { root, target, state } = fixture();
  try {
    const ready = await readyTask(state);
    const claimed = await state.claimAssignment({
      taskId: ready.taskId,
      expectedRevision: ready.revision,
      binding: attempt(),
      scopes: ready.writableScopes,
      updatedAt: AT,
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.state, "assigned");
    assert.equal(claimed.task.revision, ready.revision + 1);
    assert.equal((await state.getWriterLease("SRC/engineering")).attemptId, "attempt-1");
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);

    const reloaded = new DurableSchedulerState(target, { clock: () => AT });
    assert.equal(reloaded.recover().leases.length, 1);
    assert.equal((await reloaded.getTask("task-1")).activeBinding.attemptId, "attempt-1");

    const other = await readyTask(reloaded, {
      taskId: "task-2",
      writableScopes: ["src"],
    });
    const conflict = await reloaded.claimAssignment({
      taskId: other.taskId,
      expectedRevision: other.revision,
      binding: attempt({ attemptId: "attempt-2", operationId: "dispatch-2" }),
      scopes: other.writableScopes,
      updatedAt: AT,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "writer_conflict");
    assert.equal((await reloaded.getTask("task-2")).state, "ready");

    await assert.rejects(() => reloaded.putTask(
      { ...claimed.task, state: "running" },
      { expectedRevision: ready.revision },
    ), /revision conflict/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EngineeringScheduler uses the durable adapter across process-style reloads", async () => {
  const { root, target, state } = fixture();
  try {
    let sequence = 0;
    const scheduler = new EngineeringScheduler({
      state,
      idFactory: (kind) => `${kind}-${++sequence}`,
      clock: () => AT,
      runtime: {
        async dispatch({ binding }) {
          return { state: "running", childId: `child-${binding.attemptId}` };
        },
        async inspect() { return { state: "running" }; },
        async cancel() { return { state: "cancelled" }; },
      },
    });
    await scheduler.registerTasks("run-live", [{
      taskId: "task-live", writableScopes: ["src/live"], attemptLimit: 1,
    }]);
    const [running] = await scheduler.dispatchReady("run-live");
    assert.equal(running.state, "running");

    const reloadedState = createDurableSchedulerState(target, { clock: () => AT });
    const reloadedTask = await reloadedState.getTask("task-live");
    assert.equal(reloadedTask.activeBinding.attemptId, running.activeBinding.attemptId);
    const reloadedScheduler = new EngineeringScheduler({
      state: reloadedState,
      clock: () => AT,
      runtime: {
        async dispatch() { throw new Error("not used"); },
        async inspect() { return { state: "running" }; },
        async cancel() { return { state: "cancelled" }; },
      },
    });
    const recorded = await reloadedScheduler.recordResult("task-live", {
      attemptId: reloadedTask.activeBinding.attemptId,
      operationId: reloadedTask.activeBinding.operationId,
      fences: fenceMap(reloadedTask),
      summary: "recorded after reload",
    });
    assert.equal(recorded.integrable, true);
    assert.equal((await reloadedState.getTask("task-live")).workerResult.summary, "recorded after reload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("result is stored once before leases release; duplicates and late attempts are quarantined", async () => {
  const { root, state } = fixture();
  try {
    const ready = await readyTask(state);
    const claimed = await state.claimAssignment({
      taskId: ready.taskId,
      expectedRevision: ready.revision,
      binding: attempt(),
      scopes: ready.writableScopes,
      updatedAt: AT,
    });
    const result = {
      attemptId: "attempt-1",
      operationId: "dispatch-1",
      fences: fenceMap(claimed.task),
      summary: "completed once",
    };
    const recorded = await state.recordTaskResult({
      taskId: "task-1",
      expectedRevision: claimed.task.revision,
      ...result,
      result,
      updatedAt: AT,
    });
    assert.equal(recorded.integrable, true);
    assert.equal(recorded.task.state, "result_recorded");
    assert.equal(recorded.task.workerResult.summary, "completed once");
    assert.equal(state.snapshot().leases.length, 0);

    const duplicate = await state.recordTaskResult({
      taskId: "task-1",
      expectedRevision: recorded.task.revision,
      ...result,
      result: { ...result, summary: "must not replace" },
      updatedAt: AT,
    });
    assert.equal(duplicate.integrable, false);
    assert.equal(duplicate.reason, "duplicate_result");
    assert.equal((await state.getTask("task-1")).workerResult.summary, "completed once");

    const late = await state.recordTaskResult({
      taskId: "task-1",
      expectedRevision: recorded.task.revision,
      attemptId: "attempt-old",
      operationId: "dispatch-old",
      fences: result.fences,
      result: { summary: "late" },
      updatedAt: AT,
    });
    assert.equal(late.integrable, false);
    assert.equal(late.reason, "late_or_stale_result");
    assert.deepEqual(state.snapshot().lateResults.map((item) => item.kind), [
      "duplicate_result",
      "late_result",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incorporation acknowledgement is persisted exactly once and mismatches are quarantined", async () => {
  const { root, state } = fixture();
  try {
    const ready = await readyTask(state);
    const claimed = await state.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision, binding: attempt(),
      scopes: ready.writableScopes, updatedAt: AT,
    });
    const result = {
      attemptId: "attempt-1", operationId: "dispatch-1",
      fences: fenceMap(claimed.task), summary: "done",
    };
    const recorded = await state.recordTaskResult({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      ...result, result, updatedAt: AT,
    });
    const first = await state.acknowledgeIncorporation({
      taskId: "task-1", expectedRevision: recorded.task.revision,
      attemptId: "attempt-1", operationId: "dispatch-1",
      incorporationId: "integration-1", updatedAt: AT,
    });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);

    const second = await state.acknowledgeIncorporation({
      taskId: "task-1", expectedRevision: first.task.revision,
      attemptId: "attempt-1", operationId: "dispatch-1",
      incorporationId: "integration-2", updatedAt: AT,
    });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.acknowledgement.incorporationId, "integration-1");

    const wrong = await state.acknowledgeIncorporation({
      taskId: "task-1", expectedRevision: first.task.revision,
      attemptId: "attempt-other", operationId: "dispatch-other",
      incorporationId: "integration-wrong", updatedAt: AT,
    });
    assert.equal(wrong.ok, false);
    assert.equal(state.snapshot().lateResults.at(-1).kind, "late_incorporation_acknowledgement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash before result commit preserves active attempt and crash after commit recovers one result", async () => {
  let crashPhase;
  const faultInjector = (phase) => {
    if (phase === crashPhase) {
      crashPhase = undefined;
      throw new Error(`simulated crash at ${phase}`);
    }
  };
  const { root, target, state } = fixture({ faultInjector });
  try {
    const ready = await readyTask(state);
    const claimed = await state.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision, binding: attempt(),
      scopes: ready.writableScopes, updatedAt: AT,
    });
    const result = {
      attemptId: "attempt-1", operationId: "dispatch-1",
      fences: fenceMap(claimed.task), summary: "durable",
    };

    crashPhase = "recordTaskResult:beforeCommit";
    await assert.rejects(() => state.recordTaskResult({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      ...result, result, updatedAt: AT,
    }), /simulated crash/u);
    let reloaded = createDurableSchedulerState(target, { clock: () => AT, faultInjector });
    assert.equal((await reloaded.getTask("task-1")).state, "assigned");
    assert.equal(reloaded.snapshot().leases.length, 1);

    crashPhase = "recordTaskResult:afterCommit";
    await assert.rejects(() => reloaded.recordTaskResult({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      ...result, result, updatedAt: AT,
    }), /simulated crash/u);
    reloaded = createDurableSchedulerState(target, { clock: () => AT });
    const recovered = await reloaded.getTask("task-1");
    assert.equal(recovered.state, "result_recorded");
    assert.equal(recovered.workerResult.summary, "durable");
    assert.equal(reloaded.recover().leases.length, 0);

    const replay = await reloaded.recordTaskResult({
      taskId: "task-1", expectedRevision: recovered.revision,
      ...result, result, updatedAt: AT,
    });
    assert.equal(replay.integrable, false);
    assert.equal(replay.reason, "duplicate_result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assignment intent has deterministic recovery on both sides of its atomic commit", async () => {
  let crashPhase = "claimAssignment:beforeCommit";
  const faultInjector = (phase) => {
    if (phase === crashPhase) {
      crashPhase = undefined;
      throw new Error(`simulated crash at ${phase}`);
    }
  };
  const { root, target, state } = fixture({ faultInjector });
  try {
    const ready = await readyTask(state);
    const claim = () => state.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision, binding: attempt(),
      scopes: ready.writableScopes, updatedAt: AT,
    });
    await assert.rejects(claim, /claimAssignment:beforeCommit/u);
    let reloaded = createDurableSchedulerState(target, { clock: () => AT, faultInjector });
    assert.equal((await reloaded.getTask("task-1")).state, "ready");
    assert.equal(reloaded.recover().leases.length, 0);

    crashPhase = "claimAssignment:afterCommit";
    await assert.rejects(() => reloaded.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision, binding: attempt(),
      scopes: ready.writableScopes, updatedAt: AT,
    }), /claimAssignment:afterCommit/u);
    reloaded = createDurableSchedulerState(target, { clock: () => AT });
    assert.equal((await reloaded.getTask("task-1")).state, "assigned");
    assert.equal(reloaded.recover().leases.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finishAttempt releases only the current fenced attempt and survives reload", async () => {
  let crashAfterCommit = false;
  const { root, target, state } = fixture({
    faultInjector(phase) {
      if (crashAfterCommit && phase === "finishAttempt:afterCommit") {
        crashAfterCommit = false;
        throw new Error("simulated finish crash after commit");
      }
    },
  });
  try {
    const ready = await readyTask(state);
    const claimed = await state.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision, binding: attempt(),
      scopes: ready.writableScopes, updatedAt: AT,
    });
    const stale = await state.finishAttempt({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      attemptId: "attempt-stale", state: "retry_pending", updatedAt: AT,
    });
    assert.equal(stale.ok, false);
    assert.equal(state.snapshot().leases.length, 1);

    crashAfterCommit = true;
    await assert.rejects(() => state.finishAttempt({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      attemptId: "attempt-1", state: "retry_pending",
      patch: { lastError: "not dispatched" }, updatedAt: AT,
    }), /simulated finish crash/u);
    const reloaded = createDurableSchedulerState(target, { clock: () => AT });
    assert.equal(reloaded.recover().leases.length, 0);
    const finished = await reloaded.getTask("task-1");
    assert.equal(finished.state, "retry_pending");
    assert.equal(finished.lastError, "not dispatched");
    assert.equal(finished.activeBinding, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding resolver trusts only a current enabled durable assignment and ignores the raw header", async () => {
  const { root, target, state } = fixture();
  try {
    const executionBinding = createExecutionBinding({
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      dispatchOperationId: "dispatch-1",
      assignment: {
        agentType: "router_kiro_prism_claude_sonnet_5",
        model: "kiro-prism/claude-sonnet-5",
        provider: "kiro-prism",
        family: "claude",
        effectiveEffort: "high",
        effortSource: "role_default",
      },
      role: "complex_coder",
      preset: "balanced",
      policyRevision: 7,
      attempt: 1,
      worktree: root,
      branch: "engineering/task-1",
      leaseToken: "lease-1",
      createdAt: AT,
    });
    const ready = await readyTask(state, {
      baseRevision: "source-revision-1",
      executionBinding,
      policyEnabledAtAssignment: true,
    });
    const claimed = await state.claimAssignment({
      taskId: "task-1", expectedRevision: ready.revision,
      binding: attempt({ executionBinding }), scopes: ready.writableScopes, updatedAt: AT,
    });
    const resolved = resolveEngineeringBinding(executionBinding.bindingId, { target, clock: () => AT });
    assert.equal(resolved.model, "kiro-prism/claude-sonnet-5");
    assert.equal(resolved.effectiveEffort, "high");
    assert.equal(resolved.sourceRevision, "source-revision-1");
    assert.equal(resolved.status, "assigned");
    assert.equal(resolved.policyEnabledAtAssignment, true);
    assert.equal(resolveEngineeringBinding(`${executionBinding.bindingId}-forged`, { target }), undefined);

    const finished = await state.finishAttempt({
      taskId: "task-1", expectedRevision: claimed.task.revision,
      attemptId: "attempt-1", state: "retry_pending", updatedAt: AT,
    });
    assert.equal(finished.ok, true);
    assert.equal(resolveEngineeringBinding(executionBinding.bindingId, { target }), undefined);

    const disabledRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-scheduler-disabled-"));
    try {
      const disabledTarget = engineeringSchedulerStatePath(disabledRoot);
      const disabled = createDurableSchedulerState(disabledTarget, { clock: () => AT });
      const disabledReady = await readyTask(disabled, { executionBinding, policyEnabledAtAssignment: false });
      await disabled.claimAssignment({
        taskId: "task-1", expectedRevision: disabledReady.revision,
        binding: attempt({ executionBinding }), scopes: disabledReady.writableScopes, updatedAt: AT,
      });
      assert.equal(resolveEngineeringBinding(executionBinding.bindingId, { target: disabledTarget }), undefined);
    } finally {
      rmSync(disabledRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit store CAS fails closed without modifying current state", async () => {
  const { root, state } = fixture();
  try {
    const task = await state.putTask({
      taskId: "task-1", runId: "run-1", state: "planned", updatedAt: AT, revision: 0,
    }, { expectedRevision: 0, expectedStoreVersion: 0 });
    await assert.rejects(() => state.putTask(
      { ...task, state: "ready", updatedAt: AT },
      { expectedRevision: task.revision, expectedStoreVersion: 0 },
    ), /Engineering state version conflict/u);
    assert.equal((await state.getTask("task-1")).state, "planned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
