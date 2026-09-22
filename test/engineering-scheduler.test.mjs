import assert from "node:assert/strict";
import test from "node:test";

import {
  EngineeringScheduler,
  admittedTaskCount,
  createMemorySchedulerState,
  validateTaskGraph,
} from "../src/engineering/scheduler.mjs";

function ids() {
  let sequence = 0;
  return (kind) => `${kind}-${++sequence}`;
}

function runtime(overrides = {}) {
  return {
    async dispatch({ binding }) { return { state: "running", childId: `child-${binding.attemptId}` }; },
    async inspect() { return { state: "running" }; },
    async cancel() { return { state: "cancelled" }; },
    ...overrides,
  };
}

test("scheduler admits by the narrowest live capacity without a fixed fan-out cap", () => {
  assert.equal(admittedTaskCount(1_000, {
    runtimeSlots: 800,
    operatorLimit: 1_000,
    providerSlots: 900,
    hostSlots: 850,
  }), 800);
  assert.equal(admittedTaskCount(1_000, {}), 1_000);
  assert.throws(() => admittedTaskCount(1, { hostSlots: -1 }), /non-negative/u);
});

test("task graphs validate dependencies and support thousand-task waves", () => {
  const tasks = Array.from({ length: 1_000 }, (_, index) => ({
    taskId: `task-${index}`,
    dependencies: index === 0 ? [] : [`task-${index - 1}`],
  }));
  assert.equal(validateTaskGraph(tasks), true);
  assert.throws(() => validateTaskGraph([
    { taskId: "a", dependencies: ["b"] },
    { taskId: "b", dependencies: ["a"] },
  ]), /cycle/u);
});

test("assignment CAS and hierarchical writer fences are one transaction", async () => {
  const state = createMemorySchedulerState();
  const scheduler = new EngineeringScheduler({
    state,
    runtime: runtime(),
    capacity: async () => ({ runtimeSlots: 2 }),
    idFactory: ids(),
  });
  await scheduler.registerTasks("run", [
    { taskId: "owner", writableScopes: ["src"], attemptLimit: 1, priority: -1 },
    { taskId: "overlap", writableScopes: ["src/engineering"], attemptLimit: 1 },
  ]);
  const dispatched = await scheduler.dispatchReady("run");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].taskId, "owner");
  assert.equal(dispatched[0].state, "running");
  assert.equal((await state.getTask("overlap")).state, "ready");
  assert.equal(state.snapshot().leases.length, 1);

  const overlap = await state.getTask("overlap");
  const stale = await state.claimAssignment({
    taskId: "overlap",
    expectedRevision: overlap.revision,
    binding: { attempt: 1, attemptId: "other", operationId: "other" },
    scopes: ["SRC/engineering"],
    updatedAt: new Date().toISOString(),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "writer_conflict");
});

test("only the exact live attempt and every current fence can record an integrable result", async () => {
  const state = createMemorySchedulerState();
  const scheduler = new EngineeringScheduler({ state, runtime: runtime(), idFactory: ids() });
  await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/a"], attemptLimit: 1 }]);
  await scheduler.dispatchReady("run");
  const running = await state.getTask("task");
  const binding = running.activeBinding;

  const late = await scheduler.recordResult("task", {
    attemptId: binding.attemptId,
    operationId: binding.operationId,
    fences: { "src/a": binding.leases[0].fence + 1 },
    summary: "stale",
  });
  assert.equal(late.integrable, false);
  assert.equal((await state.getTask("task")).state, "running");
  assert.equal(state.snapshot().lateResults.length, 1);

  const recorded = await scheduler.recordResult("task", {
    attemptId: binding.attemptId,
    operationId: binding.operationId,
    fences: { "src/a": binding.leases[0].fence },
    summary: "real result",
  });
  assert.equal(recorded.integrable, true);
  assert.equal(recorded.task.state, "result_recorded");
  assert.equal(state.snapshot().leases.length, 0);

  const duplicate = await scheduler.recordResult("task", {
    attemptId: binding.attemptId,
    operationId: binding.operationId,
    fences: { "src/a": binding.leases[0].fence },
    summary: "duplicate notification",
  });
  assert.equal(duplicate.integrable, false);
  assert.equal((await state.getTask("task")).workerResult.summary, "real result");
});

test("ambiguous dispatch and inspection preserve the child binding until recovery proves an outcome", async () => {
  let observation = { state: "unknown" };
  const state = createMemorySchedulerState();
  const scheduler = new EngineeringScheduler({
    state,
    runtime: runtime({
      async dispatch() { throw new Error("connection dropped after request"); },
      async inspect() { return observation; },
    }),
    idFactory: ids(),
  });
  await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/a"], attemptLimit: 2 }]);
  await scheduler.dispatchReady("run");
  let task = await state.getTask("task");
  const binding = task.activeBinding;
  assert.equal(task.state, "assigned");
  assert.equal(task.dispatchOutcome, "unknown");

  await scheduler.reconcile("run");
  task = await state.getTask("task");
  assert.equal(task.state, "assigned");
  assert.equal(task.activeBinding.attemptId, binding.attemptId);
  assert.equal(state.snapshot().leases.length, 1);

  observation = {
    state: "result",
    result: {
      attemptId: binding.attemptId,
      operationId: binding.operationId,
      fences: Object.fromEntries(binding.leases.map((lease) => [lease.scope, lease.fence])),
      summary: "recovered",
    },
  };
  await scheduler.reconcile("run");
  task = await state.getTask("task");
  assert.equal(task.state, "result_recorded");
  assert.equal(task.workerResult.summary, "recovered");
});

test("cancellation retains fences until the runtime definitely stops", async () => {
  let observation = { state: "unknown" };
  const state = createMemorySchedulerState();
  const scheduler = new EngineeringScheduler({
    state,
    runtime: runtime({
      async cancel() { return { state: "unknown" }; },
      async inspect() { return observation; },
    }),
    idFactory: ids(),
  });
  await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/a"] }]);
  await scheduler.dispatchReady("run");
  await scheduler.cancelTask("task", "operator requested stop");
  assert.equal((await state.getTask("task")).state, "cancelling");
  assert.equal(state.snapshot().leases.length, 1);

  observation = { state: "missing", reason: "runtime proved child absent" };
  await scheduler.reconcile("run");
  assert.equal((await state.getTask("task")).state, "cancelled");
  assert.equal(state.snapshot().leases.length, 0);
});

test("cancellation racing a dispatch proven not sent finishes cancelled without a retry", async () => {
  let rejectDispatch;
  const dispatchBarrier = new Promise((resolve, reject) => { rejectDispatch = reject; });
  const state = createMemorySchedulerState();
  const scheduler = new EngineeringScheduler({
    state,
    runtime: runtime({
      async dispatch() { return dispatchBarrier; },
      async cancel() { return { state: "unknown" }; },
    }),
    idFactory: ids(),
  });
  await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/a"], attemptLimit: 2 }]);
  const dispatching = scheduler.dispatchReady("run");
  while ((await state.getTask("task")).state !== "assigned") await new Promise((resolve) => setImmediate(resolve));
  await scheduler.cancelTask("task");
  const error = new Error("transport refused before sending");
  error.dispatched = false;
  rejectDispatch(error);
  await dispatching;
  assert.equal((await state.getTask("task")).state, "cancelled");
  assert.equal(state.snapshot().leases.length, 0);
});
