import { immutableSnapshot } from "./contracts.mjs";
import { readEngineeringPolicyState } from "./policy-state.mjs";
import { resolveEngineeringAssignment, resolveEngineeringLead } from "./policy.mjs";
import { normalizeEngineeringUsage, summarizeEngineeringUsage } from "./telemetry.mjs";

const SAFE_CANDIDATE_FIELDS = Object.freeze([
  "model",
  "effort",
  "capacityHost",
  "disabled",
  "minimumCapabilities",
]);

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function candidateSnapshot(candidate) {
  if (!object(candidate)) return undefined;
  return Object.fromEntries(
    SAFE_CANDIDATE_FIELDS
      .filter((field) => candidate[field] !== undefined)
      .map((field) => [field, candidate[field]]),
  );
}

function roleSnapshot(role) {
  if (!object(role)) return undefined;
  return {
    candidates: (role.candidates || []).map(candidateSnapshot).filter(Boolean),
    optionalCandidates: (role.optionalCandidates || []).map(candidateSnapshot).filter(Boolean),
    ...(role.capacityFailurePolicy ? { capacityFailurePolicy: role.capacityFailurePolicy } : {}),
    ...(role.requireDifferentFamilyFromAuthor !== undefined
      ? { requireDifferentFamilyFromAuthor: role.requireDifferentFamilyFromAuthor }
      : {}),
    ...(role.minimumCapabilities ? { minimumCapabilities: role.minimumCapabilities } : {}),
  };
}

function roleMapSnapshot(roles) {
  return Object.fromEntries(
    Object.entries(object(roles) ? roles : {})
      .map(([name, role]) => [name, roleSnapshot(role)])
      .filter(([, role]) => role),
  );
}

/**
 * Return the policy projection allowed on CLI, desktop, and HTTP status
 * surfaces. This function deliberately reconstructs the object instead of
 * redacting a copy so a future secret-bearing policy field fails closed.
 */
export function sanitizeEngineeringPolicy(policy) {
  if (!object(policy)) throw new TypeError("Engineering policy must be an object.");
  return immutableSnapshot({
    schemaVersion: policy.schemaVersion,
    enabled: policy.enabled === true,
    activePreset: policy.activePreset,
    lead: object(policy.lead)
      ? {
          executionMode: policy.lead.executionMode,
          model: policy.lead.model,
          effort: policy.lead.effort,
        }
      : undefined,
    deepSeekRecovery: (policy.deepSeekRecovery || []).map(candidateSnapshot).filter(Boolean),
    enabledOptionalModels: [...(policy.enabledOptionalModels || [])],
    operatorModelDefaults: { ...(policy.operatorModelDefaults || {}) },
    workspace: { roles: roleMapSnapshot(policy.workspace?.roles) },
    presets: Object.fromEntries(
      Object.entries(object(policy.presets) ? policy.presets : {}).map(([name, preset]) => [
        name,
        { roles: roleMapSnapshot(preset?.roles) },
      ]),
    ),
  });
}

export function engineeringUsageEvents(events = []) {
  if (!Array.isArray(events)) throw new TypeError("Engineering usage events must be an array.");
  return events
    .filter((event) => (
      object(event) &&
      typeof event.runId === "string" &&
      typeof event.taskId === "string" &&
      typeof event.attemptId === "string" &&
      object(event.usage)
    ))
    .map((event) => immutableSnapshot({
      schemaVersion: event.schemaVersion === 1 ? 1 : undefined,
      at: event.at,
      runId: event.runId,
      taskId: event.taskId,
      attemptId: event.attemptId,
      role: event.role,
      sourceRevision: event.sourceRevision,
      model: event.model,
      provider: event.provider,
      family: event.family,
      source: event.source,
      usage: normalizeEngineeringUsage(event.usage),
      ...(event.requestedRoute ? { requestedRoute: event.requestedRoute } : {}),
      ...(event.servingRoute ? { servingRoute: event.servingRoute } : {}),
      ...(event.requestedEffort ? { requestedEffort: event.requestedEffort } : {}),
      ...(event.effectiveEffort ? { effectiveEffort: event.effectiveEffort } : {}),
      ...(event.effortSource ? { effortSource: event.effortSource } : {}),
      ...(Number.isSafeInteger(event.latencyMs) ? { latencyMs: event.latencyMs } : {}),
      ...(Number.isSafeInteger(event.retries) ? { retries: event.retries } : {}),
      ...(event.circuitState ? { circuitState: event.circuitState } : {}),
      ...(event.verificationOutcome ? { verificationOutcome: event.verificationOutcome } : {}),
    }));
}

export function engineeringUsageSnapshot(events = []) {
  const filtered = engineeringUsageEvents(events);
  return immutableSnapshot({
    summary: summarizeEngineeringUsage(events.filter((event) => (
      object(event) &&
      typeof event.runId === "string" &&
      typeof event.taskId === "string" &&
      typeof event.attemptId === "string" &&
      object(event.usage)
    ))),
    events: filtered,
  });
}

function effectiveRoleSnapshots(policy) {
  const presetRoles = policy.presets?.[policy.activePreset]?.roles || {};
  const workspaceRoles = policy.workspace?.roles || {};
  return roleMapSnapshot({ ...presetRoles, ...workspaceRoles });
}

export function engineeringControlSnapshot({ state, usageEvents = [] } = {}) {
  if (!object(state) || !object(state.policy)) {
    throw new TypeError("Engineering policy state is required.");
  }
  const degraded = state.degraded === true;
  const usage = engineeringUsageSnapshot(usageEvents);
  return immutableSnapshot({
    version: 1,
    revision: Number.isSafeInteger(state.revision) ? state.revision : null,
    status: state.status,
    fresh: !degraded,
    configured: Number.isSafeInteger(state.revision) && state.revision > 0,
    enabled: degraded ? false : state.policy.enabled === true,
    healthy: !degraded,
    degraded,
    activePreset: state.policy.activePreset,
    roles: effectiveRoleSnapshots(state.policy),
    usage: usage.summary,
    gates: {
      codexTargetOnly: true,
      manualOptIn: true,
      compareAndSwap: true,
      ordinaryRoutingUnaffected: true,
    },
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  });
}

export function readEngineeringControlSnapshot({
  stateOptions,
  usageEvents = [],
} = {}) {
  return engineeringControlSnapshot({
    state: readEngineeringPolicyState(stateOptions),
    usageEvents,
  });
}

export function previewEngineeringAssignment({
  role,
  state,
  attemptOverride,
  taskOverride,
  authorBinding,
  highRisk = false,
  configuredModels = [],
  offeredBindings = [],
  modelBySlug,
  listedModels,
  modelInventory,
} = {}) {
  if (!object(state) || !object(state.policy)) {
    throw new TypeError("Engineering policy state is required.");
  }
  if (state.degraded) {
    return immutableSnapshot({
      status: "disabled",
      reason: "engineering policy state is degraded",
      policyRevision: null,
      role,
      rejectedCandidates: [],
    });
  }
  const common = {
    policy: state.policy,
    policyRevision: state.revision,
    modelBySlug,
    listedModels,
    modelInventory,
  };
  if (role === "lead_engineer") {
    return resolveEngineeringLead({
      ...common,
      override: attemptOverride || taskOverride,
      offeredBindings,
    });
  }
  return resolveEngineeringAssignment({
    ...common,
    role,
    attemptOverride,
    taskOverride,
    authorBinding,
    highRisk,
    configuredModels,
    offeredBindings,
  });
}
