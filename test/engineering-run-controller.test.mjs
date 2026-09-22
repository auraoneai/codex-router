import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineeringRunController } from "../src/engineering/run-controller.mjs";
import { EngineeringScheduler, createMemorySchedulerState } from "../src/engineering/scheduler.mjs";
import { createDurableSchedulerState } from "../src/engineering/scheduler-state-adapter.mjs";

function ids() {
  let sequence = 0;
  return (kind) => `${kind}-${++sequence}`;
}

function clock() {
  let milliseconds = Date.parse("2026-09-22T00:00:00.000Z");
  return () => new Date(milliseconds++).toISOString();
}

async function setup({ verifier, reviewer, astraLead, notifier, runtimeOverrides = {}, taskSpec = {} } = {}) {
  const state = createMemorySchedulerState();
  const dispatchObservations = [];
  const runtime = {
    async dispatch({ task, binding }) {
      dispatchObservations.push({ state: task.state, binding: structuredClone(binding) });
      return { state: "running", childId: `child-${binding.attemptId}` };
    },
    async inspect() { return { state: "running" }; },
    async cancel() { return { state: "cancelled" }; },
    ...runtimeOverrides,
  };
  const scheduler = new EngineeringScheduler({ state, runtime, idFactory: ids(), clock: clock() });
  const controller = new EngineeringRunController({
    scheduler,
    state,
    verifier: verifier || {
      async runPlan() {
        return [{ verificationId: "unit", sourceRevision: "source-rev", exitCode: 0, timedOut: false }];
      },
    },
    reviewer: reviewer || (async ({ sourceRevision }) => ({
      reviewId: "review-1", reviewedRevision: sourceRevision, disposition: "approved", findings: [],
    })),
    astraLead: astraLead || (async ({ sourceRevision }) => ({ decision: "accept", revision: sourceRevision })),
    notifier,
    idFactory: ids(),
    controllerId: "controller-stable",
    clock: clock(),
  });
  await scheduler.registerTasks("run-1", [{ taskId: "task-1", writableScopes: ["src/owned"], attemptLimit: 1, ...taskSpec }]);
  await controller.dispatchReady("run-1");
  return { state, scheduler, controller, dispatchObservations };
}

function workerResult(task, overrides = {}) {
  return {
    attemptId: task.activeBinding.attemptId,
    operationId: task.activeBinding.operationId,
    fences: Object.fromEntries(task.activeBinding.leases.map((lease) => [lease.scope, lease.fence])),
    resultRevision: "source-rev",
    summary: "implemented the bounded change",
    evidenceRefs: ["artifacts/worker.json#sha256=abc"],
    risks: [],
    ...overrides,
  };
}

test("controller persists assignment and result before external dispatch and notification", async () => {
  const notificationObservations = [];
  let state;
  const environment = await setup({
    notifier: async ({ task, idempotencyKey }) => {
      const persisted = await state.getTask(task.taskId);
      notificationObservations.push({ state: persisted.state, hasResult: Boolean(persisted.workerResult), idempotencyKey });
    },
  });
  ({ state } = environment);
  assert.equal(environment.dispatchObservations[0].state, "assigned");
  assert.ok(environment.dispatchObservations[0].binding.attemptId);

  const running = await state.getTask("task-1");
  const first = await environment.controller.recordWorkerResult("task-1", workerResult(running));
  assert.equal(first.integrable, true);
  assert.equal(first.duplicate, false);
  assert.deepEqual(notificationObservations.map(({ state: status, hasResult }) => ({ status, hasResult })), [
    { status: "result_recorded", hasResult: true },
  ]);
  assert.equal(first.task.resultNotification.status, "delivered");
  assert.ok(first.task.resultAcknowledgement.id);

  const duplicate = await environment.controller.recordWorkerResult("task-1", workerResult(running));
  assert.equal(duplicate.integrable, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(notificationObservations.length, 1);
});

test("passing deterministic gates, independent review, and exact Astra decision are all required for acceptance", async () => {
  const { state, controller } = await setup();
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const accepted = await controller.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", arguments: ["--test"], cwd: "/repo" }],
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acceptance.accepted, true);
  assert.equal(accepted.acceptance.gates.requiredVerification, true);
  assert.equal(accepted.acceptance.gates.review, true);
  assert.equal(accepted.acceptance.gates.leadAcceptance, true);
  assert.equal(accepted.evidencePacket.revision, "source-rev");
  assert.equal(Buffer.byteLength(JSON.stringify(accepted.evidencePacket)) <= 24 * 1024, true);
});

test("a skipped or not-run deterministic gate cannot be overridden by review or Astra", async () => {
  const { state, controller } = await setup({
    verifier: {
      async runPlan() {
        return [{ verificationId: "unit", sourceRevision: "source-rev", exitCode: 125, timedOut: false }];
      },
    },
  });
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const rejected = await controller.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  });
  assert.equal(rejected.state, "needs_remediation");
  assert.equal(rejected.acceptance.accepted, false);
  assert.match(rejected.acceptance.blockers.join("\n"), /verification unit/u);
});

