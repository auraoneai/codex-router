import { randomUUID } from "node:crypto";

export const TERMINAL_TASK_STATES = new Set([
  "accepted",
  "blocked",
  "cancelled",
  "failed",
]);

const ACTIVE_WRITER_STATES = new Set([
  "assigned",
  "running",
  "cancelling",
]);

function copy(value) {
  return value === undefined ? value : structuredClone(value);
}

function makeId(kind) {
  return `${kind}_${randomUUID()}`;
}

function finiteCapacity(value) {
  if (value === undefined || value === null || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Capacity must be a non-negative safe integer, got ${value}`);
  }
  return value;
}

function canonicalScope(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Writable scopes must be non-empty strings.");
  }
  const normalized = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    normalized === "." || normalized === ".." || normalized.startsWith("../") ||
    normalized.startsWith("/") || normalized.includes("/../") || normalized.includes("\0")
  ) {
    throw new Error(`Unsafe writable scope: ${value}`);
  }
  return { scope: normalized, key: normalized.toLocaleLowerCase("en-US") };
}

function scopesConflict(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function admittedTaskCount(readyCount, capacity = {}) {
  const bounds = [
    finiteCapacity(readyCount),
    finiteCapacity(capacity.runtimeSlots),
    finiteCapacity(capacity.operatorLimit),
    finiteCapacity(capacity.providerSlots),
    finiteCapacity(capacity.hostSlots),
  ];
  return Math.min(...bounds);
}

export function validateTaskGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  if (byId.size !== tasks.length) throw new Error("Engineering task IDs must be unique.");
  for (const task of tasks) {
    for (const dependency of task.dependencies || []) {
      if (!byId.has(dependency)) {
        throw new Error(`Task ${task.taskId} depends on unknown task ${dependency}.`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error(`Engineering task graph contains a cycle at ${taskId}.`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependencies || []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const taskId of byId.keys()) visit(taskId);
  return true;
}

// This adapter is intentionally process-local and is primarily useful for tests
// and foreground runs. Production callers inject the Router's durable state
// adapter with the same compare-and-swap and lease methods; the scheduler never
// reaches into Prism persistence.
export function createMemorySchedulerState() {
  const tasks = new Map();
  const leases = new Map();
  const fences = new Map();
  const events = [];
  const lateResults = [];

  return {
    async getTask(taskId) {
      return copy(tasks.get(taskId));
    },
    async listTasks(runId) {
      return [...tasks.values()].filter((task) => task.runId === runId).map(copy);
    },
    async putTask(task, { expectedRevision } = {}) {
      const current = tasks.get(task.taskId);
      const currentRevision = current?.revision || 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new Error(
          `Task ${task.taskId} revision conflict: expected ${expectedRevision}, found ${currentRevision}.`,
        );
      }
      const next = { ...copy(task), revision: currentRevision + 1 };
      tasks.set(task.taskId, next);
      return copy(next);
    },
    async appendEvent(event) {
      events.push(copy(event));
    },
    async claimAssignment({ taskId, expectedRevision, binding, scopes, updatedAt }) {
      const current = tasks.get(taskId);
      const currentRevision = current?.revision || 0;
      if (!current || currentRevision !== expectedRevision || current.state !== "ready") {
        return { ok: false, reason: "task_changed", task: copy(current) };
      }
      const canonical = [...new Map((scopes || []).map((scope) => {
        const item = canonicalScope(scope);
        return [item.key, item];
      })).values()].sort((a, b) => a.key.localeCompare(b.key));
      for (const requested of canonical) {
        for (const active of leases.values()) {
          if (scopesConflict(requested.key, active.key)) {
            return { ok: false, reason: "writer_conflict", conflict: copy(active) };
          }
        }
      }
      const reserved = canonical.map(({ scope, key }) => {
        const fence = (fences.get(key) || 0) + 1;
        fences.set(key, fence);
        const lease = { scope, key, fence, runId: current.runId, taskId, attemptId: binding.attemptId };
        leases.set(key, lease);
        return lease;
      });
      const next = {
        ...copy(current),
        state: "assigned",
        attempt: binding.attempt,
        activeBinding: { ...copy(binding), leases: copy(reserved) },
        updatedAt,
        revision: currentRevision + 1,
      };
      tasks.set(taskId, next);
      return { ok: true, task: copy(next) };
    },
    async recordTaskResult({ taskId, expectedRevision, attemptId, operationId, fences: reportedFences, result, updatedAt }) {
      const current = tasks.get(taskId);
      const binding = current?.activeBinding;
      const currentRevision = current?.revision || 0;
      const exactAttempt = currentRevision === expectedRevision && binding?.attemptId === attemptId && binding?.operationId === operationId;
      const exactLeases = exactAttempt && ["assigned", "running"].includes(current.state) && (binding.leases || []).every((expected) => {
        const active = leases.get(expected.key || canonicalScope(expected.scope).key);
        return active?.taskId === taskId && active?.attemptId === attemptId && active?.fence === expected.fence && reportedFences?.[expected.scope] === expected.fence;
      });
      if (!exactLeases) {
        const late = { ...copy(result), taskId, attemptId, operationId, nonIntegrable: true, observedState: current?.state || "missing", observedAt: updatedAt };
        lateResults.push(late);
        return { integrable: false, task: copy(current), lateResult: copy(late) };
      }
      const next = {
        ...copy(current), state: "result_recorded", activeBinding: null,
        workerResult: copy(result), updatedAt, revision: currentRevision + 1,
      };
      // Persist the result in the task before releasing its writer fences. In
      // a durable adapter this is one transaction; this in-memory adapter keeps
      // the same ordering and has no asynchronous gap.
      tasks.set(taskId, next);
      releaseExactLeases(binding.leases, taskId, attemptId);
      return { integrable: true, task: copy(next) };
    },
    async finishAttempt({ taskId, expectedRevision, attemptId, state, patch = {}, updatedAt }) {
      const current = tasks.get(taskId);
      const binding = current?.activeBinding;
      if (!current || current.revision !== expectedRevision || binding?.attemptId !== attemptId) {
        return { ok: false, reason: "attempt_changed", task: copy(current) };
      }
      if (!bindingLeasesAreCurrent(binding.leases, taskId, attemptId)) {
        return { ok: false, reason: "stale_fence", task: copy(current) };
      }
      const next = {
        ...copy(current), ...copy(patch), state, activeBinding: null,
        updatedAt, revision: current.revision + 1,
      };
      tasks.set(taskId, next);
      releaseExactLeases(binding.leases, taskId, attemptId);
      return { ok: true, task: copy(next) };
    },
    async getWriterLease(scope) {
      return copy(leases.get(canonicalScope(scope).key));
    },
    async putLateResult(result) {
      lateResults.push(copy(result));
    },
    snapshot() {
      return {
        tasks: [...tasks.values()].map(copy),
        leases: [...leases.values()].map(copy),
        events: copy(events),
        lateResults: copy(lateResults),
      };
    },
  };

  function bindingLeasesAreCurrent(expectedLeases, taskId, attemptId) {
    return (expectedLeases || []).every((expected) => {
      const current = leases.get(expected.key || canonicalScope(expected.scope).key);
      return current?.taskId === taskId && current?.attemptId === attemptId && current?.fence === expected.fence;
    });
  }

  function releaseExactLeases(expectedLeases, taskId, attemptId) {
    for (const expected of expectedLeases || []) {
      const key = expected.key || canonicalScope(expected.scope).key;
      const current = leases.get(key);
      if (current?.taskId === taskId && current?.attemptId === attemptId && current?.fence === expected.fence) {
        leases.delete(key);
      }
    }
  }
}

function normalizeTask(runId, spec, idFactory, now) {
  const taskId = spec.taskId || idFactory("task");
  if (!Number.isSafeInteger(spec.attemptLimit ?? 1) || (spec.attemptLimit ?? 1) < 1) {
    throw new Error(`Task ${taskId} attemptLimit must be a positive safe integer.`);
  }
  return {
    ...copy(spec),
    version: 1,
    runId,
    taskId,
    parentTaskId: spec.parentTaskId || null,
    dependencies: [...new Set(spec.dependencies || [])],
    writableScopes: [...new Map((spec.writableScopes || []).map((scope) => {
      const normalized = canonicalScope(scope);
      return [normalized.key, normalized.scope];
    })).values()].sort(),
    state: "planned",
    attempt: 0,
    attemptLimit: spec.attemptLimit ?? 1,
    activeBinding: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

export class EngineeringScheduler {
  constructor({ state, runtime, capacity, clock = () => new Date().toISOString(), idFactory = makeId }) {
    if (!state || !runtime) throw new Error("EngineeringScheduler requires state and runtime adapters.");
    for (const method of ["getTask", "listTasks", "putTask", "claimAssignment", "recordTaskResult", "finishAttempt"]) {
      if (typeof state[method] !== "function") throw new Error(`State adapter is missing ${method}().`);
    }
    for (const method of ["dispatch", "inspect", "cancel"]) {
      if (typeof runtime[method] !== "function") throw new Error(`Runtime adapter is missing ${method}().`);
    }
    this.state = state;
    this.runtime = runtime;
    this.capacity = capacity || (async () => ({}));
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async registerTasks(runId, specs) {
    if (!runId) throw new Error("A run ID is required.");
    const now = this.clock();
    const tasks = specs.map((spec) => normalizeTask(runId, spec, this.idFactory, now));
    validateTaskGraph(tasks);
    for (const task of tasks) {
      if (await this.state.getTask(task.taskId)) throw new Error(`Task ${task.taskId} already exists.`);
    }
    const stored = [];
    for (const task of tasks) stored.push(await this.state.putTask(task, { expectedRevision: 0 }));
    return stored;
  }

  async #write(task, patch, reason) {
    const next = await this.state.putTask(
      { ...task, ...copy(patch), updatedAt: this.clock() },
      { expectedRevision: task.revision },
    );
    await this.state.appendEvent?.({
      runId: next.runId,
      taskId: next.taskId,
      attemptId: next.activeBinding?.attemptId || null,
      state: next.state,
      reason,
      at: next.updatedAt,
    });
    return next;
  }

  async #event(task, reason) {
    await this.state.appendEvent?.({
      runId: task.runId,
      taskId: task.taskId,
      attemptId: task.activeBinding?.attemptId || null,
      state: task.state,
      reason,
      at: task.updatedAt,
    });
  }

  async promote(runId) {
    const tasks = await this.state.listTasks(runId);
    validateTaskGraph(tasks);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const promoted = [];
    for (let task of tasks) {
      if (!["planned", "retry_pending"].includes(task.state)) continue;
      const dependencies = task.dependencies.map((id) => byId.get(id));
      const terminalFailure = dependencies.find(
        (dependency) => TERMINAL_TASK_STATES.has(dependency.state) && dependency.state !== "accepted",
      );
      if (terminalFailure) {
        task = await this.#write(task, {
          state: "blocked",
          blockedBy: terminalFailure.taskId,
        }, "dependency did not reach accepted");
        promoted.push(task);
      } else if (dependencies.every((dependency) => dependency.state === "accepted")) {
        task = await this.#write(task, { state: "ready", blockedBy: null }, "dependencies accepted");
        promoted.push(task);
      }
    }
    return promoted;
  }

  async dispatchReady(runId) {
    await this.promote(runId);
    const tasks = await this.state.listTasks(runId);
    const ready = tasks.filter((task) => task.state === "ready").sort((a, b) =>
      (a.priority ?? 0) - (b.priority ?? 0) || a.taskId.localeCompare(b.taskId));
    const capacity = await this.capacity({ runId, ready: copy(ready) });
    const count = admittedTaskCount(ready.length, capacity);
    const dispatched = [];
    let admitted = 0;

    for (const original of ready) {
      if (admitted >= count) break;
      let task = await this.state.getTask(original.taskId);
      if (task.state !== "ready") continue;
      const attempt = task.attempt + 1;
      if (attempt > task.attemptLimit) {
        dispatched.push(await this.#write(task, { state: "failed" }, "attempt limit exhausted"));
        continue;
      }
      const attemptId = this.idFactory("attempt");
      const operationId = this.idFactory("dispatch");
      const binding = {
        attempt,
        attemptId,
        operationId,
        intentRecordedAt: this.clock(),
        childId: null,
      };
      // The assignment and exact dispatch identity are durable before the
      // runtime sees a request. Scope reservation and task CAS are one state
      // transaction, so a crash cannot strand an unowned writer lease.
      const assignment = await this.state.claimAssignment({
        taskId: task.taskId,
        expectedRevision: task.revision,
        binding,
        scopes: task.writableScopes,
        updatedAt: this.clock(),
      });
      if (!assignment.ok) continue;
      admitted += 1;
      task = assignment.task;
      await this.#event(task, "assignment intent and writer fences recorded");

      try {
        const receipt = await this.runtime.dispatch({ task: copy(task), binding: copy(task.activeBinding) });
        const current = await this.state.getTask(task.taskId);
        if (current.activeBinding?.attemptId !== attemptId) continue;
        if (current.state !== "assigned") {
          task = current;
          dispatched.push(task);
          continue;
        }
        task = await this.#write(current, {
          state: receipt?.state === "running" ? "running" : "assigned",
          activeBinding: {
            ...current.activeBinding,
            childId: receipt?.childId || current.activeBinding.childId,
            dispatchReceipt: copy(receipt || null),
          },
        }, "runtime acknowledged dispatch");
      } catch (error) {
        const current = await this.state.getTask(task.taskId);
        if (error?.dispatched === false) {
          const cancelledBeforeDispatch = current.state === "cancelling";
          const finished = await this.state.finishAttempt({
            taskId: current.taskId,
            expectedRevision: current.revision,
            attemptId,
            state: cancelledBeforeDispatch
              ? "cancelled"
              : current.attempt < current.attemptLimit ? "retry_pending" : "failed",
            patch: { lastError: String(error?.message || error) },
            updatedAt: this.clock(),
          });
          task = finished.task;
          if (finished.ok) await this.#event(
            task,
            cancelledBeforeDispatch ? "cancellation won before dispatch" : "runtime proved dispatch did not occur",
          );
        } else {
          task = await this.#write(current, {
            dispatchOutcome: "unknown",
            lastError: String(error?.message || error),
          }, "dispatch outcome is ambiguous; reconciliation required");
        }
      }
      dispatched.push(task);
    }
    return dispatched;
  }

  async recordResult(taskId, result) {
    let task = await this.state.getTask(taskId);
    if (!task) throw new Error(`Unknown engineering task ${taskId}.`);
    const recorded = await this.state.recordTaskResult({
      taskId,
      expectedRevision: task.revision,
      attemptId: result?.attemptId,
      operationId: result?.operationId,
      fences: result?.fences,
      result: copy(result),
      updatedAt: this.clock(),
    });
    if (recorded.integrable) await this.#event(recorded.task, "worker result recorded before notification");
    return recorded;
  }

  async cancelTask(taskId, reason = "cancelled by operator") {
    let task = await this.state.getTask(taskId);
    if (!task) throw new Error(`Unknown engineering task ${taskId}.`);
    if (TERMINAL_TASK_STATES.has(task.state)) return task;
    if (!task.activeBinding) return this.#write(task, { state: "cancelled", cancelReason: reason }, reason);
    if (task.state !== "cancelling") {
      task = await this.#write(task, { state: "cancelling", cancelReason: reason }, reason);
    }
    try {
      const outcome = await this.runtime.cancel({ task: copy(task), binding: copy(task.activeBinding) });
      if (outcome?.state === "stopped" || outcome?.state === "cancelled") {
        const finished = await this.state.finishAttempt({
          taskId: task.taskId, expectedRevision: task.revision,
          attemptId: task.activeBinding.attemptId, state: "cancelled", updatedAt: this.clock(),
        });
        if (finished.ok) await this.#event(finished.task, "runtime confirmed stop");
        return finished.task;
      }
    } catch (error) {
      task = await this.#write(task, { cancelError: String(error?.message || error) }, "cancel outcome unknown");
    }
    return task;
  }

  async reconcile(runId) {
    const tasks = await this.state.listTasks(runId);
    const reconciled = [];
    for (const original of tasks) {
      if (!ACTIVE_WRITER_STATES.has(original.state) || !original.activeBinding) continue;
      let task = await this.state.getTask(original.taskId);
      if (!ACTIVE_WRITER_STATES.has(task?.state) || !task.activeBinding) continue;
      let observation;
      try {
        observation = await this.runtime.inspect({ task: copy(task), binding: copy(task.activeBinding) });
      } catch (error) {
        // Inspection timeout or transport failure proves nothing about worker
        // liveness. Preserve both the binding and writer lease.
        task = await this.#write(task, {
          lastInspection: { outcome: "unknown", error: String(error?.message || error), at: this.clock() },
        }, "inspection was inconclusive");
        reconciled.push(task);
        continue;
      }
      if (!observation || ["unknown", "timeout"].includes(observation.state)) {
        task = await this.#write(task, {
          lastInspection: { outcome: observation?.state || "unknown", at: this.clock() },
        }, "inspection was inconclusive");
      } else if (observation.state === "running") {
        if (task.state !== "cancelling") {
          task = await this.#write(task, { state: "running" }, "runtime reports worker running");
        }
      } else if (observation.state === "result") {
        ({ task } = await this.recordResult(task.taskId, observation.result));
      } else if (["stopped", "failed", "missing"].includes(observation.state)) {
        const cancelling = task.state === "cancelling";
        const finished = await this.state.finishAttempt({
          taskId: task.taskId,
          expectedRevision: task.revision,
          attemptId: task.activeBinding.attemptId,
          state: cancelling ? "cancelled" : task.attempt < task.attemptLimit ? "retry_pending" : "failed",
          patch: cancelling ? {} : { lastError: observation.reason || observation.state },
          updatedAt: this.clock(),
        });
        task = finished.task;
        if (finished.ok) await this.#event(task, cancelling ? "runtime confirmed stop" : "runtime confirmed attempt ended without an integrable result");
      }
      reconciled.push(task);
    }
    await this.promote(runId);
    return reconciled;
  }
}
