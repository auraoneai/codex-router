import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { withAtomicStateLock } from "../atomic-state-lock.mjs";
import { writePrivateJson } from "../file-security.mjs";
import { STATE_DIR } from "../paths.mjs";
import { validateExecutionBinding } from "./execution-binding.mjs";
import { readEngineeringState, validateEngineeringState } from "./state.mjs";

const ADAPTER_SCHEMA_VERSION = 1;
const RESULT_STATES = new Set(["assigned", "running"]);
const ACTIVE_STATES = new Set(["assigned", "running", "cancelling"]);
const INTERNAL_TASK_FIELDS = new Set([
  "id",
  "version",
  "revision",
  "fenceSequence",
  "lease",
  "transitions",
  "schedulerRevision",
  "contractVersion",
]);

export function engineeringSchedulerStatePath(stateDir = STATE_DIR) {
  return path.join(stateDir, "engineering-state.json");
}

function copy(value) {
  return value === undefined ? value : structuredClone(value);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function safeRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function timestamp(value, clock) {
  const resolved = value ?? clock();
  if (typeof resolved !== "string" || !Number.isFinite(Date.parse(resolved))) {
    throw new TypeError("Engineering scheduler timestamps must be ISO date strings.");
  }
  return resolved;
}

function canonicalScope(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Writable scopes must be non-empty strings.");
  }
  const scope = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    scope === "." || scope === ".." || scope.startsWith("../") || scope.startsWith("/")
    || scope.includes("/../") || scope.includes("\0")
  ) {
    throw new Error(`Unsafe writable scope: ${value}`);
  }
  return { scope, key: scope.toLocaleLowerCase("en-US") };
}

function scopesConflict(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function adapterSection(store) {
  if (store.schedulerAdapter === undefined) {
    store.schedulerAdapter = {
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      scopeFences: {},
      writerLeases: {},
      events: [],
      quarantine: [],
      quarantineSequence: 0,
    };
  }
  const section = store.schedulerAdapter;
  if (!plainObject(section) || section.schemaVersion !== ADAPTER_SCHEMA_VERSION) {
    throw new Error("Unsupported engineering scheduler adapter state.");
  }
  if (!plainObject(section.scopeFences) || !plainObject(section.writerLeases)) {
    throw new Error("Engineering scheduler writer state is malformed.");
  }
  if (!Array.isArray(section.events) || !Array.isArray(section.quarantine)) {
    throw new Error("Engineering scheduler history is malformed.");
  }
  safeRevision(section.quarantineSequence, "Engineering scheduler quarantine sequence");
  return section;
}

function schedulerRevision(task) {
  return safeRevision(task.schedulerRevision ?? 0, `Task ${task.id} scheduler revision`);
}

function assertTaskRevision(task, expectedRevision) {
  safeRevision(expectedRevision, `Task ${task.id} expected revision`);
  const actual = schedulerRevision(task);
  if (actual !== expectedRevision) {
    throw new Error(`Task ${task.id} revision conflict: expected ${expectedRevision}, found ${actual}.`);
  }
}

function schedulerFields(input) {
  const result = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!INTERNAL_TASK_FIELDS.has(key)) result[key] = copy(value);
  }
  return result;
}

function toSchedulerTask(task) {
  if (!task) return undefined;
  const result = schedulerFields(task);
  result.version = task.contractVersion ?? 1;
  result.revision = schedulerRevision(task);
  return result;
}

function appendTransition(task, nextState, reason, at) {
  if (task.state === nextState) return false;
  const from = task.state;
  task.state = nextState;
  task.version += 1;
  task.transitions.push({
    version: task.version,
    from,
    to: nextState,
    at,
    reason,
  });
  return true;
}

function bumpTask(task, transitioned = false) {
  if (!transitioned) task.version += 1;
  task.schedulerRevision = schedulerRevision(task) + 1;
}

function taskLeaseIsCurrent(task, attemptId) {
  return plainObject(task.lease)
    && task.lease.owner === `attempt:${attemptId}`
    && task.lease.sequence === task.fenceSequence;
}

function bindingLeasesAreCurrent(section, leases, taskId, attemptId) {
  return (leases || []).every((expected) => {
    const key = expected.key || canonicalScope(expected.scope).key;
    const active = section.writerLeases[key];
    return active?.taskId === taskId
      && active?.attemptId === attemptId
      && active?.fence === expected.fence;
  });
}