test("resume delivers a persisted result notification with the same idempotency key", async () => {
  const deliveries = [];
  const { state, controller } = await setup({
    notifier: async ({ idempotencyKey }) => deliveries.push(idempotencyKey),
  });
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  assert.equal(deliveries.length, 0);
  await controller.resume("run-1");
  assert.equal(deliveries.length, 1);
  assert.ok((await state.getTask("task-1")).resultAcknowledgement.id);
  await controller.resume("run-1");
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0], /^result:run-1:task-1:/u);
});

test("recovery inspects an in-flight verification operation and never starts a duplicate writer", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const verifier = {
    async runPlan() {
      executions += 1;
      await barrier;
      return [{ verificationId: "unit", sourceRevision: "source-rev", exitCode: 0, timedOut: false }];
    },
    async inspect() { return { state: "unknown" }; },
  };
  const { state, scheduler, controller } = await setup({ verifier });
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const finalizing = controller.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  });
  while ((await state.getTask("task-1")).composition?.stage !== "verification_running") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const recovered = new EngineeringRunController({
    scheduler,
    state,
    verifier,
    reviewer: async ({ sourceRevision }) => ({ reviewId: "review", reviewedRevision: sourceRevision, disposition: "approved", findings: [] }),
    astraLead: async ({ sourceRevision }) => ({ decision: "accept", revision: sourceRevision }),
    controllerId: "controller-stable",
    clock: clock(),
  });
  await recovered.resume("run-1");
  assert.equal(executions, 1);
  assert.equal((await state.getTask("task-1")).composition.stage, "verification_running");
  release();
  assert.equal((await finalizing).state, "accepted");
});

