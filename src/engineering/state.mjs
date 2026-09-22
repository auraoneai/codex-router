import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";

import { withAtomicStateLock } from "../atomic-state-lock.mjs";
import { privateFileIsProtected, writePrivateJson } from "../file-security.mjs";

export const ENGINEERING_STATE_SCHEMA_VERSION = 1;

export const ENGINEERING_TASK_STATES = Object.freeze([
  "planned",
  "ready",
  "assigned",
  "running",
  "result_recorded",
  "verifying",
  "reviewing",
  "integrating",
  "accepted",
  "retry_pending",
  "needs_remediation",
  "blocked",
  "cancelling",
  "cancelled",
  "failed",
]);

const STATE_SET = new Set(ENGINEERING_TASK_STATES);
const TRANSITIONS = new Map(Object.entries({
  planned: ["ready", "blocked", "cancelled", "failed"],
  ready: ["assigned", "blocked", "cancelled", "failed"],
  assigned: ["running", "retry_pending", "cancelling", "blocked", "failed"],
  running: ["result_recorded", "retry_pending", "needs_remediation", "cancelling", "blocked", "failed"],
  result_recorded: ["verifying", "retry_pending", "needs_remediation", "blocked", "failed"],
  verifying: ["reviewing", "integrating", "needs_remediation", "retry_pending", "blocked", "failed"],
  reviewing: ["integrating", "needs_remediation", "retry_pending", "blocked", "failed"],
  integrating: ["verifying", "needs_remediation", "retry_pending", "blocked", "failed"],
  retry_pending: ["ready", "assigned", "blocked", "cancelled", "failed"],
  needs_remediation: ["ready", "assigned", "blocked", "cancelled", "failed"],
  blocked: ["ready", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  failed: ["retry_pending"],
  accepted: [],
}).map(([state, next]) => [state, new Set(next)]));

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function safeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function newFenceToken(sequence) {
  return `lease_${sequence}_${randomBytes(18).toString("base64url")}`;
}

function emptyStore() {
  return {
    schemaVersion: ENGINEERING_STATE_SCHEMA_VERSION,
    version: 0,
    fenceSequence: 0,
    tasks: {},
  };
}

function validateTransitionRecord(record, index) {
  if (!plainObject(record)) throw new Error(`Engineering transition ${index} is malformed.`);
  safeInteger(record.version, `Engineering transition ${index} version`, { minimum: 1 });
  if (record.from !== null && !STATE_SET.has(record.from)) {
    throw new Error(`Engineering transition ${index} has an unknown source state.`);
  }
  if (!STATE_SET.has(record.to)) throw new Error(`Engineering transition ${index} has an unknown destination state.`);
  nonEmptyString(record.at, `Engineering transition ${index} timestamp`);
  nonEmptyString(record.reason, `Engineering transition ${index} reason`);
}

function validateTask(task, taskId) {
  if (!plainObject(task)) throw new Error(`Engineering task ${taskId} is malformed.`);
  if (task.id !== taskId) throw new Error(`Engineering task ${taskId} has a mismatched id.`);
  if (!STATE_SET.has(task.state)) throw new Error(`Engineering task ${taskId} has an unknown state.`);
  safeInteger(task.version, `Engineering task ${taskId} version`, { minimum: 1 });
  safeInteger(task.fenceSequence, `Engineering task ${taskId} fence sequence`);
  if (task.lease !== null) {
    if (!plainObject(task.lease)) throw new Error(`Engineering task ${taskId} lease is malformed.`);
    nonEmptyString(task.lease.token, `Engineering task ${taskId} lease token`);
    nonEmptyString(task.lease.owner, `Engineering task ${taskId} lease owner`);
    safeInteger(task.lease.sequence, `Engineering task ${taskId} lease sequence`, { minimum: 1 });
    if (task.lease.sequence !== task.fenceSequence) {
      throw new Error(`Engineering task ${taskId} lease fence does not match its sequence.`);
    }
  }
  if (!Array.isArray(task.transitions)) throw new Error(`Engineering task ${taskId} transitions are malformed.`);
  task.transitions.forEach(validateTransitionRecord);
  if (
    task.transitions.length === 0
    || task.transitions[0].version !== 1
    || task.transitions[0].from !== null
    || task.transitions[0].to !== "planned"
  ) {
    throw new Error(`Engineering task ${taskId} has an invalid initial transition.`);
  }
  for (let index = 1; index < task.transitions.length; index += 1) {
    const previous = task.transitions[index - 1];
    const current = task.transitions[index];
    if (current.version <= previous.version || current.from !== previous.to) {
      throw new Error(`Engineering task ${taskId} transition history is inconsistent.`);
    }
    const legal = current.to === "accepted"
      ? ["verifying", "reviewing", "integrating"].includes(current.from)
      : TRANSITIONS.get(current.from)?.has(current.to);
    if (!legal) throw new Error(`Engineering task ${taskId} transition history contains an illegal transition.`);
  }
  if (task.transitions.length === 0 || task.transitions.at(-1).to !== task.state) {
    throw new Error(`Engineering task ${taskId} state does not match its transition history.`);
  }
  if (task.version < task.transitions.at(-1).version) {
    throw new Error(`Engineering task ${taskId} version trails its transition history.`);
  }
  if (task.state === "accepted") validateAcceptance(task, taskId);
  return task;
}

function validateAcceptance(task, taskId) {
  const acceptance = task.acceptance;
  if (!plainObject(acceptance) || acceptance.accepted !== true) {
    throw new Error(`Engineering task ${taskId} is accepted without a passing runtime acceptance result.`);
  }
  if (
    typeof task.revision !== "string"
    || task.revision === ""
    || acceptance.revision !== task.revision
  ) {
    throw new Error(`Engineering task ${taskId} accepted a stale or missing revision.`);
  }
  if (
    !plainObject(acceptance.gates)
    || Object.keys(acceptance.gates).length === 0
    || !Object.values(acceptance.gates).every((value) => value === true)
  ) {
    throw new Error(`Engineering task ${taskId} is accepted without every runtime gate passing.`);
  }
  if (!Array.isArray(acceptance.blockers) || acceptance.blockers.length !== 0) {
    throw new Error(`Engineering task ${taskId} is accepted with unresolved blockers.`);
  }
}

export function validateEngineeringState(store) {
  if (!plainObject(store)) throw new Error("Engineering state is malformed.");
  if (store.schemaVersion !== ENGINEERING_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported engineering state schema: ${store.schemaVersion}.`);
  }
  safeInteger(store.version, "Engineering state version");
  safeInteger(store.fenceSequence, "Engineering state fence sequence");
  if (!plainObject(store.tasks)) throw new Error("Engineering state tasks are malformed.");
  for (const [taskId, task] of Object.entries(store.tasks)) {
    nonEmptyString(taskId, "Engineering task id");
    validateTask(task, taskId);
  }
  return store;
}

export function readEngineeringState(target, { requireProtected = true } = {}) {
  if (!existsSync(target)) return emptyStore();
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Engineering state must be a regular file: ${target}`);
  }
  if (requireProtected && !privateFileIsProtected(target)) {
    throw new Error(`Engineering state is not owner-only: ${target}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (cause) {
    throw new Error(`Engineering state is not valid JSON: ${target}`, { cause });
  }
  return validateEngineeringState(parsed);
}

function clone(value) {
  return structuredClone(value);
}

function writeStore(target, store) {
  validateEngineeringState(store);
  writePrivateJson(target, store, { space: 2, directoryMode: 0o700 });
  return clone(store);
}

function compareVersion(actual, expected, label) {
  safeInteger(expected, `${label} expected version`);
  if (actual !== expected) throw new Error(`${label} version conflict: expected ${expected}, found ${actual}.`);
}

function requireFence(task, fenceToken) {
  if (task.lease === null) {
    throw new Error(`Engineering task ${task.id} has no active lease.`);
  }
  if (typeof fenceToken !== "string" || fenceToken !== task.lease.token) {
    throw new Error(`Engineering task ${task.id} rejected a stale or missing fencing token.`);
  }
}

function mutate(target, expectedStoreVersion, operation) {
  return withAtomicStateLock(target, () => {
    const store = readEngineeringState(target);
    compareVersion(store.version, expectedStoreVersion, "Engineering state");
    const next = clone(store);
    const result = operation(next);
    next.version += 1;
    return { state: writeStore(target, next), result };
  });
}

export function createEngineeringTask(target, task, { expectedStoreVersion = 0, now = () => new Date() } = {}) {
  if (!plainObject(task)) throw new TypeError("Engineering task must be an object.");
  const taskId = nonEmptyString(task.id ?? task.taskId, "Engineering task id");
  return mutate(target, expectedStoreVersion, (store) => {
    if (store.tasks[taskId]) throw new Error(`Engineering task already exists: ${taskId}`);
    const at = now().toISOString();
    const record = {
      ...clone(task),
      id: taskId,
      state: "planned",
      version: 1,
      fenceSequence: 0,
      lease: null,
      revision: task.revision ?? task.baseRevision ?? null,
      transitions: [{ version: 1, from: null, to: "planned", at, reason: "task created" }],
    };
    validateTask(record, taskId);
    store.tasks[taskId] = record;
    return clone(record);
  });
}

export function claimEngineeringTaskLease(target, {
  taskId,
  owner,
  expectedStoreVersion,
  expectedTaskVersion,
  now = () => new Date(),
} = {}) {
  nonEmptyString(taskId, "Engineering task id");
  nonEmptyString(owner, "Engineering lease owner");
  return mutate(target, expectedStoreVersion, (store) => {
    const task = store.tasks[taskId];
    if (!task) throw new Error(`Unknown engineering task: ${taskId}`);
    compareVersion(task.version, expectedTaskVersion, `Engineering task ${taskId}`);
    if (["accepted", "cancelled"].includes(task.state)) {
      throw new Error(`Engineering task ${taskId} is terminal and cannot be leased.`);
    }
    if (task.lease !== null) throw new Error(`Engineering task ${taskId} already has an active lease.`);
    store.fenceSequence += 1;
    task.fenceSequence = store.fenceSequence;
    task.lease = {
      token: newFenceToken(store.fenceSequence),
      sequence: store.fenceSequence,
      owner,
      acquiredAt: now().toISOString(),
    };
    task.version += 1;
    return clone(task.lease);
  });
}

export function releaseEngineeringTaskLease(target, {
  taskId,
  fenceToken,
  expectedStoreVersion,
  expectedTaskVersion,
} = {}) {
  return mutate(target, expectedStoreVersion, (store) => {
    const task = store.tasks[nonEmptyString(taskId, "Engineering task id")];
    if (!task) throw new Error(`Unknown engineering task: ${taskId}`);
    compareVersion(task.version, expectedTaskVersion, `Engineering task ${taskId}`);
    requireFence(task, fenceToken);
    if (task.lease === null) throw new Error(`Engineering task ${taskId} has no active lease.`);
    task.lease = null;
    task.version += 1;
    return clone(task);
  });
}

function applyTransition(task, to, reason, now, revision) {
  if (!STATE_SET.has(to)) throw new Error(`Unknown engineering task state: ${to}`);
  if (to === "accepted") throw new Error("Use acceptEngineeringTask for the runtime acceptance transition.");
  if (!TRANSITIONS.get(task.state)?.has(to)) {
    throw new Error(`Illegal engineering task transition: ${task.state} -> ${to}.`);
  }
  const from = task.state;
  task.state = to;
  if (revision !== undefined) task.revision = revision;
  task.version += 1;
  task.transitions.push({ version: task.version, from, to, at: now().toISOString(), reason });
}

export function transitionEngineeringTask(target, {
  taskId,
  to,
  reason,
  revision,
  fenceToken,
  expectedStoreVersion,
  expectedTaskVersion,
  now = () => new Date(),
} = {}) {
  nonEmptyString(reason, "Engineering transition reason");
  return mutate(target, expectedStoreVersion, (store) => {
    const task = store.tasks[nonEmptyString(taskId, "Engineering task id")];
    if (!task) throw new Error(`Unknown engineering task: ${taskId}`);
    compareVersion(task.version, expectedTaskVersion, `Engineering task ${taskId}`);
    requireFence(task, fenceToken);
    applyTransition(task, to, reason, now, revision);
    return clone(task);
  });
}

export function acceptEngineeringTask(target, {
  taskId,
  acceptance,
  reason = "runtime acceptance gates passed",
  fenceToken,
  expectedStoreVersion,
  expectedTaskVersion,
  now = () => new Date(),
} = {}) {
  if (!plainObject(acceptance) || acceptance.accepted !== true) throw new Error("Engineering acceptance requires a passing runtime acceptance result.");
  return mutate(target, expectedStoreVersion, (store) => {
    const task = store.tasks[nonEmptyString(taskId, "Engineering task id")];
    if (!task) throw new Error(`Unknown engineering task: ${taskId}`);
    compareVersion(task.version, expectedTaskVersion, `Engineering task ${taskId}`);
    requireFence(task, fenceToken);
    if (!["verifying", "reviewing", "integrating"].includes(task.state)) {
      throw new Error(`Engineering task ${taskId} cannot be accepted from ${task.state}.`);
    }
    if (typeof task.revision !== "string" || task.revision === "" || acceptance.revision !== task.revision) {
      throw new Error(`Engineering task ${taskId} acceptance revision does not match its current revision.`);
    }
    validateAcceptance({ ...task, state: "accepted", acceptance }, taskId);
    const from = task.state;
    task.state = "accepted";
    task.version += 1;
    task.acceptance = clone(acceptance);
    task.transitions.push({ version: task.version, from, to: "accepted", at: now().toISOString(), reason });
    return clone(task);
  });
}
