import { immutableSnapshot } from "./contracts.mjs";

const USAGE_KINDS = new Set(["measured", "estimated", "unknown"]);
const MAX_TEXT = 160;
const LEAD_OUTCOMES = new Set(["running", "accepted", "rejected", "failed"]);

function safeText(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw new TypeError(`${name} is required.`);
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${MAX_TEXT} characters.`);
  }
  return value.trim();
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return value;
}

export function usageValue(kind = "unknown", value) {
  if (!USAGE_KINDS.has(kind)) throw new TypeError(`Unsupported usage kind ${JSON.stringify(kind)}.`);
  if (kind === "unknown") {
    if (value !== undefined) throw new TypeError("Unknown usage cannot carry a numeric value.");
    return Object.freeze({ kind: "unknown" });
  }
  return Object.freeze({ kind, value: count(value, `${kind} usage`) });
}

function normalizeUsageField(value, name) {
  if (value === undefined || value === null) return usageValue("unknown");
  if (Number.isSafeInteger(value)) return usageValue("measured", value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is invalid.`);
  return usageValue(value.kind, value.value);
}

export function normalizeEngineeringUsage(usage = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("usage must be an object.");
  return immutableSnapshot({
    inputTokens: normalizeUsageField(usage.inputTokens, "inputTokens"),
    cachedInputTokens: normalizeUsageField(usage.cachedInputTokens, "cachedInputTokens"),
    outputTokens: normalizeUsageField(usage.outputTokens, "outputTokens"),
    reasoningTokens: normalizeUsageField(usage.reasoningTokens, "reasoningTokens"),
    totalTokens: normalizeUsageField(usage.totalTokens, "totalTokens"),
    costMicros: normalizeUsageField(usage.costMicros, "costMicros"),
  });
}

export function normalizeLeadInvocationUsage(usage = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new TypeError("lead invocation usage must be an object.");
  }
  return immutableSnapshot({
    inputTokens: normalizeUsageField(usage.inputTokens, "inputTokens"),
    outputTokens: normalizeUsageField(usage.outputTokens, "outputTokens"),
    totalTokens: normalizeUsageField(usage.totalTokens, "totalTokens"),
    contextTokens: normalizeUsageField(usage.contextTokens, "contextTokens"),
    contextBytes: normalizeUsageField(usage.contextBytes, "contextBytes"),
  });
}

/**
 * Records one actual native lead call. Token fields remain explicitly unknown
 * when Codex does not expose them; callers may still record the locally
 * measurable serialized evidence-packet size as contextBytes.
 */
export function createLeadInvocationEvent({
  runId,
  taskId,
  invocationId,
  operationId,
  sourceRevision,
  model = "gpt-6-astra",
  outcome = "running",
  usage,
  at = Date.now(),
} = {}) {
  if (!LEAD_OUTCOMES.has(outcome)) throw new TypeError(`Unsupported lead invocation outcome ${JSON.stringify(outcome)}.`);
  return immutableSnapshot({
    schemaVersion: 1,
    type: "native-lead-invocation",
    at: new Date(at).toISOString(),
    runId: safeText(runId, "runId"),
    taskId: safeText(taskId, "taskId"),
    invocationId: safeText(invocationId, "invocationId"),
    operationId: safeText(operationId, "operationId"),
    sourceRevision: safeText(sourceRevision, "sourceRevision"),
    model: safeText(model, "model"),
    outcome,
    usage: normalizeLeadInvocationUsage(usage),
  });
}

export function summarizeLeadInvocations(events = []) {
  if (!Array.isArray(events)) throw new TypeError("lead invocation events must be an array.");
  const fields = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "contextTokens", "contextBytes"]) {
    const values = events.map((event) => normalizeLeadInvocationUsage(event?.usage)[field]);
    fields[field] = {
      measured: values.filter(({ kind }) => kind === "measured").reduce((sum, item) => sum + item.value, 0),
      estimated: values.filter(({ kind }) => kind === "estimated").reduce((sum, item) => sum + item.value, 0),
      unknown: values.filter(({ kind }) => kind === "unknown").length,
    };
  }
  return immutableSnapshot({ invocationCount: events.length, fields });
}

export function createEngineeringUsageEvent({
  runId,
  taskId,
  attemptId,
  role,
  sourceRevision,
  model,
  provider,
  family,
  usage,
  childId,
  decisionId,
  providerRequestId,
  routerRequestId,
  servingRoute,
  requestedRoute,
  requestedEffort,
  effectiveEffort,
  effortSource,
  latencyMs,
  retries,
  circuitState,
  verificationOutcome,
  source = "engineering",
  at = Date.now(),
} = {}) {
  const event = {
    schemaVersion: 1,
    at: new Date(at).toISOString(),
    runId: safeText(runId, "runId"),
    taskId: safeText(taskId, "taskId"),
    attemptId: safeText(attemptId, "attemptId"),
    role: safeText(role, "role"),
    sourceRevision: safeText(sourceRevision, "sourceRevision"),
    model: safeText(model, "model"),
    provider: safeText(provider, "provider"),
    family: safeText(family, "family"),
    source: safeText(source, "source"),
    usage: normalizeEngineeringUsage(usage),
  };
  for (const [key, value] of Object.entries({
    childId, decisionId, providerRequestId, routerRequestId, servingRoute,
    requestedRoute, requestedEffort, effectiveEffort, effortSource, circuitState,
    verificationOutcome,
  })) {
    const normalized = safeText(value, key, { optional: true });
    if (normalized !== undefined) event[key] = normalized;
  }
  if (latencyMs !== undefined) event.latencyMs = count(Math.round(latencyMs), "latencyMs");
  if (retries !== undefined) event.retries = count(retries, "retries");
  return immutableSnapshot(event);
}