test("a stale source revision is rejected before any verification operation", async () => {
  let executions = 0;
  const { state, controller } = await setup({
    verifier: { async runPlan() { executions += 1; return []; } },
  });
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  await assert.rejects(() => controller.finalizeTask("task-1", {
    sourceRevision: "stale-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  }), /worker result is not bound/u);
  assert.equal(executions, 0);
});

test("controller refuses secret-bearing gate configuration before durable composition state", async () => {
  const { state, controller } = await setup();
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  await assert.rejects(() => controller.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo", args: ["--token", "literal-secret"] }],
  }), /use envRef/u);
  const recorded = await state.getTask("task-1");
  assert.equal(recorded.composition, undefined);
});

test("durable scheduler state survives controller replacement with one incorporation acknowledgement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "router-run-controller-"));
  const target = path.join(directory, "engineering-state.json");
  try {
    const state = createDurableSchedulerState(target, { clock: clock() });
    const runtime = {
      async dispatch({ binding }) { return { state: "running", childId: `child-${binding.attemptId}` }; },
      async inspect() { return { state: "running" }; },
      async cancel() { return { state: "cancelled" }; },
    };
    const scheduler = new EngineeringScheduler({ state, runtime, idFactory: ids(), clock: clock() });
    const dependencies = {
      scheduler,
      state,
      verifier: { async runPlan() { return [{ verificationId: "unit", sourceRevision: "source-rev", exitCode: 0, timedOut: false }]; } },
      reviewer: async ({ sourceRevision }) => ({ reviewId: "review", reviewedRevision: sourceRevision, disposition: "approved", findings: [] }),
      astraLead: async ({ sourceRevision }) => ({ decision: "accept", revision: sourceRevision }),
      controllerId: "durable-controller",
      clock: clock(),
    };
    const first = new EngineeringRunController(dependencies);
    await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/owned"] }]);
    await first.dispatchReady("run");
    const running = await state.getTask("task");
    await first.recordWorkerResult("task", workerResult(running), { notify: false });
    let recorded = await state.getTask("task");
    assert.ok(recorded.completedAttempt.incorporation.incorporationId);

    const reloadedState = createDurableSchedulerState(target, { clock: clock() });
    const reloadedScheduler = new EngineeringScheduler({ state: reloadedState, runtime, idFactory: ids(), clock: clock() });
    const recovered = new EngineeringRunController({ ...dependencies, state: reloadedState, scheduler: reloadedScheduler });
    const accepted = await recovered.finalizeTask("task", {
      sourceRevision: "source-rev",
      verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
    });
    assert.equal(accepted.state, "accepted");
    recorded = await reloadedState.getTask("task");
    assert.equal(recorded.completedAttempt.incorporation.incorporationId, running
      ? `result:run:task:${running.activeBinding.attemptId}:${running.activeBinding.operationId}`
      : "unreachable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent finalize calls claim each external phase only once", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let verificationCalls = 0;
  const verifier = {
    async runPlan() {
      verificationCalls += 1;
      await barrier;
      return [{ verificationId: "unit", sourceRevision: "source-rev", exitCode: 0, timedOut: false }];
    },
    async inspect() { return { state: "running" }; },
  };
  const { state, controller } = await setup({ verifier });
  const running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const options = {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  };
  const first = controller.finalizeTask("task-1", options);
  while ((await state.getTask("task-1")).composition?.stage !== "verification_running") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = await controller.finalizeTask("task-1", options);
  assert.equal(second.composition.stage, "verification_running");
  assert.equal(verificationCalls, 1);
  release();
  assert.equal((await first).state, "accepted");
});

test("persisted multi-worker strategy requires integration and reruns gates and review on the integrated revision", async () => {
  const observed = [];
  const { state, scheduler } = await setup({ taskSpec: { strategy: "swarm" } });
  const running = await state.getTask("task-1");
  const baseController = new EngineeringRunController({
    scheduler,
    state,
    integrator: async ({ sourceRevision }) => ({
      sourceRevision: "integrated-rev",
      workerResult: { ...workerResult(running), resultRevision: "integrated-rev", summary: `integrated from ${sourceRevision}` },
    }),
    verifier: {
      async runPlan(_gates, context) {
        observed.push(["verify", context.expectedIdentity.sourceRevision]);
        return [{ verificationId: "unit", sourceRevision: context.expectedIdentity.sourceRevision, exitCode: 0, timedOut: false }];
      },
    },
    reviewer: async ({ sourceRevision }) => {
      observed.push(["review", sourceRevision]);
      return { reviewId: "review", reviewedRevision: sourceRevision, disposition: "approved", findings: [] };
    },
    astraLead: async ({ sourceRevision }) => {
      observed.push(["lead", sourceRevision]);
      return { decision: "accept", revision: sourceRevision };
    },
    controllerId: "integration-controller",
    clock: clock(),
  });
  await baseController.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const accepted = await baseController.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.evidencePacket.revision, "integrated-rev");
  assert.deepEqual(observed, [
    ["verify", "integrated-rev"],
    ["review", "integrated-rev"],
    ["lead", "integrated-rev"],
  ]);
});

test("failed composition can be remediated only through a new fenced worker attempt", async () => {
  let fail = true;
  const { state, controller } = await setup({
    verifier: {
      async runPlan() {
        if (fail) throw new Error("transient verifier outage");
        return [{ verificationId: "unit", sourceRevision: "source-rev-2", exitCode: 0, timedOut: false }];
      },
    },
  });
  let running = await state.getTask("task-1");
  await controller.recordWorkerResult("task-1", workerResult(running), { notify: false });
  const failed = await controller.finalizeTask("task-1", {
    sourceRevision: "source-rev",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  });
  assert.equal(failed.state, "needs_remediation");
  const ready = await controller.retryComposition("task-1", { reason: "retry after verifier repair" });
  assert.equal(ready.state, "ready");
  assert.equal(ready.composition, undefined);
  assert.equal(ready.compositionHistory.length, 1);

  fail = false;
  await controller.dispatchReady("run-1");
  running = await state.getTask("task-1");
  assert.equal(running.attempt, 2);
  await controller.recordWorkerResult("task-1", workerResult(running, { resultRevision: "source-rev-2" }), { notify: false });
  const accepted = await controller.finalizeTask("task-1", {
    sourceRevision: "source-rev-2",
    verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
  });
  assert.equal(accepted.state, "accepted");
});

test("durable lifecycle accepts needs-remediation requeue without a direct verification shortcut", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "router-remediation-"));
  const target = path.join(directory, "engineering-state.json");
  try {
    const state = createDurableSchedulerState(target, { clock: clock() });
    const runtime = {
      async dispatch({ binding }) { return { state: "running", childId: `child-${binding.attemptId}` }; },
      async inspect() { return { state: "running" }; },
      async cancel() { return { state: "cancelled" }; },
    };
    const scheduler = new EngineeringScheduler({ state, runtime, idFactory: ids(), clock: clock() });
    const controller = new EngineeringRunController({
      scheduler,
      state,
      verifier: { async runPlan() { throw new Error("gate infrastructure failed"); } },
      reviewer: async () => undefined,
      astraLead: async () => undefined,
      controllerId: "durable-remediator",
      clock: clock(),
    });
    await scheduler.registerTasks("run", [{ taskId: "task", writableScopes: ["src/owned"] }]);
    await controller.dispatchReady("run");
    const running = await state.getTask("task");
    await controller.recordWorkerResult("task", workerResult(running), { notify: false });
    assert.equal((await controller.finalizeTask("task", {
      sourceRevision: "source-rev",
      verificationGates: [{ id: "unit", command: "node", cwd: "/repo" }],
    })).state, "needs_remediation");
    const ready = await controller.retryComposition("task");
    assert.equal(ready.state, "ready");
    assert.equal(ready.composition, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