function releaseExactLeases(section, leases, taskId, attemptId) {
  for (const expected of leases || []) {
    const key = expected.key || canonicalScope(expected.scope).key;
    const active = section.writerLeases[key];
    if (
      active?.taskId === taskId
      && active?.attemptId === attemptId
      && active?.fence === expected.fence
    ) {
      delete section.writerLeases[key];
    }
  }
}

function exactReportedFences(expectedLeases, reportedFences) {
  if (!plainObject(reportedFences)) return (expectedLeases || []).length === 0;
  const expected = expectedLeases || [];
  if (Object.keys(reportedFences).length !== expected.length) return false;
  return expected.every((lease) => reportedFences[lease.scope] === lease.fence);
}

function quarantine(section, kind, details, observedAt) {
  section.quarantineSequence += 1;
  const record = {
    quarantineId: `quarantine_${section.quarantineSequence}`,
    kind,
    nonIntegrable: true,
    observedAt,
    ...copy(details),
  };
  section.quarantine.push(record);
  return record;
}

function validateAdapterInvariants(store) {
  const section = adapterSection(store);
  for (const [key, lease] of Object.entries(section.writerLeases)) {
    const task = store.tasks[lease.taskId];
    const binding = task?.activeBinding;
    const expected = binding?.leases?.find((item) => (item.key || canonicalScope(item.scope).key) === key);
    if (
      !task || !ACTIVE_STATES.has(task.state) || !taskLeaseIsCurrent(task, lease.attemptId)
      || binding?.attemptId !== lease.attemptId || expected?.fence !== lease.fence
    ) {
      throw new Error(`Orphaned or stale engineering writer lease: ${key}.`);
    }
  }
  for (const task of Object.values(store.tasks)) {
    if (task.activeBinding) {
      if (!ACTIVE_STATES.has(task.state) || !taskLeaseIsCurrent(task, task.activeBinding.attemptId)) {
        throw new Error(`Engineering task ${task.id} has an unfenced active binding.`);
      }
      if (!bindingLeasesAreCurrent(section, task.activeBinding.leases, task.id, task.activeBinding.attemptId)) {
        throw new Error(`Engineering task ${task.id} has a stale writer lease.`);
      }
    } else if (task.lease !== null) {
      throw new Error(`Engineering task ${task.id} has a lease without an active binding.`);
    }
    if (task.state === "result_recorded" && !plainObject(task.completedAttempt)) {
      throw new Error(`Engineering task ${task.id} has no durable completed-attempt record.`);
    }
  }
  return store;
}

/**
 * Durable scheduler adapter backed by the engineering state document. The
 * scheduler's numeric revision is deliberately stored as schedulerRevision;
 * state.mjs owns task.version and the immutable source revision separately.
 */
export class DurableSchedulerState {
  constructor(target, {
    clock = () => new Date().toISOString(),
    faultInjector = () => {},
  } = {}) {
    this.target = requiredString(target, "Engineering state path");
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  #read() {
    return validateAdapterInvariants(readEngineeringState(this.target));
  }