export function engineeringUsageFromRouterEvent(correlation, routerEvent) {
  if (!routerEvent || typeof routerEvent !== "object") throw new TypeError("routerEvent is required.");
  const measuredOrUnknown = (field) => routerEvent[field] === undefined
    ? usageValue("unknown")
    : usageValue("measured", count(routerEvent[field], field));
  const input = routerEvent.inputTokens !== undefined
    ? measuredOrUnknown("inputTokens")
    : routerEvent.estimatedInputTokens !== undefined
      ? usageValue("estimated", count(routerEvent.estimatedInputTokens, "estimatedInputTokens"))
      : usageValue("unknown");
  return createEngineeringUsageEvent({
    ...correlation,
    model: routerEvent.model,
    provider: routerEvent.provider,
    family: correlation.family || routerEvent.provider,
    routerRequestId: routerEvent.requestId,
    providerRequestId: routerEvent.providerRequestId,
    servingRoute: routerEvent.servingRoute || routerEvent.model,
    latencyMs: routerEvent.durationMs,
    retries: routerEvent.retries,
    usage: {
      inputTokens: input,
      cachedInputTokens: measuredOrUnknown("cachedInputTokens"),
      outputTokens: measuredOrUnknown("outputTokens"),
      reasoningTokens: measuredOrUnknown("reasoningTokens"),
      totalTokens: measuredOrUnknown("totalTokens"),
      costMicros: routerEvent.costMicros === undefined
        ? usageValue("unknown")
        : usageValue("measured", count(routerEvent.costMicros, "costMicros")),
    },
    source: "router",
    at: routerEvent.at ? Date.parse(routerEvent.at) : Date.now(),
  });
}

function rank(kind) {
  return kind === "measured" ? 2 : kind === "estimated" ? 1 : 0;
}

/** Merge duplicate Router/Prism/native observations without adding the same request twice. */
export function deduplicateEngineeringUsage(events) {
  const parents = events.map((_, index) => index);
  const root = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left, right) => {
    const a = root(left);
    const b = root(right);
    if (a !== b) parents[b] = a;
  };
  const identifiers = new Map();
  events.forEach((event, index) => {
    const scope = `${event.runId}\0${event.taskId}\0${event.attemptId}`;
    const tokens = [
      event.routerRequestId && `${scope}\0router\0${event.routerRequestId}`,
      event.providerRequestId && `${scope}\0provider\0${event.provider}\0${event.providerRequestId}`,
    ].filter(Boolean);
    for (const token of tokens) {
      if (identifiers.has(token)) union(index, identifiers.get(token));
      else identifiers.set(token, index);
    }
  });
  const groups = new Map();
  events.forEach((event, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  const results = [];
  for (const group of groups.values()) {
    let current = group[0];
    const conflicts = [];
    for (const event of group.slice(1)) {
    const usage = {};
    for (const field of Object.keys(current.usage)) {
      const left = current.usage[field];
      const right = event.usage[field];
      const priorConflict = conflicts.find((entry) => entry.field === field);
      if (priorConflict) {
        usage[field] = usageValue("unknown");
        if (right.kind === "measured" && !priorConflict.values.includes(right.value)) {
          priorConflict.values.push(right.value);
          priorConflict.values.sort((a, b) => a - b);
        }
      } else if (left.kind === "measured" && right.kind === "measured" && left.value !== right.value) {
        usage[field] = usageValue("unknown");
        conflicts.push({
          field,
          kind: "measured_disagreement",
          values: [...new Set([left.value, right.value])].sort((a, b) => a - b),
        });
      } else {
        usage[field] = rank(right.kind) > rank(left.kind) ? right : left;
      }
    }
    current = immutableSnapshot({
      ...current,
      ...event,
      usage,
      sources: [...new Set([...(current.sources || [current.source]), ...(event.sources || [event.source])])],
      ...(conflicts.length ? { usageConflicts: conflicts } : {}),
    });
    }
    results.push(current);
  }
  return Object.freeze(results);
}

export function summarizeEngineeringUsage(events) {
  const deduplicated = deduplicateEngineeringUsage(events);
  const summary = { requests: deduplicated.length, fields: {} };
  for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicros"]) {
    const values = deduplicated.map((event) => event.usage[field]);
    const measured = values.filter((value) => value.kind === "measured");
    const estimated = values.filter((value) => value.kind === "estimated");
    const unknown = values.filter((value) => value.kind === "unknown").length;
    summary.fields[field] = {
      measured: measured.reduce((sum, value) => sum + value.value, 0),
      estimated: estimated.reduce((sum, value) => sum + value.value, 0),
      unknown,
    };
  }
  return immutableSnapshot(summary);
}
