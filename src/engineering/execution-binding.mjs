import { createHash } from "node:crypto";
import path from "node:path";

import { ENGINEERING_CONTRACT_VERSION, immutableSnapshot } from "./contracts.mjs";

const IMMUTABLE_ASSIGNMENT_FIELDS = Object.freeze([
  "agentType",
  "model",
  "provider",
  "codexProvider",
  "upstreamModel",
  "gatewayModel",
  "family",
  "requestedEffort",
  "effectiveEffort",
  "effortSource",
  "capacityHost",
  "capacityFailurePolicy",
]);

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function safeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function assignmentSnapshot(assignment) {
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
    throw new TypeError("assignment must be an object.");
  }
  const result = {};
  for (const field of IMMUTABLE_ASSIGNMENT_FIELDS) {
    if (assignment[field] !== undefined) result[field] = assignment[field];
  }
  result.codexProvider ||= result.model?.includes("/") ? "codex-router" : result.provider;
  for (const field of ["agentType", "model", "provider", "codexProvider", "family", "effectiveEffort", "effortSource"]) {
    nonempty(result[field], `assignment.${field}`);
  }
  if (result.requestedEffort !== undefined) nonempty(result.requestedEffort, "assignment.requestedEffort");
  return result;
}

function bindingDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const REQUIRED_BINDING_STRINGS = Object.freeze([
  "runId", "taskId", "attemptId", "agentType", "model", "provider",
  "codexProvider", "family", "effectiveEffort", "effortSource", "role", "preset",
  "executionHost", "worktree", "branch", "leaseToken", "dispatchOperationId", "createdAt",
]);
const OPTIONAL_BINDING_STRINGS = Object.freeze([
  "upstreamModel", "gatewayModel", "requestedEffort", "capacityHost",
  "capacityFailurePolicy", "agentId", "threadId", "turnId", "assignmentBindingId",
]);
const BINDING_FIELDS = new Set([
  "version", "type", "bindingId", ...REQUIRED_BINDING_STRINGS,
  ...OPTIONAL_BINDING_STRINGS, "policyRevision", "attempt",
]);

function identityDigestFields(binding) {
  return Object.fromEntries(Object.entries(binding).filter(([key]) => ![
    "version", "type", "bindingId",
  ].includes(key)));
}

export function validateExecutionBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("binding must be an object.");
  }
  if (input.version !== ENGINEERING_CONTRACT_VERSION || input.type !== "ExecutionBinding") {
    throw new TypeError("binding has an unsupported execution-binding contract version.");
  }
  for (const key of Object.keys(input)) {
    if (!BINDING_FIELDS.has(key)) throw new TypeError(`binding contains unsupported field ${key}.`);
  }
  for (const field of REQUIRED_BINDING_STRINGS) nonempty(input[field], `binding.${field}`);
  for (const field of OPTIONAL_BINDING_STRINGS) {
    if (input[field] !== undefined) nonempty(input[field], `binding.${field}`);
  }
  if (input.assignmentBindingId !== undefined && !/^binding-[a-f0-9]{32}$/.test(input.assignmentBindingId)) {
    throw new TypeError("binding.assignmentBindingId is invalid.");
  }
  safeInteger(input.policyRevision, "binding.policyRevision");
  safeInteger(input.attempt, "binding.attempt", { minimum: 1 });
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new TypeError("binding.createdAt must be an ISO timestamp.");
  if (input.worktree !== path.resolve(input.worktree)) {
    throw new TypeError("binding.worktree must be an absolute normalized path.");
  }
  const expected = `binding-${bindingDigest(identityDigestFields(input)).slice(0, 32)}`;
  if (input.bindingId !== expected) throw new Error("Execution binding identity digest does not match its fields.");
  return input;
}

/**
 * Create the immutable bridge between a resolved policy assignment and one
 * concrete Codex execution. The digest deliberately excludes no routing or
 * checkout identity: changing any of them creates a different binding.
 */