  #mutate(operation, { expectedStoreVersion, beforeCommitPhase, afterCommitPhase } = {}) {
    const result = withAtomicStateLock(this.target, () => {
      const current = readEngineeringState(this.target);
      if (expectedStoreVersion !== undefined) {
        safeRevision(expectedStoreVersion, "Engineering state expected version");
        if (current.version !== expectedStoreVersion) {
          throw new Error(`Engineering state version conflict: expected ${expectedStoreVersion}, found ${current.version}.`);
        }
      }
      const next = copy(current);
      adapterSection(next);
      const value = operation(next);
      validateAdapterInvariants(next);
      validateEngineeringState(next);
      if (beforeCommitPhase) this.faultInjector(beforeCommitPhase, copy(value));
      next.version += 1;
      writePrivateJson(this.target, next, { space: 2, directoryMode: 0o700 });
      return { value: copy(value), storeVersion: next.version };
    });
    if (afterCommitPhase) this.faultInjector(afterCommitPhase, copy(result));
    return result;
  }

  async getTask(taskId) {
    return toSchedulerTask(this.#read().tasks[requiredString(taskId, "Engineering task id")]);
  }

  async listTasks(runId) {
    return Object.values(this.#read().tasks)
      .filter((task) => task.runId === runId)
      .map(toSchedulerTask);
  }

  async putTask(input, { expectedRevision, expectedStoreVersion } = {}) {
    if (!plainObject(input)) throw new TypeError("Engineering scheduler task must be an object.");
    const taskId = requiredString(input.taskId || input.id, "Engineering task id");
    const at = timestamp(input.updatedAt, this.clock);
    return this.#mutate((store) => {
      const existing = store.tasks[taskId];
      if (!existing) {
        if (expectedRevision !== undefined && expectedRevision !== 0) {
          throw new Error(`Task ${taskId} revision conflict: expected ${expectedRevision}, found 0.`);
        }
        const fields = schedulerFields(input);
        const created = {
          ...fields,
          id: taskId,
          taskId,
          state: "planned",
          version: 1,
          contractVersion: input.version ?? 1,
          schedulerRevision: 1,
          fenceSequence: 0,
          lease: null,
          revision: input.baseRevision ?? input.sourceRevision ?? null,
          transitions: [{ version: 1, from: null, to: "planned", at, reason: "task registered" }],
        };
        store.tasks[taskId] = created;
        return toSchedulerTask(created);
      }
      assertTaskRevision(existing, expectedRevision);
      const fields = schedulerFields(input);
      const nextState = fields.state ?? existing.state;
      const transitioned = appendTransition(existing, nextState, fields.transitionReason || `scheduler updated task to ${nextState}`, at);
      Object.assign(existing, fields, { state: nextState, updatedAt: at });
      if (nextState === "accepted" && plainObject(fields.acceptance)) {
        existing.revision = fields.acceptance.revision;
      }
      bumpTask(existing, transitioned);
      return toSchedulerTask(existing);
    }, { expectedStoreVersion }).value;
  }

  async appendEvent(event, { expectedStoreVersion } = {}) {
    const at = timestamp(event?.at, this.clock);
    return this.#mutate((store) => {
      const record = { ...copy(event), at };
      adapterSection(store).events.push(record);
      return record;
    }, { expectedStoreVersion }).value;
  }

  async claimAssignment({
    taskId,
    expectedRevision,
    expectedStoreVersion,
    binding,
    scopes = [],
    updatedAt,
  } = {}) {
    requiredString(taskId, "Engineering task id");
    if (!plainObject(binding)) throw new TypeError("Engineering assignment binding must be an object.");
    const attemptId = requiredString(binding.attemptId, "Engineering attempt id");
    requiredString(binding.operationId, "Engineering operation id");
    const at = timestamp(updatedAt, this.clock);
    const canonical = [...new Map(scopes.map((scope) => {
      const item = canonicalScope(scope);
      return [item.key, item];
    })).values()].sort((a, b) => a.key.localeCompare(b.key));

    return this.#mutate((store) => {
      const section = adapterSection(store);
      const task = store.tasks[taskId];
      if (!task || schedulerRevision(task) !== expectedRevision || task.state !== "ready") {
        return { ok: false, reason: "task_changed", task: toSchedulerTask(task) };
      }
      for (const requested of canonical) {
        for (const active of Object.values(section.writerLeases)) {
          if (scopesConflict(requested.key, active.key)) {
            return { ok: false, reason: "writer_conflict", conflict: copy(active) };
          }
        }
      }
      store.fenceSequence += 1;
      task.fenceSequence = store.fenceSequence;
      task.lease = {
        token: `attempt_lease_${store.fenceSequence}_${randomBytes(18).toString("base64url")}`,
        sequence: store.fenceSequence,
        owner: `attempt:${attemptId}`,
        acquiredAt: at,
      };
      const leases = canonical.map(({ scope, key }) => {
        const fence = (section.scopeFences[key] || 0) + 1;
        section.scopeFences[key] = fence;
        const lease = { scope, key, fence, runId: task.runId, taskId, attemptId };
        section.writerLeases[key] = lease;
        return lease;
      });
      const transitioned = appendTransition(task, "assigned", "assignment intent and writer fences recorded", at);
      task.attempt = binding.attempt;
      task.activeBinding = { ...copy(binding), leases };
      task.updatedAt = at;
      bumpTask(task, transitioned);
      return { ok: true, task: toSchedulerTask(task) };
    }, {
      expectedStoreVersion,
      beforeCommitPhase: "claimAssignment:beforeCommit",
      afterCommitPhase: "claimAssignment:afterCommit",
    }).value;
  }

  async recordTaskResult({
    taskId,
    expectedRevision,
    expectedStoreVersion,
    attemptId,
    operationId,
    fences,
    result,
    updatedAt,
  } = {}) {
    requiredString(taskId, "Engineering task id");
    const at = timestamp(updatedAt, this.clock);
    return this.#mutate((store) => {
      const section = adapterSection(store);
      const task = store.tasks[taskId];
      const binding = task?.activeBinding;
      const exactAttempt = task
        && schedulerRevision(task) === expectedRevision
        && binding?.attemptId === attemptId
        && binding?.operationId === operationId;
      const exactLeases = exactAttempt
        && RESULT_STATES.has(task.state)
        && taskLeaseIsCurrent(task, attemptId)
        && bindingLeasesAreCurrent(section, binding.leases, taskId, attemptId)
        && exactReportedFences(binding.leases, fences);
      if (!exactLeases) {
        const completed = task?.completedAttempt;
        const duplicate = completed?.attemptId === attemptId && completed?.operationId === operationId;
        const lateResult = quarantine(section, duplicate ? "duplicate_result" : "late_result", {
          taskId,
          attemptId,
          operationId,
          observedState: task?.state || "missing",
          resultDigest: digest(result),
          result: copy(result),
        }, at);
        return {
          integrable: false,
          reason: duplicate ? "duplicate_result" : "late_or_stale_result",
          task: toSchedulerTask(task),
          lateResult,
        };
      }

      const resultDigest = digest(result);
      const leases = copy(binding.leases);
      if (task.state === "assigned") {
        appendTransition(task, "running", "worker result proves the assigned attempt ran", at);
      }
      const transitioned = appendTransition(task, "result_recorded", "worker result durably recorded", at);
      task.workerResult = copy(result);
      task.completedAttempt = {
        attemptId,
        operationId,
        fences: Object.fromEntries(leases.map((lease) => [lease.scope, lease.fence])),
        resultDigest,
        recordedAt: at,
        incorporation: null,
        ...(task.executionBinding || binding.executionBinding || binding.dispatchReceipt?.executionBinding
          ? { executionBinding: copy(task.executionBinding || binding.executionBinding || binding.dispatchReceipt.executionBinding) }
          : {}),
      };
      task.activeBinding = null;
      task.updatedAt = at;
      bumpTask(task, transitioned);
      releaseExactLeases(section, leases, taskId, attemptId);
      task.lease = null;
      return { integrable: true, task: toSchedulerTask(task), resultDigest };
    }, {
      expectedStoreVersion,
      beforeCommitPhase: "recordTaskResult:beforeCommit",
      afterCommitPhase: "recordTaskResult:afterCommit",
    }).value;
  }

  async finishAttempt({
    taskId,
    expectedRevision,
    expectedStoreVersion,
    attemptId,
    state,
    patch = {},
    updatedAt,
  } = {}) {
    requiredString(taskId, "Engineering task id");
    requiredString(state, "Engineering task state");
    const at = timestamp(updatedAt, this.clock);
    return this.#mutate((store) => {
      const section = adapterSection(store);
      const task = store.tasks[taskId];
      const binding = task?.activeBinding;
      if (!task || schedulerRevision(task) !== expectedRevision || binding?.attemptId !== attemptId) {
        return { ok: false, reason: "attempt_changed", task: toSchedulerTask(task) };
      }
      if (
        !taskLeaseIsCurrent(task, attemptId)
        || !bindingLeasesAreCurrent(section, binding.leases, taskId, attemptId)
      ) {
        return { ok: false, reason: "stale_fence", task: toSchedulerTask(task) };
      }
      const leases = copy(binding.leases);
      const fields = schedulerFields(patch);
      const transitioned = appendTransition(task, state, fields.transitionReason || `attempt finished as ${state}`, at);
      Object.assign(task, fields, {
        state,
        activeBinding: null,
        updatedAt: at,
        completedAttempt: {
          attemptId,
          operationId: binding.operationId,
          fences: Object.fromEntries(leases.map((lease) => [lease.scope, lease.fence])),
          finishedAt: at,
          terminalState: state,
          incorporation: null,
          ...(task.executionBinding || binding.executionBinding || binding.dispatchReceipt?.executionBinding
            ? { executionBinding: copy(task.executionBinding || binding.executionBinding || binding.dispatchReceipt.executionBinding) }
            : {}),
        },
      });
      bumpTask(task, transitioned);
      releaseExactLeases(section, leases, taskId, attemptId);
      task.lease = null;
      return { ok: true, task: toSchedulerTask(task) };
    }, {
      expectedStoreVersion,
      beforeCommitPhase: "finishAttempt:beforeCommit",
      afterCommitPhase: "finishAttempt:afterCommit",
    }).value;
  }

  async acknowledgeIncorporation({
    taskId,
    expectedRevision,
    expectedStoreVersion,
    attemptId,
    operationId,
    incorporationId,
    updatedAt,
  } = {}) {
    requiredString(taskId, "Engineering task id");
    requiredString(attemptId, "Engineering attempt id");
    requiredString(operationId, "Engineering operation id");
    requiredString(incorporationId, "Engineering incorporation id");
    const at = timestamp(updatedAt, this.clock);
    return this.#mutate((store) => {
      const section = adapterSection(store);
      const task = store.tasks[taskId];
      const completed = task?.completedAttempt;
      if (
        !task || (expectedRevision !== undefined && schedulerRevision(task) !== expectedRevision)
        || completed?.attemptId !== attemptId || completed?.operationId !== operationId
        || !completed.resultDigest
      ) {
        const acknowledgement = quarantine(section, "late_incorporation_acknowledgement", {
          taskId, attemptId, operationId, incorporationId, observedState: task?.state || "missing",
        }, at);
        return { ok: false, reason: "result_changed", task: toSchedulerTask(task), acknowledgement };
      }
      if (completed.incorporation) {
        return {
          ok: true,
          duplicate: true,
          acknowledgement: copy(completed.incorporation),
          task: toSchedulerTask(task),
        };
      }
      completed.incorporation = { incorporationId, acknowledgedAt: at };
      task.updatedAt = at;
      bumpTask(task);
      return {
        ok: true,
        duplicate: false,
        acknowledgement: copy(completed.incorporation),
        task: toSchedulerTask(task),
      };
    }, {
      expectedStoreVersion,
      beforeCommitPhase: "acknowledgeIncorporation:beforeCommit",
      afterCommitPhase: "acknowledgeIncorporation:afterCommit",
    }).value;
  }

  async getWriterLease(scope) {
    const key = canonicalScope(scope).key;
    return copy(adapterSection(this.#read()).writerLeases[key]);
  }

  resolveBinding(bindingId) {
    requiredString(bindingId, "Engineering execution binding id");
    const store = this.#read();
    for (const task of Object.values(store.tasks)) {
      if (!["assigned", "running"].includes(task.state) || !task.activeBinding) continue;
      if (task.policyEnabledAtAssignment !== true) continue;
      const candidates = [
        task.executionBinding,
        task.activeBinding?.executionBinding,
        task.activeBinding?.dispatchReceipt?.executionBinding,
      ].filter(Boolean);
      const binding = candidates.find((candidate) => candidate.bindingId === bindingId);
      if (!binding) continue;
      validateExecutionBinding(binding);
      if (binding.taskId !== task.taskId || binding.runId !== task.runId) {
        throw new Error(`Engineering execution binding ${bindingId} does not match its durable task identity.`);
      }
      if (binding.attemptId !== task.activeBinding.attemptId) {
        throw new Error(`Engineering execution binding ${bindingId} is not the task's current attempt.`);
      }
      return Object.freeze({
        binding: Object.freeze(copy(binding)),
        bindingId,
        model: binding.model,
        effectiveEffort: binding.effectiveEffort,
        runId: binding.runId,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        role: binding.role,
        policyEnabledAtAssignment: true,
        sourceRevision: task.revision ?? task.baseRevision ?? task.sourceRevision ?? null,
        status: task.state,
        schedulerRevision: schedulerRevision(task),
      });
    }
    return undefined;
  }

  async putLateResult(result, { expectedStoreVersion } = {}) {
    const at = timestamp(result?.observedAt, this.clock);
    return this.#mutate((store) => quarantine(
      adapterSection(store),
      result?.kind || "late_result",
      result,
      at,
    ), { expectedStoreVersion }).value;
  }

  recover() {
    const store = this.#read();
    return {
      storeVersion: store.version,
      tasks: Object.values(store.tasks).map(toSchedulerTask),
      leases: Object.values(adapterSection(store).writerLeases).map(copy),
    };
  }

  snapshot() {
    const store = this.#read();
    const section = adapterSection(store);
    return {
      storeVersion: store.version,
      tasks: Object.values(store.tasks).map(toSchedulerTask),
      leases: Object.values(section.writerLeases).map(copy),
      events: copy(section.events),
      lateResults: copy(section.quarantine),
    };
  }
}

export function createDurableSchedulerState(target, options) {
  return new DurableSchedulerState(target, options);
}

export function resolveEngineeringBinding(
  bindingId,
  { target = engineeringSchedulerStatePath(), ...options } = {},
) {
  return createDurableSchedulerState(target, options).resolveBinding(bindingId);
}
