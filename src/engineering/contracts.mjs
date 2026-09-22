export const ENGINEERING_CONTRACT_VERSION = 1;

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

const RECORD_TYPES = Object.freeze({
  EngineeringTask: {
    strings: ["runId", "taskId", "objective", "role", "executionHost", "baseRevision"],
    arrays: ["acceptanceCriteria", "dependencies", "ownedPaths", "artifactRefs"],
    integers: ["policyRevision", "attemptLimit", "deadlineMs"],
    optionalStrings: ["parentTaskId"],
    enums: { state: ENGINEERING_TASK_STATES },
  },
  EngineeringRoutingDecision: {
    strings: [
      "taskId", "assessmentId", "taskType", "complexity", "risk", "breadth",
      "determinism", "chosenRole", "strategy", "reviewPolicy",
      "verificationPolicy", "source",
    ],
    arrays: ["eligibleRoutes", "rejectedRoutes", "orderedFallbacks", "familyConstraints"],
    objects: ["selectedRoute"],
    optionalStrings: ["escalationReason"],
    enums: { source: ["jev", "deterministic-fallback"] },
  },
  ExecutionBinding: {
    strings: [
      "runId", "taskId", "attemptId", "bindingId", "agentType", "model", "provider",
      "codexProvider", "family", "effectiveEffort", "effortSource", "role", "preset",
      "executionHost", "worktree", "branch", "leaseToken", "dispatchOperationId", "createdAt",
    ],
    integers: ["policyRevision", "attempt"],
    optionalStrings: [
      "agentId", "threadId", "turnId", "assignmentBindingId", "upstreamModel",
      "gatewayModel", "requestedEffort", "capacityHost", "capacityFailurePolicy",
    ],
  },
  WorkerResult: {
    strings: ["taskId", "attemptId", "status", "summary", "baseRevision", "resultRevision", "nextAction"],
    arrays: ["changedFiles", "evidenceRefs", "commands", "tests", "risks", "unresolvedIssues"],
    enums: { status: ["pass", "issues", "blocked"] },
  },
  VerificationResult: {
    strings: ["taskId", "verificationId", "runner", "command", "cwd", "host", "sourceRevision", "artifactDigest", "startedAt", "finishedAt"],
    integers: ["testCount"],
    booleans: ["timedOut"],
    arrays: ["arguments", "artifactRefs"],
    optionalIntegers: ["exitCode"],
    optionalStrings: ["signal", "dirtyTreeDigest", "artifactLocation"],
  },
  ReviewResult: {
    strings: ["taskId", "reviewId", "reviewerModel", "reviewerFamily", "reviewedRevision", "disposition"],
    arrays: ["findings", "remediationRefs"],
    optionalStrings: ["severity"],
  },
  EvidencePacket: {
    strings: ["runId", "taskId", "revision", "generatedAt"],
    textStrings: ["summary"],
    arrays: [
      "acceptedResultRefs", "reviewDisagreements", "residualRisks", "unresolvedFailures",
      "rawArtifactReferences", "criticalExcerpts",
    ],
    objects: ["acceptance", "deterministicGateOutcomes", "truncation"],
    optionalObjects: ["routingSummary", "usageSummary", "leadDecision"],
  },
});

function plainObject(value, field) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(prototype)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return value;
}

function nonemptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function validateFields(type, value, schema) {
  for (const field of schema.strings || []) nonemptyString(value[field], `${type}.${field}`);
  for (const field of schema.textStrings || []) {
    if (typeof value[field] !== "string") throw new TypeError(`${type}.${field} must be a string.`);
  }
  for (const field of schema.arrays || []) {
    if (!Array.isArray(value[field])) throw new TypeError(`${type}.${field} must be an array.`);
  }
  for (const field of schema.objects || []) plainObject(value[field], `${type}.${field}`);
  for (const field of schema.integers || []) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new TypeError(`${type}.${field} must be a non-negative safe integer.`);
    }
  }
  for (const field of schema.booleans || []) {
    if (typeof value[field] !== "boolean") throw new TypeError(`${type}.${field} must be a boolean.`);
  }
  for (const field of schema.optionalStrings || []) {
    if (value[field] !== undefined && value[field] !== null) nonemptyString(value[field], `${type}.${field}`);
  }
  for (const field of schema.optionalIntegers || []) {
    if (
      value[field] !== undefined && value[field] !== null &&
      (!Number.isSafeInteger(value[field]) || value[field] < 0)
    ) throw new TypeError(`${type}.${field} must be a non-negative safe integer when present.`);
  }
  for (const field of schema.optionalObjects || []) {
    if (value[field] !== undefined && value[field] !== null) {
      plainObject(value[field], `${type}.${field}`);
    }
  }
  for (const [field, choices] of Object.entries(schema.enums || {})) {
    if (!choices.includes(value[field])) {
      throw new TypeError(`${type}.${field} is unsupported: ${JSON.stringify(value[field])}.`);
    }
  }
}

function allowedFields(schema) {
  return new Set([
    "version",
    "type",
    ...Object.keys(schema.enums || {}),
    ...(schema.strings || []),
    ...(schema.textStrings || []),
    ...(schema.arrays || []),
    ...(schema.objects || []),
    ...(schema.integers || []),
    ...(schema.booleans || []),
    ...(schema.optionalStrings || []),
    ...(schema.optionalIntegers || []),
    ...(schema.optionalObjects || []),
  ]);
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export function immutableSnapshot(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch (cause) {
    throw new TypeError("Engineering records must contain structured-cloneable data.", { cause });
  }
}

export function validateEngineeringRecord(type, input) {
  const schema = RECORD_TYPES[type];
  if (!schema) throw new TypeError(`Unknown engineering record type ${JSON.stringify(type)}.`);
  const value = plainObject(input, type);
  if (value.version !== ENGINEERING_CONTRACT_VERSION) {
    throw new TypeError(`${type}.version must be ${ENGINEERING_CONTRACT_VERSION}.`);
  }
  if (value.type !== type) throw new TypeError(`${type}.type must be ${type}.`);
  for (const field of Object.keys(value)) {
    if (!allowedFields(schema).has(field)) {
      throw new TypeError(`${type} contains unsupported field ${field}.`);
    }
  }
  validateFields(type, value, schema);
  if (type === "VerificationResult") {
    if (value.exitCode === undefined && value.signal === undefined && value.timedOut !== true) {
      throw new TypeError("VerificationResult must record exitCode, signal, or timedOut=true.");
    }
    if (!Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.finishedAt))) {
      throw new TypeError("VerificationResult timestamps must be valid ISO timestamps.");
    }
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      throw new TypeError("VerificationResult.finishedAt cannot precede startedAt.");
    }
  }
  return immutableSnapshot(value);
}

export function createEngineeringRecord(type, fields) {
  return validateEngineeringRecord(type, {
    version: ENGINEERING_CONTRACT_VERSION,
    type,
    ...fields,
  });
}

export const ENGINEERING_RECORD_TYPES = Object.freeze(Object.keys(RECORD_TYPES));