export function createExecutionBinding({
  runId,
  taskId,
  attemptId,
  dispatchOperationId,
  assignment,
  role,
  preset,
  policyRevision,
  attempt,
  agentId,
  executionHost = "codex-app-server",
  worktree,
  branch,
  leaseToken,
  createdAt = new Date().toISOString(),
} = {}) {
  const selected = assignmentSnapshot(assignment);
  const normalizedWorktree = path.resolve(nonempty(worktree, "worktree"));
  const fields = {
    runId: nonempty(runId, "runId"),
    taskId: nonempty(taskId, "taskId"),
    attemptId: nonempty(attemptId, "attemptId"),
    ...(agentId ? { agentId: nonempty(agentId, "agentId") } : {}),
    agentType: selected.agentType,
    model: selected.model,
    provider: selected.provider,
    codexProvider: selected.codexProvider,
    family: selected.family,
    ...(selected.upstreamModel ? { upstreamModel: selected.upstreamModel } : {}),
    ...(selected.gatewayModel ? { gatewayModel: selected.gatewayModel } : {}),
    ...(selected.requestedEffort ? { requestedEffort: selected.requestedEffort } : {}),
    effectiveEffort: selected.effectiveEffort,
    effortSource: selected.effortSource,
    ...(selected.capacityHost ? { capacityHost: selected.capacityHost } : {}),
    ...(selected.capacityFailurePolicy
      ? { capacityFailurePolicy: selected.capacityFailurePolicy }
      : {}),
    role: nonempty(role, "role"),
    preset: nonempty(preset, "preset"),
    policyRevision: safeInteger(policyRevision, "policyRevision"),
    attempt: safeInteger(attempt, "attempt", { minimum: 1 }),
    executionHost: nonempty(executionHost, "executionHost"),
    worktree: normalizedWorktree,
    branch: nonempty(branch, "branch"),
    leaseToken: nonempty(leaseToken, "leaseToken"),
    dispatchOperationId: nonempty(dispatchOperationId, "dispatchOperationId"),
    createdAt: nonempty(createdAt, "createdAt"),
  };
  const bindingId = `binding-${bindingDigest(identityDigestFields(fields)).slice(0, 32)}`;
  const binding = immutableSnapshot({
    version: ENGINEERING_CONTRACT_VERSION,
    type: "ExecutionBinding",
    ...fields,
    bindingId,
  });
  return validateExecutionBinding(binding);
}

export function bindExecutionIdentity(binding, { agentId, threadId, turnId } = {}) {
  validateExecutionBinding(binding);
  const actualAgentId = nonempty(agentId || threadId, "agentId");
  for (const [field, next] of Object.entries({ agentId: actualAgentId, threadId, turnId })) {
    if (next !== undefined && binding[field] !== undefined && binding[field] !== next) {
      throw new Error(`Execution binding is already bound to a different ${field}.`);
    }
  }
  const fields = {
    ...binding,
    assignmentBindingId: binding.assignmentBindingId || binding.bindingId,
    agentId: actualAgentId,
    ...(threadId ? { threadId: nonempty(threadId, "threadId") } : {}),
    ...(turnId ? { turnId: nonempty(turnId, "turnId") } : {}),
  };
  fields.bindingId = `binding-${bindingDigest(identityDigestFields(fields)).slice(0, 32)}`;
  const attached = immutableSnapshot(fields);
  return validateExecutionBinding(attached);
}

export function assertBindingMatchesAssignment(binding, assignment) {
  validateExecutionBinding(binding);
  const expected = assignmentSnapshot(assignment);
  for (const field of IMMUTABLE_ASSIGNMENT_FIELDS) {
    if (expected[field] !== binding[field]) {
      throw new Error(
        `Execution binding ${binding.bindingId || binding.attemptId} no longer matches assignment field ${field}.`,
      );
    }
  }
  return binding;
}

export function codexExecutionOverrides(binding) {
  validateExecutionBinding(binding);
  const effort = binding.effectiveEffort;
  return immutableSnapshot({
    model: binding.model,
    modelProvider: binding.codexProvider,
    cwd: binding.worktree,
    ...(![undefined, null, "", "default", "unknown"].includes(effort) ? { effort } : {}),
  });
}

export function executionBindingFingerprint(binding) {
  validateExecutionBinding(binding);
  return bindingDigest(binding);
}
